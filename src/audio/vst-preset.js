// A saved patch: one plugin plus the parameter values that made it sound the
// way it did.
//
// Why it exists: `anyaudio_vst info` dumps two hundred parameter names, and
// tuning a synth by number is the kind of work nobody wants to repeat. Once a
// patch is right, the numbers should be a name that a later score can point at
// — `"vst": {"preset": "juno-warm-pad"}` — instead of a block of magic values
// copied from an old reply.
//
// This is the twin of the style card in style.js: the style card records *how
// a piece is written*, a preset records *what it is played on*.

import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { homedir } from 'node:os'
import { isVst2Plugin, probeVst2Plugin, readVst2Patch } from './vst-host.js'

export const PRESET_SCHEMA = 2

// The file a plugin writes from its own window. This is the only way to reach
// the knobs a plugin keeps out of its parameter list — a person opens the
// plugin, turns what they hear, saves it, and a score points at the file.
const STATE_FORMATS = new Map([
  ['.vstpreset', 'vstpreset'],
  ['.fxp', 'fxp'],
  ['.fxb', 'fxb'],
])

/** Guess the state format from the file name. Unknown extensions are left
 *  undefined so the worker falls back to its generic loader. */
export function stateFormatOf(file) {
  return STATE_FORMATS.get(String(extname(String(file ?? ''))).toLowerCase()) ?? ''
}

/** A {path, format} pair, or null when the input says nothing useful. */
export function cleanState(state) {
  if (!state) return null
  if (typeof state === 'string') {
    const path = state.trim()
    if (!path) return null
    const format = stateFormatOf(path)
    return format ? { path, format } : { path }
  }
  if (typeof state !== 'object' || Array.isArray(state)) return null
  const path = typeof state.path === 'string' ? state.path.trim() : ''
  if (!path) return null
  const format = typeof state.format === 'string' && state.format.trim()
    ? state.format.trim().toLowerCase()
    : stateFormatOf(path)
  return format ? { path, format } : { path }
}

/** Where presets live. `ANYAUDIO_VST_PRESET_DIR` overrides it, which is what
 *  the test suite uses so it never touches the machine-wide shelf. */
export function presetDir() {
  const configured = process.env.ANYAUDIO_VST_PRESET_DIR
  if (configured && configured.trim()) return configured.trim()
  return join(homedir(), '.dsh', 'anyaudio', 'vst-presets')
}

export function presetSlug(name) {
  const slug = String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'preset'
}

function cleanParams(params) {
  const out = {}
  if (!params || typeof params !== 'object' || Array.isArray(params)) return out
  for (const [key, value] of Object.entries(params)) {
    const number = Number(value)
    if (!Number.isFinite(number)) continue
    out[String(key)] = number
  }
  return out
}

async function readPresetFile(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

/** Every preset on the shelf, newest first. A file that does not parse is
 *  reported rather than skipped silently: it is the only copy of somebody's
 *  patch, and they should hear that it is broken. */
export async function listPresets() {
  const dir = presetDir()
  let names = []
  try {
    names = (await readdir(dir)).filter((entry) => entry.endsWith('.json'))
  } catch {
    return { presets: [], broken: [] }
  }
  const presets = []
  const broken = []
  for (const file of names) {
    const path = join(dir, file)
    try {
      const raw = await readPresetFile(path)
      presets.push({
        id: raw.id ?? basename(file, '.json'),
        name: raw.name ?? raw.id ?? basename(file, '.json'),
        plugin: raw.plugin,
        pluginName: raw.pluginName ?? (raw.plugin ? basename(String(raw.plugin)) : ''),
        params: raw.params ?? {},
        state: cleanState(raw.state),
        note: raw.note ?? '',
        createdAt: raw.createdAt ?? null,
      })
    } catch (error) {
      broken.push({ file, error: error.message })
    }
  }
  presets.sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))
  return { presets, broken }
}

/** Find one preset by id, display name, or id slug — the three things a person
 *  might paste back in. Returns null when nothing matches. */
export async function findPreset(name) {
  const wanted = String(name ?? '').trim()
  if (!wanted) return null
  const { presets } = await listPresets()
  const lower = wanted.toLowerCase()
  return presets.find((entry) => entry.id === wanted)
    ?? presets.find((entry) => String(entry.name).toLowerCase() === lower)
    ?? presets.find((entry) => entry.id === presetSlug(wanted))
    ?? null
}

