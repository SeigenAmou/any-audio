import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const DEFAULT_WORKER = resolve(here, '..', '..', 'engine', 'audio_worker.py')

const PING_TIMEOUT_MS = 30000

export class AudioHostError extends Error {
  constructor(message, { code = 'AUDIO_ERROR', detail = null } = {}) {
    super(message)
    this.name = 'AudioHostError'
    this.code = code
    this.detail = detail
  }
}

/** The interpreter that carries sounddevice. Same contract as the VST bridge. */
export function audioPython() {
  return process.env.ANYAUDIO_AUDIO_PYTHON || process.env.ANYAUDIO_VST_PYTHON || 'python'
}

export function audioWorkerPath() {
  return process.env.ANYAUDIO_AUDIO_WORKER || DEFAULT_WORKER
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
    // A hung audio stream holds the device until the process really dies; the
    // parent gave up already, so there is nothing left to report.
  }
}

/**
 * One worker process per call: a capture stream left open would keep the
 * device busy for everyone else on the machine.
 */
export function runAudioWorker(requests, { timeoutMs = PING_TIMEOUT_MS, python = audioPython(), worker = audioWorkerPath() } = {}) {
  if (!existsSync(worker)) {
    return Promise.reject(new AudioHostError(`audio worker script not found: ${worker}`, { code: 'WORKER_MISSING' }))
  }
  return new Promise((resolvePromise, reject) => {
    let child
    try {
      child = spawn(python, ['-X', 'utf8', worker], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true })
    } catch (error) {
      reject(new AudioHostError(`could not start ${python}: ${error.message}`, { code: 'SPAWN_FAILED' }))
      return
    }
    let stdout = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      killTree(child)
      reject(new AudioHostError(
        `recording did not finish within ${Math.round(timeoutMs / 1000)}s. If another program (an ASIO driver, a DAW) holds the input, WASAPI has nothing to hand over.`,
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
      reject(new AudioHostError(`worker error: ${error.message}`, { code: 'SPAWN_FAILED' }))
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const lines = stdout.split(/\r?\n/).filter((line) => line.trim().startsWith('{'))
      if (lines.length === 0) {
        reject(new AudioHostError(`the worker exited with code ${code} and no reply.`, { code: 'NO_REPLY' }))
        return
      }
      try {
        resolvePromise(lines.map((line) => JSON.parse(line)))
      } catch (error) {
        reject(new AudioHostError(`could not parse the worker reply: ${error.message}`, { code: 'BAD_REPLY' }))
      }
    })

    child.stdin.on('error', () => {})
    child.stdin.write(requests.map((request) => JSON.stringify(request)).join('\n') + '\n', 'utf8')
    child.stdin.end()
  })
}

/** Is there a python that can capture audio at all? */
export async function audioStatus() {
  try {
    const [reply] = await runAudioWorker([{ op: 'ping' }], { timeoutMs: PING_TIMEOUT_MS })
    if (!reply?.ok) {
      return { available: false, python: audioPython(), error: reply?.error ?? 'unknown' }
    }
    return { available: true, python: audioPython(), version: reply.python, sounddevice: reply.sounddevice }
  } catch (error) {
    return { available: false, python: audioPython(), error: error.message }
  }
}

/** Every input the machine exposes, with the WASAPI one flagged. */
export async function listInputs() {
  const [reply] = await runAudioWorker([{ op: 'devices' }], { timeoutMs: 60000 })
  if (!reply?.ok) {
    throw new AudioHostError(reply?.error ?? 'could not list audio inputs', { code: reply?.code ?? 'AUDIO_ERROR' })
  }
  return { hostApis: reply.hostApis ?? [], wasapi: reply.wasapi ?? null, inputs: reply.inputs ?? [] }
}

/**
 * Capture `durationSec` from one input into a WAV. The timeout is the
 * recording length plus room for opening and closing the device.
 */
export async function recordInput({ device, durationSec, sampleRate, channels, out, warmupSec = 0, timeoutMs }) {
  const duration = Number(durationSec)
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new AudioHostError('recordInput needs a positive durationSec', { code: 'BAD_REQUEST' })
  }
  const budget = timeoutMs ?? Math.round(duration * 1000) + 30000
  const [reply] = await runAudioWorker(
    [{ op: 'record', device, durationSec: duration, sampleRate, channels, out, warmupSec }],
    { timeoutMs: budget },
  )
  if (!reply?.ok) {
    throw new AudioHostError(reply?.error ?? 'recording failed', { code: reply?.code ?? 'RECORD_FAILED' })
  }
  return reply
}
