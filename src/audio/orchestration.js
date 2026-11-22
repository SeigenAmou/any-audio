/**
 * Orchestration tables: which instrument came from which sound source, on which
 * bank and program, for a real piece of music.
 *
 * The users of this plugin write in one style and already own the modules those
 * pieces were made with. A table like that answers the question a score cannot:
 * "for this kind of part, what would they have picked?" It is reference data,
 * not a preset store — nothing here renders.
 */

import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'
import { promisify } from 'node:util'

export const ORCHESTRATION_SCHEMA = 1
const MAX_ROWS = 20000

export function orchestrationDir() {
  const base = process.env.ANYAUDIO_ORCHESTRATIONS
  return base && base.trim() ? base.trim() : join(homedir(), '.dsh', 'anyaudio', 'orchestrations')
}

export function orchestrationSlug(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[\s/\\:*?"<>|]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
}

function ensureDir(dir = orchestrationDir()) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

function cell(row, index) {
  const value = row[index]
  return value === undefined || value === null ? '' : String(value).trim()
}

/** `062 000 Brass FF` → { program: 62, bank: 0, name: 'Brass FF' } */
export function parsePresetCell(text) {
  const value = String(text || '').trim()
  // Three shapes appear in real tables: "001 000 St.Piano 1" (program, bank,
  // name), "001 St.Concert" (program and name, bank implied) and a bare name.
  const full = /^(\d{1,3})\s+(\d{1,3})\s+(.*)$/.exec(value)
  if (full) return { program: Number(full[1]), bank: Number(full[2]), name: full[3].trim() }
  const short = /^(\d{1,3})\s+(.+)$/.exec(value)
  if (short) return { program: Number(short[1]), bank: null, name: short[2].trim() }
  return { program: null, bank: null, name: value }
}

/**
 * The sheet is written for people: a song title row, an optional `BPM:` row,
 * then one row per instrument. Everything else is commentary and is kept as-is
 * so a reader can see the author's own notes.
 */
export function parseOrchestrationCsv(text, { name = '', sheet = null } = {}) {
  const lines = String(text || '').split(/\r?\n/)
  const rows = []
  for (const line of lines) {
    if (!line.trim()) continue
    rows.push(splitCsvLine(line))
    if (rows.length >= MAX_ROWS) break
  }

  const sections = []
  let current = null
  let pendingTitle = ''
  for (const row of rows) {
    const first = cell(row, 0)
    if (!first) continue
    const source = cell(row, 1)
    const bankPath = cell(row, 2)
    const presetText = cell(row, 3)
    const notes = cell(row, 4)
    // A real instrument row is the only kind that fills the bank or preset
    // column. A title row often has a second cell (its translation) but never
    // a bank.
    // The header row fills the bank column with the word "Path/Bank", so it
    // looks exactly like an instrument row; skip it by name before anything else.
    if (/^instrument$/i.test(first) && /^source$/i.test(source)) continue
    const isInstrument = Boolean(bankPath || presetText || notes) && Boolean(source)
    if (!isInstrument) {
      if (/^BPM\b/i.test(first)) {
        if (current) current.meta.push(first)
        continue
      }
      const looksLikeHeading = !/^(Table of Contents|JUMP TO:|\(links\)|Findings done|TOUHOU \+)/i.test(first)
      if (looksLikeHeading) {
        pendingTitle = source ? `${first} — ${source}` : first
        current = null
      }
      continue
    }
    if (!current) current = startSection(sections, pendingTitle || name || 'untitled')
    const preset = parsePresetCell(presetText)
    current.rows.push({
      instrument: first,
      source,
      bankPath,
      presetText,
      program: preset.program,
      bank: preset.bank,
      preset: preset.name,
      notes,
      demo: cell(row, 5),
    })
  }
  const kept = sections.filter((section) => section.rows.length > 0)
  for (const section of kept) section.sheet = sheet
  return {
    schema: ORCHESTRATION_SCHEMA,
    name: name || null,
    sections: kept,
    rowCount: kept.reduce((sum, section) => sum + section.rows.length, 0),
  }
}

function startSection(sections, title) {
  const section = { title, meta: [], rows: [] }
  sections.push(section)
  return section
}

/** Tiny RFC-4180 reader: quotes, doubled quotes, embedded commas. */
function splitCsvLine(line) {
  const out = []
  let value = ''
  let quoted = false
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (quoted) {
      if (char === '"') {
        if (line[index + 1] === '"') { value += '"'; index += 1 } else quoted = false
      } else value += char
    } else if (char === '"') quoted = true
    else if (char === ',') { out.push(value); value = '' }
    else value += char
  }
  out.push(value)
  return out
}

