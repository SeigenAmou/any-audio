// A score part can name a VST3 plugin instead of a SoundFont preset.
//
// The two worlds cannot share one synth pass. spessasynth mixes every SoundFont
// track through one processor so reverb and chorus behave like a real ensemble;
// a plugin is its own instrument living in its own process. So a VST part is
// rendered by the bridge on its own and summed onto the SoundFont mix
// afterwards. That also means the two halves are normalised together, once, at
// the end — normalising each side separately would restore the balance the
// score asked for only by accident.
//
// Nothing here loads a plugin in-process: every render goes through
// `renderVst`, which owns a child process and a hard deadline.

import { readFile, rm } from 'node:fs/promises'
import { peakOf, parseWav, rmsOf, toDb } from './wav.js'
import { renderCompiled } from './synth.js'
import { renderVst, renderVstBatch } from './vst-host.js'
import { renderHwTracks } from './hw-track.js'

/** A VST part is rendered one plugin process at a time; 20k notes is already
 *  far past what a single part should carry, and the limit turns a runaway
 *  score into a sentence instead of a stalled child. */
export const MAX_VST_NOTES = 20000

/** Every track that asked for a plugin, in score order. */
export function vstTracksOf(compiled) {
  return compiled.tracks.filter((track) => track.vst && track.vst.plugin)
}

/** The bridge's note list: [startSec, durationSec, midi, velocity]. */
export function notesForVst(track) {
  if (track.notes.length > MAX_VST_NOTES) {
    throw new Error(
      `track "${track.name}" has ${track.notes.length} notes; a VST part renders at most ${MAX_VST_NOTES} per call`,
    )
  }
  return track.notes.map((note) => [note.start, note.duration, note.midi, note.velocity])
}

/** CC events the plugin should hear. `automation` in the score becomes track
 *  events, so a VST part keeps the syntax a SoundFont part already has. */
export function controlsForVst(track) {
  const events = track.events.filter((event) => event.type === 'cc')
  const explicit = Array.isArray(track.vst?.controls) ? track.vst.controls : []
  const merged = [...events.map((event) => [event.t, event.controller, event.value]), ...explicit]
  merged.sort((a, b) => a[0] - b[0])
  return merged
}

function emptyPair(frames) {
  return [new Float32Array(frames), new Float32Array(frames)]
}

/** Fit a rendered channel pair into exactly `frames` samples: longer tails are
 *  cut, shorter renders are padded with silence. A plugin that ignores the
 *  requested duration must not move the rest of the score. */
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

/** Turn one worker reply plus the WAV it wrote into a channel pair of exactly
 *  `frames` samples. The scratch file goes away whether or not the read works. */
async function stemFromRender(track, { out, frames, reply }) {
  try {
    const parsed = parseWav(await readFile(out))
    const channels = fitChannels(parsed.channels, frames)
    // `gainDb` means the same thing it means for a SoundFont part; a plugin has
    // no CC7 to carry it, so the equivalent linear gain is applied here.
    const mixGain = Number.isFinite(track.mixGain) ? track.mixGain : 1
    if (mixGain !== 1) {
      for (const channel of channels) for (let i = 0; i < channel.length; i++) channel[i] *= mixGain
    }
    return {
      channels,
      frames,
      peakDb: toDb(peakOf(channels)),
      rmsDb: toDb(rmsOf(channels)),
      plugin: track.vst?.plugin,
      warnings: [
        ...(reply?.warnings ?? []),
        ...(parsed.frames !== frames ? [`the plugin rendered ${parsed.frames} frames instead of ${frames}; padded or trimmed to fit`] : []),
      ],
    }
  } finally {
    await rm(out, { force: true })
  }
}

/**
 * Render one VST track to a channel pair. `out` is a scratch WAV path the
 * bridge writes; it is removed before returning, whether or not the render
 * worked.
 */
