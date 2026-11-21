// Bridge to a real VST3 plugin, through pedalboard running in a Python child.
//
// Why a child process and not an in-process binding: several plugins (Steinberg's
// Padshop is the measured case) block forever inside the loader waiting for a
// GUI/licence handshake. In a child that costs one timeout; in-process it would
// hang the whole DSH host with no way back. Every call therefore runs against a
// hard deadline and the process tree is killed when it expires.
//
// Why pedalboard: it is the only maintained offline host that can load a Windows
// VST3, feed it MIDI and render without a desktop. It cannot load VST2 — those
// are scanned and listed (so the person can see what is on the machine) but a
// render of one says so instead of pretending.

import { spawn, spawnSync } from 'node:child_process'
import { closeSync, existsSync, openSync, readFileSync, readdirSync, readSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const DEFAULT_WORKER = resolve(here, '..', '..', 'engine', 'vst_worker.py')

// Redirect stubs (3–6 KB files that only point at the real one) are skipped by
// size; the Virtual Guitarist trees are a user project in progress and are left
// alone even though they look like ordinary plugins.
const MIN_PLUGIN_BYTES = 16384
const PROTECTED = ['virtual guitarist']
const MAX_DEPTH = 3

// A VST2 plugin is an ordinary PE DLL that exports VSTPluginMain (or the old
// plain `main`). Only 64-bit ones are offered: a 32-bit DLL cannot be loaded by
// the 64-bit host at all, and the honest answer is to list it as "needs a
// bridge" rather than to hide it.
const PE32_PLUS = 0x20b
const MACHINE_X64 = 0x8664
const MACHINE_X86 = 0x14c
const VST2_ENTRY_POINTS = ['VSTPluginMain', 'main']

const LOAD_TIMEOUT_MS = 60000
const RENDER_TIMEOUT_MS = 120000

export class VstHostError extends Error {
  constructor(message, { code = 'VST_ERROR', kind = 'render' } = {}) {
    super(message)
    this.name = 'VstHostError'
    this.code = code
    this.kind = kind
  }
}

export function vstPython() {
  const configured = process.env.ANYAUDIO_VST_PYTHON
  return configured && configured.trim() ? resolve(configured.trim()) : 'python'
}

export function vstWorkerPath() {
  const configured = process.env.ANYAUDIO_VST_WORKER
  return configured && configured.trim() ? resolve(configured.trim()) : DEFAULT_WORKER
}

function programFiles() {
  return process.env.ProgramFiles || 'C:\\Program Files'
}

function commonProgramFiles() {
  return process.env.CommonProgramFiles || join(programFiles(), 'Common Files')
}

/** Where VST3 plugins live on this machine. `ANYAUDIO_VST_DIRS` (semicolon
 *  separated) comes first so a machine can point at a custom folder. */
export function vstSearchDirs(configured = []) {
  const fromConfig = (Array.isArray(configured) ? configured : [])
    .filter((entry) => typeof entry === 'string' && entry.trim())
    .map((entry) => resolve(entry.trim()))
  const extra = (process.env.ANYAUDIO_VST_DIRS || '')
    .split(';')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => resolve(entry))
  const standard = [
    join(commonProgramFiles(), 'VST3'),
    join(programFiles(), 'Roland Cloud'),
    join(programFiles(), 'Roland'),
    // VST2 folders, so a 64-bit DLL in the usual place is found without the
    // person having to add it by hand.
    join(commonProgramFiles(), 'VST2'),
    join(programFiles(), 'VSTPlugins'),
    join(programFiles(), 'Steinberg', 'VSTPlugins'),
  ]
  const seen = new Set()
  const dirs = []
  // Configured folders come first: a person who typed a path is looking for a
  // plugin the standard folders do not have, and the order is the answer to
  // "which copy did it load".
  for (const dir of [...fromConfig, ...extra, ...standard]) {
    const key = dir.toLowerCase()
    if (seen.has(key) || !existsSync(dir)) continue
    seen.add(key)
    dirs.push(dir)
  }
  return dirs
}

/** Walk the search dirs for .vst3 entries (file or bundle), skipping redirect
 *  stubs and the protected trees. Synchronous on purpose: the listing is small
 *  and the tool wants a plain array. */
export function scanVstPlugins(configured = []) {
  return scanVstLibrary(configured).plugins
}

/**
 * Everything the scan found, grouped the way the settings page shows it: the
 * plugins themselves, plus the 32-bit DLLs that are plugins but cannot be
 * loaded by a 64-bit host (they need a bridge, so they are named rather than
 * hidden).
 */
