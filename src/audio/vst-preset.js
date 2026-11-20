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

import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { homedir } from 'node:os'

export const PRESET_SCHEMA = 1

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

export async function savePreset({ name, plugin, params, note }) {
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
    note: String(note ?? '').trim(),
  }
  await writeFile(join(dir, `${id}.json`), `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  const lines = [
    `# ${record.name}`,
    '',
    `- 插件：${record.pluginName}`,
    `- 路径：${record.plugin}`,
    `- 参数：${Object.keys(record.params).length} 个`,
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
    resolved.push({
      ...track,
      vst: {
        ...rest,
        plugin: found.plugin,
        params: { ...found.params, ...(rest.params && typeof rest.params === 'object' ? rest.params : {}) },
      },
    })
  }
  if (!changed) return score
  return { ...score, tracks: resolved }
}
