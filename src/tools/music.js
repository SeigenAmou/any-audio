import { existsSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { loadCatalog, planFonts, resolveConfiguredDefault, resolveFontSource } from '../audio/banks.js'
import { accumulateInto, dbToGain, panGains } from '../audio/mix.js'
import { ScoreError, compileScore } from '../audio/score.js'
import { renderCompiled } from '../audio/synth.js'
import { mergedCatalog } from '../audio/vst3-catalog.js'
import { createVst3Process } from '../audio/vst3-process.js'
import { scanPluginTimbres } from '../audio/vst3-presets.js'
import { KEYSWITCH_HOLD_SEC, KEYSWITCH_LEAD_SEC } from '../audio/vst3-techniques.js'
import { conformChannels, padOrTrim, parseWav, peakOf, resample, rmsOf, toDb } from '../audio/wav.js'
import { barStartSeconds, encodeMidiFile, parseMidiFile, scoreFromMidi } from '../audio/midi-file.js'
import { renderScore } from '../audio/renderers.js'
import { renderMixWithParts, renderVstStem, vstTracksOf } from '../audio/vst-track.js'
import { hwTracksOf, renderHwStem } from '../audio/hw-track.js'
import { resolveScorePresets } from '../audio/vst-preset.js'
import { readConfig } from '../config.js'
import { attachMaterialFile } from '../project/attach.js'
import { projectDir } from '../project/paths.js'
import { renderVst3Stem } from './instrument.js'
import { deliverCopy, deliveryPath, finalizeTool, nowStamp, readJsonParam, relativeToWorkspace, requireProjectId, resolveOutputPath, scratchPath, seconds as clampSeconds, textRenderer, workspaceRootOf, writeWavFile } from './shared.js'

/**
 * What made this part: the hosted plugin, the hardware module, or the font.
 *
 * A stem carries it into the project so the clip bay can say "VST · JUNO-106"
 * on the track head instead of leaving a person to remember which of seven
 * identically named stems came from the plugin they just opened.
 */
function originOf(track, layout) {
  if (track.vst) {
    return {
      kind: 'vst',
      plugin: basename(track.vst.plugin),
      path: track.vst.plugin,
      preset: track.vst.preset ?? null,
    }
  }
  if (track.hw) return { kind: 'hw', port: track.hw.port, device: track.hw.captureDevice ?? null }
  const program = layout?.get(track.name)
  return { kind: 'font', instrument: track.instrument ?? null, program: program?.program ?? null }
}

/** `midiFile:` is the read that anyaudio_midi action "import" does, without the round trip through a .json file: a .mid is already an arrangement, so hand it straight to the renderer. */
function parseBarRange(spec) {
  const text = String(spec ?? '').trim()
  const match = /^(\d+)\s*(?:-\s*(\d+))?$/.exec(text)
  if (!match) throw new Error(`"bars" must look like "37-39" or "37", got "${text}"`)
  const from = Number(match[1])
  const to = match[2] ? Number(match[2]) : from
  if (!(from >= 1)) throw new Error(`"bars" counts from 1, got ${from}`)
  if (to < from) throw new Error(`"bars" needs the end after the start, got "${text}"`)
  return { from, to }
}

/** Keep the bars a caller asked for and move them to zero; a long note that runs
 *  past the last bar is cut there instead of bleeding in from outside. */
function sliceScoreByBars(score, parsed, { bars, pad = 0, beatsPerBar = 4 }) {
  const { from, to } = parseBarRange(bars)
  const starts = barStartSeconds(parsed, beatsPerBar)
  if (starts.length === 0) throw new Error('this .mid has no bars to slice')
  if (from > starts.length) {
    throw new Error(`"bars" asks for bar ${from} but this .mid has ${starts.length} bar(s)`)
  }
  const padBars = Math.max(0, Math.round(Number(pad) || 0))
  const first = Math.max(1, from - padBars)
  const last = Math.min(starts.length, to + padBars)
  const t0 = starts[first - 1]
  const t1 = last < starts.length ? starts[last] : Math.max(score.durationSec, starts[last - 1])
  const tracks = score.tracks.map((track) => ({
    ...track,
    notes: track.notes
      .filter(([start]) => start >= t0 - 1e-6 && start < t1 - 1e-6)
      .map(([start, duration, midi, velocity]) => [
        Number((start - t0).toFixed(4)),
        Number(Math.max(0, Math.min(duration, t1 - start)).toFixed(4)),
        midi,
        velocity,
      ])
      .filter(([, duration]) => duration > 1e-4),
  }))
  const kept = tracks.reduce((sum, track) => sum + track.notes.length, 0)
  return {
    ...score,
    title: `${score.title} (bars ${first}-${last})`,
    tracks,
    durationSec: Number((t1 - t0).toFixed(6)),
    bars: { from: first, to: last, beatPerBar: beatsPerBar, notes: kept },
  }
}

export async function scoreFromMidiPath(value, workspaceRoot, { bars = null, pad = 0, beatsPerBar = 4 } = {}) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) throw new Error('pass "midiFile": the .mid file to render')
  const path = isAbsolute(text) ? text : resolve(workspaceRoot, text)
  let buffer
  try {
    buffer = await readFile(path)
  } catch (error) {
    throw new Error(`cannot read ${path}: ${error.message}`)
  }
  const parsed = parseMidiFile(buffer)
  const score = scoreFromMidi(parsed, { title: basename(path, extname(path)) })
  return bars === null || bars === undefined ? score : sliceScoreByBars(score, parsed, { bars, pad, beatsPerBar })
}

function describeTracks(tracks) {
  return tracks
    .map((track) => {
      const kind = track.sourceKind === 'vst3' ? ' (vst3)' : ''
      const preset = track.preset && track.sourceKind !== 'vst3' ? `, preset: ${track.preset}` : ''
      const fallback = track.fallback ? ', fallback' : ''
      const source = track.source ? ` [source: ${track.source}${kind}${preset}${fallback}]` : ''
      const level = Number.isFinite(track.rmsDb) ? `, ${track.rmsDb.toFixed(1)} dBFS RMS` : ''
      // A VST3 track's instrument field is not what plays — the plugin's preset
      // is. Printing "piano" for a guitar plugin reads as a mistake.
      const label = track.sourceKind === 'vst3'
        ? (track.preset ? `preset:${track.preset}` : 'default preset')
        : `${track.instrument}${track.drums ? ' (drum kit)' : ''}${Number.isFinite(track.bank) && track.bank !== 0 ? ` (program ${track.program}, bank ${track.bank})` : ''}`
      return `- ${track.name}: ${label}${source}, ${track.notes} notes, ${track.endSec.toFixed(2)}s${level}`
    })
    .join('\n')
}

