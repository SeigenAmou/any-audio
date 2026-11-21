// Drum keys are not a scale: a kit answers the keys its samples were mapped to,
// and different banks have very different maps. A bank that answers only a
// handful of keys makes a normal groove look broken — the notes vanish without
// an error. This module finds the nearest key the kit does answer, so a part
// written against one bank still keeps its rhythm on another.

/** General MIDI percussion key names. Only used to explain a mapping. */
export const GM_DRUM_NAMES = {
  35: 'Acoustic Bass Drum',
  36: 'Bass Drum 1',
  37: 'Side Stick',
  38: 'Acoustic Snare',
  39: 'Hand Clap',
  40: 'Electric Snare',
  41: 'Low Floor Tom',
  42: 'Closed Hi-Hat',
  43: 'High Floor Tom',
  44: 'Pedal Hi-Hat',
  45: 'Low Tom',
  46: 'Open Hi-Hat',
  47: 'Low-Mid Tom',
  48: 'Hi-Mid Tom',
  49: 'Crash Cymbal 1',
  50: 'High Tom',
  51: 'Ride Cymbal 1',
  52: 'Chinese Cymbal',
  53: 'Ride Bell',
  54: 'Tambourine',
  55: 'Splash Cymbal',
  56: 'Cowbell',
  57: 'Crash Cymbal 2',
  58: 'Vibraslap',
  59: 'Ride Cymbal 2',
  60: 'Hi Bongo',
  61: 'Low Bongo',
  62: 'Mute Hi Conga',
  63: 'Open Hi Conga',
  64: 'Low Conga',
  65: 'High Timbale',
  66: 'Low Timbale',
  67: 'High Agogo',
  68: 'Low Agogo',
  69: 'Cabasa',
  70: 'Maracas',
  71: 'Short Whistle',
  72: 'Long Whistle',
  73: 'Short Guiro',
  74: 'Long Guiro',
  75: 'Claves',
  76: 'Hi Wood Block',
  77: 'Low Wood Block',
  78: 'Mute Cuica',
  79: 'Open Cuica',
  80: 'Mute Triangle',
  81: 'Open Triangle',
}

/** Families in GM order; a substitution stays inside its family when it can. */
const FAMILIES = [
  ['kick', [35, 36]],
  ['stick', [37]],
  ['snare', [38, 39, 40]],
  ['tom', [41, 43, 45, 47, 48, 50]],
  ['hat', [42, 44, 46]],
  ['cymbal', [49, 51, 52, 53, 55, 57, 59]],
  ['perc', [54, 56, 58, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81]],
]

/** The family a key belongs to, or 'other' for notes outside the GM map. */
export function drumFamily(key) {
  for (const [name, keys] of FAMILIES) {
    if (keys.includes(key)) return name
  }
  return 'other'
}

/**
 * The key a kit should play instead of `key`, or null when it already answers.
 *
 * Prefers the nearest key of the same family — a tom stays a tom, a cymbal
 * stays a cymbal — and only falls back to the nearest key overall when the
 * family is entirely absent, which is common in small kits.
 */
export function nearestDrumKey(key, available) {
  if (!(available instanceof Set) || available.size === 0) return null
  if (available.has(key)) return null
  const family = drumFamily(key)
  let best = null
  for (const candidate of available) {
    const sameFamily = drumFamily(candidate) === family
    const distance = Math.abs(candidate - key)
    const score = sameFamily ? distance : distance + 1000
    if (best === null || score < best.score) best = { key: candidate, score, sameFamily }
  }
  return best
}

/**
 * Rename the notes of a drum track onto the keys the kit actually answers.
 *
 * Mutates `track.notes` and the matching on/off events. Returns one entry per
 * moved key so the caller can say which notes changed instead of quietly
 * altering the part.
 */
export function remapDrumTrack(track, available) {
  const moves = new Map()
  if (!(available instanceof Set) || available.size === 0) return []
  for (const note of track.notes) {
    const match = nearestDrumKey(note.midi, available)
    if (!match) continue
    const from = note.midi
    note.midi = match.key
    const key = `${from}>${match.key}`
    moves.set(key, (moves.get(key) ?? 0) + 1)
  }
  if (moves.size === 0) return []
  for (const event of track.events) {
    if (event.type !== 'on' && event.type !== 'off') continue
    const match = nearestDrumKey(event.note, available)
    if (match) event.note = match.key
  }
  return [...moves.entries()].map(([move, count]) => {
    const [from, to] = move.split('>').map(Number)
    return {
      from,
      to,
      count,
      fromName: GM_DRUM_NAMES[from] ?? `key ${from}`,
      toName: GM_DRUM_NAMES[to] ?? `key ${to}`,
      crossFamily: drumFamily(from) !== drumFamily(to),
    }
  })
}
