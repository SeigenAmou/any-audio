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

/**
 * How far the capture sits from the score's grid, in seconds.
 *
 * `latencyMs` covers the wire: "the note was sent" to "the module answered".
 * It does not cover the recorder opening its stream slightly later, or a
 * driver reporting a shorter input latency than the hardware really has. What
 * is left is a constant few tens of milliseconds, and at 120 BPM a sixteenth
 * note is 125 ms, so 25 ms is a fifth of one — audible as a part that drags.
 *
 * Measuring it needs no extra signal. The part says when notes start; the
 * capture says when sound starts; cross-correlating the two envelopes over a
 * bounded window gives the shift. Returns null when the envelopes do not
 * agree well enough to trust the number.
 */
function envelopeOf(channels, frames, hop) {
  const buckets = Math.floor(frames / hop)
  const out = new Float32Array(buckets)
  for (let b = 0; b < buckets; b++) {
    let sum = 0
    for (let i = b * hop, end = (b + 1) * hop; i < end; i++) {
      let mono = 0
      for (const channel of channels) mono += channel[i]
      mono /= channels.length
      sum += mono * mono
    }
    out[b] = Math.sqrt(sum / hop)
  }
  return out
}

function theoryEnvelope(track, buckets, sampleRate, hop) {
  const out = new Float32Array(buckets)
  const decay = Math.max(1, Math.round((0.12 * sampleRate) / hop))
  for (const note of track.notes) {
    const start = Math.round((note.start * sampleRate) / hop)
    const weight = Math.min(1, Math.max(0.15, note.velocity / 100))
    for (let k = 0; k < decay; k++) {
      const index = start + k
      if (index >= 0 && index < buckets) out[index] += weight * (1 - k / decay)
    }
  }
  return out
}

function centred(arr) {
  let mean = 0
  for (const value of arr) mean += value
  mean /= arr.length || 1
  const out = new Float32Array(arr.length)
  let energy = 0
  for (let i = 0; i < arr.length; i++) {
    out[i] = arr[i] - mean
    energy += out[i] * out[i]
  }
  const norm = Math.sqrt(energy) || 1
  for (let i = 0; i < out.length; i++) out[i] /= norm
  return out
}

export function measureCaptureLag(channels, track, sampleRate, { maxMs = 250 } = {}) {
  const hop = Math.max(1, Math.round(sampleRate * 0.005))
  const frames = channels[0]?.length ?? 0
  const buckets = Math.floor(frames / hop)
  if (buckets < 40 || track.notes.length === 0) return null
  const captured = centred(envelopeOf(channels, frames, hop))
  const theory = centred(theoryEnvelope(track, buckets, sampleRate, hop))
  const limit = Math.max(1, Math.round(((maxMs / 1000) * sampleRate) / hop))
  let best = null
  for (let lag = -limit; lag <= limit; lag++) {
    let sum = 0
    for (let i = 0; i < buckets; i++) {
      const j = i + lag
      if (j < 0 || j >= buckets) continue
      sum += theory[i] * captured[j]
    }
    if (best === null || sum > best.sum) best = { sum, lag }
  }
  // Below this the envelopes share no shape worth calling an offset; leaving
  // the take alone is safer than moving it on a guess.
  if (best === null || best.sum < 0.12) return null
  return (best.lag * hop) / sampleRate
}

/** Move every channel by `lagSec`; a positive lag means the take arrived late. */
export function shiftChannels(channels, lagSec, sampleRate) {
  const shift = Math.round(lagSec * sampleRate)
  if (shift === 0) return
  for (const channel of channels) {
    if (shift > 0) {
      for (let i = 0; i + shift < channel.length; i++) channel[i] = channel[i + shift]
      for (let i = Math.max(0, channel.length - shift); i < channel.length; i++) channel[i] = 0
    } else {
      const back = -shift
      for (let i = channel.length - 1; i >= back; i--) channel[i] = channel[i - back]
      for (let i = 0; i < back; i++) channel[i] = 0
    }
  }
}

/**
 * Seconds into the capture where the module first answers, or null.
 *
 * A part is recorded with one short note 0.4 s before the music starts. That
 * note is the only sound in the lead-in, so the first sample above the floor
 * is the module answering, and how far in it sits is the wire delay plus the
 * recorder's own start — the two numbers a person cannot measure by hand.
 */
export function firstPeakOffset(channels, sampleRate, { searchSec = 1, floorDb = -50 } = {}) {
  const limit = Math.min(channels[0]?.length ?? 0, Math.round(searchSec * sampleRate))
  let peak = 0
  for (const channel of channels) {
    for (let i = 0; i < limit; i++) peak = Math.max(peak, Math.abs(channel[i]))
  }
  if (peak === 0) return null
  const floor = peak * Math.pow(10, floorDb / 20)
  for (let i = 0; i < limit; i++) {
    for (const channel of channels) {
      if (Math.abs(channel[i]) > floor) return i / sampleRate
    }
  }
  return null
}