export function scanVstLibrary(configured = []) {
  const dirs = vstSearchDirs(configured)
  const found = []
  const legacy = []
  const seen = new Set()
  for (const root of dirs) {
    walk(root, 0, (path, bytes, format, meta) => {
      const key = path.toLowerCase()
      if (seen.has(key)) return
      if (PROTECTED.some((word) => key.includes(word))) return
      if (bytes !== null && bytes < MIN_PLUGIN_BYTES) return
      seen.add(key)
      found.push({
        path,
        bytes,
        name: baseName(path),
        format,
        vendor: meta?.vendor ?? '',
        category: meta?.category ?? '',
      })
    }, (path) => {
      const key = path.toLowerCase()
      if (seen.has(key)) return
      if (PROTECTED.some((word) => key.includes(word))) return
      seen.add(key)
      legacy.push({ path, name: baseName(path) })
    })
  }
  return {
    dirs,
    plugins: found.sort((a, b) => a.path.localeCompare(b.path)),
    legacy32: legacy.sort((a, b) => a.path.localeCompare(b.path)),
  }
}

/**
 * Ask each plugin what it is. Loading a plugin is the only way to learn its
 * vendor and whether it is an instrument — a folder scan cannot answer that —
 * so this runs one plugin per worker call, with a short deadline: a plugin that
 * opens a licence window hangs exactly the way it does at render time, and must
 * cost one skipped row, not the whole list.
 */
export async function probeVstPlugins(paths, { timeoutMs = 20000 } = {}) {
  const rows = []
  for (const path of paths) {
    try {
      const [reply] = await runVstWorker([{ op: 'probe', plugin: path }], { timeoutMs })
      rows.push({
        path,
        ok: Boolean(reply?.ok),
        name: reply?.name ?? '',
        vendor: reply?.vendor ?? '',
        instrument: Boolean(reply?.instrument),
        category: reply?.category ?? '',
        error: reply?.ok ? '' : String(reply?.error ?? 'no reply'),
      })
    } catch (error) {
      rows.push({ path, ok: false, name: '', vendor: '', instrument: false, category: '', error: error.message })
    }
  }
  return rows
}

function readAt(fd, length, position) {
  if (length <= 0) return Buffer.alloc(0)
  const buffer = Buffer.alloc(length)
  const got = readSync(fd, buffer, 0, length, position)
  return got === length ? buffer : null
}

function readAscii(fd, position, maxLength = 256) {
  const buffer = readAt(fd, maxLength, position)
  if (!buffer) return ''
  const end = buffer.indexOf(0)
  return (end < 0 ? buffer : buffer.subarray(0, end)).toString('latin1')
}

/**
 * Read only the PE headers: is this a DLL, which machine is it built for, and
 * does the export table carry a VST2 entry point? All header reads, so scanning
 * a folder never loads (or runs) a plugin.
 */
export function peInfo(path) {
  let fd = null
  try {
    fd = openSync(path, 'r')
    const head = readAt(fd, 0x400, 0)
    if (!head || head[0] !== 0x4d || head[1] !== 0x5a) return null // "MZ"
    const peOffset = head.readUInt32LE(0x3c)
    if (peOffset + 24 > head.length) return null
    if (head.readUInt32LE(peOffset) !== 0x00004550) return null // "PE\0\0"
    const machine = head.readUInt16LE(peOffset + 4)
    const sectionCount = head.readUInt16LE(peOffset + 6)
    const optionalSize = head.readUInt16LE(peOffset + 20)
    const characteristics = head.readUInt16LE(peOffset + 22)
    // Reported, not enforced here: an .exe and an .dll parse the same way, and
    // the caller decides whether a DLL is what it wanted.
    const isDll = (characteristics & 0x2000) !== 0
    const optionalOffset = peOffset + 24
    const magic = head.readUInt16LE(optionalOffset)
    if (magic !== 0x10b && magic !== PE32_PLUS) return null
    const directoryOffset = optionalOffset + (magic === PE32_PLUS ? 112 : 96)
    const sectionOffset = optionalOffset + optionalSize
    if (directoryOffset + 8 > head.length || sectionOffset + sectionCount * 40 > head.length) return null
    const exportRva = head.readUInt32LE(directoryOffset)
    const sections = []
    for (let index = 0; index < sectionCount; index += 1) {
      const at = sectionOffset + index * 40
      const virtualSize = head.readUInt32LE(at + 8)
      const virtualAddress = head.readUInt32LE(at + 12)
      const rawSize = head.readUInt32LE(at + 16)
      const rawPointer = head.readUInt32LE(at + 20)
      sections.push({ virtualAddress, virtualSize: Math.max(virtualSize, rawSize), rawPointer })
    }
    const toFile = (rva) => {
      for (const section of sections) {
        if (rva >= section.virtualAddress && rva < section.virtualAddress + section.virtualSize) {
          return rva - section.virtualAddress + section.rawPointer
        }
      }
      return -1
    }
    let exports = []
    if (exportRva) {
      const tableOffset = toFile(exportRva)
      if (tableOffset >= 0) {
        const table = readAt(fd, 40, tableOffset)
        if (table) {
          const nameCount = table.readUInt32LE(24)
          const namesRva = table.readUInt32LE(32)
          const namesOffset = toFile(namesRva)
          if (namesOffset >= 0 && nameCount > 0) {
            const addressCount = Math.min(nameCount, 64)
            const addresses = readAt(fd, addressCount * 4, namesOffset)
            if (addresses) {
              for (let index = 0; index < addressCount; index += 1) {
                const nameOffset = toFile(addresses.readUInt32LE(index * 4))
                if (nameOffset < 0) continue
                const name = readAscii(fd, nameOffset, 128)
                if (name) exports.push(name)
              }
            }
          }
        }
      }
    }
    return { machine, isDll, exports }
  } catch {
    return null
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        /* already closed */
      }
    }
  }
}

