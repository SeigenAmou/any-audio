// Notes a person writes about a sound source, so the next agent composing for it
// does not have to guess.
//
// The problem this solves: a hardware module or a plugin patch has no schema. An
// agent asked for "a warm pad on the SD-20" can pick a program number, but only
// the owner knows that program 0 on PART B is the Rhodes and that the module
// ignores CC64. A manual is that knowledge, stored next to the rig it describes.
//
// One file per source, markdown, in the same shared folder as everything else
// this plugin keeps for the machine (not per project: the SD-20 is the same
// module in every project).

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/** Vendors ship .txt, .md, .pdf, .docx and folders of one-page HTML; this reads them. */
export function manualExtractorPath() {
  const configured = process.env.ANYAUDIO_DOC_EXTRACTOR
  if (configured && configured.trim()) return configured.trim()
  return join(here, '..', '..', 'engine', 'doc_extract.py')
}

export function manualPython() {
  const configured = process.env.ANYAUDIO_PYTHON
  return configured && configured.trim() ? configured.trim() : 'python'
}

/** A manual is prose, not a sample library; anything past this is a mistake. */
export const MAX_MANUAL_BYTES = 256 * 1024

/** How much text the extractor may hand back for one source. A manual is kept
 *  in a note sheet of at most 256 KB and CJK costs three bytes a character, so
 *  a very large vendor folder is read up to this many characters and the
 *  extractor reports what it had to leave for later. */
export const MANUAL_EXTRACT_CHARS = 200000

/** A note sheet is capped at 256 KB. A manual that reads past that is not cut
 *  at an arbitrary character: the limit is applied on a paragraph boundary and
 *  the card says what did not fit, so the reader knows the rest is in the
 *  source file rather than believing the manual ends there. */
export function fitManualText(text) {
  const limit = 250000
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes <= limit) return text
  let cut = Math.floor(text.length * 0.6)
  while (cut > 1000 && Buffer.byteLength(text.slice(0, cut), 'utf8') > limit) cut = Math.floor(cut * 0.9)
  const head = text.slice(0, cut)
  const at = head.lastIndexOf('\n\n')
  const body = at > 0 ? head.slice(0, at) : head
  return `${body}\n\n[cut here: this note is longer than a note sheet can hold. The full text is still in the source file the manual was imported from.]\n`
}

export function manualsDir() {
  return process.env.ANYAUDIO_MANUALS || join(homedir(), '.dsh', 'anyaudio', 'manuals')
}

/**
 * The file name for a source name. "SD-20 / PART A" and "sd-20 part a" must land
 * on the same file, so the slug is what everything else keys on.
 */
export function manualSlug(name) {
  const slug = String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s/\\:*?"<>|]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!slug) throw new Error('a manual needs a name to hang on, e.g. "SD-20"')
  return slug
}

function entryPath(name) {
  return join(manualsDir(), `${manualSlug(name)}.md`)
}

export function listManuals() {
  const dir = manualsDir()
  if (!existsSync(dir)) return []
  const rows = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue
    const path = join(dir, entry.name)
    let bytes = 0
    let updated = ''
    try {
      const info = statSync(path)
      bytes = info.size
      updated = info.mtime.toISOString()
    } catch {
      continue
    }
    rows.push({ name: entry.name.replace(/\.md$/i, ''), path, bytes, updated })
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Manuals that were pointed at but not read yet.
 *
 * A vendor PDF is often hundreds of pages; extracting it the moment it is named
 * spends minutes on text nobody asked for, and truncation throws away the part
 * that mattered. So a source is registered by path first (this list), and the
 * text is extracted only when an agent is about to use that source. The skill
 * tells the agent to check this list before composing.
 */
export function pendingPath() {
  return join(manualsDir(), 'pending.json')
}

export function listPending() {
  const path = pendingPath()
  if (!existsSync(path)) return []
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter(row => row && typeof row.name === 'string' && typeof row.path === 'string')
      .map(row => ({ name: row.name, path: row.path, addedAt: row.addedAt || '', note: row.note || '' }))
  } catch {
    return []
  }
}

function writePending(rows) {
  const dir = manualsDir()
  mkdirSync(dir, { recursive: true })
  writeFileSync(pendingPath(), JSON.stringify(rows, null, 2), 'utf8')
}