export async function renderVstStem(track, { sampleRate = 48000, durationSec, out, timeoutMs } = {}) {
  if (!out) throw new Error(`renderVstStem needs an output path for "${track.name}"`)
  const plugin = track.vst?.plugin
  if (!plugin) throw new Error(`track "${track.name}" is not a VST part`)
  const frames = Math.max(1, Math.ceil((Number.isFinite(durationSec) ? durationSec : track.endSec) * sampleRate))
  const notes = notesForVst(track)
  if (notes.length === 0) {
    // A part with no notes is silence, not an error: a person may have muted it
    // by deleting the notes and still wants the rest of the score to render.
    return { channels: emptyPair(frames), frames, peakDb: null, rmsDb: null, plugin, warnings: ['the part has no notes'] }
  }
  try {
    const reply = await renderVst({
      plugin,
      notes,
      controls: controlsForVst(track),
      params: track.vst?.params,
      durationSec: frames / sampleRate,
      sampleRate,
      out,
      timeoutMs,
    })
    return await stemFromRender(track, { out, frames, reply })
  } finally {
    await rm(out, { force: true })
  }
}

/**
 * Render every VST track and sum them into one pair. Parts of the same plugin
 * share one worker process (the worker keeps a loaded plugin per path), while
 * a different plugin gets its own process — so one synth that wedges its
 * loader cannot take the others down with it. A failing part is reported and
 * skipped: one unlicensed synth must not take the whole score down, and
 * pretending it rendered silence without saying so would be worse.
 */
export async function renderVstTracks(compiled, { sampleRate, durationSec, makeScratch, timeoutMs } = {}) {
  const tracks = vstTracksOf(compiled)
  if (tracks.length === 0) return null
  const rate = sampleRate ?? compiled.sampleRate ?? 48000
  const total = Math.max(0.1, Number.isFinite(durationSec) ? durationSec : compiled.durationSec)
  const frames = Math.ceil(total * rate)
  const mixed = emptyPair(frames)
  const parts = []
  const errors = []

  const groups = new Map()
  for (const track of tracks) {
    const plugin = track.vst.plugin
    if (!groups.has(plugin)) groups.set(plugin, [])
    groups.get(plugin).push(track)
  }

  for (const [plugin, group] of groups) {
    const jobs = []
    for (const track of group) {
      let notes
      try {
        notes = notesForVst(track)
      } catch (error) {
        errors.push({ name: track.name, plugin, message: error.message, code: error.code ?? 'VST_ERROR' })
        continue
      }
      if (notes.length === 0) {
        parts.push({ name: track.name, plugin, peakDb: null, rmsDb: null, warnings: ['the part has no notes'] })
        continue
      }
      jobs.push({ track, notes, out: makeScratch(track) })
    }
    if (jobs.length === 0) continue

    let replies
    try {
      replies = await renderVstBatch(jobs.map((job) => ({
        plugin,
        notes: job.notes,
        controls: controlsForVst(job.track),
        params: job.track.vst?.params,
        durationSec: total,
        sampleRate: rate,
        out: job.out,
      })), { timeoutMs })
    } catch (error) {
      // The process died or ran out of time: every part in this group shares
      // that fate, and each one says so by name.
      for (const job of jobs) {
        errors.push({ name: job.track.name, plugin, message: error.message, code: error.code ?? 'VST_ERROR' })
        await rm(job.out, { force: true }).catch(() => {})
      }
      continue
    }

    for (let index = 0; index < jobs.length; index++) {
      const job = jobs[index]
      const reply = replies[index]
      if (!reply || reply.ok !== true) {
        errors.push({
          name: job.track.name,
          plugin,
          message: reply?.error ?? 'the worker said nothing for this part',
          code: reply?.kind === 'render' ? 'RENDER_FAILED' : 'VST_ERROR',
        })
        await rm(job.out, { force: true }).catch(() => {})
        continue
      }
      try {
        const stem = await stemFromRender(job.track, { out: job.out, frames, reply })
        for (let ch = 0; ch < 2; ch++) {
          const source = stem.channels[ch]
          for (let i = 0; i < frames; i++) mixed[ch][i] += source[i]
        }
        parts.push({ name: job.track.name, plugin, peakDb: stem.peakDb, rmsDb: stem.rmsDb, warnings: stem.warnings })
      } catch (error) {
        errors.push({ name: job.track.name, plugin, message: error.message, code: 'VST_ERROR' })
      }
    }
  }
  return { channels: mixed, frames, parts, errors }
}