/**
 * One synthesis per track, in one pass, for both the level and the stem files.
 *
 * `anyaudio_music` mixes every track through a single synth, so a track's own
 * level exists only if that track is synthesised on its own (improvement plan
 * 03, I-35 — the "renderer is already per track" assumption was wrong, it
 * described `project/render.js`, not this one). That makes the cost N extra
 * syntheses; what must never happen is paying it *twice*, which is exactly what
 * a separate "measure" pass beside a separate "write stems" pass would do.
 *
 * `renderOne` is injected so the test can count calls with a stub instead of
 * rendering twelve tracks of real audio.
 */
export async function eachTrackStem(compiled, { renderOne, gain = 1, onStem = null }) {
  const levels = new Map()
  const gainDb = Number.isFinite(gain) && gain > 0 ? 20 * Math.log10(gain) : 0
  let rendered = 0
  for (const track of compiled.tracks) {
    // A track with no notes can only render silence. Synthesising it to learn
    // that would spend a full pass to produce −Infinity, which JSON cannot even
    // carry — so it is skipped and simply has no level to report.
    if (!track.notes?.length) continue
    const stem = await renderOne(track)
    rendered++
    // The level is kept even when it is −Infinity: that value is how a track that
    // did play but came out silent (a dB-written automation curve, say) is
    // reported as silent rather than as "quiet". The reply filters it out of the
    // numbers and explains it in a warning instead.
    const level = { peakDb: stem.peakDb + gainDb, rmsDb: stem.rmsDb + gainDb }
    levels.set(track.name, level)
    if (!onStem) continue
    const channels = gain === 1 ? stem.channels : stem.channels.map((channel) => channel.map((sample) => sample * gain))
    await onStem(track, channels, level)
  }
  return { levels, rendered }
}

/** Notes and CC11 for the VST3 sidecar: the target notes, a short keyswitch
 *  note before each note that names an articulation, and the track's expression
 *  curve. Only the expression controller is handed over — the mix CCs (volume,
 *  pan, sends) are applied to the rendered audio instead, because a plugin is
 *  not obliged to map them. The keyswitch pitches are returned too, so the
 *  sidecar's range check can exempt them.
 *
 *  The curve's last point is the end of a note, which can sit exactly on the
 *  render length (a part that fills the video). It is kept just inside: the tail
 *  is truncated anyway, but the sidecar refuses a message at t >= duration and
 *  would fail the whole track over a controller nobody would hear.
 *
 *  Exported so the wiring can be tested without a real plugin. */
export function vst3NoteEvents(track, durationSec) {
  const keyswitches = new Map((track.vst3?.articulations ?? []).map((item) => [item.id, item.keyswitch]))
  const notes = []
  const usedKeyswitches = new Set()
  for (const note of track.notes) {
    const keyswitch = note.art ? keyswitches.get(note.art) : undefined
    if (keyswitch !== undefined) {
      usedKeyswitches.add(keyswitch)
      notes.push({
        pitch: keyswitch,
        start: Math.max(0, note.start - KEYSWITCH_LEAD_SEC),
        dur: KEYSWITCH_HOLD_SEC,
        vel: 100,
      })
    }
    notes.push({ pitch: note.midi, start: note.start, dur: note.duration, vel: note.velocity })
  }
  const latest = Number.isFinite(Number(durationSec)) ? Math.max(0, Number(durationSec) - 1e-3) : Infinity
  const ccs = track.events
    .filter((event) => event.type === 'cc' && event.controller === 11)
    .map((event) => ({ t: Math.min(event.t, latest), controller: 11, value: event.value }))
  return { notes, keyswitches: [...usedKeyswitches], ccs }
}

/**
 * One line per source for the "name a source" error: the ids to choose from, and
 * for a VST3 source the timbre names its `preset` field takes. A source whose
 * presets were never scanned is scanned here, so the error is enough on its own.
 */
async function describeSources(fonts, plugins, timbresOf) {
  const lines = []
  for (const font of fonts) lines.push(`- [SF2] ${font.id} — ${font.name}`)
  for (const entry of plugins) {
    const names = (await timbresOf(entry)).map((timbre) => timbre.name)
    lines.push(
      `- [VST3] ${entry.id} — ${entry.name}`
      + (names.length > 0 ? `; preset: ${names.join(', ')}` : '; no presets found (omit preset)'),
    )
  }
  return lines.length > 0 ? lines.join('\n') : '(no source is installed)'
}

/**
 * The timbres a VST3 source offers: the list the settings page scanned into the
 * config, or a fresh scan when nothing was stored yet. Cached per plugin path so
 * one render scans each source at most once.
 */
function timbreLookup() {
  const cache = new Map()
  return async (entry) => {
    const key = String(entry.plugin).toLowerCase()
    if (cache.has(key)) return cache.get(key)
    const stored = entry.timbres ?? []
    const timbres = stored.length > 0 ? stored : await scanPluginTimbres(entry.plugin)
    cache.set(key, timbres)
    return timbres
  }
}

/**
 * Resolve every track's `source` to a VST3 instrument or an installed SoundFont,
 * and a VST3 track's `preset` to the state file the sidecar loads.
 *
 * Nothing is picked automatically: a program cannot know which of the installed
 * instruments a name means, so the caller chooses from the real list
 * (anyaudio_sources action "list"). A track with no source, with a source that
 * is neither a catalog VST3 id nor an installed font, or with a preset its
 * source does not offer, fails here and the error carries the list to choose
 * from.
 *
 * Exported so the failure can be tested without uninstalling a real plugin.
 */
