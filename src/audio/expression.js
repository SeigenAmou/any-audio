// Played, not written.
//
// A note list says which pitches happen when. It does not say that the player
// leaned into the third bar, that the strings swelled under the last chord, or
// that the pedal stayed down across the phrase. Those are events in their own
// right — pitch bend, controller moves, velocity changes, small timing
// irregularities — and every renderer we have (SoundFont, VST2 through a MIDI
// file, a hardware module) plays them as written.
//
// The shapes are borrowed from the `dsh-midi-studio` plugin's effects layer,
// with one deliberate change: times are seconds on the project timeline, not
// beats. A score here is authored in seconds, so an expression that says
// "beat 12" would need the tempo to mean anything.

const BEND_CENTER = 8192
const BEND_LIMIT = 8191

export const EXPRESSION_TYPES = [
  'pitchbend_line',
  'pitchbend_curve',
  'cc_line',
  'cc_curve',
  'sustain',
  'velocity_line',
  'humanize',
]

const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value))
const finite = (value) => typeof value === 'number' && Number.isFinite(value)

/** Deterministic jitter: the same score and seed always give the same shuffle. */
function lcg(seed) {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 4294967296
  }
}

function seedOf(text) {
  let hash = 2166136261 >>> 0
  for (let i = 0; i < text.length; i++) {
    hash = ((hash ^ text.charCodeAt(i)) * 16777619) >>> 0
  }
  return hash
}

function pickTracks(tracks, name, type) {
  if (name === undefined || name === null || name === '') return tracks
  const found = tracks.find((track) => track.name === name)
  if (!found) {
    const available = tracks.map((track) => `"${track.name}"`).join(', ')
    throw new Error(
      `expression "${type}" names track "${name}", which this score does not have. `
      + `The tracks are: ${available || '(none)'}. Leave "track" out to reach every track.`,
    )
  }
  return [found]
}

function window(spec, type) {
  const start = Number(spec.start)
  const end = Number(spec.end)
  if (!finite(start) || !finite(end)) {
    throw new Error(`expression "${type}" needs "start" and "end" in seconds`)
  }
  if (end <= start) {
    throw new Error(`expression "${type}" ends at ${end}s but starts at ${start}s; "end" must be after "start"`)
  }
  return [start, end]
}

/** How many points a moving value is written with: dense enough to sound
 *  smooth, bounded so a long gesture cannot flood the file. */
function stepsFor(start, end) {
  return clamp(Math.round((end - start) * 20), 8, 480)
}

function dropInRange(track, start, end, predicate) {
  const before = track.events.length
  track.events = track.events.filter((event) => !(event.t >= start && event.t <= end && predicate(event)))
  return before - track.events.length
}

function needController(spec, type) {
  const control = Number(spec.control)
  if (!finite(control) || control < 0 || control > 127) {
    throw new Error(`expression "${type}" needs "control" in 0..127`)
  }
  return Math.round(control)
}

/** Rebuild the on/off events of one track from its notes, after a change that
 *  moved or re-weighted them. Everything else in `events` is left alone. */
function rebuildNotes(track) {
  track.events = track.events.filter((event) => event.type !== 'on' && event.type !== 'off')
  for (const note of track.notes) {
    track.events.push({ t: note.start, type: 'on', channel: track.channel, note: note.midi, velocity: note.velocity })
    track.events.push({ t: note.start + note.duration, type: 'off', channel: track.channel, note: note.midi })
  }
  track.events.sort((a, b) => a.t - b.t)
  track.endSec = track.notes.reduce((max, note) => Math.max(max, note.start + note.duration), 0)
}

/**
 * Apply expression specs to compiled tracks, in place.
 *
 * Returns one report per spec so the caller can say what happened — a gesture
 * that touched no note is a mistake worth naming, not a silent no-op.
 */
