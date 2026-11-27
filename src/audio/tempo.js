/**
 * Tempo map: meter and tempo changes on a time line, plus the two conversions a
 * score needs — a bar position to seconds, and seconds back to a bar position.
 *
 * A score keeps note times in seconds, so a tempo map does not change how a
 * score sounds; it decides where the bar lines are, what the MIDI file says, and
 * (later) what the editor draws. Keeping it out of the note stream is what makes
 * "change the tempo at bar 9" safe: nothing already rendered moves.
 *
 * Positions are written the way a person counts them — bar 1, beat 1, sixteenth 1
 * are all 1-based, and a tick inside a sixteenth is 0-based (0..127), because
 * "start of the sixteenth" has to be expressible.
 */

export const DEFAULT_METER = [4, 4]
export const DEFAULT_BPM = 120
const MAX_TICK = 127
const TICKS_PER_SIXTEENTH = 128

/** A meter as a number of whole notes per bar: 4/4 → 1, 3/4 → 0.75, 6/8 → 0.75. */
export function meterValue(meter) {
  const pair = Array.isArray(meter) ? meter : String(meter ?? '').split('/')
  const num = Number(pair[0])
  const den = Number(pair[1])
  if (!Number.isFinite(num) || !Number.isFinite(den) || num <= 0 || den <= 0) {
    throw new Error(`meter "${Array.isArray(meter) ? meter.join('/') : meter}" is not a pair like [4, 4]`)
  }
  return { num, den, r: num / den, beats: num }
}

/** One bar is this many seconds at this tempo and meter. */
export function barSeconds(bpm, meter) {
  // Called both with a raw pair ([4, 4]) and with an already normalised entry.
  const m = meter && typeof meter === 'object' && !Array.isArray(meter) && Number.isFinite(meter.r)
    ? meter
    : meterValue(meter)
  return (240 * m.r) / bpm
}

/**
 * Normalise a tempo map. Accepts [{ bar, bpm, meter }] (bar 1-based) and returns
 * a sorted list where every entry carries its own start time in seconds.
 */
export function buildTempoMap(spec) {
  if (spec === undefined || spec === null) return []
  if (!Array.isArray(spec)) throw new Error('tempo must be a list like [{ bar: 1, bpm: 120, meter: [4, 4] }]')
  const entries = []
  for (const [index, raw] of spec.entries()) {
    if (!raw || typeof raw !== 'object') throw new Error(`tempo #${index + 1} is not an object`)
    const bar = Number(raw.bar ?? raw.atBar ?? raw.fromBar)
    const bpm = Number(raw.bpm ?? raw.tempo)
    if (!Number.isFinite(bar) || bar < 1) throw new Error(`tempo #${index + 1}: "bar" must be 1 or more`)
    if (!Number.isFinite(bpm) || bpm < 20 || bpm > 400) throw new Error(`tempo #${index + 1}: "bpm" must be between 20 and 400`)
    const meter = raw.meter === undefined ? null : meterValue(raw.meter)
    entries.push({ bar: Math.round(bar), bpm, meter, r: meter ? meter.r : null })
  }
  if (entries.length === 0) return []
  entries.sort((a, b) => a.bar - b.bar || 0)
  if (entries[0].bar !== 1) {
    entries.unshift({ bar: 1, bpm: DEFAULT_BPM, meter: meterValue(DEFAULT_METER), r: meterValue(DEFAULT_METER).r, implicit: true })
  } else if (!entries[0].meter) {
    entries[0].meter = meterValue(DEFAULT_METER)
    entries[0].r = entries[0].meter.r
  }
  // Fill a missing value from the entry before it — a tempo change keeps the
  // meter, a meter change keeps the tempo.
  for (let i = 1; i < entries.length; i += 1) {
    if (!entries[i].meter) {
      entries[i].meter = entries[i - 1].meter
      entries[i].r = entries[i].meter.r
    }
  }
  let seconds = 0
  let previous = null
  for (const entry of entries) {
    if (previous) {
      const bars = entry.bar - previous.bar
      seconds += bars * barSeconds(previous.bpm, previous.meter)
    }
    entry.startSec = seconds
    previous = entry
  }
  return entries
}

/** The entry that is in force at a bar (a 1-based bar number). */
export function tempoAtBar(map, bar) {
  if (!map || map.length === 0) {
    const meter = meterValue(DEFAULT_METER)
    return { bar: 1, bpm: DEFAULT_BPM, meter, r: meter.r, startSec: 0 }
  }
  let found = map[0]
  for (const entry of map) {
    if (entry.bar <= bar) found = entry
    else break
  }
  return found
}

/**
 * Bar position → seconds.
 *
 * The formula is the one in docs/any-audio/BEAT-SPEC.md:
 * (240*r/bpm)*A + (60/bpm)*B + (15/bpm)*C + (15/(128*bpm))*D - (240/bpm)*r - (75/bpm)
 * measured from the start of the tempo segment the bar falls in, so a tempo
 * change at bar 9 keeps bar 9 exactly where the bars before it put it.
 */