export async function selectSources(compiled, { catalog = null, fonts = null, workspaceRoot } = {}) {
  const resolvedCatalog = catalog ?? await mergedCatalog()
  const vst3ById = new Map(resolvedCatalog.plugins.map((entry) => [entry.id, entry]))
  const fontCatalog = fonts ?? await loadCatalog()
  const timbresOf = timbreLookup()
  const warnings = []
  const problems = []

  for (const track of compiled.tracks) {
    // Our own plugin and hardware parts name their sound source directly — a
    // plugin path or a MIDI port — so the catalog check does not apply to them.
    if (track.vst || track.hw) continue
    let source = typeof track.source === 'string' ? track.source.trim() : ''
    if (!source) {
      // A score written before source was required still has to play: fall back
      // to the first installed font and say which one was used, rather than
      // refusing a score that worked yesterday.
      const fallback = fontCatalog.find((font) => font.id === 'generaluser') ?? fontCatalog[0]
      if (!fallback) {
        problems.push(`track "${track.name}" names no source and no SoundFont is installed`)
        continue
      }
      source = fallback.id
      track.source = fallback.id
      warnings.push(`track "${track.name}": no source named — rendered with "${fallback.id}"`)
    }
    const explicit = vst3ById.get(source)
    if (explicit) {
      // A drum track may name a VST3 instrument too: its GM drum-map pitches go
      // straight to the plugin, which decides what each key plays.
      if (!existsSync(explicit.plugin)) {
        track.vst3 = null
        track.vst3Fallback = true
        track.source = 'auto'
        warnings.push(
          `track "${track.name}": VST3 source "${explicit.id}" is not installed (${explicit.plugin}); `
          + 'rendered with the SoundFont fallback instead',
        )
        continue
      }
      track.vst3 = explicit
      // A VST3 track's timbre is the plugin preset; an instrument name there is
      // ignored, and silently ignoring it would let the caller believe its
      // choice took effect.
      if (track.instrumentExplicit) {
        warnings.push(
          `track "${track.name}": instrument "${track.instrument}" does not apply to a VST3 source — `
          + 'the plugin preset is the timbre; set preset instead',
        )
      }
      if (track.preset) {
        const timbres = await timbresOf(explicit)
        const match = timbres.find((timbre) => timbre.name === track.preset)
          ?? timbres.find((timbre) => timbre.id === track.preset)
        if (!match) {
          problems.push(
            `track "${track.name}": source "${explicit.id}" has no preset "${track.preset}". `
            + (timbres.length > 0
              ? `Its presets: ${timbres.map((timbre) => timbre.name).join(', ')}`
              : 'It offers no presets — omit preset to use its default timbre'),
          )
          continue
        }
        // A parameter-type timbre is a named program value the sidecar sets on
        // the plugin; a state/file timbre is a preset file it loads.
        if (match.kind === 'parameter') {
          track.presetParameter = { parameter: match.parameter, value: match.value }
        } else if (match.kind === 'file') {
          track.presetFile = match.statePath
        } else {
          track.presetPath = match.statePath
        }
      }
      continue
    }
    try {
      await resolveFontSource(source, { workspaceRoot, catalog: fontCatalog })
    } catch (error) {
      problems.push(`track "${track.name}": ${error.message}`)
      continue
    }
    // `preset` is a VST3 timbre; a SoundFont track picks its timbre with
    // `instrument`, so a preset here would be silently dropped otherwise.
    if (track.preset) {
      warnings.push(
        `track "${track.name}": preset "${track.preset}" only applies to a VST3 source; `
        + `"${source}" is a SoundFont, so it was ignored — use instrument for its timbre`,
      )
    }
    // A track that names no timbre renders piano; saying so keeps a forgotten
    // instrument from looking like a deliberate choice.
    if (!track.instrumentExplicit && !track.drums) {
      warnings.push(`track "${track.name}": no instrument named — rendered with the default piano`)
    }
  }

  if (problems.length > 0) {
    throw new ScoreError(
      `${problems.join('\n')}\n`
      + 'Every track must name a source from anyaudio_sources action "list". Available sources:\n'
      + await describeSources(fontCatalog, resolvedCatalog.plugins, timbresOf),
    )
  }

  return {
    sf2Compiled: { ...compiled, tracks: compiled.tracks.filter((track) => !track.vst3) },
    vst3Tracks: compiled.tracks.filter((track) => track.vst3),
    warnings,
  }
}

/** Render one VST3 track to a stem at the mix's sample rate and length. */
async function renderVst3TrackStem(track, { manager, sampleRate, durationSec, workspaceRoot, stamp, index }) {
  const out = scratchPath(workspaceRoot, `vst3-${stamp}-${index}.wav`)
  const events = vst3NoteEvents(track, durationSec)
  // The preset the score's timbre name resolved to; without one the sidecar
  // renders the instrument's own default state.
  const preset = track.presetParameter
    ? { kind: 'parameter', ...track.presetParameter }
    : track.presetFile ? { kind: 'file', path: track.presetFile } : track.presetPath
  const result = await renderVst3Stem({
    plugin: track.vst3.plugin,
    notes: events.notes,
    keyswitches: events.keyswitches,
    ccs: events.ccs,
    preset,
    duration: durationSec,
    out,
    manager,
  })
  let channels
  try {
    const wav = parseWav(await readFile(out))
    channels = conformChannels(wav.channels, 2)
    if (wav.sampleRate !== sampleRate) channels = resample(channels, wav.sampleRate, sampleRate)
  } finally {
    await rm(out, { force: true })
  }
  channels = padOrTrim(channels, Math.ceil(durationSec * sampleRate))
  return {
    channels,
    peakDb: toDb(peakOf(channels)),
    rmsDb: toDb(rmsOf(channels)),
    seconds: result.seconds,
  }
}

/**
 * Render a score that mixes SoundFont tracks and VST3 tracks.
 *
 * The SF2 half is rendered exactly as before, only without its master
 * normalisation; the VST3 stems are added with their own gainDb/pan, and one
 * master normalisation is applied to the combined mix. The VST3 stems are kept
 * so the per-track stem pass does not render them a second time.
 */
async function renderMixedScore({ compiled, sf2Compiled, plan, vst3Tracks, sampleRate, durationSec, peakDb, normalize, workspaceRoot }) {
  const frames = Math.ceil(durationSec * sampleRate)
  const sf2 = sf2Compiled.tracks.length > 0
    ? await renderCompiled(sf2Compiled, {
      banks: plan.banks, layout: plan.layout, sampleRate, durationSec, normalize: false,
    })
    : { channels: [new Float32Array(frames), new Float32Array(frames)], brokenSamples: 0, voices: 0 }
  const acc = [new Float32Array(frames), new Float32Array(frames)]
  accumulateInto(acc, sf2.channels, 0, 1, 1)

  const stamp = nowStamp()
  const manager = createVst3Process()
  const stems = new Map()
  try {
    for (const [index, track] of vst3Tracks.entries()) {
      if (!track.notes?.length) continue
      const stem = await renderVst3TrackStem(track, { manager, sampleRate, durationSec, workspaceRoot, stamp, index })
      stems.set(track.name, stem)
      const gain = dbToGain(track.gainDb)
      const [left, right] = panGains(track.pan)
      accumulateInto(acc, stem.channels, 0, gain * left, gain * right)
    }
  } finally {
    await manager.shutdown().catch(() => {})
  }

  const peakBefore = peakOf(acc)
  let appliedGain = 1
  if (normalize && peakBefore > 0 && Number.isFinite(peakDb)) {
    appliedGain = Math.pow(10, peakDb / 20) / peakBefore
    for (let i = 0; i < frames; i++) {
      acc[0][i] *= appliedGain
      acc[1][i] *= appliedGain
    }
  }
  return {
    channels: acc,
    sampleRate,
    durationSec: frames / sampleRate,
    frames,
    appliedGain,
    peakBeforeDb: toDb(peakBefore),
    peakDb: toDb(peakOf(acc)),
    rmsDb: toDb(rmsOf(acc)),
    brokenSamples: sf2.brokenSamples,
    notes: compiled.tracks.reduce((sum, track) => sum + track.notes.length, 0),
    voices: sf2.voices,
    stems,
  }
}

