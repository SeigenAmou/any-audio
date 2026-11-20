import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const DEFAULT_WORKER = resolve(here, '..', '..', 'engine', 'midi_worker.py')

const PING_TIMEOUT_MS = 30000

export class MidiHostError extends Error {
  constructor(message, { code = 'MIDI_ERROR', detail = null } = {}) {
    super(message)
    this.name = 'MidiHostError'
    this.code = code
    this.detail = detail
  }
}

/** The interpreter that carries python-rtmidi. */
export function midiPython() {
  return process.env.ANYAUDIO_MIDI_PYTHON || process.env.ANYAUDIO_VST_PYTHON || 'python'
}

export function midiWorkerPath() {
  return process.env.ANYAUDIO_MIDI_WORKER || DEFAULT_WORKER
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
    // The notes already left the port; a stuck process cannot be un-sent.
  }
}

export function runMidiWorker(requests, { timeoutMs = PING_TIMEOUT_MS, python = midiPython(), worker = midiWorkerPath() } = {}) {
  if (!existsSync(worker)) {
    return Promise.reject(new MidiHostError(`MIDI worker script not found: ${worker}`, { code: 'WORKER_MISSING' }))
  }
  return new Promise((resolvePromise, reject) => {
    let child
    try {
      child = spawn(python, ['-X', 'utf8', worker], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true })
    } catch (error) {
      reject(new MidiHostError(`could not start ${python}: ${error.message}`, { code: 'SPAWN_FAILED' }))
      return
    }
    let stdout = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      killTree(child)
      reject(new MidiHostError(
        `the MIDI worker did not finish within ${Math.round(timeoutMs / 1000)}s. A port that is held by another program can block every send.`,
        { code: 'TIMEOUT' },
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
      reject(new MidiHostError(`worker error: ${error.message}`, { code: 'SPAWN_FAILED' }))
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const lines = stdout.split(/\r?\n/).filter((line) => line.trim().startsWith('{'))
      if (lines.length === 0) {
        reject(new MidiHostError(`the worker exited with code ${code} and no reply.`, { code: 'NO_REPLY' }))
        return
      }
      try {
        resolvePromise(lines.map((line) => JSON.parse(line)))
      } catch (error) {
        reject(new MidiHostError(`could not parse the worker reply: ${error.message}`, { code: 'BAD_REPLY' }))
      }
    })

    child.stdin.on('error', () => {})
    child.stdin.write(requests.map((request) => JSON.stringify(request)).join('\n') + '\n', 'utf8')
    child.stdin.end()
  })
}

export async function midiStatus() {
  try {
    const [reply] = await runMidiWorker([{ op: 'ping' }], { timeoutMs: PING_TIMEOUT_MS })
    if (!reply?.ok) return { available: false, python: midiPython(), error: reply?.error ?? 'unknown' }
    return { available: true, python: midiPython(), version: reply.python, rtmidi: reply.rtmidi, ports: reply.ports ?? [] }
  } catch (error) {
    return { available: false, python: midiPython(), error: error.message }
  }
}

export async function listMidiPorts() {
  const [reply] = await runMidiWorker([{ op: 'ports' }], { timeoutMs: 60000 })
  if (!reply?.ok) {
    throw new MidiHostError(reply?.error ?? 'could not list MIDI ports', { code: reply?.code ?? 'MIDI_ERROR' })
  }
  return { outputs: reply.outputs ?? [], inputs: reply.inputs ?? [] }
}

/** Send notes to a port on a timeline. Resolves when the last note-off left.
 *  With `capture` the worker records the line input on the same clock. */
export async function playMidi({ port, notes, channel, program, controls, capture, durationSec, timeoutMs }) {
  const lastEnd = (notes ?? []).reduce((end, note) => Math.max(end, Number(note?.[0] ?? 0) + Number(note?.[1] ?? 0)), 0)
  const budget = timeoutMs ?? Math.round(Math.max(durationSec ?? lastEnd, lastEnd) * 1000) + 30000
  const [reply] = await runMidiWorker([{ op: 'play', port, notes, channel, program, controls, capture }], { timeoutMs: budget })
  if (!reply?.ok) {
    throw new MidiHostError(reply?.error ?? 'the notes could not be sent', { code: reply?.code ?? 'PLAY_FAILED' })
  }
  return reply
}

/** Play pings while recording the line input; report the measured lag. */
export async function calibrateMidi(options = {}) {
  const duration = Number(options.durationSec ?? 8)
  const budget = options.timeoutMs ?? Math.round(duration * 1000) + 30000
  const [reply] = await runMidiWorker([{ op: 'calibrate', ...options }], { timeoutMs: budget })
  if (!reply?.ok) {
    throw new MidiHostError(reply?.error ?? 'calibration failed', { code: reply?.code ?? 'CALIBRATE_FAILED' })
  }
  return reply
}