export function saveOrchestration(name, table, { source = null } = {}) {
  const slug = orchestrationSlug(name)
  if (!slug) throw new Error('an orchestration needs a name')
  ensureDir()
  const payload = {
    ...table,
    id: slug,
    name: table.name || name,
    source: source ?? table.source ?? null,
    savedAt: new Date().toISOString(),
  }
  const target = join(orchestrationDir(), `${slug}.json`)
  writeFileSync(target, JSON.stringify(payload, null, 1), 'utf8')
  return { id: slug, path: target, rowCount: payload.rowCount ?? 0, sections: payload.sections?.length ?? 0 }
}

export function listOrchestrations() {
  const dir = orchestrationDir()
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .map((file) => {
      const path = join(dir, file)
      try {
        const data = JSON.parse(readFileSync(path, 'utf8'))
        return {
          id: data.id ?? basename(file, '.json'),
          name: data.name ?? null,
          rowCount: data.rowCount ?? 0,
          sections: data.sections?.length ?? 0,
          savedAt: data.savedAt ?? null,
          source: data.source ?? null,
        }
      } catch {
        return { id: basename(file, '.json'), name: null, error: 'unreadable' }
      }
    })
}

export function readOrchestration(name) {
  const slug = orchestrationSlug(name)
  const path = join(orchestrationDir(), `${slug}.json`)
  if (!existsSync(path)) return null
  return JSON.parse(readFileSync(path, 'utf8'))
}

export function removeOrchestration(name) {
  const slug = orchestrationSlug(name)
  const path = join(orchestrationDir(), `${slug}.json`)
  if (!existsSync(path)) return false
  unlinkSync(path)
  return true
}

/**
 * What the table says about one instrument: every source/preset it was played
 * with, most frequent first. `track` matches loosely on the instrument name.
 */
export function summarizeOrchestration(table, { instrument = null, source = null } = {}) {
  const wantInstrument = instrument ? String(instrument).toLowerCase() : null
  const wantSource = source ? String(source).toLowerCase() : null
  const byInstrument = new Map()
  const bySource = new Map()
  for (const section of table.sections ?? []) {
    for (const row of section.rows) {
      if (wantInstrument && !row.instrument.toLowerCase().includes(wantInstrument)) continue
      if (wantSource && !row.source.toLowerCase().includes(wantSource)) continue
      const key = row.instrument
      if (!byInstrument.has(key)) byInstrument.set(key, { instrument: key, count: 0, choices: new Map(), sections: new Set() })
      const entry = byInstrument.get(key)
      entry.count += 1
      entry.sections.add(section.title)
      const choiceKey = `${row.source} :: ${row.bankPath} :: ${row.presetText}`
      if (!entry.choices.has(choiceKey)) {
        entry.choices.set(choiceKey, {
          source: row.source, bankPath: row.bankPath, preset: row.preset,
          program: row.program, bank: row.bank, count: 0, notes: row.notes || null,
        })
      }
      entry.choices.get(choiceKey).count += 1
      bySource.set(row.source, (bySource.get(row.source) ?? 0) + 1)
    }
  }
  const instruments = [...byInstrument.values()]
    .map((entry) => ({
      instrument: entry.instrument,
      count: entry.count,
      sections: entry.sections.size,
      choices: [...entry.choices.values()].sort((a, b) => b.count - a.count).slice(0, 8),
    }))
    .sort((a, b) => b.count - a.count)
  return {
    instruments,
    sources: [...bySource.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })),
  }
}