export async function savePreset({ name, plugin, params, state, note }) {
  if (!name || !String(name).trim()) throw new Error('a preset needs a name')
  if (!plugin || !String(plugin).trim()) throw new Error('a preset needs the plugin path it was tuned on')
  const dir = presetDir()
  await mkdir(dir, { recursive: true })
  const base = presetSlug(name)
  let id = base
  for (let suffix = 2; ; suffix++) {
    try {
      await readFile(join(dir, `${id}.json`), 'utf8')
      id = `${base}-${suffix}`
    } catch {
      break
    }
  }
  const record = {
    schema: PRESET_SCHEMA,
    id,
    name: String(name).trim(),
    createdAt: new Date().toISOString(),
    plugin: String(plugin).trim(),
    pluginName: basename(String(plugin).trim()),
    params: cleanParams(params),
    ...(cleanState(state) ? { state: cleanState(state) } : {}),
    note: String(note ?? '').trim(),
  }
  await writeFile(join(dir, `${id}.json`), `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  const lines = [
    `# ${record.name}`,
    '',
    `- 插件：${record.pluginName}`,
    `- 路径：${record.plugin}`,
    `- 参数：${Object.keys(record.params).length} 个`,
    record.state ? `- 状态文件：${record.state.path}` : '',
    record.note ? `- 说明：${record.note}` : '',
    '',
    '```json',
    JSON.stringify({ vst: { preset: record.id } }, null, 2),
    '```',
    '',
    '把上面这段放进 anyaudio_music 的某条轨道，就用了这个音色。',
  ].filter((line) => line !== undefined)
  await writeFile(join(dir, `${id}.md`), `${lines.join('\n')}\n`, 'utf8')
  return record
}

/**
 * A `.vstpreset` a Cubase-style host writes for a VST2 plugin is a VST3
 * wrapper around the plugin's own `FxCk` or `FBCh` chunk. The wrapper means
 * nothing to a VST2 state loader, so pull the inner chunk out; the plugin then
 * sees exactly the file it would have saved itself.
 */
export function extractVst2Chunk(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 16) return null
  if (buffer.toString('latin1', 0, 4) !== 'VST3') return null
  const index = buffer.indexOf('CcnK', 4)
  if (index < 0 || index + 8 > buffer.length) return null
  const bodyLength = buffer.readInt32BE(index + 4)
  if (bodyLength <= 0 || index + 8 + bodyLength > buffer.length) return null
  const body = buffer.subarray(index + 8, index + 8 + bodyLength)
  const kind = body.toString('latin1', 0, 4)
  if (kind !== 'FxCk' && kind !== 'FBCh') return null
  const fxId = body.readInt32BE(8)
  const name = kind === 'FxCk' ? body.toString('latin1', 20, 48).replace(/\0[\s\S]*$/, '').trim() : ''
  const programs = kind === 'FBCh' ? body.readInt32BE(16) : 1
  return { kind, fxId, name, programs, chunk: Buffer.concat([buffer.subarray(index, index + 8), body]) }
}

/**
 * Register a preset file the plugin itself wrote. Nothing is parsed: the file
 * belongs to the plugin, and handing it back unchanged is the whole point.
 */
export async function importPreset({ name, plugin, file, note }) {
  const source = String(file ?? '').trim()
  if (!source) throw new Error('importing a preset needs a file: the .vstpreset, .fxp or .fxb the plugin saved')
  let info
  try {
    info = await stat(source)
  } catch (error) {
    throw new Error(`cannot read the preset file ${source}: ${error.message}`)
  }
  if (!info.isFile()) throw new Error(`${source} is not a file`)
  if (info.size === 0) throw new Error(`${source} is empty`)
  const label = String(name ?? '').trim() || basename(source, extname(source))
  // A Cubase-style host saves the VST2 plugin's own chunk inside its
  // `.vstpreset` wrapper; a VST2 host cannot read the wrapper, so the chunk is
  // written out as the `.fxp`/`.fxb` the plugin itself would have saved. A
  // file without an inner chunk is handed over untouched — a VST3 file is its
  // own format, and only the plugin can judge it.
  let state = cleanState({ path: source })
  note = String(note ?? '').trim() || `imported from ${basename(source)}`
  const inner = extractVst2Chunk(await readFile(source))
  if (inner) {
    const target = join(presetDir(), `${presetSlug(label)}.${inner.kind === 'FBCh' ? 'fxb' : 'fxp'}`)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, inner.chunk)
    state = cleanState({ path: target })
    note = `imported from ${basename(source)} — the VST2 ${inner.kind === 'FBCh' ? 'bank' : 'program'} chunk it wraps${inner.name ? ` ("${inner.name}")` : ''}, ${inner.programs} program(s)`
  }
  return savePreset({
    name: label,
    // A preset file may be shared by several plugins, and a score track that
    // points at the preset still needs to say which plugin plays it, so the
    // plugin stays optional here and is filled in by the caller when missing.
    plugin: String(plugin ?? '').trim() || 'unknown',
    params: {},
    state,
    note,
  })
}

