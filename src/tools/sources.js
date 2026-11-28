import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { extname, join, resolve } from 'node:path'
import { FONT_EXTENSIONS, RECOMMENDED_FONTS, findRecommendedByFile, fontSearchDirs, installFont, listFonts, resolveFont } from '../audio/fonts.js'
import { loadCatalog } from '../audio/banks.js'
import { addPending, extractManualText, fitManualText, listManuals, listPending, MANUAL_EXTRACT_CHARS, manualsDir, pendingFor, readManual, removeManual, removePending, saveManual } from '../audio/manuals.js'
import { mergedCatalog } from '../audio/vst3-catalog.js'
import { scanPluginTimbres } from '../audio/vst3-presets.js'
import { DRUM_MAP, INSTRUMENTS } from '../audio/score.js'
import { importOrchestrationSource, listOrchestrations, orchestrationDir, readOrchestration, removeOrchestration, summarizeOrchestration } from '../audio/orchestration.js'
import { CATEGORY_LABELS, scoreTable } from '../audio/scoring.js'
import { listSourceKinds } from '../audio/sources.js'
import { loadSoundBank, listPresets } from '../audio/synth.js'
import { readConfig, updateConfig } from '../config.js'
import { finalizeTool, formatBytes, relativeToWorkspace, textRenderer, workspaceRootOf } from './shared.js'


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

