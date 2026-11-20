/**
 * Standard MIDI File (SMF) read and write.
 *
 * A score keeps time in seconds, because it shares its clock with the video
 * timeline; a MIDI file keeps time in ticks, because that is what every DAW
 * and every hardware sound module reads. This module is the one place the two
 * meet: `encodeMidiFile` writes a compiled score out as a `.mid` a person can
 * open elsewhere or feed to an external module, and `parseMidiFile` +
 * `scoreFromMidi` read one back into the score model.
 *
 * Only what the score model can express is written: note on/off, program,
 * bank (as CC0, the way the built-in synth reads it), the controllers a score
 * carries (CC7/10/91/93 plus automation curves) and pitch bend. Tempo is one
 * constant for the whole file — a score has no tempo map, and inventing one
 * would make the seconds either the timeline or not, never both.
 */

import { INSTRUMENTS } from './score.js'

const DEFAULT_PPQ = 480
const DEFAULT_BPM = 120
const DEFAULT_TEMPO = 500000 // µs per quarter note at 120 bpm

const NOTE_OFF = 0x80
const NOTE_ON = 0x90
const CC = 0xb0
const PROGRAM = 0xc0
const PITCH_BEND = 0xe0
const META = 0xff

/**
 * Order of events that land on the same tick. It mirrors `EVENT_PRIORITY` in
 * score.js so a score written to disk and read back keeps its note spelling:
 * a note that ends exactly where the next one begins is off-then-on, not the
 * other way around.
 */
const NOTE_ORDER = { off: 3, on: 4 }
const CONTROL_ORDER = { bank: 0, program: 1, cc: 2, pitch: 2 }

/** Clamp a value into the 7-bit range every MIDI data byte must live in. */
function data(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return 0
  return Math.max(0, Math.min(127, Math.round(number)))
}

function variableLength(value) {
  const bytes = [value & 0x7f]
  let rest = value >> 7
  while (rest > 0) {
    bytes.unshift((rest & 0x7f) | 0x80)
    rest >>= 7
  }
  return bytes
}

function readVariable(buffer, offset, end) {
  let value = 0
  let position = offset
  for (let i = 0; i < 4; i++) {
    if (position >= end) throw new Error('MIDI file ends inside a variable-length number')
    const byte = buffer[position++]
    value = (value << 7) | (byte & 0x7f)
    if (byte < 0x80) return [value, position]
  }
  throw new Error('MIDI variable-length number is longer than 4 bytes')
}

function textMeta(type, text) {
  const bytes = Array.from(Buffer.from(String(text ?? ''), 'utf8'))
  return [META, type, ...variableLength(bytes.length), ...bytes]
}

function chunk(id, bytes) {
  const header = Buffer.alloc(8)
  header.write(id, 0, 'latin1')
  header.writeUInt32BE(bytes.length, 4)
  return Buffer.concat([header, Buffer.from(bytes)])
}

function eventBytes(event) {
  switch (event.type) {
    case 'bank':
      return [CC | event.channel, 0, data(event.bank)]
    case 'program':
      return [PROGRAM | event.channel, data(event.program)]
    case 'cc':
      return [CC | event.channel, data(event.controller), data(event.value)]
    case 'pitch': {
      const value = Math.max(0, Math.min(16383, Math.round(Number(event.value) || 0)))
      return [PITCH_BEND | event.channel, value & 0x7f, (value >> 7) & 0x7f]
    }
    default:
      throw new Error(`cannot write score event "${event.type}" to a MIDI file`)
  }
}

/**
 * Write a compiled score (the output of `compileScore`) as a standard MIDI
 * file and return the bytes.
 *
 * Notes come from `track.notes`, not from `track.events`, so a note keeps its
 * exact length: an on/off pair rounded to the same tick would become a
 * zero-length note, which some samplers drop and others turn into a click.
 * Everything else (bank, program, per-track CC7/10/91/93, automation) comes
 * from `track.events`, which is where those live — note on/off in `events`
 * are skipped because `notes` already carries them.
 */