/** A 64-bit DLL exporting VSTPluginMain (or the legacy `main`). */
export function vst2Kind(path) {
  const info = peInfo(path)
  if (!info) return null
  if (!info.isDll) return null
  if (!info.exports.some((name) => VST2_ENTRY_POINTS.includes(name))) return null
  if (info.machine === MACHINE_X64) return 'vst2'
  if (info.machine === MACHINE_X86) return 'vst2-32'
  return null
}

/** What a VST3 bundle says about itself, when it ships a moduleinfo.json. */
function vst3Meta(path, isBundle) {
  if (!isBundle) return null
  try {
    const raw = readFileSync(join(path, 'Contents', 'moduleinfo.json'), 'utf8')
    const info = JSON.parse(raw)
    const vendor = typeof info?.factory?.vendor === 'string' ? info.factory.vendor : ''
    const classes = Array.isArray(info?.classes) ? info.classes : []
    const category = classes.find((entry) => typeof entry?.category === 'string')?.category ?? ''
    const name = classes.find((entry) => typeof entry?.name === 'string')?.name ?? (typeof info?.name === 'string' ? info.name : '')
    return { vendor, category, name }
  } catch {
    return null
  }
}


function walk(dir, depth, visit, onLegacy) {
  if (depth > MAX_DEPTH) return
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    const lowered = entry.name.toLowerCase()
    if (entry.isDirectory()) {
      // A .vst3 directory is a bundle: record it, do not walk into it.
      if (lowered.endsWith('.vst3')) {
        visit(path, null, 'vst3', vst3Meta(path, true))
        continue
      }
      walk(path, depth + 1, visit, onLegacy)
      continue
    }
    if (lowered.endsWith('.vst3')) {
      let bytes = null
      try {
        bytes = statSync(path).size
      } catch {
        continue
      }
      visit(path, bytes, 'vst3', null)
      continue
    }
    if (lowered.endsWith('.dll')) {
      const kind = vst2Kind(path)
      if (!kind) continue
      let bytes = null
      try {
        bytes = statSync(path).size
      } catch {
        continue
      }
      if (bytes < MIN_PLUGIN_BYTES) continue
      if (kind === 'vst2-32') {
        onLegacy?.(path)
        continue
      }
      visit(path, bytes, 'vst2', null)
    }
  }
}

function baseName(path) {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1]
}

function killTree(child) {
  if (!child || child.exitCode !== null) return
  try {
    if (process.platform === 'win32' && child.pid) {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    } else {
      child.kill('SIGKILL')
    }
  } catch {
    // A plugin that wedged the process may resist everything; nothing else to do.
  }
}

/**
 * Send every request to one worker process, then read one JSON reply per line.
 * The child is started fresh each call: plugin state (and any wedged licence
 * dialog) must never leak between renders.
 */
