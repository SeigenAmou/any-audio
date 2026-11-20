import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, resolve } from 'node:path'
import { compileScore } from '../audio/score.js'
import { encodeMidiFile, parseMidiFile, scoreFromMidi, programName } from '../audio/midi-file.js'
import {
  finalizeTool, nowStamp, readJsonParam, relativeToWorkspace, resolveOutputPath, textRenderer, workspaceRootOf,
} from './shared.js'

/**
 * MIDI is the escape hatch out of this toolchain, not a fourth kind of audio.
 *
 * The score model is modelled on what a MIDI file can say (channels, programs,
 * notes, a handful of controllers), so a rendered WAV has always been a
 * one-way door: the timbre is baked, and a person who wants a different piano,
 * a longer bridge or a real DAW's quantise has nothing to open. A .mid file is
 * that door — it carries the arrangement, not the sound, so it survives a trip
 * through another program and comes back.
 *
 * What it is deliberately *not*: a material in the project. Every material in
 * this toolchain is PCM that the mixer can place on the timeline, and a .mid has
 * no samples to mix; registering one as `kind: "midi"` would put a clip on a
 * track that renders as silence and break `render.js`, whose `loadMaterial`
 * parses WAV and nothing else. So the file lands in `out/` beside the renders,
 * where a person can pick it up, and comes back in as a score.
 */

function slugOf(text, fallback) {
  const cleaned = String(text ?? '').trim().replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '')
  return cleaned || fallback
}

function resolveInput(workspaceRoot, path) {
  const value = typeof path === 'string' ? path.trim() : ''
  if (!value) throw new Error('pass "file": the .mid to read')
  return isAbsolute(value) ? value : resolve(workspaceRoot, value)
}

/** Note spans as one flat list, so the analysis does not care which track they came from. */
function flatNotes(parsed) {
  const out = []
  for (const track of parsed.tracks) {
    for (const note of track.notes) out.push({ ...note, track: track.name })
  }
  return out
}

function median(values) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

/**
 * How far the note starts sit from a sixteenth-note grid.
 *
 * A person asking "what is this piece like" needs to know whether it was played
 * by hand or drawn on a grid: at a 15 ms tolerance a quantised part hits above
 * 95%, a humanised or freely played one lands far below. That one number decides
 * whether a learned style should say "humanised timing" or not.
 */
function gridAlignment(onsets, bpm) {
  if (onsets.length === 0) return null
  const sixteenth = 60 / Math.max(1, bpm) / 4
  const offsets = onsets.map((start) => {
    const nearest = Math.round(start / sixteenth) * sixteenth
    return Math.abs(start - nearest)
  })
  const onGrid = offsets.filter((offset) => offset <= 0.015).length
  return {
    sixteenthMs: Number((sixteenth * 1000).toFixed(2)),
    onGridRatio: Number((onGrid / offsets.length).toFixed(3)),
    medianOffsetMs: Number((median(offsets) * 1000).toFixed(2)),
  }
}

/** Highest number of notes that start at (nearly) the same moment — a chord-size read. */
function maxPolyphony(notes) {
  const starts = [...notes.map((note) => note.start)].sort((a, b) => a - b)
  let best = 0
  for (let index = 0; index < starts.length; index++) {
    let count = 1
    for (let next = index + 1; next < starts.length && starts[next] - starts[index] < 0.03; next++) count++
    best = Math.max(best, count)
  }
  return best
}

function describeAnalysis(parsed) {
  const notes = flatNotes(parsed)
  const pitches = notes.map((note) => note.midi)
  // A format-1 file's first track is the conductor: a tempo and a time
  // signature, no notes. Counting it as a part would tell a person the file has
  // two parts when it has one, so empty tracks are dropped — unless the file has
  // no notes at all, where listing them is the only way to say something useful.
  const sounding = parsed.tracks.filter((track) => track.notes.length > 0)
  const tracks = (sounding.length > 0 ? sounding : parsed.tracks).map((track) => {
    const own = track.notes
    if (own.length === 0) return { name: track.name || '(unnamed)', notes: 0 }
    const midis = own.map((note) => note.midi)
    const instruments = Object.entries(track.programs ?? {}).map(([channel, program]) => ({ channel: Number(channel), program, name: programName(program) }))
    return {
      name: track.name || '(unnamed)',
      notes: own.length,
      channels: [...new Set(own.map((note) => note.channel))],
      instruments,
      range: [Math.min(...midis), Math.max(...midis)],
      // A part's pace is notes per second it is actually sounding, which is what
      // makes "this is a busy part" comparable between a 4 s fill and a 4 min pad.
      spanSec: Number((Math.max(...own.map((note) => note.start + note.duration)) - Math.min(...own.map((note) => note.start))).toFixed(3)),
      meanDurationSec: Number((own.reduce((sum, note) => sum + note.duration, 0) / own.length).toFixed(3)),
      maxPolyphony: maxPolyphony(own),
    }
  })
  return {
    durationSec: parsed.durationSec,
    bpm: parsed.bpm,
    ppq: parsed.ppq,
    format: parsed.format,
    tempoChanges: parsed.tempos.length,
    notes: notes.length,
    pitchRange: pitches.length ? [Math.min(...pitches), Math.max(...pitches)] : null,
    grid: gridAlignment(notes.map((note) => note.start), parsed.bpm),
    tracks,
  }
}