export function encodeMidiFile(compiled, { bpm = DEFAULT_BPM, ppq = DEFAULT_PPQ, title = null, format = 1 } = {}) {
  if (!compiled || !Array.isArray(compiled.tracks) || compiled.tracks.length === 0) {
    throw new Error('encodeMidiFile needs a compiled score with tracks')
  }
  const tempoBpm = Math.max(20, Math.min(400, Number(bpm) || DEFAULT_BPM))
  const ticksPerQuarter = Math.max(24, Math.min(960, Math.round(Number(ppq) || DEFAULT_PPQ)))
  const ticksPerSecond = (ticksPerQuarter * tempoBpm) / 60
  const tickOf = (seconds) => {
    const value = Number(seconds)
    return Number.isFinite(value) && value > 0 ? Math.round(value * ticksPerSecond) : 0
  }
  const usPerQuarter = Math.round(60000000 / tempoBpm)
  // Every event in a track starts with a delta, including the first. A writer
  // may leave out the delta of the very first event, but never of a later one:
  // the 0xFF of a meta event that follows another event would then be read as a
  // delta byte (0xFF is "continue", so the reader swallows the meta type too and
  // every following event shifts by thousands of ticks).
  const conductor = [
    0x00, ...textMeta(0x03, title ?? compiled.title ?? 'any-audio'),
    0x00, META, 0x51, 0x03, (usPerQuarter >> 16) & 0xff, (usPerQuarter >> 8) & 0xff, usPerQuarter & 0xff,
    0x00, META, 0x58, 0x04, 4, 2, 24, 8,
    0x00, META, 0x2f, 0x00,
  ]

  const groups = format === 0
    ? [{ name: title ?? compiled.title ?? 'score', tracks: compiled.tracks }]
    : compiled.tracks.map((track) => ({ name: track.name, tracks: [track] }))
  const trackChunks = []
  for (const group of groups) {
    const rows = []
    for (const track of group.tracks) {
      for (const note of track.notes ?? []) {
        const on = tickOf(note.start)
        const off = Math.max(on + 1, tickOf(note.start + note.duration))
        rows.push({ tick: on, order: NOTE_ORDER.on, bytes: [NOTE_ON | track.channel, data(note.midi), data(note.velocity)] })
        rows.push({ tick: off, order: NOTE_ORDER.off, bytes: [NOTE_OFF | track.channel, data(note.midi), 64] })
      }
      for (const event of track.events ?? []) {
        if (!(event.type in CONTROL_ORDER)) continue
        rows.push({ tick: tickOf(event.t), order: CONTROL_ORDER[event.type], bytes: eventBytes({ ...event, channel: track.channel }) })
      }
    }
    rows.sort((a, b) => (a.tick - b.tick) || (a.order - b.order))
    const body = [0x00, ...textMeta(0x03, group.name ?? 'track')]
    let previous = 0
    for (const row of rows) {
      body.push(...variableLength(Math.max(0, row.tick - previous)), ...row.bytes)
      previous = row.tick
    }
    body.push(0x00, META, 0x2f, 0x00)
    trackChunks.push(chunk('MTrk', body))
  }

  const headerBytes = Buffer.alloc(6)
  headerBytes.writeUInt16BE(format === 0 ? 0 : 1, 0)
  headerBytes.writeUInt16BE(format === 0 ? 1 : trackChunks.length + 1, 2)
  headerBytes.writeUInt16BE(ticksPerQuarter, 4)
  return Buffer.concat([chunk('MThd', Array.from(headerBytes)), chunk('MTrk', conductor), ...trackChunks])
}

/** Decode one MTrk chunk into absolute-tick events. */
function decodeTrack(buffer, start, end) {
  const events = []
  const nameParts = []
  let tick = 0
  let running = 0
  let position = start
  while (position < end) {
    const [delta, afterDelta] = readVariable(buffer, position, end)
    tick += delta
    position = afterDelta
    if (position >= end) break
    let status = buffer[position]
    if (status < 0x80) {
      if (!running) throw new Error('MIDI data byte with no running status')
      status = running
    } else {
      position++
      if (status < 0xf0) running = status
    }
    if (status === META) {
      const type = buffer[position++]
      const [length, afterLength] = readVariable(buffer, position, end)
      position = afterLength
      const stop = Math.min(end, position + length)
      const payload = buffer.subarray(position, stop)
      position = stop
      if (type === 0x2f) break
      if (type === 0x03) nameParts.push(payload.toString('utf8'))
      else if (type === 0x51 && payload.length >= 3) {
        events.push({ tick, type: 'tempo', usPerQuarter: (payload[0] << 16) | (payload[1] << 8) | payload[2] })
      }
      continue
    }
    if (status === 0xf0 || status === 0xf7) {
      const [length, afterLength] = readVariable(buffer, position, end)
      position = afterLength + length
      continue
    }
    const kind = status & 0xf0
    const channel = status & 0x0f
    if (kind === 0xc0) {
      events.push({ tick, type: 'program', channel, program: buffer[position++] })
    } else if (kind === 0xd0) {
      position++
    } else if (kind === 0x80 || kind === 0x90) {
      const note = buffer[position++]
      const velocity = buffer[position++]
      events.push({ tick, type: kind === 0x90 && velocity > 0 ? 'on' : 'off', channel, note, velocity })
    } else if (kind === 0xa0 || kind === 0xb0 || kind === 0xe0) {
      const a = buffer[position++]
      const b = buffer[position++]
      if (kind === 0xb0) events.push({ tick, type: 'cc', channel, controller: a, value: b })
      else if (kind === 0xe0) events.push({ tick, type: 'pitch', channel, value: a | (b << 7) })
    }
  }
  return { name: nameParts.join(' ').trim(), events, endTick: tick }
}