export function applyExpression(tracks, specs, { warn = () => {} } = {}) {
  const reports = []
  for (const spec of specs ?? []) {
    const type = String(spec?.type ?? '').trim()
    if (!EXPRESSION_TYPES.includes(type)) {
      throw new Error(
        `unknown expression "${type}". Use one of: ${EXPRESSION_TYPES.join(', ')}`,
      )
    }
    const targets = pickTracks(tracks, spec.track, type)
    const label = spec.track === undefined || spec.track === null || spec.track === '' ? 'all' : `"${spec.track}"`

    if (type === 'velocity_line') {
      const [start, end] = window(spec, type)
      const from = clamp(Math.round(Number(spec.from ?? 96)), 1, 127)
      const to = clamp(Math.round(Number(spec.to ?? 96)), 1, 127)
      let points = 0
      for (const track of targets) {
        for (const note of track.notes) {
          if (note.start < start || note.start > end) continue
          const ratio = end === start ? 1 : (note.start - start) / (end - start)
          note.velocity = clamp(Math.round(from + (to - from) * ratio), 1, 127)
          points++
        }
        if (points > 0) rebuildNotes(track)
      }
      if (points === 0) warn(`expression "velocity_line" found no note starting between ${start}s and ${end}s on ${label}`)
      reports.push({ type, track: label, points })
      continue
    }

    if (type === 'humanize') {
      const amount = clamp(Math.round(Number(spec.amount ?? 8)), 0, 64)
      const timing = Math.max(0, Number(spec.timing ?? 0))
      const seed = finite(spec.seed) ? Math.round(spec.seed) : seedOf(targets.map((track) => track.name).join('|'))
      const random = lcg((seed ^ (amount * 31) ^ Math.round(timing * 1000)) >>> 0)
      let points = 0
      for (const track of targets) {
        for (const note of track.notes) {
          const jitter = Math.round((random() * 2 - 1) * amount)
          note.velocity = clamp((note.velocity ?? 96) + jitter, 1, 127)
          if (timing > 0) {
            const shift = (random() * 2 - 1) * timing
            note.start = Math.max(0, note.start + shift)
          }
          points++
        }
        if (points > 0) rebuildNotes(track)
      }
      if (points === 0) warn(`expression "humanize" found no notes on ${label}`)
      reports.push({ type, track: label, points, amount, timing })
      continue
    }

    const [start, end] = window(spec, type)
    let points = 0
    let removed = 0

    if (type === 'sustain') {
      for (const track of targets) {
        removed += dropInRange(track, start, end, (event) => event.type === 'cc' && event.controller === 64)
        track.events.push({ t: start, type: 'cc', channel: track.channel, controller: 64, value: 127 })
        track.events.push({ t: end, type: 'cc', channel: track.channel, controller: 64, value: 0 })
        track.events.sort((a, b) => a.t - b.t)
        points += 2
      }
      reports.push({ type, track: label, points, removed })
      continue
    }

    if (type === 'pitchbend_line' || type === 'pitchbend_curve') {
      const steps = stepsFor(start, end)
      const from = clamp(Number(spec.from ?? 0), -BEND_LIMIT, BEND_LIMIT)
      const to = clamp(Number(spec.to ?? 0), -BEND_LIMIT, BEND_LIMIT)
      const depth = clamp(Number(spec.depth ?? 0), -BEND_LIMIT, BEND_LIMIT)
      const base = clamp(Number(spec.base ?? 0), -BEND_LIMIT, BEND_LIMIT)
      const cycles = Math.max(0.25, Number(spec.cycles ?? 1))
      for (const track of targets) {
        removed += dropInRange(track, start, end, (event) => event.type === 'pitch')
        for (let i = 0; i <= steps; i++) {
          const t = start + ((end - start) * i) / steps
          const bend = type === 'pitchbend_line'
            ? from + ((to - from) * i) / steps
            : base + depth * Math.sin((2 * Math.PI * cycles * i) / steps)
          track.events.push({
            t,
            type: 'pitch',
            channel: track.channel,
            value: clamp(Math.round(bend + BEND_CENTER), 0, 16383),
          })
          points++
        }
        track.events.sort((a, b) => a.t - b.t)
      }
      reports.push({ type, track: label, points, removed })
      continue
    }

    // cc_line / cc_curve
    const control = needController(spec, type)
    const steps = stepsFor(start, end)
    const from = clamp(Number(spec.from ?? 0), 0, 127)
    const to = clamp(Number(spec.to ?? 127), 0, 127)
    const min = clamp(Number(spec.min ?? 0), 0, 127)
    const max = clamp(Number(spec.max ?? 127), 0, 127)
    const cycles = Math.max(0.25, Number(spec.cycles ?? 1))
    const triangle = spec.pattern === 'triangle'
    for (const track of targets) {
      removed += dropInRange(track, start, end, (event) => event.type === 'cc' && event.controller === control)
      for (let i = 0; i <= steps; i++) {
        const t = start + ((end - start) * i) / steps
        let value
        if (type === 'cc_line') {
          value = from + ((to - from) * i) / steps
        } else {
          const phase = (cycles * i) / steps
          if (triangle) {
            const p = phase % 1
            value = min + (max - min) * (0.5 + 0.5 * (1 - 4 * Math.abs(p - 0.5)))
          } else {
            value = min + (max - min) * (0.5 + 0.5 * Math.sin(2 * Math.PI * phase - Math.PI / 2))
          }
        }
        track.events.push({
          t,
          type: 'cc',
          channel: track.channel,
          controller: control,
          value: clamp(Math.round(value), 0, 127),
        })
        points++
      }
      track.events.sort((a, b) => a.t - b.t)
    }
    reports.push({ type, track: label, points, removed })
  }
  return reports
}