function normalise(channels, peakDb) {
  const peak = peakOf(channels)
  if (!(peak > 0) || !Number.isFinite(peakDb)) return { appliedGain: 1, peakBeforeDb: toDb(peak) }
  const appliedGain = Math.pow(10, peakDb / 20) / peak
  for (const channel of channels) for (let i = 0; i < channel.length; i++) channel[i] *= appliedGain
  return { appliedGain, peakBeforeDb: toDb(peak) }
}

/**
 * Render a score that mixes SoundFont parts with parts that sound elsewhere
 * (a plugin process, a hardware module), and return the same shape as
 * `renderCompiled`. The SoundFont half is rendered without normalisation, every
 * outside half is summed on top, and only then is the master gain applied — see
 * the header note on why.
 *
 * Hardware parts are rendered last and one at a time: they are the only ones
 * that take real time, and the caller may want to say so between them.
 */
export async function renderMixWithParts(compiled, {
  soundFontOptions = {},
  sampleRate,
  durationSec,
  peakDb = -3,
  normalize = true,
  makeScratch,
  timeoutMs,
  onHwPart,
} = {}) {
  const rate = sampleRate ?? compiled.sampleRate ?? 48000
  const total = Math.max(0.1, Number.isFinite(durationSec) ? durationSec : compiled.durationSec)
  const frames = Math.ceil(total * rate)
  const vst = await renderVstTracks(compiled, { sampleRate: rate, durationSec: total, makeScratch, timeoutMs })
  const hw = await renderHwTracks(compiled, { sampleRate: rate, durationSec: total, makeScratch, timeoutMs, onPart: onHwPart })
  // A score made only of outside parts has no SoundFont half to render, and
  // asking `renderCompiled` for one would throw on the empty bank list.
  const hasFontPart = compiled.tracks.some((track) => !(track.vst && track.vst.plugin) && !track.hw)
  const soundfont = hasFontPart
    ? await renderCompiled(compiled, {
      ...soundFontOptions,
      sampleRate: rate,
      durationSec: total,
      normalize: false,
    })
    : null
  const channels = emptyPair(frames)
  for (let ch = 0; ch < 2; ch++) {
    const fromFont = soundfont?.channels[ch]
    const fromVst = vst?.channels[ch]
    const fromHw = hw?.channels[ch]
    for (let i = 0; i < frames; i++) {
      channels[ch][i] = (fromFont?.[i] ?? 0) + (fromVst?.[i] ?? 0) + (fromHw?.[i] ?? 0)
    }
  }
  const gain = normalize ? normalise(channels, peakDb) : { appliedGain: 1, peakBeforeDb: toDb(peakOf(channels)) }
  return {
    channels,
    sampleRate: rate,
    durationSec: frames / rate,
    frames,
    appliedGain: gain.appliedGain,
    peakBeforeDb: gain.peakBeforeDb,
    peakDb: toDb(peakOf(channels)),
    rmsDb: toDb(rmsOf(channels)),
    brokenSamples: (soundfont?.brokenSamples ?? 0),
    notes: compiled.tracks.reduce((sum, track) => sum + track.notes.length, 0),
    voices: soundfont?.voices ?? 0,
    vstParts: vst?.parts ?? [],
    vstErrors: vst?.errors ?? [],
    hwParts: hw?.parts ?? [],
    hwErrors: hw?.errors ?? [],
  }
}

/** Kept for callers that only know about plugins; it is the same render. */
export async function renderMixWithVst(compiled, options = {}) {
  if (vstTracksOf(compiled).length === 0) {
    throw new Error('renderMixWithVst was called on a score with no VST parts')
  }
  return renderMixWithParts(compiled, options)
}