export const midiToolDefinition = finalizeTool({
  name: 'anyaudio_midi',
  description:
    'Move music between a MIDI file and this toolchain, in both directions. ' +
    'action "export": compile a score (same format as anyaudio_music) and write a standard MIDI file — use it when the person wants to take the arrangement into a DAW, replace a timbre, or finish the part by hand. ' +
    'action "import": read a .mid and return it as a score object that anyaudio_music accepts, so music from anywhere becomes editable, renderable material in this toolchain. ' +
    'action "analyze": read a .mid and report what it contains (parts, instrument programs, pitch ranges, note density, chord size, how tightly the starts sit on a sixteenth grid) — the input for describing or imitating a style. ' +
    'The file itself is not added to a project: MIDI carries no samples, so the mixer cannot place it. Export the file, edit it elsewhere, then pass the result of "import" to anyaudio_music to hear it here.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['export', 'import', 'analyze'], description: 'What to do: export a score to .mid, import a .mid to a score, or analyze a .mid.' },
      score: { oneOf: [{ type: 'object' }, { type: 'string' }], description: 'export only: the score object, in the same format anyaudio_music takes, or a path to a .json file holding it.' },
      file: { type: 'string', description: 'import/analyze: the .mid file to read. Relative paths resolve against the workspace folder.' },
      output: { type: 'string', description: 'export: where to write the .mid (default <workspace>/.anyaudio/out/<title>.mid). import: optional path to also save the score JSON. Relative paths resolve against the workspace folder.' },
      bpm: { type: 'number', description: 'export: tempo written into the file, default 120. The score clock is in seconds, so the tempo only decides how many ticks a second is worth — it does not change what is heard.' },
      ppq: { type: 'number', description: 'export: ticks per quarter note, default 480. Higher keeps finer timing, at a larger file.' },
      title: { type: 'string', description: 'export: name written into the file as its track name, and the default file name. Default the score title.' },
    },
    required: ['action'],
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: true,
      // Only `ok` is on every reply; which of the rest appear depends on the
      // action, so they are declared without being required (the host rejects a
      // value whose declared field has the wrong type, not a missing one).
      properties: {
        ok: { type: 'boolean' },
        action: { type: 'string' },
        file: { type: 'string' },
        absolutePath: { type: 'string' },
        saved: { type: 'string' },
        bytes: { type: 'number' },
        bpm: { type: 'number' },
        ppq: { type: 'number' },
        title: { type: 'string' },
        durationSec: { type: 'number' },
        tracks: { type: 'array', items: { type: 'object', additionalProperties: true } },
        warnings: { type: 'array', items: { type: 'string' } },
        score: { type: 'object', additionalProperties: true },
        analysis: { type: 'object', additionalProperties: true },
        summary: { type: 'object', additionalProperties: true },
      },
    },
    render: textRenderer((args, value) => {
    const lines = []
    if (args.action === 'export') {
      lines.push(`Wrote ${value.file} (${value.bytes} bytes, ${value.tracks.length} part(s), ${value.durationSec}s at ${value.bpm} bpm, ${value.ppq} ppq).`)
      for (const track of value.tracks) {
        lines.push(`- ${track.name}: ${track.instrument}${track.channel === 9 ? ' (drum kit)' : ''}, channel ${track.channel + 1}, ${track.notes} notes`)
      }
      if (value.warnings.length > 0) for (const warning of value.warnings) lines.push(`Warning: ${warning}`)
      lines.push('This file is an arrangement, not audio: it has no samples, so it is not in the project and the mixer will not play it. To hear it here, pass it to action "import" and render the returned score with anyaudio_music.')
      return lines.join('\n')
    }
    if (args.action === 'import') {
      lines.push(`Read ${value.file}: ${value.score.tracks.length} part(s), ${value.summary.notes} notes, ${value.score.durationSec}s at ${value.summary.bpm} bpm.`)
      for (const track of value.score.tracks) {
        lines.push(`- ${track.name}: ${track.instrument}${track.drums ? ' (drum kit)' : ''}, channel ${track.channel + 1}, ${track.notes.length} notes`)
      }
      if (value.saved) lines.push(`Score saved to ${value.saved}.`)
      if (value.summary.tempoChanges > 1) lines.push(`Warning: the file has ${value.summary.tempoChanges} tempo changes; a score has one clock in seconds, so later tempo changes were applied to the note times and cannot be re-created on export.`)
      lines.push('Next: pass the "score" object (or the saved .json path) as anyaudio_music\'s score to render it with real instruments.')
      return lines.join('\n')
    }
    lines.push(`${value.file}: ${value.analysis.durationSec}s, ${value.analysis.bpm} bpm, ${value.analysis.notes} notes in ${value.analysis.tracks.length} part(s).`)
    for (const track of value.analysis.tracks) {
      if (track.notes === 0) {
        lines.push(`- ${track.name}: no notes`)
        continue
      }
      const instruments = track.instruments.map((entry) => `${entry.name} (ch ${entry.channel + 1})`).join(', ') || 'no program change'
      const grid = Number.isFinite(track.maxPolyphony) ? `, up to ${track.maxPolyphony}-note chords` : ''
      lines.push(`- ${track.name}: ${track.notes} notes over ${track.spanSec}s, ${instruments}, MIDI ${track.range[0]}–${track.range[1]}, mean note ${track.meanDurationSec}s${grid}`)
    }
    if (value.analysis.grid) {
      lines.push(`Timing: ${(value.analysis.grid.onGridRatio * 100).toFixed(0)}% of starts within 15 ms of a sixteenth grid, median offset ${value.analysis.grid.medianOffsetMs} ms.`)
    }
    return lines.join('\n')
    }),
  },
  async execute(args, exec) {
    const workspaceRoot = await workspaceRootOf(exec)
    const action = String(args.action ?? '').trim()
    if (action === 'export') {
      const score = await readJsonParam(args.score, 'score', { workspaceRoot })
      const compiled = compileScore(score)
      const bpm = Number.isFinite(Number(args.bpm)) ? Number(args.bpm) : 120
      const ppq = Number.isFinite(Number(args.ppq)) ? Number(args.ppq) : 480
      const title = typeof args.title === 'string' && args.title.trim() ? args.title.trim() : compiled.title
      const buffer = encodeMidiFile(compiled, { bpm, ppq, title })
      const target = resolveOutputPath({
        workspaceRoot,
        requested: args.output,
        defaultName: `${slugOf(title, 'score')}-${nowStamp()}.mid`,
      })
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, buffer)
      return {
        ok: true,
        action,
        file: relativeToWorkspace(workspaceRoot, target),
        absolutePath: target,
        bytes: buffer.length,
        bpm,
        ppq,
        title,
        durationSec: Number(compiled.durationSec.toFixed(3)),
        tracks: compiled.tracks.map((track) => ({
          name: track.name,
          instrument: track.instrument,
          channel: track.channel,
          notes: track.notes.length,
        })),
        warnings: compiled.warnings,
      }
    }

    const file = resolveInput(workspaceRoot, args.file)
    const buffer = await readFile(file)
    const parsed = parseMidiFile(buffer)

    if (action === 'analyze') {
      return { ok: true, action, file: relativeToWorkspace(workspaceRoot, file), analysis: describeAnalysis(parsed) }
    }

    const title = typeof args.title === 'string' && args.title.trim()
      ? args.title.trim()
      : basename(file, extname(file))
    const score = scoreFromMidi(parsed, { title })
    // `saved` is only present when a JSON copy was asked for: the reply schema
    // declares it a string, and a null would fail its own contract.
    let saved = null
    if (typeof args.output === 'string' && args.output.trim()) {
      saved = isAbsolute(args.output) ? args.output : resolve(workspaceRoot, args.output)
      await mkdir(dirname(saved), { recursive: true })
      await writeFile(saved, `${JSON.stringify(score, null, 2)}\n`, 'utf8')
    }
    return {
      ok: true,
      action,
      file: relativeToWorkspace(workspaceRoot, file),
      score,
      ...(saved ? { saved: relativeToWorkspace(workspaceRoot, saved) } : {}),
      summary: describeAnalysis(parsed),
    }
  },
})

export function registerMidiTool(ctx) {
  ctx.tools.register(midiToolDefinition)
}
