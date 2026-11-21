// anyaudio_record — capture audio from an input on this machine.
//
// Why this exists: a SoundFont or a plugin can only produce sounds it already
// contains. A hardware module (an EDIROL SD-20, a guitar pedal, a synth with a
// cable in the back) makes its own sound, and the only way to use that sound in
// a project is to listen to the line input and write down what came out.
//
// Nothing here invents audio: WASAPI hands over whatever the cable carries, and
// silence is reported as silence instead of being hidden.

import { mkdir, readFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { parseWav, toDb } from '../audio/wav.js'
import { attachMaterialFile } from '../project/attach.js'
import { projectDir } from '../project/paths.js'
import { readConfig } from '../config.js'
import { audioStatus, listInputs, recordInput } from '../audio/record-host.js'
import {
  deliverCopy, deliveryPath, finalizeTool, nowStamp, relativeToWorkspace, requireProjectId,
  scratchPath, textRenderer, workspaceRootOf,
} from './shared.js'

const MAX_SECONDS = 900

async function measure(path) {
  const wav = parseWav(await readFile(path))
  let peak = 0
  let sum = 0
  let count = 0
  for (const channel of wav.channels) {
    for (let index = 0; index < channel.length; index++) {
      const sample = channel[index]
      const magnitude = sample < 0 ? -sample : sample
      if (magnitude > peak) peak = magnitude
      sum += sample * sample
      count++
    }
  }
  const rms = count ? Math.sqrt(sum / count) : 0
  return {
    sampleRate: wav.sampleRate,
    durationSec: wav.frames / wav.sampleRate,
    // -120 dBFS instead of null: the host's schema checker rejects a null in a
    // typed field; `silent` carries "nothing was captured".
    peakDb: peak > 0 ? toDb(peak) : -120,
    rmsDb: rms > 0 ? toDb(rms) : -120,
    silent: !(peak > 1e-5),
  }
}

export const recordToolDefinition = finalizeTool({
  name: 'anyaudio_record',
  description:
    'Capture audio from a line input or microphone: a hardware sound module, a guitar, a synth, anything that arrives down a cable. ' +
    'action "devices" lists the inputs this machine exposes; action "record" captures N seconds into a WAV and (with a projectId) adds it as material. ' +
    'This is how a hardware synth gets into a project: drive it over MIDI (anyaudio_midiout), record its line output here, and the result is ordinary material. ' +
    'Silence is reported honestly — if the input is held by an ASIO driver or the cable is not connected, the result says so instead of pretending.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['devices', 'record', 'status'], description: 'devices = list inputs; record = capture audio; status = is the Python capture bridge ready.' },
      device: { type: 'string', description: 'Input to capture from: an index from action "devices" ("26") or a piece of its name ("USB Audio Device"). Ambiguous names are refused with the candidates.' },
      durationSec: { type: 'number', description: 'How many seconds to capture, up to 900.' },
      sampleRate: { type: 'number', description: 'Defaults to the device rate (usually 48000).' },
      channels: { type: 'number', description: 'Defaults to 2 (or the device maximum, whichever is smaller).' },
      warmupSec: { type: 'number', description: 'Extra audio captured before the window and thrown away, so the device has settled. Default 0.3.' },
      projectId: { type: 'string', description: 'Project to add the recording to. Without it the WAV is still written.' },
      trackName: { type: 'string', description: 'Track for the recording, default the device name.' },
      kind: { type: 'string', enum: ['imported', 'music', 'ambience'], description: 'Material kind, default "imported" — use "music" when the capture is an instrument performance on the timeline.' },
      startSec: { type: 'number', description: 'Where the clip starts on the project timeline, default 0.' },
      output: { type: 'string', description: 'Optional extra copy at this path.' },
    },
    required: ['action'],
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: true,
      properties: {
        ok: { type: 'boolean' },
        action: { type: 'string' },
        available: { type: 'boolean' },
        python: { type: 'string' },
        sounddevice: { type: 'string' },
        hostApis: { type: 'array', items: { type: 'string' } },
        count: { type: 'number' },
        inputs: { type: 'array', items: { type: 'object', additionalProperties: true } },
        device: { type: 'string' },
        file: { type: 'string' },
        absolutePath: { type: 'string' },
        delivered: { type: 'string' },
        durationSec: { type: 'number' },
        sampleRate: { type: 'number' },
        channels: { type: 'number' },
        peakDb: { type: 'number', description: 'Peak level in dBFS; -120 means the capture was silence.' },
        rmsDb: { type: 'number', description: 'RMS level in dBFS; -120 means silence.' },
        attached: { type: 'array', items: { type: 'object', additionalProperties: true } },
        warnings: { type: 'array', items: { type: 'string' } },
      },
    },
    render: textRenderer((args, value) => {
      if (value.action === 'status') {
        return value.available
          ? `Capture bridge ready: python ${value.python}, sounddevice ${value.sounddevice}`
          : `Capture bridge not ready: ${value.error ?? 'unknown'} (run pip install --user sounddevice)`
      }
      if (value.action === 'devices') {
        const rows = (value.inputs ?? []).map((entry) => (
          `- [${entry.index}] ${entry.name} — ${entry.hostApi}, ${entry.channels} ch, ${entry.sampleRate} Hz${entry.default ? ' (default)' : ''}`
        ))
        const head = `${rows.length} input(s)${value.wasapi === null ? '' : `; WASAPI is host API ${value.wasapi}`}`
        return [head, ...rows].join('\n')
      }
      const lines = [
        `Recorded ${value.durationSec?.toFixed(2)}s @ ${value.sampleRate} Hz from ${value.device} → ${value.file}`,
        `peak ${Number(value.peakDb) <= -120 ? '—' : Number(value.peakDb).toFixed(1)} dBFS, RMS ${Number(value.rmsDb) <= -120 ? '—' : Number(value.rmsDb).toFixed(1)} dBFS`,
      ]
      if (value.warnings?.length) lines.push(`Warnings:\n${value.warnings.map((warning) => `- ${warning}`).join('\n')}`)
      const placed = value.attached ?? []
      lines.push(placed.length
        ? `In project: ${placed.map((entry) => `${entry.clipId} "${entry.trackName}" @ ${Number(entry.startSec).toFixed(2)}s`).join(', ')}`
        : 'Not added to a project (no projectId given); the WAV is still on disk.')
      if (value.delivered) lines.push(`Delivered copy: ${value.delivered}`)
      return lines.join('\n')
    }),
  },
  async execute(args, exec) {
    const workspaceRoot = await workspaceRootOf(exec)
    const action = String(args.action ?? '').trim() || 'devices'

    if (action === 'status') {
      const status = await audioStatus()
      return { ok: status.available, action, ...status }
    }

    if (action === 'devices') {
      const listed = await listInputs()
      return {
        ok: true,
        action,
        available: true,
        hostApis: listed.hostApis,
        wasapi: listed.wasapi,
        count: listed.inputs.length,
        inputs: listed.inputs,
      }
    }

    if (action !== 'record') throw new Error(`unknown action ${action}; use devices, record or status`)

    const durationSec = Number(args.durationSec)
    if (!Number.isFinite(durationSec) || durationSec <= 0) {
      throw new Error('record needs durationSec (how many seconds to capture)')
    }
    if (durationSec > MAX_SECONDS) throw new Error(`a single recording is capped at ${MAX_SECONDS} seconds`)

    const device = String(args.device ?? '').trim()
    if (!device) throw new Error('record needs device: an index or a name from action "devices"')

    const sampleRate = Number.isFinite(Number(args.sampleRate)) && Number(args.sampleRate) > 0
      ? Math.round(Number(args.sampleRate))
      : undefined
    const channels = Number.isFinite(Number(args.channels)) && Number(args.channels) > 0
      ? Math.round(Number(args.channels))
      : undefined
    const warmupSec = Number.isFinite(Number(args.warmupSec)) && Number(args.warmupSec) >= 0
      ? Number(args.warmupSec)
      : 0.3

    const target = scratchPath(workspaceRoot, `record-${nowStamp()}.wav`)
    await mkdir(dirname(target), { recursive: true })
    const warnings = []
    let captured
    try {
      captured = await recordInput({
        device: /^\d+$/.test(device) ? Number(device) : device,
        durationSec,
        sampleRate,
        channels,
        warmupSec,
        out: target,
      })
    } catch (error) {
      error.message = `${error.message}\n(input: ${device})`
      throw error
    }

    const measured = await measure(target)
    if (measured.silent) {
      warnings.push(
        'the input delivered silence. Signal only arrives if the cable reaches this input and nothing else owns it — '
        + 'an ASIO driver (ASIO4ALL and friends) takes the device exclusively, and a sound module still has to be switched on. '
        + 'Check the cable and the device, then record again; no amount of retrying creates signal.',
      )
    }
    if (captured && Math.abs((captured.durationSec ?? durationSec) - durationSec) > 0.25) {
      warnings.push(`the device delivered ${captured.durationSec}s instead of the ${durationSec}s asked for.`)
    }

    const projectId = typeof args.projectId === 'string' && args.projectId.trim() ? args.projectId.trim() : ''
    const kind = ['imported', 'music', 'ambience'].includes(String(args.kind)) ? String(args.kind) : 'imported'
    const category = kind === 'music' ? 'music' : kind === 'ambience' ? 'ambience' : 'other'
    const trackName = String(args.trackName ?? '').trim() || captured?.device || 'recording'
    let attached = []
    if (projectId) {
      requireProjectId(args, 'anyaudio_record')
      const landed = await attachMaterialFile(workspaceRoot, projectId, target, {
        kind,
        trackName,
        category,
        snapshot: { device, durationSec, sampleRate, channels, warmupSec },
        snapshotKind: 'capture',
        tool: 'anyaudio_record',
        label: trackName,
        startSec: Number(args.startSec ?? 0),
        peakDb: measured.peakDb,
        rmsDb: measured.rmsDb,
        note: `captured from ${device}`,
      })
      attached = [landed]
    }

    let delivered = null
    if (args.output) {
      const { config } = await readConfig()
      delivered = await deliverCopy(target, deliveryPath({
        workspaceRoot,
        outputDir: config.output?.dir,
        requested: args.output,
        stagedPath: target,
      }))
    }

    const absolutePath = attached.length > 0 && projectId
      ? join(projectDir(workspaceRoot, projectId), attached[0].file)
      : target
    if (attached.length > 0) await rm(target, { force: true })

    return {
      ok: true,
      action,
      device: captured?.device ?? device,
      file: relativeToWorkspace(workspaceRoot, absolutePath),
      absolutePath,
      ...(delivered
        ? { delivered: relativeToWorkspace(workspaceRoot, delivered), deliveredAbsolutePath: delivered }
        : {}),
      durationSec: measured.durationSec,
      sampleRate: measured.sampleRate,
      channels: captured?.channels ?? null,
      peakDb: measured.peakDb,
      rmsDb: measured.rmsDb,
      attached,
      warnings,
    }
  },
})

export function registerRecordTool(ctx) {
  ctx.tools.register(recordToolDefinition)
}
