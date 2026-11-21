// anyaudio_midiout — play notes on a hardware MIDI module, and measure its lag.
//
// Why this exists: a SoundFont lives inside the process and a VST3 plugin lives
// in a DLL, but an EDIROL SD-20 lives on the other end of a cable. It makes its
// own sound, so the only way to use it is to send it notes and listen to its
// line output. This tool sends; `capture` sends and records in the same call so
// the two share one clock.
//
// The latency measured here is the part of that clock nobody can see: MIDI goes
// out instantly, the module's own sound engine answers a few milliseconds to a
// few tens of milliseconds later.

import { mkdir, readFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { parseWav, toDb } from '../audio/wav.js'
import { attachMaterialFile } from '../project/attach.js'
import { projectDir } from '../project/paths.js'
import { calibrateMidi, listMidiPorts, midiStatus, playMidi } from '../audio/midi-host.js'
import {
  finalizeTool, nowStamp, readJsonParam, relativeToWorkspace, requireProjectId, scratchPath,
  textRenderer, workspaceRootOf,
} from './shared.js'

/** Same note grammar as anyaudio_vst: [startSec, durSec, midi, velocity, channel?]. */
function normalizeNotes(raw) {
  if (!Array.isArray(raw)) throw new Error('notes must be an array of [startSec, durSec, midi, velocity]')
  return raw.map((note, index) => {
    if (!Array.isArray(note) || note.length < 3) {
      throw new Error(`notes[${index}] must be [startSec, durSec, midi, velocity, channel?]`)
    }
    const start = Number(note[0])
    const duration = Number(note[1])
    const midi = Number(note[2])
    const velocity = note[3] === undefined ? 100 : Number(note[3])
    if (!Number.isFinite(start) || start < 0) throw new Error(`notes[${index}]: startSec must be a non-negative number`)
    if (!Number.isFinite(duration) || duration <= 0) throw new Error(`notes[${index}]: durSec must be greater than 0`)
    if (!Number.isInteger(midi) || midi < 0 || midi > 127) throw new Error(`notes[${index}]: midi must be an integer 0..127`)
    if (!Number.isFinite(velocity) || velocity < 1 || velocity > 127) throw new Error(`notes[${index}]: velocity must be 1..127`)
    const channel = note[4] === undefined ? undefined : Number(note[4])
    if (channel !== undefined && (!Number.isInteger(channel) || channel < 0 || channel > 15)) {
      throw new Error(`notes[${index}]: channel must be an integer 0..15`)
    }
    return channel === undefined ? [start, duration, midi, velocity] : [start, duration, midi, velocity, channel]
  })
}

function notesFromScore(score) {
  const tracks = Array.isArray(score?.tracks) ? score.tracks : []
  const track = tracks.find((entry) => Array.isArray(entry?.notes) && entry.notes.length > 0)
  if (!track) throw new Error('score has no track with notes')
  const notes = []
  for (const note of track.notes) {
    if (!Array.isArray(note) || note.length < 3) continue
    if (Array.isArray(note[2])) {
      for (const pitch of note[2]) notes.push([Number(note[0]), Number(note[1]), Number(pitch), Number(note[3] ?? 100)])
      continue
    }
    notes.push([Number(note[0]), Number(note[1]), Number(note[2]), Number(note[3] ?? 100)])
  }
  return notes
}

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

export const midioutToolDefinition = finalizeTool({
  name: 'anyaudio_midiout',
  description:
    'Drive a hardware sound module over MIDI: notes out of a port, and optionally record its line output in the same call. ' +
    'action "ports" lists the MIDI outputs and inputs (names and indexes); action "play" sends notes; action "calibrate" measures how far the audio lags the notes. ' +
    'Use it when the sound has to come from real hardware (an EDIROL SD-20, a rack synth) rather than a SoundFont or a plugin. ' +
    'With "capture" the module\'s audio is recorded while the notes play, so the take is one timeline; the capture becomes ordinary material when a projectId is given. ' +
    'Run "calibrate" once per rig: the measured latency is what keeps hardware parts from sounding late.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['ports', 'play', 'calibrate', 'status'], description: 'ports = list MIDI ports; play = send notes; calibrate = measure the round-trip lag; status = is the python bridge ready.' },
      port: { type: 'string', description: 'MIDI output to use: an index ("2") or a piece of its name ("SD-20 PART A"). Defaults to index 0 when playing.' },
      notes: { type: 'array', description: 'Notes as [startSec, durSec, midi, velocity, channel?].', items: { type: 'array', items: { type: 'number' } } },
      score: { oneOf: [{ type: 'object' }, { type: 'string' }], description: 'Alternative to notes: a score object (or .json path) whose first track with notes is played.' },
      program: { type: 'number', description: 'Send a program change (0..127) before the notes, so the module picks the intended patch.' },
      channel: { type: 'number', description: 'Default channel 0..15 for notes that do not name one. SD-20 PART A/B are two 16-channel banks: A is the first 16, B the second.' },
      captureDevice: { type: 'string', description: 'With action "play": also record from this input (index or name from anyaudio_record devices). The capture and the notes share one clock.' },
      captureSec: { type: 'number', description: 'Capture length; defaults to the last note end plus 2 s.' },
      trimLatencyMs: { type: 'number', description: 'Drop this many leading milliseconds from the capture. Use the number anyaudio_midiout calibrate measured.' },
      projectId: { type: 'string', description: 'Project to add the capture to.' },
      trackName: { type: 'string', description: 'Track for the capture, default the port name.' },
      startSec: { type: 'number', description: 'Where the capture starts on the project timeline, default 0.' },
      device: { type: 'string', description: 'With action "calibrate": the input that hears the module.' },
      durationSec: { type: 'number', description: 'With action "calibrate": how long to listen, default 8 s.' },
      intervalSec: { type: 'number', description: 'With action "calibrate": gap between pings, default 0.9 s.' },
      count: { type: 'number', description: 'With action "calibrate": how many pings, 3..12, default 6.' },
      midi: { type: 'number', description: 'With action "calibrate": the ping note, default 72.' },
      output: { type: 'string', description: 'Optional extra copy of a capture at this path.' },
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
        rtmidi: { type: 'string' },
        outputs: { type: 'array', items: { type: 'string' } },
        inputs: { type: 'array', items: { type: 'string' } },
        port: { type: 'string' },
        sent: { type: 'number' },
        notes: { type: 'number' },
        durationSec: { type: 'number' },
        latencyMs: { type: 'number', description: 'Median audio lag behind the MIDI send, in ms; -1 when nothing was heard.' },
        spreadMs: { type: 'number' },
        offsetsMs: { type: 'array', items: { type: 'number' } },
        notesHeard: { type: 'number' },
        device: { type: 'string' },
        file: { type: 'string' },
        peakDb: { type: 'number', description: 'Peak level in dBFS; -120 means silence.' },
        rmsDb: { type: 'number', description: 'RMS level in dBFS; -120 means silence.' },
        attached: { type: 'array', items: { type: 'object', additionalProperties: true } },
        warnings: { type: 'array', items: { type: 'string' } },
      },
    },
    render: textRenderer((args, value) => {
      if (value.action === 'status') {
        return value.available
          ? `MIDI bridge ready: python ${value.python}, python-rtmidi ${value.rtmidi}`
          : `MIDI bridge not ready: ${value.error ?? 'unknown'} (run pip install --user python-rtmidi)`
      }
      if (value.action === 'ports') {
        const outs = (value.outputs ?? []).map((name, index) => `- [${index}] ${name}`)
        const ins = (value.inputs ?? []).map((name, index) => `- [${index}] ${name}`)
        return [
          `${outs.length} MIDI output(s):`, ...outs,
          `${ins.length} MIDI input(s):`, ...ins,
        ].join('\n')
      }
      if (value.action === 'calibrate') {
        if (value.latencyMs === null || value.latencyMs === undefined || value.latencyMs < 0) {
          return `${value.warning ?? 'no offset measured'} (port ${value.port}, input ${value.device})`
        }
        return [
          `${value.latencyMs} ms median lag (spread ${value.spreadMs} ms over ${value.notesHeard}/${value.notesSent} pings)`,
          `port ${value.port} → input ${value.device}`,
          `offsets: ${(value.offsetsMs ?? []).join(', ')} ms`,
        ].join('\n')
      }
      const lines = [`Sent ${value.sent} message(s) on ${value.port} (${value.durationSec?.toFixed(2)}s)`]
      if (value.file) {
        lines.push(`Captured ${value.durationSec?.toFixed(2)}s → ${value.file}`)
        lines.push(`peak ${Number(value.peakDb) <= -120 ? '—' : Number(value.peakDb).toFixed(1)} dBFS`)
      }
      if (value.warnings?.length) lines.push(`Warnings:\n${value.warnings.map((warning) => `- ${warning}`).join('\n')}`)
      const placed = value.attached ?? []
      if (placed.length) lines.push(`In project: ${placed.map((entry) => `${entry.clipId} "${entry.trackName}" @ ${Number(entry.startSec).toFixed(2)}s`).join(', ')}`)
      return lines.join('\n')
    }),
  },
  async execute(args, exec) {
    const workspaceRoot = await workspaceRootOf(exec)
    const action = String(args.action ?? '').trim() || 'ports'

    if (action === 'status') {
      const status = await midiStatus()
      return { ok: status.available, action, ...status }
    }

    if (action === 'ports') {
      const ports = await listMidiPorts()
      return { ok: true, action, available: true, ...ports }
    }

    if (action === 'calibrate') {
      const device = String(args.device ?? '').trim()
      if (!device) throw new Error('calibrate needs device: the input that hears the module (see anyaudio_record devices)')
      const measured = await calibrateMidi({
        port: args.port === undefined ? undefined : (/^\d+$/.test(String(args.port)) ? Number(args.port) : String(args.port)),
        device: /^\d+$/.test(device) ? Number(device) : device,
        durationSec: args.durationSec,
        intervalSec: args.intervalSec,
        count: args.count,
        midi: args.midi,
        channel: args.channel,
        program: args.program,
        sampleRate: args.sampleRate,
      })
      return {
        ok: true,
        action,
        port: measured.port,
        device: measured.device,
        latencyMs: measured.latencyMs ?? -1,
        spreadMs: measured.spreadMs,
        offsetsMs: measured.offsetsMs ?? [],
        notesSent: measured.notesSent,
        notesHeard: measured.notesHeard,
        warnings: measured.warning ? [measured.warning] : [],
      }
    }

    if (action !== 'play') throw new Error(`unknown action ${action}; use ports, play, calibrate or status`)

    let notes
    if (Array.isArray(args.notes)) {
      notes = normalizeNotes(args.notes)
    } else if (args.score !== undefined) {
      notes = normalizeNotes(notesFromScore(await readJsonParam(args.score, 'score', { workspaceRoot })))
    } else {
      throw new Error('play needs notes: [[startSec, durSec, midi, velocity], …] or a score with a track that has notes')
    }

    const projectId = typeof args.projectId === 'string' && args.projectId.trim() ? args.projectId.trim() : ''
    const port = args.port === undefined ? undefined : (/^\d+$/.test(String(args.port)) ? Number(args.port) : String(args.port))
    const captureDevice = String(args.captureDevice ?? '').trim()
    const lastEnd = notes.reduce((end, note) => Math.max(end, note[0] + note[1]), 0)
    const captureSec = Number.isFinite(Number(args.captureSec)) && Number(args.captureSec) > 0
      ? Number(args.captureSec)
      : Math.min(lastEnd + 2, 900)

    const target = captureDevice ? scratchPath(workspaceRoot, `midiout-${nowStamp()}.wav`) : null
    if (target) await mkdir(dirname(target), { recursive: true })
    const played = await playMidi({
      port,
      notes,
      channel: args.channel === undefined ? undefined : Number(args.channel),
      program: args.program === undefined ? undefined : Number(args.program),
      durationSec: captureSec,
      capture: captureDevice
        ? {
          device: /^\d+$/.test(captureDevice) ? Number(captureDevice) : captureDevice,
          durationSec: captureSec,
          trimLatencyMs: Number(args.trimLatencyMs) || 0,
          out: target,
        }
        : undefined,
    })

    const warnings = []
    let measured = null
    if (target) {
      measured = await measure(target)
      if (measured.silent) {
        warnings.push(
          'the module sent nothing back through the line input. Check that the capture input really hears the module '
          + '(an ASIO driver can hold it exclusively) and that the module is switched on and its volume is up; '
          + 'run anyaudio_record devices, then anyaudio_midiout calibrate to see which input carries it.',
        )
      }
    }

    let attached = []
    if (target && projectId) {
      requireProjectId(args, 'anyaudio_midiout')
      const trackName = String(args.trackName ?? '').trim() || played.port || 'hardware'
      const landed = await attachMaterialFile(workspaceRoot, projectId, target, {
        kind: 'music',
        trackName,
        category: 'music',
        snapshot: { port: played.port, notes, captureSec, trimLatencyMs: Number(args.trimLatencyMs) || 0 },
        snapshotKind: 'hardware-capture',
        tool: 'anyaudio_midiout',
        label: trackName,
        startSec: Number(args.startSec ?? 0),
        peakDb: measured.peakDb,
        rmsDb: measured.rmsDb,
        note: `played on ${played.port}`,
      })
      attached = [landed]
    }

    const absolutePath = target
      ? (attached.length > 0 && projectId ? join(projectDir(workspaceRoot, projectId), attached[0].file) : target)
      : null
    if (attached.length > 0 && target) await rm(target, { force: true })

    return {
      ok: true,
      action,
      port: played.port,
      sent: played.sent,
      notes: played.notes,
      durationSec: measured ? measured.durationSec : played.durationSec,
      ...(absolutePath && measured
        ? {
          file: relativeToWorkspace(workspaceRoot, absolutePath),
          absolutePath,
          peakDb: measured.peakDb,
          rmsDb: measured.rmsDb,
        }
        : {}),
      attached,
      warnings,
    }
  },
})

export function registerMidioutTool(ctx) {
  ctx.tools.register(midioutToolDefinition)
}