/**
 * A note event stream as note spans, pairing note-on with the next note-off of
 * the same channel and key. A note left open at the end of the track is closed
 * there rather than dropped: a broken file should cost the file's tail, not the
 * last chord.
 */
function notesFromEvents(events, endTick) {
  const open = new Map()
  const notes = []
  const press = (event) => {
    const key = `${event.channel}:${event.note}`
    if (!open.has(key)) open.set(key, [])
    open.get(key).push({ tick: event.tick, velocity: event.velocity, channel: event.channel, midi: event.note })
  }
  const release = (channel, midi, tick) => {
    const stack = open.get(`${channel}:${midi}`)
    const start = stack?.shift()
    if (!start) return
    notes.push({ ...start, endTick: Math.max(tick, start.tick + 1) })
  }
  for (const event of events) {
    if (event.type === 'on') press(event)
    else if (event.type === 'off') release(event.channel, event.note, event.tick)
  }
  for (const stack of open.values()) {
    for (const start of stack) notes.push({ ...start, endTick: Math.max(endTick, start.tick + 1) })
  }
  return notes
}

/**
 * Convert a tempo map into a `tick → seconds` function.
 *
 * Tempos are shared by every track in a format-1 file, so they are collected
 * once and applied to all of them; a file without a tempo meta plays at
 * 120 bpm, which is what every player assumes.
 */
function secondsAt(segments, ppq) {
  const marks = [{ tick: 0, seconds: 0, usPerQuarter: DEFAULT_TEMPO }]
  let seconds = 0
  let lastTick = 0
  let usPerQuarter = DEFAULT_TEMPO
  for (const segment of segments) {
    if (segment.tick <= lastTick) {
      // Same tick (already de-duplicated) or a tempo at 0: replace the mark.
      if (segment.tick === lastTick && marks.length > 1) marks[marks.length - 1].usPerQuarter = segment.usPerQuarter
      usPerQuarter = segment.usPerQuarter
      continue
    }
    seconds += ((segment.tick - lastTick) * usPerQuarter) / (ppq * 1e6)
    lastTick = segment.tick
    usPerQuarter = segment.usPerQuarter
    marks.push({ tick: segment.tick, seconds, usPerQuarter })
  }
  return (tick) => {
    let index = 0
    while (index + 1 < marks.length && marks[index + 1].tick <= tick) index++
    const mark = marks[index]
    return mark.seconds + ((tick - mark.tick) * mark.usPerQuarter) / (ppq * 1e6)
  }
}

/**
 * Read an SMF into plain data. Timing is resolved to seconds here, once, so
 * every caller works on the same clock as the score model.
 */