export function addPending({ name, path, note = '' }) {
  const slug = manualSlug(name)
  const target = String(path ?? '').trim()
  if (!target) throw new Error('a pending manual needs a file or folder path')
  if (!existsSync(target)) throw new Error(`nothing at ${target}`)
  const rows = listPending().filter(row => row.name !== slug)
  rows.push({ name: slug, path: target, addedAt: new Date().toISOString(), note: String(note ?? '') })
  writePending(rows)
  return { name: slug, path: target, pending: true }
}

export function removePending(name) {
  const slug = manualSlug(name)
  const rows = listPending()
  const next = rows.filter(row => row.name !== slug)
  if (next.length !== rows.length) writePending(next)
  return { name: slug, removed: next.length !== rows.length }
}

/** The path registered for a source, or null. */
export function pendingFor(name) {
  const slug = manualSlug(name)
  return listPending().find(row => row.name === slug) || null
}

/** Returns null when nothing was written for that source. */
export function readManual(name) {
  const path = entryPath(name)
  if (!existsSync(path)) return null
  return { name: manualSlug(name), path, text: readFileSync(path, 'utf8') }
}

export function saveManual(name, text) {
  const slug = manualSlug(name)
  const body = String(text ?? '')
  const bytes = Buffer.byteLength(body, 'utf8')
  if (!body.trim()) throw new Error(`a manual for "${slug}" needs some text`)
  if (bytes > MAX_MANUAL_BYTES) {
    throw new Error(`a manual is limited to ${Math.round(MAX_MANUAL_BYTES / 1024)} KB; this one is ${Math.round(bytes / 1024)} KB`)
  }
  const dir = manualsDir()
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${slug}.md`)
  writeFileSync(path, body, 'utf8')
  return { name: slug, path, bytes }
}

export function removeManual(name) {
  const slug = manualSlug(name)
  const path = join(manualsDir(), `${slug}.md`)
  if (!existsSync(path)) return { name: slug, path, removed: false }
  rmSync(path)
  return { name: slug, path, removed: true }
}

/**
 * Read a manual that came as a file or a folder of files and return its text.
 *
 * This only extracts; it does not summarise. A thousand-page PDF and a folder of
 * forty HTML pages both come back as one markdown-ish document with a heading per
 * file, and the agent reading it is the one that decides what matters.
 */
export function extractManualText(sourcePath, { maxChars = 180000, timeoutMs = 180000 } = {}) {
  const target = String(sourcePath ?? '').trim()
  if (!target) return Promise.reject(new Error('manual_import needs a path to a file or a folder'))
  const outPath = join(tmpdir(), `anyaudio-manual-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`)
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        if (existsSync(outPath)) rmSync(outPath)
      } catch {
        /* a leftover temp file is not worth failing the import */
      }
      if (error) reject(error)
      else resolve(value)
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* already gone */
      }
      finish(new Error(`reading that manual took longer than ${Math.round(timeoutMs / 1000)}s`))
    }, timeoutMs)
    let child
    try {
      child = spawn(manualPython(), ['-X', 'utf8', manualExtractorPath(), '--path', target, '--out', outPath, '--max-chars', String(maxChars)], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      finish(new Error(`could not start ${manualPython()}: ${error.message}`))
      return
    }
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', (error) => finish(new Error(`could not start ${manualPython()}: ${error.message}`)))
    child.on('close', () => {
      let parsed = null
      try {
        parsed = JSON.parse(stdout.trim())
      } catch {
        finish(new Error(`the extractor said nothing usable${stderr ? `: ${stderr.trim().slice(0, 300)}` : ''}`))
        return
      }
      if (!parsed?.ok) {
        finish(new Error(parsed?.error ?? 'nothing readable was found'))
        return
      }
      let text = ''
      try {
        text = readFileSync(outPath, 'utf8')
      } catch (error) {
        finish(new Error(`the extractor wrote nothing: ${error.message}`))
        return
      }
      finish(null, { text, files: parsed.files, read: parsed.read, chars: parsed.chars, truncated: parsed.truncated, warnings: parsed.warnings ?? [] })
    })
  })
}