export function barToSeconds(map, bar, beat = 1, sixteenth = 1, tick = 0) {
  const A = Number(bar)
  const B = Number(beat)
  const C = Number(sixteenth)
  const D = Number(tick)
  if (!Number.isFinite(A) || A < 1) throw new Error(`bar must be 1 or more (got ${bar})`)
  if (!Number.isFinite(B) || B < 1) throw new Error(`beat must be 1 or more (got ${beat})`)
  if (!Number.isFinite(C) || C < 1) throw new Error(`sixteenth must be 1 or more (got ${sixteenth})`)
  if (!Number.isFinite(D) || D < 0 || D > MAX_TICK) throw new Error(`tick must be 0..${MAX_TICK} (got ${tick})`)
  const entry = tempoAtBar(map, A)
  const { bpm, meter } = entry
  const beatsPerBar = Math.floor(4 * meter.r)
  if (B > beatsPerBar) {
    throw new Error(`bar ${A} has ${beatsPerBar} beat(s) at ${meter.num}/${meter.den}, so beat ${B} does not exist`)
  }
  const local = A - entry.bar
  return entry.startSec
    + (240 * meter.r / bpm) * local
    + (60 / bpm) * (B - 1)
    + (15 / bpm) * (C - 1)
    + (15 / (TICKS_PER_SIXTEENTH * bpm)) * D
}

/** Seconds → the bar position nearest to it, as { bar, beat, sixteenth, tick }. */
export function secondsToBar(map, seconds) {
  const sec = Math.max(0, Number(seconds) || 0)
  if (!map || map.length === 0) {
    const meter = meterValue(DEFAULT_METER)
    const unit = 60 / DEFAULT_BPM
    const barLen = barSeconds(DEFAULT_BPM, meter)
    const index = Math.floor(sec / barLen)
    const rest = sec - index * barLen
    return {
      bar: index + 1,
      beat: Math.floor(rest / unit) + 1,
      sixteenth: Math.floor((rest - Math.floor(rest / unit) * unit) / (unit / 4)) + 1,
      tick: Math.min(MAX_TICK, Math.floor(((rest - Math.floor(rest / (unit / 4)) * (unit / 4))) / (unit / 4 / TICKS_PER_SIXTEENTH))),
    }
  }
  let entry = map[0]
  for (const candidate of map) {
    if (candidate.startSec <= sec + 1e-9) entry = candidate
    else break
  }
  const barLen = barSeconds(entry.bpm, entry.meter)
  const beats = Math.floor((sec - entry.startSec) / barLen)
  const bar = entry.bar + beats
  const inBar = sec - (entry.startSec + beats * barLen)
  const unit = 60 / entry.bpm
  const sixteenthUnit = unit / 4
  const beat = Math.floor(inBar / unit) + 1
  const inBeat = inBar - (beat - 1) * unit
  const sixteenth = Math.floor(inBeat / sixteenthUnit) + 1
  const inSixteenth = inBeat - (sixteenth - 1) * sixteenthUnit
  const tick = Math.min(MAX_TICK, Math.floor(inSixteenth / (sixteenthUnit / TICKS_PER_SIXTEENTH)))
  return { bar, beat, sixteenth, tick }
}

/** The tempo events a MIDI file needs, in seconds, for a compiled score. */
export function tempoEvents(map) {
  return (map || []).map((entry) => ({
    atSec: entry.startSec,
    bar: entry.bar,
    bpm: entry.bpm,
    meter: entry.meter.num + '/' + entry.meter.den,
  }))
}

/** Beats per bar for a tempo entry (4/4 → 4, 3/4 → 3, 6/8 → 3 quarter-note beats). */
export function beatsPerBar(entry) {
  return Math.floor(4 * entry.meter.r)
}

/**
 * Seconds → MIDI ticks under a tempo map. A MIDI file counts ticks at a fixed
 * resolution, so the tick rate changes with the tempo: each segment contributes
 * its whole bars, and the offset inside the segment is scaled by its own bpm.
 */
export function secondsToTicks(map, seconds, ppq) {
  const sec = Math.max(0, Number(seconds) || 0)
  if (!map || map.length === 0) return Math.round(sec * (ppq * DEFAULT_BPM) / 60)
  let entry = map[0]
  let ticks = 0
  for (let i = 0; i < map.length; i += 1) {
    const next = map[i + 1]
    if (next && sec >= next.startSec) {
      ticks += (next.bar - map[i].bar) * beatsPerBar(map[i]) * ppq
      entry = next
    } else {
      entry = map[i]
      break
    }
  }
  const quarters = ((sec - entry.startSec) * entry.bpm) / 60
  return Math.round(ticks + quarters * ppq)
}

/** The inverse, for reading a tick position back as seconds. */
export function ticksToSeconds(map, ticks, ppq) {
  if (!map || map.length === 0) return (Math.max(0, Number(ticks) || 0) / ppq) * (60 / DEFAULT_BPM)
  let entry = map[0]
  let base = 0
  for (let i = 0; i < map.length; i += 1) {
    const perBar = beatsPerBar(map[i]) * ppq
    const next = map[i + 1]
    const span = next ? (next.bar - map[i].bar) * perBar : Infinity
    if (ticks < base + span) {
      entry = map[i]
      return entry.startSec + ((ticks - base) / ppq) * (60 / entry.bpm)
    }
    if (!next) return entry.startSec + ((ticks - base) / ppq) * (60 / entry.bpm)
    base += span
  }
  return entry.startSec
}
