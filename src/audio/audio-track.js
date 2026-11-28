import { readFile } from 'node:fs/promises'
import { conformChannels, fromDb, padOrTrim, parseWav, peakOf, resample, rmsOf, toDb } from './wav.js'

/**
 * A part that is already a recording: a field recording, a vocal take, a loop
 * someone rendered elsewhere. It is not played by anything, so it has no
 * program, no channel and no bank — the file IS the part, and the score only
 * says where it sits and how loud it is.
 *
 * `path` is resolved by the caller (the tool knows the workspace; this module
 * does not), so everything here is a straight file read.
 */
export function audioTracksOf(compiled) {
  return compiled.tracks.filter((track) => track.audio && track.audio.path)
}

/** Equal-power pan, the same law the mixer uses elsewhere. */
function panGains(pan) {
  const value = Math.max(-1, Math.min(1, Number(pan) || 0))
  const angle = ((value + 1) / 2) * (Math.PI / 2)
  return [Math.cos(angle), Math.sin(angle)]
}

/**
 * Read one recorded part and hand back two channels at the render's rate and
 * length. Nothing is written: the caller decides whether this is a stem or one
 * contribution to the mix, so the same read serves both.
 */
export async function loadAudioPart(track, { sampleRate, durationSec }) {
  const label = track.name ?? 'audio'
  const file = track.audio.path
  let buffer
  try {
    buffer = await readFile(file)
  } catch (error) {
    throw new Error(`track "${label}": cannot read ${file}: ${error.message}`)
  }
  const wav = parseWav(buffer)
  if (!wav.channels.some((channel) => channel.some((value) => value !== 0))) {
    throw new Error(`track "${label}": ${file} is silent (every sample is zero)`)
  }
  let channels = wav.channels
  if (wav.sampleRate !== sampleRate) channels = resample(channels, wav.sampleRate, sampleRate)
  channels = conformChannels(channels, 2)
  const frames = Math.max(1, Math.ceil(durationSec * sampleRate))
  channels = padOrTrim(channels, frames)
  const gain = fromDb(Number.isFinite(track.audio.gainDb) ? track.audio.gainDb : (track.gainDb ?? 0)) * (track.mixGain ?? 1)
  const [left, right] = panGains(track.audio.pan ?? track.pan ?? 0)
  const out = [new Float32Array(channels[0].length), new Float32Array(channels[0].length)]
  for (let i = 0; i < out[0].length; i += 1) {
    out[0][i] = channels[0][i] * gain * left
    out[1][i] = (channels[1] ?? channels[0])[i] * gain * right
  }
  return {
    channels: out,
    sampleRate,
    frames: out[0].length,
    sourceSampleRate: wav.sampleRate,
    sourceFrames: wav.channels[0].length,
    warnings: wav.sampleRate !== sampleRate
      ? [`track "${label}": ${file} is ${wav.sampleRate} Hz and was resampled to ${sampleRate} Hz`]
      : [],
  }
}

/**
 * Sum every recorded part. Unlike the plugin paths there is no subprocess and
 * no host: a wav is read and scaled, which is why this one is fast.
 */
export async function renderAudioTracks(compiled, { sampleRate, durationSec }) {
  const tracks = audioTracksOf(compiled)
  const frames = Math.max(1, Math.ceil(durationSec * sampleRate))
  const mixed = [new Float32Array(frames), new Float32Array(frames)]
  const parts = []
  const errors = []
  for (const track of tracks) {
    try {
      const part = await loadAudioPart(track, { sampleRate, durationSec })
      for (let i = 0; i < frames; i += 1) {
        mixed[0][i] += part.channels[0][i] ?? 0
        mixed[1][i] += part.channels[1][i] ?? 0
      }
      const peak = peakOf(part.channels)
      const rms = rmsOf(part.channels)
      parts.push({
        name: track.name,
        kind: 'audio',
        file: track.audio.path,
        frames: part.frames,
        peakDb: peak <= 0 ? -120 : toDb(peak),
        rmsDb: rms <= 0 ? -120 : toDb(rms),
        warnings: part.warnings,
      })
    } catch (error) {
      errors.push({ name: track.name, error: error.message })
    }
  }
  return { mixed, parts, errors }
}
