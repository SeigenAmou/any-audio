// A score part can name a hardware module instead of a synth.
//
// A plugin lives inside a process the host owns; a mounted module lives on a
// desk. The computer sends it notes and hears it back through a line input, so
// a hardware part is the only source that cannot be rendered faster than it
// plays: the score waits, in real time, for exactly as long as the music lasts.
// That is why it gets its own file and its own rules.
//
// Two consequences shape everything here:
//   - One part per pass. Two modules sounding at once would both land in the
//     same capture, and there is no way to take them apart afterwards.
//   - The latency belongs to the wire. `latencyMs` drops the few tens of
//     milliseconds between "the note was sent" and "the module answered", so
//     the audio file starts where the score does.

import { readFile, rm } from 'node:fs/promises'
import { peakOf, parseWav, rmsOf, toDb } from './wav.js'
import { playMidi } from './midi-host.js'

/** One part per call; a runaway score becomes a sentence, not a hung port. */
export const MAX_HW_NOTES = 20000

export function hwTracksOf(compiled) {
  return compiled.tracks.filter((track) => track.hw && track.hw.port)
}

/** The bridge's note list: [startSec, durationSec, midi, velocity]. */
export function notesForHw(track) {
  if (track.notes.length > MAX_HW_NOTES) {
    throw new Error(
      `track "${track.name}" has ${track.notes.length} notes; a hardware part plays at most ${MAX_HW_NOTES} per call`,
    )
  }
  return track.notes.map((note) => [note.start, note.duration, note.midi, note.velocity])
}

/** The most notes that sound at once. A module answers a fixed number of voices
 *  (an SD-20 answers 64 across both of its parts); past that the extra notes are
 *  dropped silently, which sounds like a thin arrangement rather than an error.
 *  Worth a warning before it costs a take. */
export function peakPolyphony(notes) {
  const edges = []
  for (const note of notes) {
    const start = Number(note[0])
    const end = start + Number(note[1])
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue
    edges.push([start, 1], [end, -1])
  }
  edges.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  let live = 0
  let peak = 0
  for (const edge of edges) {
    live += edge[1]
    if (live > peak) peak = live
  }
  return peak
}

/** CC events the module should hear. `automation` in the score becomes track
 *  events, so a hardware part keeps the syntax a SoundFont part already has —
 *  which is how a GS module gets its bank select and part volume. */
export function controlsForHw(track) {
  return track.events
    .filter((event) => event.type === 'cc')
    .map((event) => [event.t, event.controller, event.value])
    .sort((a, b) => a[0] - b[0])
}

/** Which input hears this module: the part says so, or the machine does. */
export function captureDeviceFor(track) {
  const explicit = track.hw?.captureDevice
  if (explicit) return explicit
  const configured = process.env.ANYAUDIO_CAPTURE_DEVICE
  if (configured && configured.trim()) return configured.trim()
  throw new Error(
    `track "${track.name}" plays on "${track.hw.port}" but nothing records it: `
    + 'add "captureDevice" to the part (a name or index from anyaudio_record action "devices"), '
    + 'or set ANYAUDIO_CAPTURE_DEVICE. A module that is heard but not recorded would leave the mix silent.',
  )
}

function emptyPair(frames) {
  return [new Float32Array(frames), new Float32Array(frames)]
}

function fitChannels(channels, frames) {
  const out = emptyPair(frames)
  for (let ch = 0; ch < 2; ch++) {
    const source = channels[ch] ?? channels[0]
    if (!source) continue
    const count = Math.min(frames, source.length)
    for (let i = 0; i < count; i++) out[ch][i] = Number.isFinite(source[i]) ? source[i] : 0
  }
  return out
}

/**
 * Play one hardware part and record what came back. `out` is a scratch WAV
 * path; it is removed before returning. The call takes as long as the music
 * does — there is no way to ask a module to render faster.
 */