export function parseMidiFile(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input)
  if (buffer.length < 14 || buffer.toString('latin1', 0, 4) !== 'MThd') {
    throw new Error('not a standard MIDI file: missing MThd header')
  }
  const headerLength = buffer.readUInt32BE(4)
  const format = buffer.readUInt16BE(8)
  const division = buffer.readUInt16BE(12)
  if (division & 0x8000) {
    throw new Error('SMPTE time division (frames per second) is not supported; export the file with metrical time')
  }
  const ppq = division

  const decoded = []
  const tempos = []
  let offset = 8 + headerLength
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('latin1', offset, offset + 4)
    const length = buffer.readUInt32BE(offset + 4)
    const start = offset + 8
    const end = start + length
    if (end > buffer.length) throw new Error(`MIDI chunk "${id}" runs past the end of the file`)
    if (id === 'MTrk') {
      const track = decodeTrack(buffer, start, end)
      decoded.push(track)
      for (const event of track.events) if (event.type === 'tempo') tempos.push({ tick: event.tick, usPerQuarter: event.usPerQuarter })
    }
    offset = end
  }

  tempos.sort((a, b) => a.tick - b.tick)
  // A later tempo at the same tick wins: that is what a player does.
  const segments = []
  for (const tempo of tempos) {
    const existing = segments.findIndex((entry) => entry.tick === tempo.tick)
    if (existing >= 0) segments[existing] = tempo
    else segments.push(tempo)
  }
  const toSeconds = secondsAt(segments, ppq)

  const tracks = decoded.map((track, index) => {
    const notes = notesFromEvents(track.events, track.endTick)
      .map((note) => ({
        channel: note.channel,
        midi: note.midi,
        velocity: note.velocity,
        start: Number(toSeconds(note.tick).toFixed(6)),
        duration: Number((toSeconds(note.endTick) - toSeconds(note.tick)).toFixed(6)),
      }))
      .filter((note) => note.duration > 0)
    const programs = {}
    for (const event of track.events) if (event.type === 'program') programs[event.channel] = event.program
    return { index, name: track.name, notes, programs }
  })

  const durationSec = tracks.reduce((max, track) => {
    for (const note of track.notes) max = Math.max(max, note.start + note.duration)
    return max
  }, 0)

  return {
    format,
    ppq,
    division,
    tempos: segments,
    bpm: segments.length > 0 ? Math.round(60000000 / segments[0].usPerQuarter) : DEFAULT_BPM,
    tracks,
    durationSec: Number(durationSec.toFixed(6)),
  }
}

/** The first GM name that maps to `program`, so a score can name its instrument. */
const PROGRAM_NAMES = (() => {
  const names = new Map()
  for (const [name, program] of Object.entries(INSTRUMENTS)) {
    if (!names.has(program)) names.set(program, name)
  }
  return names
})()

export function programName(program) {
  return PROGRAM_NAMES.get(Number(program)) ?? `program-${program}`
}

/**
 * Turn parsed MIDI into a score object `compileScore` accepts.
 *
 * Channels are the unit of arrangement here, not file tracks: a MIDI channel
 * carries one program at a time in practice, and two score tracks sharing a
 * channel would be rejected by `compileScore` anyway. A file's own track name
 * is kept as the label when there is one, because a person naming a track
 * "cello" usually means it.
 */
export function scoreFromMidi(parsed, { title = null } = {}) {
  const byChannel = new Map()
  for (const track of parsed.tracks ?? []) {
    for (const note of track.notes ?? []) {
      if (!byChannel.has(note.channel)) byChannel.set(note.channel, { channel: note.channel, program: null, name: '', notes: [] })
      byChannel.get(note.channel).notes.push(note)
    }
    for (const [channel, program] of Object.entries(track.programs ?? {})) {
      const numeric = Number(channel)
      if (!byChannel.has(numeric)) byChannel.set(numeric, { channel: numeric, program: null, name: '', notes: [] })
      const group = byChannel.get(numeric)
      if (!group.name && track.name) group.name = track.name
      // The first program change is the patch the part starts on; later ones
      // are switches this model has no place for, so the first one is kept.
      if (group.program === null) group.program = Number(program)
    }
  }

  const channels = [...byChannel.keys()].sort((a, b) => a - b)
  const used = new Set()
  const tracks = channels.map((channel, index) => {
    const group = byChannel.get(channel)
    const drum = channel === 9
    const program = drum ? 0 : (group.program ?? 0)
    let name = group.name || (drum ? 'drums' : `channel-${channel + 1}`)
    for (let suffix = 2; used.has(name); suffix++) name = `${group.name || (drum ? 'drums' : `channel-${channel + 1}`)} ${suffix}`
    used.add(name)
    return {
      name,
      instrument: drum ? 'drums' : programName(program),
      program,
      channel,
      ...(drum ? { drums: true } : {}),
      gainDb: 0,
      pan: 0,
      notes: group.notes
        .sort((a, b) => a.start - b.start || a.midi - b.midi)
        .map((note) => [Number(note.start.toFixed(4)), Number(note.duration.toFixed(4)), note.midi, note.velocity]),
    }
  })

  return {
    title: title ?? 'imported-midi',
    tracks,
    durationSec: parsed.durationSec,
  }
}