/** `https://docs.google.com/spreadsheets/d/<id>/edit#gid=0` → the CSV export URL. */
export function sheetExportUrl(url) {
  const text = String(url || '').trim()
  const match = /docs\.google\.com\/spreadsheets\/d\/([A-Za-z0-9_-]+)/.exec(text)
  if (!match) return null
  const gid = /[#&?]gid=(\d+)/.exec(text)?.[1] ?? '0'
  return `https://docs.google.com/spreadsheets/d/${match[1]}/export?format=csv&gid=${gid}`
}

/** Runs the python extractor so .xlsx needs no node dependency. */
export function sheetExtractorPath() {
  const override = process.env.ANYAUDIO_SHEET_EXTRACTOR
  if (override && override.trim()) return override.trim()
  const here = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
  return join(here, '..', '..', 'engine', 'sheet_extract.py')
}

export function sheetPython() {
  const override = process.env.ANYAUDIO_PYTHON
  return override && override.trim() ? override.trim() : 'python'
}

/**
 * Merge several sheets of one workbook into a single table. Each sheet keeps its
 * own title, so a reader still knows which era or album a row came from.
 */
export function mergeOrchestrationSheets(sheets, { name = '' } = {}) {
  const sections = []
  let rowCount = 0
  for (const [sheetName, text] of Object.entries(sheets)) {
    const parsed = parseOrchestrationCsv(text, { name: sheetName, sheet: sheetName })
    for (const section of parsed.sections) sections.push(section)
    rowCount += parsed.rowCount
  }
  return {
    schema: ORCHESTRATION_SCHEMA,
    name: name || null,
    sheets: Object.keys(sheets),
    sections,
    rowCount,
  }
}

const run = promisify(execFile)

function stripFileUrl(value) {
  const text = String(value)
  return text.startsWith('file://') ? decodeURIComponent(text.slice(7)).replace(/^\//, '') : text
}

/**
 * Read one table out of wherever it lives: a Google Sheets link, a spreadsheet
 * file, or a plain CSV. The workbook case keeps every sheet, because a real
 * workbook spreads the eras across a dozen tabs.
 */
export async function importOrchestrationSource({ name, path = null, url = null, proxy = null, sheet = null } = {}) {
  if (!name) throw new Error('importOrchestrationSource needs "name"')
  const sheets = {}
  let source = null
  if (url) {
    const exportUrl = sheetExportUrl(url)
    if (!exportUrl) throw new Error('that does not look like a Google Sheets link (need docs.google.com/spreadsheets/d/<id>)')
    const dir = mkdtempSync(join(tmpdir(), 'anyaudio-orch-'))
    try {
      const out = join(dir, 'sheet.csv')
      const args = ['-sL', '-o', out]
      if (proxy) args.push('--proxy', proxy)
      args.push(exportUrl)
      await run('curl', args, { windowsHide: true, timeout: 120000 })
      sheets.sheet = readFileSync(out, 'utf8')
      source = { kind: 'url', url }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  } else if (path) {
    const target = stripFileUrl(path)
    if (!existsSync(target)) throw new Error(`no file at ${target}`)
    const ext = (target.split('.').pop() ?? '').toLowerCase()
    if (ext === 'xlsx' || ext === 'xlsm') {
      const dir = mkdtempSync(join(tmpdir(), 'anyaudio-orch-'))
      try {
        const args = ['-X', 'utf8', sheetExtractorPath(), '--path', target, '--out-dir', dir]
        if (sheet) args.push('--sheet', sheet)
        await run(sheetPython(), args, { windowsHide: true, timeout: 180000 })
        for (const file of readdirSync(dir)) {
          if (!file.endsWith('.csv')) continue
          sheets[file.replace(/\.csv$/, '')] = readFileSync(join(dir, file), 'utf8')
        }
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
      if (!Object.keys(sheets).length) throw new Error(`the workbook at ${target} produced no sheets`)
    } else {
      sheets[sheet ?? 'sheet'] = readFileSync(target, 'utf8')
    }
    source = { kind: 'file', path: target }
  } else {
    throw new Error('importOrchestrationSource needs "path" or "url"')
  }
  const table = mergeOrchestrationSheets(sheets, { name })
  const saved = saveOrchestration(name, table, { source })
  return { ...saved, sheets: Object.keys(sheets) }
}