export async function renderHwStem(track, { sampleRate = 48000, durationSec, out, timeoutMs } = {}) {
  if (!out) throw new Error(`renderHwStem needs an output path for "${track.name}"`)
  const port = track.hw?.port
  if (!port) throw new Error(`track "${track.name}" is not a hardware part`)
  const frames = Math.max(1, Math.ceil((Number.isFinite(durationSec) ? durationSec : track.endSec) * sampleRate))
  const notes = notesForHw(track)
  if (notes.length === 0) {
    return { channels: emptyPair(frames), frames, peakDb: null, rmsDb: null, port, warnings: ['the part has no notes'] }
  }
  const device = captureDeviceFor(track)
  // An index may arrive as "29". The worker treats a real number as an index and
  // anything else as a name, so a numeric string would match no input at all.
  const deviceArg = /^\d+$/.test(String(device)) ? Number(device) : device
  const configuredLatency = Number(process.env.ANYAUDIO_MIDI_LATENCY_MS)
  const latencyMs = Number.isFinite(track.hw.latencyMs)
    ? track.hw.latencyMs
    : (Number.isFinite(configuredLatency) ? Math.max(0, configuredLatency) : 0)
  const warnings = []
  // How many notes a module answers is a property of the module, not of the
  // format: an SD-20 answers 64 voices, an XV-5080 or SC-88 answers 128. Never
  // assume one; check only when the part says how many it has.
  const polyphony = peakPolyphony(notes)
  const declaredVoices = Number.isFinite(track.hw.voices) && track.hw.voices > 0 ? track.hw.voices : undefined
  if (declaredVoices && polyphony > declaredVoices) {
    warnings.push(
      `this part peaks at ${polyphony} notes sounding at once and hw.voices says this module answers ${declaredVoices}, `
      + 'so the extra notes are silent — thin the part, split it across ports, or correct voices',
    )
  } else if (!declaredVoices && polyphony > 64) {
    warnings.push(
      `${polyphony} notes sound at once and how many voices this module answers is unknown `
      + '(an SD-20 answers 64, an XV-5080 or an SC-88 answers 128); notes past the limit are silent, '
      + 'so put the real number in hw.voices to have it checked',
    )
  }
  if (!(latencyMs > 0)) {
    warnings.push(
      'no latency was given for this part, so the audio may start a few tens of milliseconds late. '
      + 'Run anyaudio_midiout action "calibrate" once for this rig and put the measured number in latencyMs.',
    )
  }
  try {
    const reply = await playMidi({
      port,
      notes,
      channel: track.hw.channel,
      program: track.hw.program,
      controls: controlsForHw(track),
      durationSec: frames / sampleRate,
      capture: { device: deviceArg, channels: 2, sampleRate, durationSec: frames / sampleRate, trimLatencyMs: latencyMs, out },
      timeoutMs: timeoutMs ?? Math.round((frames / sampleRate) * 1000) + 60000,
    })
    const capture = reply.capture ?? {}
    if (capture.silent) {
      warnings.push(
        `the module sent nothing back through "${capture.device ?? device}". `
        + 'Check that the capture input really hears it (an ASIO driver can hold the input exclusively), '
        + 'that the module is on and its volume is up, and that the part is on the right channel.',
      )
    }
    const parsed = parseWav(await readFile(out))
    const channels = fitChannels(parsed.channels, frames)
    const mixGain = Number.isFinite(track.mixGain) ? track.mixGain : 1
    if (mixGain !== 1) {
      for (const channel of channels) for (let i = 0; i < channel.length; i++) channel[i] *= mixGain
    }
    if (parsed.frames !== frames) {
      warnings.push(`the capture was ${parsed.frames} frames instead of ${frames}; padded or trimmed to fit`)
    }
    return {
      channels,
      frames,
      peakDb: capture.silent ? null : toDb(peakOf(channels)),
      rmsDb: capture.silent ? null : toDb(rmsOf(channels)),
      port: reply.port ?? port,
      device: capture.device ?? device,
      latencyMs,
      warnings,
    }
  } finally {
    await rm(out, { force: true })
  }
}

/**
 * Render every hardware part, one at a time, and sum them. A failing module is
 * reported and skipped — the rest of the score still renders, and a person is
 * told which wire to check.
 */
export async function renderHwTracks(compiled, { sampleRate, durationSec, makeScratch, timeoutMs, onPart } = {}) {
  const tracks = hwTracksOf(compiled)
  if (tracks.length === 0) return null
  const rate = sampleRate ?? compiled.sampleRate ?? 48000
  const total = Math.max(0.1, Number.isFinite(durationSec) ? durationSec : compiled.durationSec)
  const frames = Math.ceil(total * rate)
  const mixed = emptyPair(frames)
  const parts = []
  const errors = []
  for (const track of tracks) {
    try {
      if (onPart) onPart(track)
      const stem = await renderHwStem(track, { sampleRate: rate, durationSec: total, out: makeScratch(track), timeoutMs })
      for (let ch = 0; ch < 2; ch++) {
        const source = stem.channels[ch]
        for (let i = 0; i < frames; i++) mixed[ch][i] += source[i]
      }
      parts.push({
        name: track.name,
        port: stem.port,
        device: stem.device,
        latencyMs: stem.latencyMs,
        peakDb: stem.peakDb,
        rmsDb: stem.rmsDb,
        warnings: stem.warnings,
      })
    } catch (error) {
      errors.push({ name: track.name, port: track.hw.port, message: error.message, code: error.code ?? 'HW_ERROR' })
    }
  }
  return { channels: mixed, frames, parts, errors }
}