export function runVstWorker(requests, { timeoutMs = LOAD_TIMEOUT_MS, python = vstPython(), worker = vstWorkerPath() } = {}) {
  if (!existsSync(worker)) {
    return Promise.reject(new VstHostError(`VST worker script not found: ${worker}`, { code: 'WORKER_MISSING' }))
  }
  return new Promise((resolvePromise, reject) => {
    let child
    try {
      child = spawn(python, ['-X', 'utf8', worker], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true })
    } catch (error) {
      reject(new VstHostError(`could not start ${python}: ${error.message}`, { code: 'SPAWN_FAILED' }))
      return
    }
    let stdout = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      killTree(child)
      reject(new VstHostError(
        `the plugin did not finish within ${Math.round(timeoutMs / 1000)}s. A plugin that hangs while loading is usually waiting for a licence window, which an offline host cannot give it.`,
        { code: 'TIMEOUT', kind: 'load' },
      ))
    }, timeoutMs)

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new VstHostError(`worker error: ${error.message}`, { code: 'SPAWN_FAILED' }))
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const lines = stdout.split(/\r?\n/).filter((line) => line.trim().startsWith('{'))
      if (lines.length === 0) {
        reject(new VstHostError(`the worker exited with code ${code} and no reply. If it says nothing at all, the plugin crashed the process.`, { code: 'NO_REPLY' }))
        return
      }
      try {
        resolvePromise(lines.map((line) => JSON.parse(line)))
      } catch (error) {
        reject(new VstHostError(`could not parse the worker reply: ${error.message}`, { code: 'BAD_REPLY' }))
      }
    })

    child.stdin.on('error', () => {}) // the child may die before we finish writing
    child.stdin.write(requests.map((request) => JSON.stringify(request)).join('\n') + '\n', 'utf8')
    child.stdin.end()
  })
}

/** Is pedalboard installed for the python we would launch? */
export async function vstStatus() {
  try {
    const [reply] = await runVstWorker([{ op: 'ping' }], { timeoutMs: 30000 })
    if (!reply?.ok) return { available: false, python: vstPython(), error: reply?.error ?? 'unknown' }
    return { available: true, python: vstPython(), version: reply.python, pedalboard: reply.pedalboard }
  } catch (error) {
    return { available: false, python: vstPython(), error: error.message }
  }
}

/** Load one plugin and describe it. Never leaves a process behind. */
export async function describeVst(plugin, options = {}) {
  const [reply] = await runVstWorker([{ op: 'info', plugin }], { timeoutMs: options.timeoutMs ?? LOAD_TIMEOUT_MS })
  if (!reply?.ok) {
    throw new VstHostError(reply?.error ?? 'the plugin could not be described', {
      code: reply?.kind === 'load' ? 'LOAD_FAILED' : 'VST_ERROR',
      kind: reply?.kind ?? 'load',
    })
  }
  return { path: plugin, instrument: Boolean(reply.instrument), parameters: reply.parameters ?? [] }
}

/** Render several parts through one worker process. The worker keeps one loaded
 *  plugin per path, so three parts of the same synth pay its load cost once
 *  instead of three times. A reply that is not ok belongs to its own index; a
 *  failure of the process itself rejects the whole call, leaving the caller to
 *  decide which parts that takes down. */
export async function renderVstBatch(requests, { timeoutMs } = {}) {
  if (!Array.isArray(requests) || requests.length === 0) return []
  const batch = requests.map((request) => ({
    op: 'render',
    plugin: request.plugin,
    notes: request.notes,
    durationSec: Number.isFinite(Number(request.durationSec)) ? Number(request.durationSec) : undefined,
    sampleRate: request.sampleRate,
    params: request.params && typeof request.params === 'object' ? request.params : undefined,
    controls: Array.isArray(request.controls) ? request.controls : undefined,
    out: request.out,
  }))
  // The budget grows with the number of parts but stops at ten minutes: a batch
  // is still one deadline, and a wedged loader must not sit there forever.
  const budget = timeoutMs ?? Math.min(RENDER_TIMEOUT_MS * requests.length, 600000)
  return runVstWorker(batch, { timeoutMs: budget })
}

/** Render notes through one plugin and write a WAV. `notes` is
 *  [[startSec, durationSec, midi, velocity], …] — the same shape as a score. */
export async function renderVst({ plugin, notes, controls, params, durationSec, sampleRate = 48000, out, timeoutMs }) {
  if (!Array.isArray(notes) || notes.length === 0) {
    throw new VstHostError('notes must be a non-empty array of [startSec, durationSec, midi, velocity]', { code: 'BAD_NOTES', kind: 'param' })
  }
  if (!out) throw new VstHostError('out must be a WAV path', { code: 'BAD_OUTPUT', kind: 'param' })
  const request = {
    op: 'render',
    plugin,
    notes,
    durationSec: Number.isFinite(Number(durationSec)) ? Number(durationSec) : undefined,
    sampleRate,
    params: params && typeof params === 'object' ? params : undefined,
    controls: Array.isArray(controls) ? controls : undefined,
    out,
  }
  const [reply] = await runVstWorker([request], { timeoutMs: timeoutMs ?? RENDER_TIMEOUT_MS })
  if (!reply?.ok) {
    throw new VstHostError(reply?.error ?? 'the plugin rendered nothing', { code: 'RENDER_FAILED', kind: reply?.kind ?? 'render' })
  }
  return {
    peak: reply.peak,
    rms: reply.rms,
    frames: reply.frames,
    channels: reply.channels,
    durationSec: reply.durationSec,
    warnings: reply.warnings ?? [],
  }
}