/**
 * Write a VST2 program file. The format is small and fully known — a `CcnK`
 * wrapper around a `FxCk` chunk — so a patch does not have to come from the
 * plugin's own window: the values can be computed, and the plugin accepts the
 * result because `load_preset` does not check who wrote it.
 *
 * `values` are raw parameter values in the plugin's own range, indexed exactly
 * like the list `get_patch()` returns.
 */
export function encodeFxp({ name = '', values = [] }) {
  const count = values.length
  const body = Buffer.alloc(48 + count * 4)
  body.write('FxCk', 0, 'latin1')
  body.writeInt32BE(1, 4) // version
  body.writeInt32BE(0, 8) // fxID — checked by nobody, so zero is honest
  body.writeInt32BE(1, 12) // fxVersion
  body.writeInt32BE(count, 16)
  body.write(String(name).slice(0, 27), 20, 'latin1')
  for (let index = 0; index < count; index++) {
    const value = Number(values[index])
    body.writeFloatBE(Number.isFinite(value) ? value : 0, 48 + index * 4)
  }
  const head = Buffer.alloc(8)
  head.write('CcnK', 0, 'latin1')
  head.writeInt32BE(body.length, 4)
  return Buffer.concat([head, body])
}

/**
 * Build a .fxp for a 64-bit VST2 plugin: start from the values the plugin
 * reports, apply the named changes, write the file, and register it.
 *
 * `params` is addressed by name because parameter order is not documented
 * anywhere; a name the plugin does not have is an error, not a silent skip.
 */
export async function writeFxpPreset({ name, plugin, params = {}, file, note }) {
  if (!name || !String(name).trim()) throw new Error('a preset needs a name')
  if (!plugin || !String(plugin).trim()) throw new Error('writing a VST2 patch needs the plugin path: the .dll it is for')
  if (!/\.dll$/i.test(String(plugin))) {
    throw new Error('a .fxp belongs to VST2; write this one from the plugin window and register the .vstpreset instead')
  }
  // A .fxp is a VST2 file, so the parameter list has to come from the VST2
  // host: the pedalboard probe refuses a .dll outright.
  const probe = isVst2Plugin(plugin)
    ? await probeVst2Plugin(plugin)
    : (await probeVstPlugins([plugin]))[0]
  if (!probe?.ok) throw new Error(`cannot open ${basename(plugin)}: ${probe?.error ?? 'the plugin did not answer'}`)
  const indexOf = new Map()
  for (const [index, entry] of (probe.parameters ?? []).entries()) {
    if (entry?.name) indexOf.set(entry.name, index)
  }
  const { patch } = await readVst2Patch(plugin)
  const values = new Array(patch.length).fill(0)
  for (const [index, value] of patch) values[index] = value
  const changed = []
  for (const [key, value] of Object.entries(params ?? {})) {
    const index = indexOf.get(String(key))
    if (index === undefined) {
      const close = [...indexOf.keys()].filter((item) => item.toLowerCase().includes(String(key).toLowerCase())).slice(0, 5)
      throw new Error(`"${key}" is not a parameter of ${probe.name || basename(plugin)}${close.length ? `; closest names: ${close.join(', ')}` : ''}`)
    }
    values[index] = Number(value)
    changed.push({ name: String(key), value: Number(value) })
  }
  const target = String(file ?? '').trim() || join(presetDir(), `${presetSlug(name)}.fxp`)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, encodeFxp({ name, values }))
  const record = await savePreset({
    name,
    plugin,
    params: Object.fromEntries(changed.map((entry) => [entry.name, entry.value])),
    state: { path: target },
    note: note ?? `written here: ${changed.length} parameter(s) changed from the plugin's own values`,
  })
  return { preset: record, file: target, count: values.length, changed }
}

