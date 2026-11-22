import { readdir, readFile, stat } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'
import { FONT_EXTENSIONS, RECOMMENDED_FONTS, findRecommendedByFile, fontSearchDirs, installFont, listFonts, resolveFont } from '../audio/fonts.js'
import { loadCatalog } from '../audio/banks.js'
import { addPending, extractManualText, listManuals, listPending, manualsDir, pendingFor, readManual, removeManual, removePending, saveManual } from '../audio/manuals.js'
import { DRUM_MAP, INSTRUMENTS } from '../audio/score.js'
import { CATEGORY_LABELS, scoreTable } from '../audio/scoring.js'
import { listSourceKinds } from '../audio/sources.js'
import { loadSoundBank, listPresets } from '../audio/synth.js'
import { readConfig, updateConfig } from '../config.js'
import { finalizeTool, formatBytes, relativeToWorkspace, textRenderer, workspaceRootOf } from './shared.js'

/**
 * How much of an imported manual to keep. The manual file itself is capped at
 * 256 KB, and CJK costs three bytes a character, so a full dump of a 300-page
 * PDF would be rejected. 70k characters keeps roughly 200 KB of Japanese and a
 * comfortable English manual, and the extractor says when it truncated.
 */
const MANUAL_EXTRACT_CHARS = 200000

/** A note sheet is capped at 256 KB. A manual that reads past that is not cut
 *  at an arbitrary character: the limit is applied on a paragraph boundary and
 *  the card says what did not fit, so the reader knows the rest is in the
 *  source file rather than believing the manual ends there. */
function fitManualText(text) {
  const limit = 250000
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes <= limit) return text
  let cut = Math.floor(text.length * 0.6)
  while (cut > 1000 && Buffer.byteLength(text.slice(0, cut), 'utf8') > limit) cut = Math.floor(cut * 0.9)
  const boundary = text.lastIndexOf('\n\n', cut)
  if (boundary > cut * 0.5) cut = boundary
  const head = text.slice(0, cut).trimEnd()
  return head + `\n\n[stored: ${bytes} bytes were read; the first ${Buffer.byteLength(head, 'utf8')} bytes are below and the rest is still in the source file — re-read that section there if you need it]`
}

function groupInstruments() {
  const families = {
    keyboard: ['piano', 'epiano', 'harpsichord', 'celesta', 'vibraphone', 'marimba', 'organ', 'accordion'],
    plucked: ['nylon-guitar', 'steel-guitar', 'harp', 'koto', 'guzheng', 'guqin', 'pipa', 'yangqin', 'sitar', 'banjo', 'shamisen', 'kalimba', 'dulcimer'],
    bowed: ['violin', 'viola', 'cello', 'contrabass', 'strings', 'slow-strings', 'pizzicato', 'erhu', 'fiddle', 'tremolo-strings'],
    wind: ['flute', 'recorder', 'pan-flute', 'shakuhachi', 'dizi', 'xiao', 'whistle', 'oboe', 'clarinet', 'bassoon', 'sheng', 'suona', 'shenai', 'englishhorn', 'harmonica', 'ocarina'],
    brass: ['trumpet', 'trombone', 'tuba', 'horn', 'brass-section'],
    bass: ['bass', 'finger-bass', 'pick-bass', 'fretless-bass', 'contrabass'],
    percussion: ['timpani', 'taiko', 'chinese-drums', 'tubular-bells', 'bianzhong', 'musicbox', 'tinkle-bell', 'steel-drums', 'woodblock', 'melodic-tom', 'synth-drum'],
    texture: ['choir', 'voice-ooh', 'new-age-pad', 'warm-pad', 'choir-pad', 'bowed-pad', 'halo-pad', 'soundtrack', 'crystal', 'atmosphere', 'seashore', 'rain-fx'],
  }
  return Object.entries(families).map(([family, names]) => ({
    family,
    instruments: names.map((name) => ({ name, program: INSTRUMENTS[name] })),
  }))
}

/**
 * Fonts left in a project folder by 0.1.0 and earlier. They are reported so the
 * user can re-install them into the shared library; nothing is moved or deleted
 * automatically.
 */
