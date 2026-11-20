import { basename } from 'node:path'
import { programName } from './midi-file.js'

/**
 * A style card is a written-down description of how a piece is put together.
 *
 * The reason it exists: this toolchain can render a score it was handed, but it
 * has no way to carry a *way of writing* from one piece to the next. A person
 * who says "like the last one" is talking about tempo, groove, register,
 * density, how many parts were playing and how loud each was — measurable
 * properties of a score, not a feeling. So we measure them, write them into a
 * small JSON file next to a human-readable sentence, and hand that back later.
 *
 * What this deliberately is *not*: a generator. A card does not create notes;
 * turning "syncopated, 92 BPM, minor" into a melody is the part that needs an
 * author. The card's job is to make the next score start from the same facts
 * instead of from a generic idea of "cinematic strings".
 */

export const STYLE_SCHEMA = 1

const NOTE_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B']

// Krumhansl-Kessler key profiles. Correlating a pitch-class histogram against
// the twelve rotations of each is cheap, needs no dependency, and is right often
// enough to be useful as a hint — the confidence number says how much to trust it.
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]

const INTERVAL_NAMES = [
  'unison', 'minor 2nd', 'major 2nd', 'minor 3rd', 'major 3rd', 'perfect 4th',
  'tritone', 'perfect 5th', 'minor 6th', 'major 6th', 'minor 7th', 'major 7th', 'octave',
]

const MINOR_THIRD = 3
const MAJOR_THIRD = 4
const PERFECT_FIFTH = 7

function median(values) {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function mean(values) {
  if (!values.length) return 0
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function std(values) {
  if (values.length < 2) return 0
  const average = mean(values)
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1))
}