// Where the plugins themselves put their presets. A person who saves a patch
// from the plugin window has no reason to know the path either — Steinberg's
// convention is `Documents/VST3 Presets/<vendor>/<plugin>/<name>.vstpreset`,
// and every other host that speaks .vstpreset uses the same one.
export function presetSearchDirs() {
  const home = homedir()
  const appData = process.env.APPDATA || join(home, 'AppData', 'Roaming')
  const dirs = [
    join(home, 'Documents', 'VST3 Presets'),
    join(home, 'OneDrive', 'Documents', 'VST3 Presets'),
    join(appData, 'VST3 Presets'),
  ]
  const extra = String(process.env.ANYAUDIO_VST_PRESET_DIRS ?? '')
    .split(';')
    .map((entry) => entry.trim())
    .filter(Boolean)
  return [...new Set([...dirs, ...extra])]
}

const MAX_SCAN_FILES = 2000
const MAX_SCAN_DEPTH = 5

/**
 * Every preset file the plugins left on disk, as {file, name, vendor, plugin, format}.
 * Read-only and bounded: a host that dumps ten thousand presets must not stall
 * the tool, so the walk stops at MAX_SCAN_FILES and says so.
 */
export async function scanPresetFiles({ dirs = presetSearchDirs(), query = '', limit = 400 } = {}) {
  const wanted = String(query ?? '').trim().toLowerCase()
  const files = []
  let truncated = false

  async function walk(dir, depth) {
    if (files.length >= MAX_SCAN_FILES) {
      truncated = true
      return
    }
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.')) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (depth > 0) await walk(full, depth - 1)
        continue
      }
      const format = stateFormatOf(full)
      if (!format) continue
      files.push({ file: full, format })
      if (files.length >= MAX_SCAN_FILES) {
        truncated = true
        return
      }
    }
  }

  for (const dir of dirs) await walk(dir, MAX_SCAN_DEPTH)

  const rows = files.map(({ file, format }) => {
    // `<root>/<vendor>/<plugin>/<preset>` — the tail is the plugin, the one
    // before it the vendor; both are only labels, the file is the truth.
    const parts = file.split(/[\\/]+/).filter(Boolean)
    const name = basename(file, extname(file))
    const plugin = parts.length >= 2 ? parts[parts.length - 2] : ''
    const vendor = parts.length >= 3 ? parts[parts.length - 3] : ''
    return { file, name, plugin, vendor, format }
  })

  const filtered = wanted
    ? rows.filter((row) => `${row.name} ${row.plugin} ${row.vendor}`.toLowerCase().includes(wanted))
    : rows
  return { dirs, files: filtered.slice(0, Math.max(1, limit)), found: filtered.length, scanned: files.length, truncated }
}

export async function removePreset(name) {
  const found = await findPreset(name)
  if (!found) return null
  const dir = presetDir()
  await rm(join(dir, `${found.id}.json`), { force: true })
  await rm(join(dir, `${found.id}.md`), { force: true })
  return found
}

/**
 * Replace `{preset: "name"}` on every score track with the plugin and parameter
 * values it points at. Explicit values on the track win, so a score can start
 * from a preset and change one knob without copying the other two hundred.
 */
export async function resolveScorePresets(score) {
  const tracks = Array.isArray(score?.tracks) ? score.tracks : []
  if (tracks.length === 0) return score
  let changed = false
  const resolved = []
  for (const track of tracks) {
    const spec = track?.vst
    if (!spec || typeof spec !== 'object' || Array.isArray(spec) || !spec.preset) {
      resolved.push(track)
      continue
    }
    const found = await findPreset(spec.preset)
    if (!found) {
      const { presets } = await listPresets()
      const available = presets.map((entry) => `"${entry.name}"`).join(', ') || '(none saved yet)'
      throw new Error(
        `track "${track.name}": no saved patch named "${spec.preset}". Saved patches: ${available}. `
        + 'Save one with anyaudio_vst action:"preset", presetAction:"save".',
      )
    }
    changed = true
    const { preset: _preset, ...rest } = spec
    const state = cleanState(rest.state) ?? found.state
    resolved.push({
      ...track,
      vst: {
        ...rest,
        plugin: found.plugin !== 'unknown' ? found.plugin : rest.plugin,
        params: { ...found.params, ...(rest.params && typeof rest.params === 'object' ? rest.params : {}) },
        ...(state ? { state } : {}),
      },
    })
  }
  if (!changed) return score
  return { ...score, tracks: resolved }
}
