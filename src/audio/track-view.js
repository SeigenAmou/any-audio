/**
 * Read-only sequence view: what each part actually plays, before it becomes audio.
 *
 * The project's deliverable is audio, but a score is what the person writes and
 * what a DAW shows as note blocks. This module turns the compiled parts into the
 * same shape a piano roll would hold — one row per part, notes with bar/beat
 * positions, and a plain-text roll — so the two views can be compared without
 * rendering anything.
 */

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

/** MIDI number to a name a person reads: 69 -> "A4". */
export function noteName(midi) {
  const value = Math.round(Number(midi))
  if (!Number.isFinite(value)) return String(midi)
  const octave = Math.floor(value / 12) - 1
  return `${NOTE_NAMES[((value % 12) + 12) % 12]}${octave}`
}

/** Where a part's sound comes from, in the words the report already uses. */
export function partKind(track) {
  if (track.vst3 && track.vst3.plugin) return 'vst3'
  if (track.vst && track.vst.plugin) return 'vst'
  if (track.hw) return 'hw'
  // A part that only sends MIDI plays on a module and records nothing, so it
  // has no audio of its own — worth its own kind instead of pretending to be sf2.
  if (track.midi) return 'midi'
  return 'sf2'
}

/** Which instrument (and channel) answers this part. */
export function partTarget(track) {
  const kind = partKind(track)
  const channel = Number.isInteger(track.channel) ? `ch ${track.channel}` : ''
  if (kind === 'hw' || kind === 'midi') {
    const port = track.hw?.port ?? track.midi?.port ?? 'a MIDI port'
    const suffix = kind === 'midi' ? ' (output only)' : ''
    return `-> ${port} ${channel}${suffix}`.trim()
  }
  if (kind === 'vst' || kind === 'vst3') {
    const plugin = track.vst?.plugin ?? track.vst3?.plugin ?? 'a plugin'
    const name = String(plugin).replace(/^.*[\\/]/, '')
    return `-> ${name} ${channel}`.trim()
  }
  const source = track.source?.id ?? track.source ?? 'the default font'
  const instrument = track.instrument ?? (track.program !== undefined ? `program ${track.program}` : '')
  return `-> ${source} ${instrument}`.trim()
}

/**
 * One row per part, in score order, with the facts a roll needs: range, note
 * count, polyphony peak, and the bar of the first and last note.
 */
export function buildTrackList(compiled, { bpm = 120, meter = [4, 4] } = {}) {
  const beats = Array.isArray(meter) ? Number(meter[0]) || 4 : 4
  const beatValue = Array.isArray(meter) ? Number(meter[1]) || 4 : 4
  const barSeconds = (beats * 60) / (bpm * beatValue)
  return (compiled.tracks ?? []).map((track) => {
    const notes = Array.isArray(track.notes) ? track.notes : []
    const starts = notes.map((note) => Number(note.start) || 0)
    const ends = notes.map((note) => (Number(note.start) || 0) + (Number(note.duration) || 0))
    let polyphony = 0
    const edges = []
    for (let index = 0; index < notes.length; index += 1) {
      edges.push({ at: starts[index], delta: 1 }, { at: ends[index], delta: -1 })
    }
    edges.sort((a, b) => a.at - b.at || a.delta - b.delta)
    let live = 0
    for (const edge of edges) {
      live += edge.delta
      if (live > polyphony) polyphony = live
    }
    const firstSec = starts.length ? Math.min(...starts) : 0
    const lastSec = ends.length ? Math.max(...ends) : 0
    return {
      name: track.name,
      kind: partKind(track),
      target: partTarget(track),
      notes: notes.length,
      firstNoteSec: firstSec,
      lastNoteSec: lastSec,
      firstBar: Math.floor(firstSec / barSeconds) + 1,
      lastBar: Math.floor(lastSec / barSeconds) + 1,
      polyphony,
      channel: track.channel ?? null,
      program: track.program ?? null,
      instrument: track.instrument ?? null,
      preset: track.preset ?? track.vst?.preset ?? null,
    }
  })
}

/**
 * A plain-text roll for one part: sixteen cells per bar, one character per
 * sixteenth, the highest sounding note decides the character. Empty cells are
 * dots so the bar lines stay readable in a monospaced report.
 */
export function rollText(compiled, { trackName = null, bars = 4, bpm = 120, meter = [4, 4] } = {}) {
  const beats = Array.isArray(meter) ? Number(meter[0]) || 4 : 4
  const beatValue = Array.isArray(meter) ? Number(meter[1]) || 4 : 4
  const barSeconds = (beats * 60) / (bpm * beatValue)
  const cellSeconds = barSeconds / 16
  const tracks = (compiled.tracks ?? []).filter((track) => !trackName || track.name === trackName)
  const lines = []
  for (const track of tracks) {
    const notes = Array.isArray(track.notes) ? track.notes : []
    lines.push(`${track.name} . ${partTarget(track)} . ${notes.length} note(s)`)
    for (let barIndex = 0; barIndex < bars; barIndex += 1) {
      let row = ''
      for (let cell = 0; cell < 16; cell += 1) {
        const at = barIndex * barSeconds + cell * cellSeconds
        let top = null
        for (const note of notes) {
          const start = Number(note.start) || 0
          const length = Number(note.duration) || 0
          if (start - 0.001 <= at && at < start + length - 0.001) {
            const midi = Number(note.midi)
            if (top === null || midi > top.midi) top = { midi, velocity: Number(note.velocity) || 0 }
          }
        }
        if (top === null) row += '.'
        else if (cell % 4 === 0) row += '#' // on the beat
        else if (top.velocity >= 100) row += '+'
        else row += '-'
      }
      lines.push(`  ${String(barIndex + 1).padStart(3)} |${row}|`)
    }
  }
  if (lines.length === 0) lines.push('no part matches that name')
  return lines.join('\n')
}