async function legacyProjectFonts(workspaceRoot) {
  if (!workspaceRoot) return []
  const dir = join(workspaceRoot, '.anyaudio', 'fonts')
  const names = await readdir(dir).catch(() => [])
  const found = []
  for (const name of names) {
    if (!FONT_EXTENSIONS.has(extname(name).toLowerCase())) continue
    const info = await stat(join(dir, name)).catch(() => null)
    if (info?.isFile()) found.push({ name, path: join(dir, name), bytes: info.size })
  }
  return found
}

async function resolveBankArg(value, workspaceRoot) {
  if (typeof value !== 'string' || !value.trim()) return resolveFont({ path: value, workspaceRoot })
  const wanted = value.trim()
  const catalog = await loadCatalog()
  const entry =
    catalog.find((item) => item.id === wanted) ??
    catalog.find((item) => item.name === wanted) ??
    catalog.find((item) => item.path.split(/[\\/]/).pop().toLowerCase() === wanted.toLowerCase())
  return entry ? entry.path : resolveFont({ path: wanted, workspaceRoot })
}

export const sourcesToolDefinition = finalizeTool({
  name: 'anyaudio_sources',
  description:
    'Inspect and manage the sound sources used by anyaudio_music and anyaudio_sfx. Actions: "list" (installed SoundFont banks with their 1-10 instrument-family scores, the shared font library path and available source kinds), "install" (download a recommended bank or copy a .sf2/.sf3/.dls from disk into the shared library), "use" (make an installed bank the default source that anyaudio_music uses for tracks without a "source"), "instruments" (GM instrument names plus the Chinese-instrument aliases this plugin understands), "presets" (list the actual patches inside a bank, optionally filtered by query), "kinds" (what source types exist, including planned ones such as sample packs and narration voices). ' +
    'The font library is shared by every project and agent session on this machine, so a bank installed once is available everywhere. ' +
    'Run "install" once if anyaudio_music reports that no SoundFont is installed. Custom banks are supported: pass "fromPath" to a local file or "url" to a direct download. Each track in a score may use a different installed bank via its "source" field; "auto" picks the best-scored installed bank for that instrument. Drum kits always come from the default bank.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'install', 'instruments', 'presets', 'use', 'kinds', 'manuals', 'manual', 'manual_set', 'manual_import', 'manual_remove', 'manuals_pending', 'manual_parse'], description: 'What to do; defaults to "list". "manuals" lists note sheets written about a sound source, "manual" reads one, "manual_set" writes or replaces one, "manual_import" registers a manual by path (it is extracted later, when the source is about to be used; add "parse": true to extract right now), "manuals_pending" lists the registered-but-not-yet-read manuals, "manual_parse" extracts one of those now, "manual_remove" deletes one.' },
      id: { type: 'string', description: 'Recommended source/bank id for install, default "generaluser".' },
      url: { type: 'string', description: 'Direct URL of a custom SoundFont to install.' },
      fromPath: { type: 'string', description: 'Local SoundFont path to install (useful when downloads are blocked).' },
      path: { type: 'string', description: 'Bank path to inspect with "presets" or to make the default with "use".' },
      font: { type: 'string', description: 'Same as path: an installed id (e.g. "musescore-general"), file name or .sf2 path.' },
      query: { type: 'string', description: 'Filter preset names, e.g. "piano", "koto", "shakuhachi".' },
      limit: { type: 'number', description: 'Max presets to list, default 60.' },
      name: { type: 'string', description: 'With "manual"/"manual_set"/"manual_import"/"manual_remove": which source the notes are about, e.g. "SD-20" or a saved hardware rig name.' },
      path: { type: 'string', description: 'With "manual_import": the manual file, or a folder of them, to register.' },
      parse: { type: 'boolean', description: 'With "manual_import": extract the text now instead of only registering the path.' },
      text: { type: 'string', description: 'With "manual_set": the notes themselves (markdown).' },
    },
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: true,
      properties: {
        ok: { type: 'boolean' },
        action: { type: 'string' },
        message: { type: 'string' },
        fonts: { type: 'array', items: { type: 'object', additionalProperties: true } },
        directories: { type: 'array', items: { type: 'string' } },
        instruments: { type: 'array', items: { type: 'object', additionalProperties: true } },
        drums: { type: 'object', additionalProperties: true },
        presets: { type: 'array', items: { type: 'object', additionalProperties: true } },
        kinds: { type: 'array', items: { type: 'object', additionalProperties: true } },
        font: { type: 'string' },
        default: { type: 'string' },
        defaultSource: { type: 'string' },
        bytes: { type: 'number' },
        sha256: { type: 'string' },
        license: { type: 'string' },
      },
    },
    render: textRenderer((_args, value) => {
      if (value.action === 'manuals') {
        return [
          value.manuals.length
            ? `Notes written about sound sources (${value.manuals.length}), in ${value.directory}:`
            : `No notes written about any source yet (folder: ${value.directory}).`,
          ...value.manuals.map((row) => `- ${row.name} (${formatBytes(row.bytes)}${row.updated ? `, ${row.updated.slice(0, 10)}` : ''}) — read with action "manual"`),
        ].join('\n')
      }
      if (value.action === 'manual') return value.text
      if (value.action === 'manuals_pending') {
        const rows = value.pending ?? []
        return rows.length
          ? [`Manuals registered but not read yet (${rows.length}):`,
            ...rows.map(row => `- ${row.name} → ${row.path}${row.addedAt ? ` (${row.addedAt.slice(0, 10)})` : ''}`),
            'Run action "manual_parse" with the name before composing for that source, then action "manual" to read the result.'].join('\n')
          : 'No manuals are waiting to be read.'
      }
      if (value.action === 'manual_import') {
        return [
          value.message,
          ...(value.warnings?.length ? [`warnings:`, ...value.warnings.map((row) => `- ${row}`)] : []),
        ].join('\n')
      }
      if (value.action === 'instruments') {
        return [
          'Instrument aliases (name → GM program):',
          ...value.instruments.map((group) => `${group.family}: ${group.instruments.map((entry) => `${entry.name}(${entry.program})`).join(', ')}`),
          `Drum kit keys: ${Object.keys(value.drums).join(', ')}`,
        ].join('\n')
      }
      if (value.action === 'presets') {
        return [`Presets in ${value.font} (${value.presets.length} shown):`, ...value.presets.map((preset) => `- ${preset.name} — program ${preset.program}, bank ${preset.bank}${preset.drums ? ' (drum kit)' : ''}`)].join('\n')
      }
      if (value.action === 'kinds') {
        return value.kinds.map((kind) => `- ${kind.id} (${kind.status}) — ${kind.label}: ${kind.description}`).join('\n')
      }
      if (value.action === 'list') {
        const withScores = (font) => {
          if (!font.scores) return `${font.id} (unscored)`
          return `${font.id}: ${Object.entries(font.scores).filter(([category]) => category !== 'default').map(([category, score]) => `${category} ${score}`).join(', ')}`
        }
        return [
          value.fonts.length ? 'Installed SoundFont banks:' : 'No SoundFont installed yet — run anyaudio_sources with action "install".',
          ...value.fonts.map((font) => `- ${font.name} (${font.source}, ${formatBytes(font.bytes)})${font.default ? ' [fallback]' : font.recommended ? ' [recommended]' : ''} → ${font.path}`),
          `Scores (1-10 by family): ${value.fonts.map(withScores).join(' | ') || 'none'}`,
          `Families: ${Object.keys(CATEGORY_LABELS).join(', ')}`,
          // Two different things answer to "default": the bank the person chose
          // with action "use" (music.font), and the bank used when they chose
          // nothing. Calling both "default" is what made a person believe they
          // had configured one, while the tool kept saying "not set"
          // (improvement plan 04).
          value.defaultSource
            ? `Configured default source: ${value.defaultSource}`
            : `Configured default source: not set — renders fall back to ${value.fonts.find((font) => font.default)?.name ?? 'the installed default bank'}`,
          `Search directories: ${value.directories.join(' | ')}`,
          ...(value.legacy?.length
            ? [
                `From an older version (project folder, not part of the shared library — re-install with install + fromPath to use them):`,
                ...value.legacy.map((font) => `- ${font.path} (${formatBytes(font.bytes)})`),
              ]
            : []),
          `Source kinds: ${value.kinds.map((kind) => `${kind.id}:${kind.status}`).join(', ')}`,
          `Recommended: ${RECOMMENDED_FONTS.filter((font) => !font.hidden).map((font) => `${font.id} (${formatBytes(font.bytes)}, ${font.license})${font.suggested ? ' [suggested]' : ''}${font.default ? ' [fallback]' : ''}`).join('; ')}`,
        ].join('\n')
      }
      return value.message ?? 'done'
    }),
  },
  async execute(args, exec) {
    const workspaceRoot = await workspaceRootOf(exec)
    const action = args.action ?? 'list'
    if (action === 'manuals') {
      return { ok: true, action, manuals: listManuals(), directory: manualsDir() }
    }
    if (action === 'manual') {
      const found = readManual(args.name)
      if (!found) {
        const available = listManuals().map((row) => row.name).join(', ') || '(none written yet)'
        throw new Error(`no manual for "${String(args.name ?? '')}". Saved manuals: ${available}. Write one with action "manual_set" (name + text), or ask the person who owns the source to describe it.`)
      }
      return { ok: true, action, name: found.name, text: found.text, path: found.path }
    }
    if (action === 'manual_set') {
      const body = args.text !== undefined
        ? String(args.text)
        : (args.fromPath ? await readFile(resolve(String(args.fromPath)), 'utf8') : '')
      if (!body.trim()) throw new Error('manual_set needs "text" (the notes), or "fromPath" (a markdown file to copy them from)')
      const saved = saveManual(args.name, body)
      return {
        ok: true,
        action,
        name: saved.name,
        path: saved.path,
        bytes: saved.bytes,
        message: `Saved notes about "${saved.name}" to ${saved.path}. anyaudio_sources with action "manual" now returns them before anyone composes for it.`,
      }
    }
    if (action === 'manual_import') {
      const source = String(args.path ?? args.fromPath ?? '').trim()
      if (!source) throw new Error('manual_import needs "path" — a manual file (.txt/.md/.pdf/.docx/.html/.mhtml) or a folder of them')
      const resolved = resolve(source)
      if (args.parse !== true) {
        const queued = addPending({ name: args.name, path: resolved, note: args.note })
        return {
          ok: true,
          action,
          name: queued.name,
          path: queued.path,
          pending: true,
          message: `Registered ${resolved} for "${queued.name}"; nothing was extracted yet. Before composing for this source, run action "manual_parse" with name "${queued.name}" to read it, or pass "parse": true next time to extract right away.`,
        }
      }
      const extracted = await extractManualText(resolved, { maxChars: MANUAL_EXTRACT_CHARS })
      const saved = saveManual(args.name, fitManualText(extracted.text))
      removePending(args.name)
      return {
        ok: true,
        action,
        name: saved.name,
        path: saved.path,
        bytes: saved.bytes,
        files: extracted.files,
        read: extracted.read,
        chars: extracted.chars,
        truncated: extracted.truncated,
        warnings: extracted.warnings,
        message: `Read ${extracted.read} of ${extracted.files} file(s) into ${saved.path}. This is the raw text — read it with action "manual" and write the parts a composer needs (patch numbers, CC support, limits) into the same name so the next agent gets the shape of it, not the whole page count.`,
      }
    }
    if (action === 'manuals_pending') {
      return { ok: true, action, pending: listPending(), directory: manualsDir() }
    }
    if (action === 'manual_parse') {
      const row = pendingFor(args.name)
      if (!row) {
        const waiting = listPending().map(entry => entry.name).join(', ') || 'none'
        throw new Error(`nothing is registered for "${String(args.name ?? '')}". Waiting: ${waiting}. Register one with action "manual_import" and a path.`)
      }
      const extracted = await extractManualText(row.path, { maxChars: MANUAL_EXTRACT_CHARS })
      const saved = saveManual(row.name, fitManualText(extracted.text))
      removePending(row.name)
      return {
        ok: true,
        action,
        name: saved.name,
        path: saved.path,
        source: row.path,
        bytes: saved.bytes,
        files: extracted.files,
        read: extracted.read,
        chars: extracted.chars,
        truncated: extracted.truncated,
        warnings: extracted.warnings,
        message: `Read ${extracted.read} of ${extracted.files} file(s) from ${row.path} into ${saved.path}. Now read it with action "manual" and write the parts a composer needs (patch numbers, CC support, limits) into the same name.`,
      }
    }
    if (action === 'manual_remove') {
      const gone = removeManual(args.name)
      return { ok: true, action, name: gone.name, path: gone.path, removed: gone.removed }
    }
    if (action === 'install') {
      const result = await installFont({
        id: args.id ?? 'generaluser',
        url: args.url,
        fromPath: args.fromPath,
        workspaceRoot,
      })
      return {
        ok: true,
        action,
        font: result.path,
        bytes: result.bytes,
        sha256: result.sha256,
        license: result.license,
        installed: true,
        message: `Installed ${result.path} (${formatBytes(result.bytes)}) into the shared font library${result.alreadyInstalled ? ' — already present' : ''}. License: ${result.license}`,
      }
    }
    if (action === 'instruments') {
      return { ok: true, action, instruments: groupInstruments(), drums: DRUM_MAP }
    }
    if (action === 'kinds') {
      return { ok: true, action, kinds: listSourceKinds() }
    }
    if (action === 'presets') {
      const fontPath = await resolveBankArg(args.path ?? args.font, workspaceRoot)
      const bank = await loadSoundBank(fontPath)
      const presets = listPresets(bank, { query: args.query, limit: Math.min(200, Math.max(1, Math.round(Number(args.limit) || 60))) })
      return { ok: true, action, font: relativeToWorkspace(workspaceRoot, fontPath), presets }
    }
    if (action === 'use') {
      const fontPath = await resolveBankArg(args.path ?? args.font, workspaceRoot)
      // Store the stable id when the file is a recommended bank, so the default
      // survives a reinstall that changes the directory layout.
      const recommended = findRecommendedByFile(fontPath.split(/[\\/]/).pop())
      const value = recommended ? recommended.id : fontPath
      const { config, path: configPath } = await updateConfig({ music: { font: value } })
      return {
        ok: true,
        action,
        font: fontPath,
        default: config.music.font,
        message: `Default sound source set to ${fontPath}; anyaudio_music now uses it for tracks without a "source" (persisted as "${config.music.font}" in ${configPath}).`,
      }
    }
    const fonts = await listFonts()
    const { config } = await readConfig()
    const table = new Map(scoreTable(RECOMMENDED_FONTS.map((font) => font)).map((entry) => [entry.id, entry.scores]))
    // 0.1.0 and earlier could install into <project>/.anyaudio/fonts. That folder
    // is no longer scanned (the library is machine-wide now); point at the files
    // so nothing silently disappears, without reading them into the library.
    const legacy = await legacyProjectFonts(workspaceRoot)
    return {
      ok: true,
      action: 'list',
      fonts: fonts.map((font) => {
        const recommended = findRecommendedByFile(font.name)
        return {
          ...font,
          relativePath: relativeToWorkspace(workspaceRoot, font.path),
          id: recommended?.id ?? null,
          recommended: Boolean(recommended),
          default: Boolean(recommended?.default),
          scores: recommended ? table.get(recommended.id) : null,
        }
      }),
      // Declared as `string` in the output schema: omit the key when unset
      // instead of sending null, or the host rejects the whole result.
      ...(config.music.font ? { defaultSource: config.music.font } : {}),
      directories: fontSearchDirs(),
      legacy,
      extensions: [...FONT_EXTENSIONS],
      kinds: listSourceKinds(),
    }
  },
})

export function registerSourcesTool(ctx) {
  ctx.tools.register(sourcesToolDefinition)
}

