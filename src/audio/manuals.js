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
import { homedir } from 'node:os'
import { join } from 'node:path'

/** A manual is prose, not a sample library; anything past this is a mistake. */
export const MAX_MANUAL_BYTES = 256 * 1024

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