/** The exact score field for one SF2 preset: bank 0 uses the alias/program, other banks need the object form. */
function writeForPreset(preset) {
  if (preset.drums) return 'drums:true（鼓组，音高按鼓件名）'
  if (preset.bank === 0) {
    const alias = PROGRAM_ALIASES.get(preset.program)
    return alias ? `instrument:"${alias}"` : `instrument:${preset.program}`
  }
  return `instrument:{program:${preset.program}, bank:${preset.bank}, name:"${preset.name}"}`
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

// 清单只给预览：音色多的音源列前若干个，完整清单用 presets 查。
const TIMBRE_PREVIEW = 12

/** GM program → 第一个别名（INSTRUMENTS 的键序决定），把 bank 的 program 写成 instrument。 */
const PROGRAM_ALIASES = new Map()
for (const [name, program] of Object.entries(INSTRUMENTS)) {
  if (!PROGRAM_ALIASES.has(program)) PROGRAM_ALIASES.set(program, name)
}

/**
 * SF2 的可写音色：bank 0 的每个 program 一条。name 是库里的预设名，write 是谱里
 * 能直接用的 instrument 写法（GM 别名优先，没有别名用 program 号）。读不了库返回
 * timbres: null——一个坏库不该让整份清单失败。vendor 取库元数据里的作者，SF2 没有
 * 厂商字段，这是最接近的一项。
 */
async function sf2Info(path) {
  let bank
  try {
    bank = await loadSoundBank(path)
  } catch {
    return { timbres: null, vendor: '' }
  }
  const byProgram = new Map()
  for (const preset of listPresets(bank, { limit: 10000 })) {
    if (preset.drums || preset.bank !== 0 || byProgram.has(preset.program)) continue
    byProgram.set(preset.program, preset.name)
  }
  const timbres = [...byProgram.entries()]
    .sort(([left], [right]) => left - right)
    .map(([program, name]) => {
      const alias = PROGRAM_ALIASES.get(program)
      return { name, program, write: alias ? `instrument:"${alias}"` : `instrument:${program}` }
    })
  const engineer = bank.soundBankInfo?.engineer
  return { timbres, vendor: typeof engineer === 'string' ? engineer.trim() : '' }
}

function formatScores(scores) {
  if (!scores) return '未评分'
  const parts = Object.entries(scores)
    .filter(([family]) => family !== 'default')
    .map(([family, score]) => `${family} ${score}`)
  if (Number.isFinite(scores.default)) parts.push(`default ${scores.default}（兜底）`)
  return parts.join(', ') || '未评分'
}

function formatTimbres(entry, kind) {
  if (kind === 'sf2' && entry.timbresReadable === false) return '读取失败（用 presets 重试）'
  if (!entry.timbres?.length) {
    return kind === 'sf2'
      ? '1 个音色（默认）— 用默认音色，instrument 可省略'
      : '1 个音色（默认）— 不写 preset，用该音源默认音色'
  }
  const shown = entry.timbres.map((timbre) => (kind === 'sf2' ? `${timbre.name}→${timbre.write}` : timbre.name))
  const count = entry.timbreCount ?? entry.timbres.length
  // SF2 lists bank 0 (the standard GM set); other banks hold extra patches and
  // are reachable through "presets", which prints the exact field for each.
  const head = kind === 'sf2'
    ? `仅列前 ${entry.timbres.length} 个（bank 0 共 ${count} 个），其余用 presets 查`
    : entry.timbresTruncated
      ? `共 ${count} 个，列前 ${entry.timbres.length} 个`
      : `${count} 个`
  return `${head} — ${shown.join(' · ')}`
}

/** A custom bank's id is its file name lowercased and stripped of punctuation, exactly
 *  what banks.js does when it loads the library. The list has to show that string, or
 *  the score the hint teaches will not resolve. */
function sanitizeFontId(value) {
  return String(value)
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'font'
}
function formatWriteHint(entry, kind) {
  if (!entry.timbres?.length) {
    return kind === 'sf2'
      ? `source:"${entry.id}"（用默认音色，instrument 可省略）`
      : `source:"${entry.id}"（不写 preset，用默认音色）`
  }
  return kind === 'sf2'
    ? `source:"${entry.id}"，instrument 按每条音色给出的值`
    : `source:"${entry.id}", preset:"<音色名>"`
}

export const sourcesToolDefinition = finalizeTool({
  name: 'anyaudio_sources',
  description:
    'Inspect and manage the sound sources used by anyaudio_music and anyaudio_sfx. Actions: "list" (every connected source — SoundFont banks and VST3 instruments — with its 1-10 instrument-family scores, measured range, and the timbres it offers, each with the exact score field to write), "install" (download a recommended bank or copy a .sf2/.sf3/.dls from disk into the shared library), "use" (choose the bank drum kits come from), "instruments" (GM alias reference — the names this plugin understands; not the list of available timbres, use "list" for that), "presets" (list one source\'s timbres — a SoundFont bank or a VST3 instrument — each with the exact score field to write), "kinds" (what source types exist, including planned ones such as sample packs and narration voices). ' +
    'The font library is shared by every project and agent session on this machine, so a bank installed once is available everywhere. ' +
    'Run "install" once if anyaudio_music reports that no SoundFont is installed. Custom banks are supported: pass "fromPath" to a local file or "url" to a direct download. Each track in a score names its source and timbre explicitly — the list action gives the exact field to write — and different tracks may use different sources. Drum kits always come from the default bank.',
  parameters: {
    type: 'object',
    properties: {

      action: { type: 'string', enum: ['list', 'install', 'instruments', 'presets', 'use', 'kinds', 'manuals', 'manual', 'manual_set', 'manual_import', 'manual_remove', 'manuals_pending', 'manual_parse', 'orchestrations', 'orchestration', 'orchestration_import', 'orchestration_remove'], description: 'What to do; defaults to "list". "orchestrations" lists orchestration tables (which instrument came from which sound source, learned from real pieces), "orchestration" reads one and summarises it per instrument, "orchestration_import" imports a .csv/.xlsx or a Google Sheets URL, "orchestration_remove" deletes one. "manuals" lists note sheets written about a sound source, "manual" reads one, "manual_set" writes or replaces one, "manual_import" registers a manual by path (it is extracted later, when the source is about to be used; add "parse": true to extract right now), "manuals_pending" lists the registered-but-not-yet-read manuals, "manual_parse" extracts one of those now, "manual_remove" deletes one.' },

      id: { type: 'string', description: 'Recommended source/bank id for install, default "generaluser".' },
      url: { type: 'string', description: 'Direct URL of a custom SoundFont to install.' },
      fromPath: { type: 'string', description: 'Local SoundFont path to install (useful when downloads are blocked).' },
      path: { type: 'string', description: 'Bank path to inspect with "presets" or to make the default with "use".' },
      source: { type: 'string', description: 'The source id from action "list" — a SoundFont bank or a VST3 instrument. Lists that source\'s timbres, each with the exact score field to write.' },
      font: { type: 'string', description: 'Alias of "source" (kept for older calls): an installed id (e.g. "musescore-general"), file name or .sf2 path.' },
      query: { type: 'string', description: 'Filter preset names, e.g. "piano", "koto", "shakuhachi".' },
      limit: { type: 'number', description: 'Max presets to list, default 60.' },
      name: { type: 'string', description: 'With "manual"/"manual_set"/"manual_import"/"manual_remove": which source the notes are about, e.g. "SD-20" or a saved hardware rig name.' },
      path: { type: 'string', description: 'With "manual_import": the manual file, or a folder of them, to register.' },
      parse: { type: 'boolean', description: 'With "manual_import": extract the text now instead of only registering the path.' },
      text: { type: 'string', description: 'With "manual_set": the notes themselves (markdown).' },
      instrument: { type: 'string', description: 'With "orchestration": only rows whose instrument contains this text.' },
      sheet: { type: 'string', description: 'With "orchestration_import": read only this worksheet of an .xlsx.' },
      proxy: { type: 'string', description: 'HTTP proxy for downloading a Google Sheets URL, e.g. "http://127.0.0.1:7881".' },
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
        vst3: { type: 'array', items: { type: 'object', additionalProperties: true } },
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
      if (value.action === 'orchestrations') {
        if (!value.tables?.length) return `No orchestration tables yet. Import one with action "orchestration_import". They are kept in ${value.directory}.`
        return `Orchestration tables (${value.tables.length}):\n` + value.tables.map((row) =>
          `- ${row.name ?? row.id} — ${row.rowCount} row(s), ${row.sections} song(s)${row.source?.path ? ` · ${row.source.path}` : ''}`).join('\n')
      }
      if (value.action === 'orchestration') {
        const lines = [`${value.name} — ${value.rows} row(s), ${value.sections} song(s)`]
        for (const entry of (value.instruments ?? []).slice(0, 12)) {
          lines.push(`- ${entry.instrument} (${entry.count}x, ${entry.sections} song(s))`)
          for (const choice of entry.choices.slice(0, 3)) {
            lines.push(`    ${choice.source} · ${choice.bankPath || '—'} · ${choice.preset || '—'} (${choice.count}x)${choice.notes ? ` — ${choice.notes.slice(0, 60)}` : ''}`)
          }
        }
        if (value.sources?.length) lines.push(`Sources: ${value.sources.slice(0, 6).map((s) => `${s.name} ${s.count}`).join(', ')}`)
        return lines.join('\n')
      }
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
        if (value.kind === 'vst3') {
          return [`Timbres in ${value.source} (${value.timbres.length}):`, ...value.timbres.map((timbre) => `- ${timbre.name}${timbre.category ? ` (${timbre.category})` : ''} → ${timbre.write}`)].join('\n')
        }
        return [`Presets in ${value.font} (${value.presets.length} shown):`, ...value.presets.map((preset) => `- ${preset.name} — program ${preset.program}, bank ${preset.bank}${preset.drums ? ' (drum kit)' : ''} → ${preset.write}`)].join('\n')
      }
      if (value.action === 'kinds') {
        return value.kinds.map((kind) => `- ${kind.id} (${kind.status}) — ${kind.label}: ${kind.description}`).join('\n')
      }
      if (value.action === 'list') {
        const lines = [
          '已接入的全部音源（SF2 与 VST3 混排）。每条轨都要写 source；音色按每条给出的写法写。',
        ]
        for (const font of value.fonts) {
          const tag = font.default ? ' [fallback：默认/兜底音源]' : font.recommended ? ' [recommended]' : ''
          const vendor = font.vendor ? `（${font.vendor}）` : ''
          lines.push(`- [SF2] ${font.id} — ${font.name}${vendor} (${formatBytes(font.bytes)})${tag}`)
          lines.push(`  评分: ${formatScores(font.scores)}`)
          lines.push(`  写法: ${formatWriteHint(font, 'sf2')}`)
          lines.push(`  音色: ${formatTimbres(font, 'sf2')}`)
        }
        for (const entry of value.vst3) {
          if (!existsSync(entry.plugin)) {
            // Listing a plugin that is not on disk teaches a score that silently
            // falls back to a SoundFont (test-compose 2026-11-28). Say so here.
            lines.push(`- [VST3] ${entry.id} — ${entry.name}（未安装，不可用；写了会回退到 SoundFont）`)
            continue
          }
          const vendor = entry.vendor && entry.vendor !== '未知' ? `（${entry.vendor}）` : ''
          const range = entry.range ? `，实测音域 MIDI ${entry.range.low}-${entry.range.high}` : '，音域未实测'
          lines.push(`- [VST3] ${entry.id} — ${entry.name}${vendor}${range}`)
          lines.push(`  评分: ${formatScores(entry.scores)}`)
          lines.push(`  写法: ${formatWriteHint(entry, 'vst3')}`)
          lines.push(`  音色: ${formatTimbres(entry, 'vst3')}`)
        }
        lines.push(`Families（评分用的乐器族名，写谱不用管）: ${Object.keys(CATEGORY_LABELS).join(', ')}`)
        // Two different things answer to "default": the bank the person chose
        // with action "use" (music.font), and the bank used when they chose
        // nothing. Calling both "default" is what made a person believe they
        // had configured one, while the tool kept saying "not set"
        // (improvement plan 04).
        lines.push(
          value.defaultSource
            ? `Configured default source (drum kits): ${value.defaultSource}`
            : `Configured default source (drum kits): not set — renders fall back to ${value.fonts.find((font) => font.default)?.name ?? 'the installed default bank'}`,
        )
        lines.push(`Search directories: ${value.directories.join(' | ')}`)
        if (value.legacy?.length) {
          lines.push('From an older version (project folder, not part of the shared library — re-install with install + fromPath to use them):')
          for (const font of value.legacy) lines.push(`- ${font.path} (${formatBytes(font.bytes)})`)
        }
        lines.push(`Source kinds（音源类型状态；planned 表示尚未支持）: ${value.kinds.map((kind) => `${kind.id}:${kind.status}`).join(', ')}`)
        return lines.join('\n')
      }
      return value.message ?? 'done'
    }),
  },
  async execute(args, exec) {
    const workspaceRoot = await workspaceRootOf(exec)
    const action = args.action ?? 'list'
    if (action === 'orchestrations') {
      return { ok: true, action, tables: listOrchestrations(), directory: orchestrationDir() }
    }
    if (action === 'orchestration') {
      if (!args.name) throw new Error('orchestration needs "name": which table to read (see action "orchestrations")')
      const table = readOrchestration(args.name)
      if (!table) throw new Error(`no orchestration table named "${args.name}". Waiting: ...`)
      const summary = summarizeOrchestration(table, { instrument: args.instrument ?? null })
      return {
        ok: true, action, name: table.name, id: table.id, rows: table.rowCount, sheets: table.sheets ?? null,
        sections: (table.sections ?? []).length, instruments: summary.instruments, sources: summary.sources,
      }
    }
    if (action === 'orchestration_import') {
      if (!args.name) throw new Error('orchestration_import needs "name": what to call this table')
      const root = workspaceRootOf(args)
      const saved = await importOrchestrationSource({
        name: args.name,
        path: args.path ? resolve(root, args.path) : null,
        url: args.url ?? null,
        proxy: args.proxy ?? null,
        sheet: args.sheet ?? null,
      })
      return { ok: true, action, id: saved.id, path: saved.path, rows: saved.rowCount, sections: saved.sections, sheets: saved.sheets }
    }
    if (action === 'orchestration_remove') {
      if (!args.name) throw new Error('orchestration_remove needs "name"')
      return { ok: removeOrchestration(args.name), action, name: args.name }
    }
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
      const wanted = String(args.source ?? args.path ?? args.font ?? '').trim()
      const catalog = await mergedCatalog()
      // A VST3 source id names a plugin; its timbres come from the catalog, not
      // from a SoundFont file. Checking it first keeps the two source kinds on
      // one action instead of making the caller guess which one to call.
      const vst3 = catalog.plugins.find((entry) => entry.id === wanted || entry.name === wanted)
      if (vst3) {
        const timbres = vst3.timbres?.length ? vst3.timbres : await scanPluginTimbres(vst3.plugin)
        return {
          ok: true,
          action,
          source: vst3.id,
          kind: 'vst3',
          timbres: timbres.map((timbre) => ({
            name: timbre.name,
            category: timbre.category,
            type: timbre.type,
            write: `source:"${vst3.id}", preset:"${timbre.name}"`,
          })),
        }
      }
      let fontPath
      try {
        fontPath = await resolveBankArg(wanted, workspaceRoot)
      } catch {
        const available = [
          ...(await listFonts()).map((font) => `[SF2] ${findRecommendedByFile(font.name)?.id ?? font.name}`),
          ...catalog.plugins.map((entry) => `[VST3] ${entry.id}`),
        ]
        throw new Error(`unknown source "${wanted}"; available sources: ${available.join(', ')}`)
      }
      const bank = await loadSoundBank(fontPath)
      const presets = listPresets(bank, { query: args.query, limit: Math.min(200, Math.max(1, Math.round(Number(args.limit) || 60))) })
        .map((preset) => ({ ...preset, write: writeForPreset(preset) }))
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
        message: `Default sound source set to ${fontPath}; it is the bank drum kits come from (persisted as "${config.music.font}" in ${configPath}).`,
      }
    }
    const fonts = await listFonts()
    const { config } = await readConfig()
    const table = new Map(scoreTable(RECOMMENDED_FONTS.map((font) => font)).map((entry) => [entry.id, entry.scores]))
    // 0.1.0 and earlier could install into <project>/.anyaudio/fonts. That folder
    // is no longer scanned (the library is machine-wide now); point at the files
    // so nothing silently disappears, without reading them into the library.
    const legacy = await legacyProjectFonts(workspaceRoot)
    const sf2 = []
    for (const font of fonts) {
      const recommended = findRecommendedByFile(font.name)
      const info = await sf2Info(font.path)
      sf2.push({
        ...font,
        kind: 'sf2',
        relativePath: relativeToWorkspace(workspaceRoot, font.path),
        // A custom bank has no catalog id; its file name is what the score's
        // `source` resolves against, so that is the id the list must show.
        id: recommended?.id ?? sanitizeFontId(font.name),
        vendor: info.vendor,
        recommended: Boolean(recommended),
        default: Boolean(recommended?.default),
        scores: recommended ? table.get(recommended.id) : { default: 3 },
        timbres: info.timbres ? info.timbres.slice(0, TIMBRE_PREVIEW) : [],
        timbreCount: info.timbres?.length ?? 0,
        timbresTruncated: Boolean(info.timbres && info.timbres.length > TIMBRE_PREVIEW),
        timbresReadable: info.timbres !== null,
      })
    }
    // 音色清单以磁盘上的预设为准。配置里有扫描结果就用它；没有就现场扫一遍
    // （只读，不写配置——工具调用不落盘配置，落盘由设置页的扫描负责）。
    const vst3 = []
    for (const entry of (await mergedCatalog()).plugins) {
      const stored = entry.timbres ?? []
      const timbres = (stored.length ? stored : await scanPluginTimbres(entry.plugin)).map((timbre) => ({
        id: timbre.id,
        name: timbre.name,
        category: timbre.category,
        type: timbre.type,
        write: `source:"${entry.id}", preset:"${timbre.name}"`,
      }))
      vst3.push({
        id: entry.id,
        name: entry.name,
        vendor: entry.vendor,
        kind: 'vst3',
        path: entry.plugin,
        scores: entry.families ?? null,
        range: entry.range ?? null,
        articulations: entry.articulations?.length ?? 0,
        notes: entry.notes ?? '',
        timbres: timbres.slice(0, TIMBRE_PREVIEW),
        timbreCount: timbres.length,
        timbresTruncated: timbres.length > TIMBRE_PREVIEW,
      })
    }
    return {
      ok: true,
      action: 'list',
      fonts: sf2,
      vst3,
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