/** The lead-in that carries the measuring note; it is cut away afterwards. */
const HW_LEAD_IN_SEC = 0.4
const HW_CALIBRATION_KEY = 84
export async function renderHwStem(track, { sampleRate = 48000, durationSec, out, timeoutMs, keepCapture = false, fromPath = null } = {}) {
  if (!out && !fromPath) throw new Error(`renderHwStem needs an output path for "${track.name}"`)
  const port = track.hw?.port
  if (!port) throw new Error(`track "${track.name}" is not a hardware part`)
  const frames = Math.max(1, Math.ceil((Number.isFinite(durationSec) ? durationSec : track.endSec) * sampleRate))
  const notes = notesForHw(track)
  if (notes.length === 0) {
    return { channels: emptyPair(frames), frames, peakDb: null, rmsDb: null, port, warnings: ['the part has no notes'] }
  }
  // The measuring note rides 0.4 s ahead of the music. It never reaches the
  // deliverable: the lead-in is cut away once the capture says where it landed,
  // and what is left is the module sitting exactly on the score's grid.
  const calibrate = track.hw.align !== false
  const leadIn = calibrate ? HW_LEAD_IN_SEC : 0
  const captureFrames = frames + Math.round(leadIn * sampleRate)
  const captureNotes = calibrate
    ? [[0, 0.03, HW_CALIBRATION_KEY, 110], ...notes.map(([start, duration, midi, velocity]) => [start + leadIn, duration, midi, velocity])]
    : notes
  const device = captureDeviceFor(track)
  // An index may arrive as "29". The worker treats a real number as an index and
  // anything else as a name, so a numeric string would match no input at all.
  const deviceArg = /^\d+$/.test(String(device)) ? Number(device) : device
  const configuredLatency = Number(process.env.ANYAUDIO_MIDI_LATENCY_MS)
  const latencyMs = Number.isFinite(track.hw.latencyMs)
    ? track.hw.latencyMs
    : (Number.isFinite(configuredLatency) ? Math.max(0, configuredLatency) : 0)
  const warnings = []
  // The mix pass already recorded this part, so a stems pass reads that take
  // back instead of playing the module a second time. Recording twice doubles
  // the wall clock on a real module, and on a long score the second take is the
  // one that comes back empty.
  if (fromPath) {
    const reused = parseWav(await readFile(fromPath))
    const raw = fitChannels(reused.channels, captureFrames)
    const peakAt = calibrate ? firstPeakOffset(raw, sampleRate) : null
    const drop = peakAt !== null ? peakAt + leadIn : (latencyMs / 1000) + leadIn
    const alignMs = Math.round(drop * 1000)
    shiftChannels(raw, drop, sampleRate)
    if (calibrate && peakAt === null) {
      warnings.push(`the measuring note did not come back, so the take was trimmed by the latency setting (${Math.round(latencyMs)} ms) instead`)
    }
    const channels = fitChannels(raw, frames)
    const mixGain = Number.isFinite(track.mixGain) ? track.mixGain : 1
    if (mixGain !== 1) {
      for (const channel of channels) for (let i = 0; i < channel.length; i++) channel[i] *= mixGain
    }
    if (reused.frames !== captureFrames) {
      warnings.push(`the capture was ${reused.frames} frames instead of ${captureFrames}; padded or trimmed to fit`)
    }
    return {
      channels,
      frames,
      peakDb: toDb(peakOf(channels)),
      rmsDb: toDb(rmsOf(channels)),
      port,
      device,
      latencyMs,
      alignMs,
      warnings,
    }
  }
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
  if (!calibrate && !(latencyMs > 0)) {
    warnings.push(
      'alignment is off for this part and no latency was given, so the audio may start a few tens of milliseconds late. '
      + 'Either drop hw.align or run anyaudio_midiout action "calibrate" and put the measured number in latencyMs.',
    )
  }
  try {
    const reply = await playMidi({
      port,
      notes: captureNotes,
      channel: track.hw.channel,
      program: track.hw.program,
      controls: controlsForHw(track),
      durationSec: captureFrames / sampleRate,
      // The cut is made here, from where the measuring note actually landed,
      // so the worker is asked to leave the capture alone.
      capture: { device: deviceArg, channels: 2, sampleRate, durationSec: captureFrames / sampleRate, trimLatencyMs: 0, out },
      timeoutMs: timeoutMs ?? Math.round((captureFrames / sampleRate) * 1000) + 60000,
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
    const raw = fitChannels(parsed.channels, captureFrames)
    const peakAt = calibrate ? firstPeakOffset(raw, sampleRate) : null
    const drop = peakAt !== null ? peakAt + leadIn : (latencyMs / 1000) + leadIn
    const alignMs = Math.round(drop * 1000)
    shiftChannels(raw, drop, sampleRate)
    if (calibrate && peakAt === null) {
      warnings.push(`the measuring note did not come back, so the take was trimmed by the latency setting (${Math.round(latencyMs)} ms) instead`)
    }
    const channels = fitChannels(raw, frames)
    const mixGain = Number.isFinite(track.mixGain) ? track.mixGain : 1
    if (mixGain !== 1) {
      for (const channel of channels) for (let i = 0; i < channel.length; i++) channel[i] *= mixGain
    }
    if (parsed.frames !== captureFrames) {
      warnings.push(`the capture was ${parsed.frames} frames instead of ${captureFrames}; padded or trimmed to fit`)
    }
    return {
      channels,
      frames,
      peakDb: capture.silent ? null : toDb(peakOf(channels)),
      rmsDb: capture.silent ? null : toDb(rmsOf(channels)),
      port: reply.port ?? port,
      device: capture.device ?? device,
      latencyMs,
      alignMs,
      warnings,
    }
  } finally {
    if (!keepCapture) await rm(out, { force: true })
  }
}

/**
 * Render every hardware part, one at a time, and sum them. A failing module is
 * reported and skipped — the rest of the score still renders, and a person is
 * told which wire to check.
 */
export async function renderHwTracks(compiled, { sampleRate, durationSec, makeScratch, timeoutMs, onPart, keepCaptures = false, onCapture = null } = {}) {
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
      const capturePath = makeScratch(track)
      const stem = await renderHwStem(track, { sampleRate: rate, durationSec: total, out: capturePath, timeoutMs, keepCapture: keepCaptures })
      if (keepCaptures && onCapture) onCapture(track.name, capturePath)
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