function round(value, digits = 3) {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function pearson(a, b) {
  const averageA = mean(a)
  const averageB = mean(b)
  let cov = 0
  let varA = 0
  let varB = 0
  for (let i = 0; i < a.length; i += 1) {
    const da = a[i] - averageA
    const db = b[i] - averageB
    cov += da * db
    varA += da * da
    varB += db * db
  }
  if (!varA || !varB) return 0
  return cov / Math.sqrt(varA * varB)
}

/** Both the score's note objects and the MIDI reader's arrays, as one shape. */
function noteOf(note) {
  if (Array.isArray(note)) return { start: note[0], duration: note[1], midi: note[2], velocity: note[3] ?? 88 }
  return { start: note.start, duration: note.duration, midi: note.midi, velocity: note.velocity ?? 88 }
}

/** Every note of every part, flattened, tagged with where it came from. */
function flatten(compiled) {
  const out = []
  for (const track of compiled.tracks ?? []) {
    for (const raw of track.notes ?? []) {
      const note = noteOf(raw)
      if (!Number.isFinite(note.start) || !Number.isFinite(note.midi)) continue
      out.push({ ...note, part: track.name, program: track.program ?? 0, drums: Boolean(track.drums) })
    }
  }
  out.sort((a, b) => a.start - b.start || a.midi - b.midi)
  return out
}

function pitchClassHistogram(notes) {
  const hist = new Array(12).fill(0)
  for (const note of notes) {
    // Weight by duration so a held chord counts as much as a run of grace notes.
    hist[((Math.round(note.midi) % 12) + 12) % 12] += Math.max(note.duration, 0.05)
  }
  return hist
}

export function detectKey(notes) {
  const pitched = notes.filter((note) => !note.drums)
  if (pitched.length < 4) return { tonic: null, mode: null, label: 'unclear', confidence: 0 }
  const hist = pitchClassHistogram(pitched)
  const candidates = []
  for (let tonic = 0; tonic < 12; tonic += 1) {
    for (const mode of ['major', 'minor']) {
      const profile = mode === 'major' ? MAJOR_PROFILE : MINOR_PROFILE
      const rotated = profile.map((_, index) => profile[(index - tonic + 12) % 12])
      candidates.push({ tonic, mode, score: pearson(hist, rotated) })
    }
  }
  candidates.sort((a, b) => b.score - a.score)
  const best = candidates[0]
  const second = candidates[1]?.score ?? 0
  // Correlations run 0..1 here; how far ahead of the runner-up is what actually
  // tells you whether to believe it.
  const confidence = best.score > 0 ? Math.max(0, Math.min(1, (best.score - second) / best.score)) : 0
  return {
    tonic: best.tonic,
    mode: best.mode,
    label: `${NOTE_NAMES[best.tonic]} ${best.mode}`,
    confidence: round(confidence, 2),
  }
}

/** 16th-note grid facts: how in time the notes are, how late the off-beats sit. */
function rhythmFacts(notes, bpm) {
  const beat = 60 / bpm
  const sixteenth = beat / 4
  const eighth = beat / 2
  if (!notes.length) {
    return { grid: { step: round(sixteenth, 4), onGridRatio: 0, medianOffsetMs: 0 }, swing: { ratio: 0, label: 'straight' }, syncopation: { ratio: 0 } }
  }
  const offsets = []
  let onGrid = 0
  let syncopated = 0
  const lateEighths = []
  for (const note of notes) {
    const steps = note.start / sixteenth
    const nearest = Math.round(steps)
    const offset = (steps - nearest) * sixteenth
    offsets.push(Math.abs(offset))
    if (Math.abs(offset) < 0.015) onGrid += 1
    if (nearest % 4 !== 0) syncopated += 1
    // Notes sitting on an off-beat eighth: how far past it they land is swing.
    if (nearest % 2 === 1 && Math.abs(offset) < eighth * 0.4) lateEighths.push(offset)
  }
  const swingRatio = lateEighths.length ? median(lateEighths) / eighth : 0
  return {
    grid: { step: round(sixteenth, 4), onGridRatio: round(onGrid / notes.length, 3), medianOffsetMs: round(median(offsets) * 1000, 1) },
    swing: {
      ratio: round(swingRatio, 3),
      label: swingRatio > 0.14 ? 'heavy swing' : swingRatio > 0.06 ? 'light swing' : swingRatio < -0.06 ? 'pushed (ahead of the beat)' : 'straight',
    },
    syncopation: { ratio: round(syncopated / notes.length, 3) },
  }
}

/** How many notes sound at once, sampled at every attack. */
function polyphonyFacts(notes) {
  const running = []
  let peak = 0
  for (const note of notes) {
    const active = notes.filter((other) => other.start <= note.start && note.start < other.start + Math.max(other.duration, 0.001))
    running.push(active.length)
    peak = Math.max(peak, active.length)
  }
  return { maxPolyphony: peak, meanPolyphony: round(mean(running), 2) }
}

function partFacts(track, notes) {
  const pitched = notes.filter((note) => !note.drums)
  const source = pitched.length ? pitched : notes
  const midis = source.map((note) => Math.round(note.midi))
  const durations = source.map((note) => note.duration)
  const velocities = source.map((note) => note.velocity)
  const span = track.endSec ? Math.max(track.endSec, 0.1) : Math.max(...notes.map((note) => note.start + note.duration), 0.1)
  return {
    name: track.name,
    instrument: track.vst
      ? `vst: ${basename(track.vst.plugin)}`
      : track.drums ? 'drums' : (track.instrument || programName(track.program ?? 0)),
    program: track.drums ? 0 : (track.program ?? 0),
    drums: Boolean(track.drums),
    notes: notes.length,
    notesPerSec: round(notes.length / span, 2),
    meanDurationSec: round(mean(durations), 3),
    range: midis.length ? [Math.min(...midis), Math.max(...midis)] : null,
    velocity: { mean: Math.round(mean(velocities)), std: Math.round(std(velocities)) },
  }
}

/** Intervals between notes that actually sound together, capped at an octave. */
function harmonyFacts(notes) {
  const pitched = notes.filter((note) => !note.drums).sort((a, b) => a.start - b.start)
  if (pitched.length < 2) return { intervals: [], thirdsShare: 0, fifthsShare: 0 }

  // Bucket by 30 ms so pairs are found without an O(n^2) sweep on long scores.
  const bucketSeconds = 0.03
  const buckets = new Map()
  for (const note of pitched) {
    const key = Math.floor(note.start / bucketSeconds)
    const list = buckets.get(key) ?? []
    list.push(note)
    buckets.set(key, list)
  }
  const counts = new Array(13).fill(0)
  let pairs = 0
  for (const [key, list] of buckets) {
    const around = [...list, ...(buckets.get(key + 1) ?? [])]
    for (let i = 0; i < around.length; i += 1) {
      for (let j = i + 1; j < around.length; j += 1) {
        const distance = Math.abs(Math.round(around[i].midi) - Math.round(around[j].midi))
        if (distance === 0) continue
        counts[Math.min(distance % 12 === 0 ? 12 : distance % 12, 12)] += 1
        pairs += 1
      }
    }
  }
  const intervalList = counts
    .map((count, index) => ({ name: INTERVAL_NAMES[index], share: pairs ? round(count / pairs, 3) : 0 }))
    .filter((entry) => entry.share > 0)
    .sort((a, b) => b.share - a.share)
  const shareOf = (...steps) => (pairs ? round(counts.filter((_, index) => steps.includes(index)).reduce((sum, count) => sum + count, 0) / pairs, 3) : 0)
  return { intervals: intervalList, thirdsShare: shareOf(MINOR_THIRD, MAJOR_THIRD), fifthsShare: shareOf(PERFECT_FIFTH) }
}

/** Whether the piece gets louder, quieter, swells, or stays flat across its arcs. */
function dynamicsFacts(notes) {
  const velocities = notes.map((note) => note.velocity)
  if (notes.length < 3) return { velocity: { mean: Math.round(mean(velocities)), std: 0 }, arc: 'flat' }
  const start = Math.min(...notes.map((note) => note.start))
  const end = Math.max(...notes.map((note) => note.start + note.duration))
  const span = Math.max(end - start, 0.1)
  const thirds = [[], [], []]
  for (const note of notes) {
    const index = Math.min(2, Math.floor(((note.start - start) / span) * 3))
    thirds[index].push(note.velocity)
  }
  const [first, middle, last] = thirds.map((group) => mean(group))
  let arc = 'flat'
  if (middle - first > 4 && middle - last > 4) arc = 'arch (peaks in the middle)'
  else if (first - last > 6) arc = 'falling'
  else if (last - first > 6) arc = 'rising'
  return { velocity: { mean: Math.round(mean(velocities)), std: Math.round(std(velocities)) }, arc }
}

/** Sentences an author can act on, generated from the measured facts. */
function adviceFor(card) {
  const out = []
  const { rhythm, texture, harmony, parts, key } = card
  if (rhythm.swing.ratio > 0.06) {
    out.push(`反拍略拖后（${Math.round(rhythm.swing.ratio * 100)}% 八分音符），写谱时把落在反拍的音往后挪一点，别按正拍写。`)
  }
  if (rhythm.grid.onGridRatio < 0.6) {
    out.push(`只有 ${Math.round(rhythm.grid.onGridRatio * 100)}% 的音精确落在 16 分网格上——这首靠的是人间的时间感，用 humanize 而不是对着网格写字。`)
  }
  if (rhythm.syncopation.ratio > 0.6) {
    out.push(`切分比例 ${Math.round(rhythm.syncopation.ratio * 100)}%：强拍常空着，重音落在弱位；先写反拍再补正拍，比反过来容易。`)
  }
  if (texture.parts >= 7) {
    out.push(`${texture.parts} 个声部同时进行，单轨容易糊——每轨的音域拉开，别让两个声部躺在同一个八度里。`)
  }
  if (texture.maxPolyphony >= 6) {
    out.push(`最多 ${texture.maxPolyphony} 个音同时响，是厚织体；留白段落靠减声部，不靠降音量。`)
  }
  if (harmony.thirdsShare > 0.45) {
    out.push(`和声以三度为主（${Math.round(harmony.thirdsShare * 100)}%），是常规的调内三和弦写法；想更宽可以加五度与八度垫底。`)
  }
  if (harmony.fifthsShare > 0.3) {
    out.push(`五度占比 ${Math.round(harmony.fifthsShare * 100)}%——空五度的骨架感很强，适合铺低音与持续音。`)
  }
  if (parts.some((part) => part.drums && part.notesPerSec > 3)) {
    out.push('鼓组密度偏高（>3 音/秒），注意底鼓与军鼓不要撞在同一个十六分上，会听起来发糊。')
  }
  if (key.tonic !== null && key.confidence < 0.25) {
    out.push('调性感不强（可能有频繁离调或大量打击乐），别硬套一个调号，按音级关系写更稳。')
  }
  if (!out.length) out.push('指标都很常规，按测得的速度、拍号与配器写即可。')
  return out
}

/**
 * The whole card, from a compiled score.
 *
 * `bpm` has to come from the caller: the score model keeps seconds, because the
 * music is placed on a video timeline. A card is about how bars feel, so it
 * needs a beat length — 120 when nobody says otherwise.
 */
export function analyzeStyle(compiled, { id, name, bpm = 120, meter = '4/4', learnedFrom } = {}) {
  const notes = flatten(compiled)
  const durationSec = Math.max(compiled.durationSec ?? 0, ...notes.map((note) => note.start + note.duration), 0.1)
  const parts = (compiled.tracks ?? []).map((track) => partFacts(track, notes.filter((note) => note.part === track.name)))
  const key = detectKey(notes)
  const rhythm = rhythmFacts(notes, bpm)
  const polyphony = polyphonyFacts(notes)
  const harmony = harmonyFacts(notes)
  const dynamics = dynamicsFacts(notes)
  const midis = notes.filter((note) => !note.drums).map((note) => Math.round(note.midi))
  const card = {
    schema: STYLE_SCHEMA,
    id: id ?? null,
    name: name ?? compiled.title ?? 'untitled',
    createdAt: new Date().toISOString(),
    learnedFrom: learnedFrom ?? { kind: 'score', title: compiled.title ?? null },
    clock: { bpm, meter },
    size: { durationSec: round(durationSec, 2), parts: parts.length, notes: notes.length, notesPerSec: round(notes.length / durationSec, 2) },
    key,
    rhythm,
    texture: {
      parts: parts.length,
      maxPolyphony: polyphony.maxPolyphony,
      meanPolyphony: polyphony.meanPolyphony,
      register: midis.length ? [Math.min(...midis), Math.max(...midis)] : null,
    },
    parts,
    harmony,
    dynamics,
  }
  card.summary = summarize(card)
  card.advice = adviceFor(card)
  return card
}

function summarize(card) {
  const busiest = [...card.parts].sort((a, b) => b.notes - a.notes)[0]
  const bits = [
    `${card.clock.bpm} BPM ${card.clock.meter}`,
    card.key.label === 'unclear' ? '调性不明' : `${card.key.label}（置信 ${card.key.confidence}）`,
    `${card.size.parts} 个声部 / ${card.size.notes} 个音符`,
    `主奏是${busiest ? `${busiest.name}（${busiest.instrument}）` : '无'}`,
    `节奏${card.rhythm.swing.label}、切分 ${Math.round(card.rhythm.syncopation.ratio * 100)}%`,
    `力度走势 ${card.dynamics.arc}`,
  ]
  return `${bits.join('；')}。`
}

/** The card as a page a person (or an agent) reads before writing the next one. */
export function describeCard(card) {
  const lines = [
    `# 风格卡：${card.name}`,
    '',
    card.summary,
    '',
    `- 速度 / 拍号：${card.clock.bpm} BPM，${card.clock.meter}`,
    `- 调性：${card.key.label}${card.key.tonic === null ? '' : `（置信度 ${card.key.confidence}）`}`,
    `- 长度：${card.size.durationSec}s，${card.size.parts} 个声部，${card.size.notes} 个音符（${card.size.notesPerSec} 音/秒）`,
    `- 网格：16 分音符 ${round(1 / card.rhythm.grid.step)} 步/秒，对齐率 ${Math.round(card.rhythm.grid.onGridRatio * 100)}%，中位偏移 ${card.rhythm.grid.medianOffsetMs} ms`,
    `- 律动：${card.rhythm.swing.label}（${card.rhythm.swing.ratio}），切分 ${Math.round(card.rhythm.syncopation.ratio * 100)}%`,
    `- 织体：最多 ${card.texture.maxPolyphony} 音同时，平均 ${card.texture.meanPolyphony}；音域 ${card.texture.register ? `${card.texture.register[0]}–${card.texture.register[1]}` : '无音高'}`,
    `- 和声：三度 ${Math.round(card.harmony.thirdsShare * 100)}%，五度 ${Math.round(card.harmony.fifthsShare * 100)}%`,
    `- 力度：平均 ${card.dynamics.velocity.mean}（±${card.dynamics.velocity.std}），走势 ${card.dynamics.arc}`,
    '',
    '## 声部',
    '',
    '| 声部 | 音色 | 音符 | 音/秒 | 平均时值 | 音域 | 力度 |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...card.parts.map((part) => `| ${part.name} | ${part.instrument} | ${part.notes} | ${part.notesPerSec} | ${part.meanDurationSec}s | ${part.range ? `${part.range[0]}–${part.range[1]}` : '—'} | ${part.velocity.mean}±${part.velocity.std} |`),
    '',
    '## 照着写',
    '',
    ...card.advice.map((line) => `- ${line}`),
  ]
  if (card.harmony.intervals.length) {
    lines.push('', '## 同时发声的音程', '', card.harmony.intervals.slice(0, 6).map((entry) => `${entry.name} ${Math.round(entry.share * 100)}%`).join('，'))
  }
  return lines.join('\n')
}
