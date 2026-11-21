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
// are reported as unsupported instead of being silently skipped.

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
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
  const found = []
  const seen = new Set()
  for (const root of vstSearchDirs(configured)) {
    walk(root, 0, (path, bytes) => {
      const key = path.toLowerCase()
      if (seen.has(key)) return
      const lowered = key
      if (PROTECTED.some((word) => lowered.includes(word))) return
      if (bytes !== null && bytes < MIN_PLUGIN_BYTES) return
      seen.add(key)
      found.push({ path, bytes, name: baseName(path) })
    })
  }
  return found.sort((a, b) => a.path.localeCompare(b.path))
}

function walk(dir, depth, visit) {
  if (depth > MAX_DEPTH) return
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      // A .vst3 directory is a bundle: record it, do not walk into it.
      if (entry.name.toLowerCase().endsWith('.vst3')) {
        visit(path, null)
        continue
      }
      walk(path, depth + 1, visit)
      continue
    }
    if (!entry.name.toLowerCase().endsWith('.vst3')) continue
    let bytes = null
    try {
      bytes = statSync(path).size
    } catch {
      continue
    }
    visit(path, bytes)
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