export const musicToolDefinition = finalizeTool({
  name: 'anyaudio_music',
  description:
    'Render a note score to a WAV file with real SoundFont instruments and VST3 instruments (MIDI-style notes, per-track gain/pan/reverb, optional automation). ' +
    'The rendered music goes into a clip bay project: pass projectId, and it is added as material and placed on its own track (one track per score track when stems:true), so the person can open, hear and adjust it. ' +
    'Call it whenever you are making or editing a video that should have a soundtrack, and prefer it over hand-writing numpy synthesis: acoustic timbres, several instruments, humanised timing. ' +
    'Each track names where its sound comes from: a "source" (an id from anyaudio_sources action "list", a .sf2 path, or "auto" to pick the best-scored installed font for that instrument) — a VST3 track also names its "preset", the timbre from the same list; a source or preset the list does not offer fails and the error carries the available ones. ' +
    'A track may instead hand its part to a hosted plugin: write vst:"<plugin path>" (or vst:{plugin, params, controls, preset, channel, bank, bankLsb}) and that part renders in its own plugin process and is summed onto the SoundFont mix before the single master gain — both halves share gainDb and one normalisation. A score may be all plugins; it then needs no SoundFont at all. VST3 and 64-bit VST2 both work; a 32-bit .dll needs a bridge. ' +
    'Different tracks in one score may use different fonts or sources; SoundFonts are loaded into one synth on non-overlapping bank offsets, and plugin parts render through a local sidecar. ' +
    'Drum kits always come from the default font (the first loaded bank) — pass another kit as "font" if you need it; a kit answers only the keys its own instruments map, and keys it lacks are moved to the nearest one it has (the reply lists the moves). ' +
    'Score format (seconds on the video timeline): {title, tracks:[{name, instrument, source, preset, gainDb, pan, reverb, drums, humanize:{timingMs,velocity}, notes:[[startSec, durSec, pitch|pitches, velocity, art?]]}], automation:[{track, controller, points:[[sec,value]]}], expression:[{type, track, start, end}] for bend, swell, pedal and humanize gestures (the types are listed in the anyaudio-scoring skill)}. ' +
    'The optional fifth note element "art" has two kinds: plugin articulations (VST3 sources only) — "sus", "pm", "ls", "hp", sent as a keyswitch just before the note — and strum gestures (any track) — "strum-down" / "strum-up", which start the chord 18 ms apart; a strum needs a chord (an array of pitches). SoundFont tracks ignore the plugin articulations but honour the strums. ' +
    'Expression (CC11): a note written as an object may add "expr", a single arrival value 0–127; the curve starts at 127 on second 0, each mark arrives when that note ends and holds until the next, so a fade is one number on the last note and a crescendo is a low value early plus 127 later. It is a channel control: every note of that track is pushed together. No "expr" means no CC11 at all. ' +
    'Pitch accepts MIDI numbers or names (D3, F#4, Bb2); instruments accept GM names (piano, cello, strings, koto, shakuhachi, erhu, guzheng), GM program numbers, or an object {program, bank, name} for a patch outside bank 0. ' +
    'Each track\'s gainDb is the level its stem is rendered at. That is a fact about the file, measured and recorded when the stem lands — it is not a mixing knob. To rebalance later, change the clip gain; do not render again. Positive values lift a track above the loudest one (the whole score is shifted instead of clipping). Per-track levels come back on every call (this tool measures them as part of rendering, one synthesis per track), so there is nothing to ask for; a part sitting more than 12 dB under the loudest one gets a warning. ' +
    'Read the anyaudio-scoring skill for arrangement technique and mixing workflow.',
  parameters: {
    type: 'object',
    properties: {
      score: { oneOf: [{ type: 'object' }, { type: 'string' }], description: 'Score object as described above. A path to a .json file holding the same object is also accepted and is the better choice for long scores — keep the notes in a file and pass the path instead of inlining thousands of numbers.' },
      midiFile: { type: 'string', description: 'A .mid file to render instead of "score": it is read into a score here (same as anyaudio_midi action "import") and rendered as-is. Pass exactly one of "score" and "midiFile" ("midi" is a different flag: asking for a .mid export beside the WAV).' },
      bars: { type: 'string', description: 'Only with "midiFile": keep these bars and move them to zero, 1-based and closed ("37-39" is bars 37, 38 and 39). A note that runs past the last bar is cut there. Bar length is "beatsPerBar" quarter notes (default 4), and the file\'s own tempo map decides how long a bar lasts.' },
      pad: { type: 'number', description: 'Only with "bars": also keep this many bars before and after the range, so the caller hears the part in context. Default 0, clamped to the file.' },
      beatsPerBar: { type: 'number', description: 'Only with "bars": quarter notes per bar for the slice, default 4 (4/4). A .mid almost never carries a usable time signature, so say 3 here for a waltz.' },
      projectId: { type: 'string', description: 'The clip bay project this music belongs to. Required: run anyaudio_project mode:"create" first when the task has no project yet. The rendered music is added to the project as material and placed on its own track.' },
      trackName: { type: 'string', description: 'Name of the track to create for this music, default the score title. Ignored with stems:true, where each score track gets its own project track named after it.' },
      startSec: { type: 'number', description: 'Where the music starts on the project timeline, default 0.' },
      output: { type: 'string', description: "Optional extra copy of the rendered WAV at this path. Relative paths resolve against the user's project. The project's own copy is always written under the project folder." },
      font: { type: 'string', description: 'Default SoundFont path or id (.sf2/.sf3/.dls). Used for tracks that resolve to a SoundFont; drum kits always come from it. Defaults to the installed font.' },
      sampleRate: { type: 'number', description: 'Sample rate, default 48000.' },
      dryRun: { type: 'boolean', description: 'Compile the score and report every track — source, note count, first and last note, program, bank, preset — without rendering a single sample. Use it to check an arrangement before spending the render.' },
      durationSec: { type: 'number', description: 'Exact output length. Defaults to last note end + tailSec.' },
      tailSec: { type: 'number', description: 'Extra seconds after the last note for release and reverb, default 2.' },
      peakDb: { type: 'number', description: 'Normalisation peak in dBFS, default -3. Pass null to keep the raw level.' },
      stems: { type: 'boolean', description: 'Also write one WAV per track next to the mix, when stems:true each track gets its own file and trackName is ignored. Stems keep the master\'s relative levels (they are not peak-normalised), so they can be inspected or re-balanced later.' },
      analyze: { type: 'boolean', description: 'Include more per-track detail in the reply (the balance warning and the silence check). Per-track levels are measured on every call and no longer depend on this flag; use it only when you want the detail listed. Measuring costs one extra synthesis per track — measured on a 12-track 64 s score at 48 kHz: mixed render 2.7 s, the twelve per-track passes 13.4 s, so the call takes about 16 s instead of 3 s. That price is paid on every call, so do not call this tool again just to see the balance.' },
      replace: { type: 'boolean', description: 'Replace instead of append. When this music is a second pass at a score the project already holds (you rebalanced the parts and are rendering again), pass true: the track family named after this score is cleared first, so the project keeps one set of stems rather than gaining a second. Without it a re-render appends, which is how a project ends up with "钟琴旋律" and "钟琴旋律 2" side by side.' },
      midi: { oneOf: [{ type: 'boolean' }, { type: 'string' }], description: 'Also write the arrangement as a standard MIDI file: true writes .anyaudio/out/score-<stamp>.mid, or pass a path. Use it when the person wants to edit the parts in a DAW, swap a timbre, or finish the performance by hand. The .mid is an arrangement, not audio — it is not added to the project and the mixer never plays it.' },
      midiBpm: { type: 'number', description: 'The tempo written into the exported .mid, default 120. The score clock is in seconds, so the tempo only decides how many ticks a second is worth; it does not change what is heard.' },
    },
    required: ['projectId'],
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: true,
      properties: {
        ok: { type: 'boolean' },
        file: { type: 'string' },
        absolutePath: { type: 'string' },
        delivered: { type: 'string' },
        deliveredAbsolutePath: { type: 'string' },
        projectId: { type: 'string' },
        attached: { type: 'array', items: { type: 'object', additionalProperties: true } },
        durationSec: { type: 'number' },
        sampleRate: { type: 'number' },
        peakDb: { type: 'number' },
        rmsDb: { type: 'number' },
        font: { type: 'string' },
        fonts: { type: 'array', items: { type: 'object', additionalProperties: true } },
        vst3: { type: 'array', items: { type: 'object', additionalProperties: true } },
        tracks: { type: 'array', items: { type: 'object', additionalProperties: true } },
        stems: { type: 'array', items: { type: 'string' } },
        midi: { type: 'string' },
        warnings: { type: 'array', items: { type: 'string' } },
      },
    },
    render: textRenderer((args, value) => {
      if (value.dryRun) {
        // A dry run is read, not heard: it lists what would be rendered so an
        // arrangement can be checked before a single sample is produced.
        const lines = [`Dry run: ${value.title ?? 'score'} — ${value.tracks.length} track(s), ${Number(value.durationSec || 0).toFixed(2)}s of music`]
        for (const track of value.tracks) {
          const bits = [`[${track.kind}]`, `${track.notes} notes`]
          if (track.firstNoteSec !== null) bits.push(`${Number(track.firstNoteSec).toFixed(2)}–${Number(track.lastNoteSec).toFixed(2)}s`)
          const instrumentText = track.instrument === undefined || track.instrument === null
            ? null
            : String(track.instrument)
          if (instrumentText && !/^program \d+$/.test(instrumentText)) bits.push(`instrument ${instrumentText}`)
          if (track.program !== undefined && track.program !== null) bits.push(`program ${track.program}`)
          if (track.bank !== undefined) bits.push(`bank ${track.bank}`)
          if (track.bankLsb !== undefined) bits.push(`lsb ${track.bankLsb}`)
          if (track.channel !== undefined) bits.push(`ch ${track.channel}`)
          if (track.preset) bits.push(`preset ${track.preset}`)
          if (track.plugin) bits.push(basename(track.plugin))
          if (track.port) bits.push(`port ${track.port}`)
          lines.push(`- ${track.name}: ${bits.join(', ')}`)
        }
        if (value.tempo?.length) lines.push(`Tempo: ${value.tempo.map((entry) => `bar ${entry.bar} ${entry.bpm} BPM ${entry.meter.num}/${entry.meter.den}`).join('; ')}`)
        if (value.warnings?.length) lines.push(`Warnings:
${value.warnings.map((warning) => `- ${warning}`).join('\\n')}`)
        lines.push('Nothing was rendered: drop dryRun to render it.')
        return lines.join('\n')
      }
      const fonts = value.fonts?.length
        ? value.fonts.map((font) => `${font.id}@+${font.offset} (${font.file})`).join(', ')
        : value.font ? basename(value.font) : 'none (plugin parts only)'
      const vst3 = value.vst3?.length ? value.vst3.map((entry) => `${entry.id} (${entry.name})`).join(', ') : ''
      const lines = [
        `Rendered ${value.durationSec.toFixed(2)}s @ ${value.sampleRate} Hz → ${value.file}`,
        `peak ${value.peakDb.toFixed(1)} dBFS, RMS ${value.rmsDb.toFixed(1)} dBFS`,
        `Fonts: ${fonts}${vst3 ? `; VST3: ${vst3}` : ''}`,
        'Tracks:',
        describeTracks(value.tracks ?? []),
      ]
      if (value.stems?.length) lines.push(`Stems (relative levels kept): ${value.stems.join(', ')}`)
      if (value.warnings?.length) lines.push(`Warnings:\n${value.warnings.map((warning) => `- ${warning}`).join('\n')}`)
      const placed = value.attached ?? []
      lines.push(placed.length
        ? `In project ${value.projectId}: ${placed.map((entry) => `${entry.clipId} "${entry.trackName}" @ ${Number(entry.startSec).toFixed(2)}s`).join(', ')}`
        : `In project ${value.projectId}.`)
      if (value.delivered) lines.push(`Delivered copy: ${value.delivered}`)
      if (value.midi) lines.push(`Arrangement: ${value.midi} — a .mid to keep editing elsewhere; it is not audio and not part of the project.`)
      // The point of I-35 is that this sentence exists on every reply. An Agent
      // that does not know the levels are already here calls the tool again to
      // find out, which is the whole "render four times" loop.
      lines.push('Per-track levels above were measured during this render and are recorded in the material index — no second call is needed to see the balance. To change the balance, adjust the clip gain in the project (anyaudio_project, target:"clip", field:"gainDb"); do not render the score again.')
      lines.push('Next: the project holds this music now — add narration and effects with their own projectId, then render the project for the finished file.')
      return lines.join('\n')
    }),
  },
  async execute(args, exec) {
    const workspaceRoot = await workspaceRootOf(exec)
    const projectId = requireProjectId(args, 'anyaudio_music')
    const { config } = await readConfig()
    if (args.midiFile !== undefined && args.score !== undefined) {
      throw new Error('pass "score" or "midi", not both: "midi" is shorthand for reading a .mid into a score')
    }
    if (args.bars !== undefined && args.midiFile === undefined) {
      warnings.push('"bars" only applies to "midiFile": a score is already the slice you wrote')
    }
    const rawScore = args.midiFile !== undefined
      ? await scoreFromMidiPath(args.midiFile, workspaceRoot, {
        bars: args.bars,
        pad: args.pad,
        beatsPerBar: args.beatsPerBar,
      })
      : await readJsonParam(args.score, 'score', { workspaceRoot })
    // A track may point at a saved patch instead of repeating a plugin path and
    // two hundred parameter values. Resolution is async, so it happens here and
    // not inside compileScore.
    const score = await resolveScorePresets(rawScore)
    const sampleRate = Math.round(clampSeconds(args.sampleRate ?? config.music.sampleRate, config.music.sampleRate)) || config.music.sampleRate
    const compiled = compileScore(score, { sampleRate, externals: config.sources?.external ?? [] })
    // VST3 tracks leave the SoundFont planner: the sidecar renders them, and the
    // SF2 synth must never see their events. Every source is resolved here,
    // before any bank is loaded, so a bad one fails without rendering anything.
    const selection = await selectSources(compiled, { workspaceRoot })
    const sf2Compiled = selection.sf2Compiled
    const vst3Tracks = selection.vst3Tracks
    const mixed = vst3Tracks.length > 0
    const tailSec = clampSeconds(args.tailSec ?? config.music.tailSec, config.music.tailSec)
    const durationSec = clampSeconds(args.durationSec, compiled.durationSec + tailSec)
    const explicitFont = typeof args.font === 'string' && args.font.trim() ? args.font.trim() : ''
    let fontPath = explicitFont || undefined
    let defaultNote = null
    if (!explicitFont && config.music.font) {
      // A saved default whose file is gone must not break every render: fall
      // back to the installed default and say so.
      const resolved = await resolveConfiguredDefault(config.music.font, { workspaceRoot })
      fontPath = resolved.path
      if (resolved.stale) {
        defaultNote = `the saved default sound source "${resolved.configured}" is no longer installed; used ${basename(resolved.path)} instead — pick another default with anyaudio_sources action "use"`
      }
    }
    const plan = await planFonts(mixed ? sf2Compiled : compiled, { workspaceRoot, fontPath })
    if (args.dryRun === true) {
      // A dry run answers "what will this sound like and with what" without
      // touching an audio device, a plugin or a bank: it is the arrangement
      // view a person can read before paying for the render.
      const described = compiled.tracks.map((track) => {
        const notes = track.notes ?? []
        const first = notes.length ? Math.min(...notes.map((note) => note.start)) : null
        const last = notes.length ? Math.max(...notes.map((note) => note.start + note.duration)) : null
        return {
          name: track.name,
          kind: track.vst3 ? 'vst3' : track.vst ? 'vst' : track.hw ? 'hw' : 'font',
          notes: notes.length,
          firstNoteSec: first,
          lastNoteSec: last,
          instrument: track.vst ? undefined : track.vst3 ? track.source : track.hw ? undefined : track.instrument,
          program: track.vst3 ? undefined : track.program,
          bank: track.vst ? track.vst.bank ?? undefined : track.bank,
          bankLsb: track.vst ? track.vst.bankLsb ?? undefined : undefined,
          channel: track.channel,
          preset: track.vst ? track.vst.preset ?? undefined : track.vst3 ? track.preset : undefined,
          plugin: track.vst ? track.vst.plugin : undefined,
          port: track.hw ? track.hw.port : undefined,
          gainDb: track.gainDb,
          pan: track.pan,
        }
      })
      return {
        ok: true,
        dryRun: true,
        title: compiled.title,
        durationSec: compiled.durationSec,
        requestedDurationSec: clampSeconds(args.durationSec, compiled.durationSec + clampSeconds(args.tailSec ?? config.music.tailSec, config.music.tailSec)),
        tempo: compiled.tempo ?? null,
        tracks: described,
        fonts: (plan.banks ?? []).map((bank) => ({ id: bank.id ?? null, path: bank.path ?? null })),
        warnings: [...(compiled.warnings ?? []), ...(plan.warnings ?? [])],
      }
    }
    const peakSetting = args.peakDb === undefined ? config.music.peakDb : args.peakDb
    const peakDb = peakSetting === null ? undefined : Number(peakSetting)
    const normalize = peakSetting !== null

    // Render into `.anyaudio/out/` first: this file is not the deliverable, it is
    // the material that is about to join the project. `output` only says where a
    // delivered copy goes once the project owns the material (I-10).
    // Render into scratch space: the mixdown is either copied into the project
    // (no stems) or a byproduct of a stems render — either way the copy a person
    // keeps lives in the project, and `out/` should only hold what they asked
    // for (improvement plan 04; measured: 9.5 MB of a 49.6s score sat in `out/`
    // with nothing in the project referencing it).
    const target = scratchPath(workspaceRoot, `score-${nowStamp()}.wav`)
    // A score may mix SoundFont parts and plugin parts. The plugin half renders
    // in its own processes and is summed onto the SoundFont half before the one
    // master gain is applied — see audio/vst-track.js for why the two halves
    // cannot be normalised separately.
    let vstScratch = 0
    const makeVstScratch = () => scratchPath(workspaceRoot, `vst-${nowStamp()}-${vstScratch++}.wav`)
    const vstParts = vstTracksOf(compiled)
    const hwParts = hwTracksOf(compiled)
    // A stems render would otherwise play every hardware module twice — once for
    // the mix, once for the stem — and on a long score that second recording is
    // the one that comes back empty. The mix pass keeps its capture and the stem
    // pass reads that take back.
    const hwCaptures = new Map()
    // Three renderers, picked by what the score actually contains: the upstream
    // VST3 sidecar, our own plugin/hardware parts, or a plain SoundFont render.
    const rendered = vst3Tracks.length > 0
      ? await renderMixedScore({ compiled, sf2Compiled, plan, vst3Tracks, sampleRate, durationSec, peakDb, normalize, workspaceRoot })
      : (vstParts.length > 0 || hwParts.length > 0)
        ? await renderMixWithParts(compiled, {
          soundFontOptions: { banks: plan.banks, layout: plan.layout },
          sampleRate,
          durationSec,
          peakDb,
          normalize,
          makeScratch: makeVstScratch,
          hwKeepCaptures: args.stems === true,
          onHwCapture: (name, path) => hwCaptures.set(name, path),
        })
        : await renderScore(compiled, { banks: plan.banks, layout: plan.layout, sampleRate, durationSec, peakDb, normalize })
    const written = await writeWavFile(target, rendered.channels, sampleRate)
    // Replace or append, decided before anything is written.
    //
    // Re-rendering a score to fix its balance is the ordinary case, and it used
    // to append: `freeTrack` found the family busy on the same span, opened
    // `钟琴旋律 2`, and the project gained a second set of stems beside the
    // first. Eight tracks where four were meant, from one rebalance. `replace`
    // is the intended path; without it the append still happens (a person may
    // genuinely want a second take side by side) but the reply says so.
    const wantedNames = args.stems === true
      ? compiled.tracks.map((entry) => entry.name)
      : [args.trackName || String(score.title ?? '').trim() || '音乐']
    const layoutNotes = []
    {
      const { readProject, saveProject } = await import('../project/store.js')
      const { trackFamily, removeTrackFamily } = await import('../project/attach.js')
      const project = await readProject(workspaceRoot, projectId)
      const occupied = wantedNames.filter((name) => trackFamily(project, name).length > 0)
      if (occupied.length > 0 && args.replace === true) {
        const removed = []
        for (const name of occupied) removed.push(...removeTrackFamily(project, name))
        await saveProject(workspaceRoot, project, { by: 'agent', note: `替换配乐：移除旧轨道 ${removed.join('、')}` })
        layoutNotes.push(`replace: removed the previous ${removed.length} track(s) — ${removed.join('、')} — before adding this render.`)
      } else if (occupied.length > 0) {
        layoutNotes.push(
          `this project already had ${occupied.join('、')}; this call APPENDED a second copy, so the timeline now holds both. `
          + 'If this render was meant to replace the old one, remove the old tracks (anyaudio_project mode:"update", target:"track", field:"delete") '
          + 'or pass replace:true next time.',
        )
      }
    }

    const stems = []
    const stemFiles = []
    const usedStemNames = new Set()
    // Every call measures every track. This is the second step of "generate →
    // measure → mix" (improvement plan 03, I-35): per-track level is the only
    // evidence that says whether a score is balanced, and making it depend on a
    // flag meant an Agent that did not ask for it saw nothing, assumed the mix
    // was fine, and re-rendered the whole score to find out.
    //
    // The cost is N more full syntheses and it is not hidden: `renderCompiled`
    // mixes every track through one synth, so a single track's level can only
    // come from running that track alone. Measured on a 12-track 64 s score
    // (48 kHz): the mixed render takes 2.7 s, the twelve stems 13.4 s — about
    // 5.9x, i.e. ~13 s more for that score.
    const gain = Number.isFinite(rendered.appliedGain) ? rendered.appliedGain : 1
    // Stem files are scratch space, not output. They exist for exactly as long as
    // it takes to copy them into materials/ and then go away: `out/` holds what a
    // person asked for, and a stem they can neither see nor delete does not count
    // (improvement plan 03, I-39 — measured: 539 of a project's 586 MB in out/
    // were byte-identical copies of the stems already in materials/).
    const base = scratchPath(workspaceRoot, `stem-${nowStamp()}`)
    const projectRel = relativeToWorkspace(workspaceRoot, projectDir(workspaceRoot, projectId))
    const { levels } = await eachTrackStem(compiled, {
      gain,
      renderOne: (track) => {
        if (track.vst3) {
          // The mix pass already rendered this stem; reuse it instead of paying
          // for a second VST3 render just to measure it.
          const stem = rendered.stems.get(track.name)
          const trackGain = dbToGain(track.gainDb)
          const [left, right] = panGains(track.pan)
          const channels = [
            Float32Array.from(stem.channels[0], (sample) => sample * trackGain * left),
            Float32Array.from(stem.channels[1], (sample) => sample * trackGain * right),
          ]
          return { channels, peakDb: toDb(peakOf(channels)), rmsDb: toDb(rmsOf(channels)) }
        }
        if (track.vst) return renderVstStem(track, { sampleRate, durationSec, out: makeVstScratch() })
        if (track.hw) {
          return renderHwStem(track, {
            sampleRate,
            durationSec,
            out: makeVstScratch(),
            fromPath: hwCaptures.get(track.name) ?? null,
          })
        }
        return renderScore(compiled, {
          banks: plan.banks, layout: plan.layout, sampleRate, durationSec, normalize: false, onlyTrack: track.name,
        })
      },
      onStem: args.stems === true
        ? async (track, channels, level) => {
          // `\w` is ASCII-only, so every Chinese track name collapsed to the same
          // `_`: a five-part score wrote all five stems to one path and only the
          // last survived, while the reply listed that same path five times. Keep
          // Unicode letters and digits, and only append a counter when two tracks
          // still collide.
          const safeName = track.name.replace(/[^\p{L}\p{N}._-]+/gu, '_').replace(/^[._]+|[._]+$/g, '') || 'stem'
          let stemName = safeName
          for (let suffix = 2; usedStemNames.has(stemName); suffix++) stemName = `${safeName}-${suffix}`
          usedStemNames.add(stemName)
          const stemPath = `${base}-${stemName}.wav`
          try {
            await writeWavFile(stemPath, channels, sampleRate)
            const attached = await attachMaterialFile(workspaceRoot, projectId, stemPath, {
              kind: 'music-stem',
              trackName: track.name,
              category: 'music',
              snapshot: score,
              snapshotKind: 'score',
              tool: 'anyaudio_music',
              label: track.name,
              exec,
              // The level was just measured; a second pass over the same samples
              // would only reproduce it.
              peakDb: Number.isFinite(level.peakDb) ? Number(level.peakDb.toFixed(2)) : null,
              rmsDb: Number.isFinite(level.rmsDb) ? Number(level.rmsDb.toFixed(3)) : null,
              origin: originOf(track, plan.layout),
            })
            stemFiles.push(attached)
            // What the reply names is the copy the project owns and the clip bay
            // plays, so a path in the reply always points at a file that exists.
            stems.push(`${projectRel}/${attached.file}`.replace(/\\/g, '/'))
          } finally {
            // Scratch, even when the attach threw: a failed stem must not leave a
            // stray file behind for the next run to trip over.
            await rm(stemPath, { force: true })
          }
        }
        : null,
    })
    // The captures the mix pass kept for the stems have been read by now; they
    // are scratch, so they go with the stem files.
    for (const kept of hwCaptures.values()) await rm(kept, { force: true })

    // A score with stems goes into the project stem by stem (spec §5.3), so a
    // person can rebalance the instruments. A plain render is one track.
    const attached = args.stems === true
      ? stemFiles
      : [await attachMaterialFile(workspaceRoot, projectId, written.path, {
        kind: 'music',
        trackName: args.trackName || String(score.title ?? '').trim() || '音乐',
        category: 'music',
        snapshot: score,
        snapshotKind: 'score',
        tool: 'anyaudio_music',
        label: String(score.title ?? '').trim() || '音乐',
        startSec: args.startSec,
        // A mixdown is several parts at once, so it records them all rather
        // than pretending it came from one instrument.
        origin: { kind: 'mix', parts: compiled.tracks.map((track) => originOf(track, plan.layout)) },
        exec,
      })]

    const delivered = await deliverCopy(written.path, deliveryPath({
      workspaceRoot,
      outputDir: config.output.dir,
      requested: args.output,
      stagedPath: written.path,
    }))
    // The copy that matters is the one the project owns (or the delivered copy
    // when the caller asked for one). A stems render has no project copy of the
    // mixdown, so the reply names the first stem rather than a scratch file that
    // no longer exists (improvement plan 04).
    await rm(written.path, { force: true })
    const primary = delivered
      ?? (attached[0]?.file ? join(projectDir(workspaceRoot, projectId), attached[0].file) : null)

    const tracks = compiled.tracks.map((track) => {
      const assignment = plan.layout.get(track.name)
      const level = levels.get(track.name)
      const vst3 = track.vst3
      return {
        name: track.name,
        // A plugin part has no SoundFont instrument; naming the plugin is the
        // only description that is true, and `piano` would send a person
        // looking at the wrong thing.
        instrument: track.vst
          ? `vst: ${basename(track.vst.plugin)}`
          : track.hw ? `hw: ${track.hw.port}` : track.instrument,
        program: vst3 ? null : assignment?.program ?? track.program,
        // The bank the render actually used: an object-form instrument names a
        // patch outside bank 0, and the reply has to show which one was loaded
        // rather than echoing the name the score wrote.
        bank: vst3 ? null : assignment?.bank ?? track.bank ?? 0,
        source: vst3 ? vst3.id : assignment?.source,
        sourceKind: vst3 ? 'vst3' : 'sf2',
        // The timbre the score named, echoed back so the reply says which one
        // was rendered; a VST3 track without one used the instrument default.
        ...(vst3 && track.preset ? { preset: track.preset } : {}),
        fallback: track.vst3Fallback === true,
        gainDb: track.gainDb,
        notes: track.notes.length,
        endSec: Number(track.endSec.toFixed(2)),
        // −Infinity cannot go through JSON, and the output schema would reject
        // the whole reply because of it. A silent track is reported by the
        // warning below instead, where the reason can be explained.
        ...(level && Number.isFinite(level.peakDb) && Number.isFinite(level.rmsDb)
          ? { peakDb: Number(level.peakDb.toFixed(2)), rmsDb: Number(level.rmsDb.toFixed(2)) }
          : {}),
      }
    })
    const warnings = [...compiled.warnings, ...plan.warnings, ...selection.warnings, ...layoutNotes]
    if (defaultNote) warnings.push(defaultNote)
    for (const failure of rendered.vstErrors ?? []) {
      warnings.push(`the plugin part "${failure.name}" (${basename(failure.plugin)}) did not render — ${failure.message}. The rest of the score was mixed without it.`)
    }
    for (const failure of rendered.hwErrors ?? []) {
      warnings.push(`the hardware part "${failure.name}" on "${failure.port}" did not record — ${failure.message}. The rest of the score was mixed without it.`)
    }
    for (const part of rendered.hwParts ?? []) {
      for (const warning of part.warnings ?? []) warnings.push(`"${part.name}" (${part.port}): ${warning}`)
    }
    if (args.durationSec !== undefined && compiled.durationSec > durationSec + 0.001) {
      // Say what is lost, not only that something is: a person comparing two
      // takes otherwise reads a cut note as a note the other take added.
      let cut = 0
      let lastStart = 0
      for (const track of compiled.tracks) {
        for (const note of track.notes) {
          if (note.start + note.duration > durationSec + 0.001) {
            cut += 1
            if (note.start > lastStart) lastStart = note.start
          }
        }
      }
      warnings.push(
        `score runs to ${compiled.durationSec.toFixed(2)}s but durationSec is ${durationSec.toFixed(2)}s — `
        + `${cut} note(s) are cut, the last starting at ${lastStart.toFixed(2)}s; add tail or end the music earlier`,
      )
    }
    if (rendered.brokenSamples > 0) warnings.push(`${rendered.brokenSamples} non-finite samples were zeroed`)
    // The balance check runs on every call now, because the measurement does. It
    // used to live behind `analyze`, which made the one warning that says "this
    // part is inaudible" something an Agent had to know to ask for.
    const leveled = [...levels.entries()]
    if (leveled.length > 1) {
      const loudest = Math.max(...leveled.map(([, level]) => level.rmsDb))
      for (const [trackName, level] of leveled) {
        // A track that rendered to pure zeros is not "quiet" and the balance
        // knob cannot bring it back: something silenced it. One session got
        // "sits 102.6 dB below the loudest track" for a pad that was zero from
        // end to end because its automation had been written in dB, and the
        // advice to turn gainDb up was useless. Say what actually happened.
        if (level.rmsDb === -Infinity) {
          warnings.push(`track "${trackName}" rendered completely silent (every sample is zero) — check its automation points, mute flags and note velocities before adjusting its gainDb, which cannot restore a track that produced no signal`)
          continue
        }
        const drop = loudest - level.rmsDb
        // 60 dB under the loudest part is inaudible in any real mix, and it is far
        // outside what a fader is for — a track that far down was silenced by
        // something, not mixed low. Naming that keeps the advice from sending the
        // caller to the wrong knob (measured at -91 dB for a dB-written CC curve).
        if (drop > 60) {
          warnings.push(`track "${trackName}" sits ${drop.toFixed(1)} dB below the loudest track, which is inaudible — check its automation points and mute flags first; its gainDb is not what silenced it`)
          continue
        }
        if (drop > 12) {
          warnings.push(`track "${trackName}" sits ${drop.toFixed(1)} dB below the loudest track — per-track gainDb is the balance knob (master normalisation does not rebalance); check whether the melody is drowning this part`)
        }
      }
    }

    // The arrangement, in the one file format another program can open. It costs
    // nothing extra to write (the score is already compiled) and it is the thing
    // a person keeps: a rendered WAV bakes the timbre, a .mid does not.
    let midiFile = null
    if (args.midi) {
      const buffer = encodeMidiFile(compiled, {
        bpm: Number.isFinite(Number(args.midiBpm)) ? Number(args.midiBpm) : 120,
      })
      const target = resolveOutputPath({
        workspaceRoot,
        requested: typeof args.midi === 'string' ? args.midi : undefined,
        defaultName: `score-${nowStamp()}.mid`,
      })
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, buffer)
      midiFile = relativeToWorkspace(workspaceRoot, target)
    }
    if (midiFile && vstParts.length > 0) {
      warnings.push(`the .mid carries the notes of ${vstParts.map((track) => `"${track.name}"`).join(', ')} but not which plugin they used — MIDI has no plugin field, so pick a sound for those parts in the DAW`)
    }
    if (midiFile && hwParts.length > 0) {
      warnings.push(`the .mid carries the notes of ${hwParts.map((track) => `"${track.name}"`).join(', ')} but not which port or channel played them — a DAW will need that set by hand`)
    }

    return {
      ok: true,
      projectId,
      ...(midiFile ? { midi: midiFile } : {}),
      ...(primary ? { file: relativeToWorkspace(workspaceRoot, primary), absolutePath: primary } : {}),
      ...(delivered ? { delivered: relativeToWorkspace(workspaceRoot, delivered), deliveredAbsolutePath: delivered } : {}),
      bytes: written.bytes,
      durationSec: Number(rendered.durationSec.toFixed(3)),
      sampleRate,
      peakDb: Number(rendered.peakDb.toFixed(2)),
      rmsDb: Number(rendered.rmsDb.toFixed(2)),
      // A pure-plugin score loads no SoundFont; an undefined `font` would fail
      // the output schema instead of saying "there is none".
      ...(plan.banks[0]?.path ? { font: plan.banks[0].path } : {}),
      fonts: plan.fonts,
      vst3: vst3Tracks.map((track) => ({
        id: track.vst3.id,
        name: track.vst3.name,
        plugin: track.vst3.plugin,
        track: track.name,
        ...(track.preset ? { preset: track.preset } : {}),
      })),
      tracks,
      stems,
      stemsNormalized: false,
      attached,
      warnings,
    }
  },
})

export function registerMusicTool(ctx) {
  ctx.tools.register(musicToolDefinition)
}
