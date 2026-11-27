#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { compileScore, parsePitch } from '../src/audio/score.js'
import { buildTrackMidi, exportProjectMidi } from '../src/audio/midi-export.js'
import { selectSources, vst3NoteEvents } from '../src/tools/music.js'
import { encodeWav, parseWav, peakOf, rmsOf, toDb } from '../src/audio/wav.js'
import { synthesizeSfx } from '../src/audio/sfx.js'
import { muxVideo } from '../src/audio/mux.js'
import { drumKeys, planFonts, planOffset, pickProgram } from '../src/audio/banks.js'
import { nearestDrumKey, remapDrumTrack } from '../src/audio/drum-map.js'
import { firstPeakOffset, peakPolyphony, shiftChannels } from '../src/audio/hw-track.js'
import { addPending, listManuals, listPending, manualSlug, pendingFor, readManual, removeManual, removePending, saveManual } from '../src/audio/manuals.js'
import { peInfo, scanVstLibrary, vst2Kind } from '../src/audio/vst-host.js'
import { encodeFxp } from '../src/audio/vst-preset.js'
import { mergeOrchestrationSheets, parseOrchestrationCsv, summarizeOrchestration } from '../src/audio/orchestration.js'
import { categoryOfProgram, fontScore, rankFonts } from '../src/audio/scoring.js'
import { registerAllTools } from '../src/tools/index.js'
import { findFfmpeg, runFfmpeg } from '../src/tools/shared.js'
import { projectDir } from '../src/project/paths.js'
import { BasicMIDI } from 'spessasynth_core'

const repoRoot = resolve('.')
const anyaudioDir = join(repoRoot, '.anyaudio')
const hadAnyAudioDir = existsSync(anyaudioDir)
const tmpDir = join(anyaudioDir, 'test-tmp')
// Generating tools stage their output in `.anyaudio/out` and put material into
// `.anyaudio/projects` (improvement 01 / I-10), both outside `test-tmp`. Record
// what was already there so the run can put the tree back exactly as it found
// it instead of leaving dozens of scratch projects behind.
const outDirPath = join(anyaudioDir, 'out')
const projectsDirPath = join(anyaudioDir, 'projects')
async function listing(path) {
  return new Set(await readdir(path).catch(() => []))
}
const preexistingOut = await listing(outDirPath)
const preexistingProjects = await listing(projectsDirPath)
// The font bookkeeping lives in a machine-wide state file, and the config file
// sits next to it by default: point both at the scratch folder before anything
// reads them, or a test that deletes a font would rewrite the user's own state.
const realStatePath = join(homedir(), '.dsh', 'anyaudio', 'state.json')
async function snapshot(path) {
  try {
    const info = await stat(path)
    return { mtimeMs: info.mtimeMs, content: await readFile(path, 'utf8') }
  } catch {
    return null
  }
}
const realStateBefore = await snapshot(realStatePath)
process.env.ANYAUDIO_STATE = join(tmpDir, 'state.json')
process.env.ANYAUDIO_CONFIG = join(tmpDir, 'config.json')
const exec = { agent: { workspaceRoot: repoRoot } }
const tools = new Map()
registerAllTools({
  tools: { register: (definition) => tools.set(definition.name, definition) },
  logger: { info: () => {} },
  get: () => undefined,
})
const { createProject, readProject } = await import('../src/project/store.js')

/** A project holding one score snapshot; `materials` stems share it, the way a
 *  stems render freezes the same score onto every stem. */
async function midiProject(name, score, materials = 1) {
  const project = await createProject(repoRoot, { name })
  const dir = projectDir(repoRoot, project.id)
  await mkdir(join(dir, 'sources'), { recursive: true })
  await writeFile(join(dir, 'sources', 'm1.score.json'), JSON.stringify(score), 'utf8')
  const rows = []
  for (let index = 1; index <= materials; index++) {
    rows.push({
      id: `m${index}`,
      file: `materials/m${index}.wav`,
      durationSec: 2,
      kind: index === 1 ? 'music' : 'music-stem',
      source: { kind: 'generated', snapshot: 'sources/m1.score.json' },
    })
  }
  await writeFile(join(dir, 'materials', 'index.json'), JSON.stringify({ materials: rows }), 'utf8')
  return { project, dir }
}

/** Read a written .mid back, so the assertions talk about the file, not the model. */
async function readMidi(path) {
  const bytes = await readFile(path)
  return BasicMIDI.fromArrayBuffer(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
}

// Improvement 01 / I-10: the three generating tools refuse to run without a
// project, because audio a person cannot adjust is the failure this suite is
// guarding against. Each call gets a fresh project, so the 20-track limit never
// leaks between tests.
let attachProjectSeq = 0
async function freshAttach() {
  attachProjectSeq++
  const project = await createProject(repoRoot, { name: `verify-attach-${attachProjectSeq}` })
  return project.id
}

let passed = 0
let failed = 0

async function test(name, run) {
  try {
    await run()
    passed++
    console.log(`ok   ${name}`)
  } catch (error) {
    failed++
    console.log(`FAIL ${name}\n     ${error.message}`)
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function near(actual, expected, tolerance, message) {
  assert(Math.abs(actual - expected) <= tolerance, `${message}: expected ${expected} ±${tolerance}, got ${actual}`)
}

// The host validates every tool result against the declared output schema and
// throws away the whole value when it does not match (ToolOutputError), so a
// schema that disagrees with the real return type silently breaks a tool for
// every caller. Mirror the host's subset here and check real returns.
function typeOf(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function schemaProblems(schema, value, path = 'value') {
  const problems = []
  if (!schema || typeof schema !== 'object') return problems
  if (Array.isArray(schema.anyOf)) {
    if (!schema.anyOf.some((option) => schemaProblems(option, value, path).length === 0)) {
      problems.push(`${path} matches none of anyOf`)
    }
    return problems
  }
  if (schema.type) {
    const allowed = Array.isArray(schema.type) ? schema.type : [schema.type]
    const actual = typeOf(value)
    const ok = allowed.some((type) => type === actual || (type === 'integer' && Number.isInteger(value)) || (type === 'number' && actual === 'number'))
    if (!ok) return [`"${path}" must be a ${allowed.join('/')}`]
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) problems.push(`${path} is not one of the enum`)
  if (Array.isArray(value) && schema.items) {
    value.forEach((item, index) => problems.push(...schemaProblems(schema.items, item, `${path}[${index}]`)))
  }
  if (typeOf(value) === 'object') {
    for (const key of schema.required ?? []) if (!(key in value)) problems.push(`"${path}.${key}" is required`)
    if (schema.properties) {
      for (const [key, child] of Object.entries(schema.properties)) {
        if (!(key in value)) continue
        problems.push(...schemaProblems(child, value[key], `${path}.${key}`))
      }
    }
  }
  return problems
}

function assertMatchesOutputSchema(definition, value) {
  const problems = schemaProblems(definition.output?.schema, value)
  assert(problems.length === 0, `${definition.name} output violates its own schema: ${problems.join('; ')}`)
}

function windowRms(channels, sampleRate, startSec, endSec) {
  const start = Math.floor(startSec * sampleRate)
  const end = Math.min(channels[0].length, Math.floor(endSec * sampleRate))
  let sum = 0
  for (let i = start; i < end; i++) sum += channels[0][i] * channels[0][i] + channels[1][i] * channels[1][i]
  return Math.sqrt(sum / Math.max(1, (end - start) * 2))
}

async function writeWav(path, channels, sampleRate = 48000) {
  await writeFile(path, encodeWav({ sampleRate, channels, bitDepth: 16 }))
  return path
}

function tone(seconds, sampleRate, { from = 0, to = seconds, frequency = 220, amplitude = 0.4 } = {}) {
  const frames = Math.ceil(seconds * sampleRate)
  const left = new Float32Array(frames)
  const right = new Float32Array(frames)
  for (let i = Math.floor(from * sampleRate); i < Math.min(frames, Math.floor(to * sampleRate)); i++) {
    const value = Math.sin((2 * Math.PI * frequency * i) / sampleRate) * amplitude
    left[i] = value
    right[i] = value * 0.96
  }
  return [left, right]
}

await mkdir(tmpDir, { recursive: true })

await test('WAV 16-bit roundtrip keeps rate, channels and length', async () => {
  const sampleRate = 44100
  const frames = 22050
  const sine = new Float32Array(frames)
  for (let i = 0; i < frames; i++) sine[i] = Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 0.5
  const parsed = parseWav(encodeWav({ sampleRate, channels: [sine, sine], bitDepth: 16 }))
  assert(parsed.sampleRate === sampleRate, 'sample rate changed')
  assert(parsed.channels.length === 2, 'channel count changed')
  near(parsed.durationSec, 0.5, 0.001, 'duration')
  near(peakOf(parsed.channels), 0.5, 0.01, 'peak')
})

await test('WAV float32 roundtrip keeps precision', async () => {
  const left = Float32Array.from([0.1, -0.25, 0.75, 0])
  const parsed = parseWav(encodeWav({ sampleRate: 48000, channels: [left, left], bitDepth: 32 }))
  for (let i = 0; i < left.length; i++) near(parsed.channels[0][i], left[i], 1e-6, `sample ${i}`)
})

await test('parsePitch understands names and MIDI numbers', async () => {
  assert(parsePitch('A4') === 69, 'A4 should be 69')
  assert(parsePitch('D3') === 50, 'D3 should be 50')
  assert(parsePitch('F#4') === 66, 'F#4 should be 66')
  assert(parsePitch('Bb2') === 46, 'Bb2 should be 46')
  assert(parsePitch(60) === 60, 'MIDI 60')
  let threw = false
  try {
    parsePitch('H2')
  } catch {
    threw = true
  }
  assert(threw, 'invalid pitch name should throw')
})

await test('compileScore builds timed events, chords, humanise and automation', async () => {
  const compiled = compileScore(
    {
      tracks: [
        {
          name: 'lead',
          instrument: 'koto',
          humanize: { timingMs: 6, velocity: 4, seed: 3 },
          notes: [
            [0, 1, 'D4', 80],
            [1, 2, ['D3', 'A3'], 90],
            { t: 2.5, d: 1, p: 'F#4', v: 110 },
          ],
        },
      ],
      automation: [{ track: 'lead', controller: 'volume', points: [[0, 100], [4, 40]] }],
    },
    { sampleRate: 48000 },
  )
  assert(compiled.tracks.length === 1, 'one track')
  const on = compiled.tracks[0].events.filter((event) => event.type === 'on')
  const off = compiled.tracks[0].events.filter((event) => event.type === 'off')
  assert(on.length === 4, `expected 4 note-ons (3 notes + 1 chord extra), got ${on.length}`)
  assert(off.length === 4, `expected 4 note-offs, got ${off.length}`)
  const ccs = compiled.tracks[0].events.filter((event) => event.type === 'cc' && event.controller === 7)
  assert(ccs.length >= 40, `automation should interpolate volume CC7 points, got ${ccs.length}`)
  assert(compiled.tracks[0].endSec >= 3.48, `track end should cover the last note (got ${compiled.tracks[0].endSec.toFixed(3)})`)
})

await test('compileScore rejects impossible pitches with a clear message', async () => {
  let message = ''
  try {
    compileScore({ tracks: [{ name: 'x', instrument: 'koto', notes: [[0, 1, 'C99']] }] })
  } catch (error) {
    message = error.message
  }
  assert(message.includes('pitch'), `error should mention pitch, got "${message}"`)
})

await test('automation written in dB is clamped and says so', async () => {
  // CC values are 0..127. Writing dB here is easy to do (gainDb on the same
  // track takes dB) and the clamp turns every negative into 0, which is
  // silence: one real project shipped a warm pad that was zero for 64 seconds.
  // It has to be reported, not applied quietly.
  const compiled = compileScore({
    tracks: [{ name: 'pad', instrument: 'choir', gainDb: -20, notes: [[0, 2, 60, 80]] }],
    automation: [{ track: 'pad', controller: 'volume', points: [[0, -26], [4, -20]] }],
  })
  const ccs = compiled.tracks[0].events.filter((event) => event.type === 'cc' && event.controller === 7)
  assert(ccs.some((event) => event.value === 0), 'a negative point still clamps to 0')
  const warning = compiled.warnings.find((entry) => entry.includes('automation for "pad"'))
  assert(warning, `clamping must warn, got ${JSON.stringify(compiled.warnings)}`)
  assert(warning.includes('0..127'), 'the warning must name the real range')
  assert(warning.includes('not dB'), 'the warning must say the values are not dB')
  assert(warning.includes('-26'), 'the warning must quote the offending value')
})

await test('automation inside 0..127 stays silent about clamping', async () => {
  const compiled = compileScore({
    tracks: [{ name: 'pad', instrument: 'choir', notes: [[0, 2, 60, 80]] }],
    automation: [{ track: 'pad', controller: 'volume', points: [[0, 100], [4, 40]] }],
  })
  assert(!compiled.warnings.some((entry) => entry.includes('automation')), `a valid curve must not warn, got ${JSON.stringify(compiled.warnings)}`)
})

await test('expr becomes one continuous CC11 curve that arrives when the note ends', async () => {
  const compiled = compileScore({
    tracks: [{
      name: 'cello',
      instrument: 'cello',
      notes: [
        { t: 0, d: 2, p: 'D3', v: 88 },
        { t: 2, d: 4, p: 'F3', v: 88, expr: 40 },
      ],
    }],
  })
  const cc = compiled.tracks[0].events.filter((event) => event.type === 'cc' && event.controller === 11)
  assert(cc.length >= 100, `the curve must be sampled, got ${cc.length} events`)
  assert(cc[0].t === 0 && cc[0].value === 127, `it starts unattenuated at 0 (${JSON.stringify(cc[0])})`)
  const last = cc[cc.length - 1]
  assert(Math.abs(last.t - 6) < 1e-6 && last.value === 40, `it arrives at the mark when the note ends (${JSON.stringify(last)})`)
  const between = cc.filter((event) => event.t > 3 && event.t < 5)
  assert(between.every((event) => event.value > 40 && event.value < 127), 'the curve moves steadily, never jumps back to the top')
  const mono = cc.every((event, index) => index === 0 || event.value <= cc[index - 1].value)
  assert(mono, 'one mark means one fall, not a sawtooth per note')
})

await test('a score without expr sends no CC11 at all', async () => {
  const compiled = compileScore({ tracks: [{ name: 'pad', instrument: 'choir', notes: [[0, 2, 60, 80]] }] })
  assert(
    !compiled.tracks[0].events.some((event) => event.controller === 11),
    'no expr means no CC11 — scores without phrasing render exactly as before',
  )
})

await test('two marks on the same instant take the weaker one', async () => {
  const compiled = compileScore({
    tracks: [{
      name: 'split',
      instrument: 'cello',
      notes: [
        { t: 0, d: 1, p: 'D3', v: 88, expr: 100 },
        { t: 0.5, d: 0.5, p: 'A3', v: 88, expr: 30 },
      ],
    }],
  })
  const atOne = compiled.tracks[0].events.filter((event) => event.controller === 11 && Math.abs(event.t - 1) < 1e-6)
  assert(atOne.length === 1 && atOne[0].value === 30, `the weaker mark wins (${JSON.stringify(atOne)})`)
})

await test('an out-of-range expr is clamped and reported', async () => {
  const compiled = compileScore({
    tracks: [{ name: 'lead', instrument: 'violin', notes: [{ t: 0, d: 1, p: 'D4', v: 88, expr: 200 }] }],
  })
  const warning = compiled.warnings.find((entry) => entry.includes('expr'))
  assert(warning && warning.includes('0..127'), `clamping must warn, got ${JSON.stringify(compiled.warnings)}`)
})

await test('MIDI export writes one file per instrument track, with notes and CC11', async () => {
  const score = {
    title: '小样',
    tracks: [
      { name: '大提琴', instrument: 'cello', notes: [{ t: 0, d: 2, p: 'D3', v: 90, expr: 60 }] },
      { name: '鼓', drums: true, notes: [[0, 0.5, 'kick', 100]] },
    ],
  }
  // A stems render freezes the same score onto every stem's snapshot: one score.
  const { project, dir } = await midiProject('verify-midi-export', score, 2)
  const result = await exportProjectMidi({ workspaceRoot: repoRoot, projectId: project.id })
  assert(result.files.length === 2, `one file per instrument track, got ${result.files.length} (${result.files.join(', ')})`)
  assert(result.files.every((file) => file.startsWith('midi/')), `files land under midi/ (${result.files.join(', ')})`)
  assert(result.files[0].endsWith('/大提琴.mid'), `the file is named after its track (${result.files[0]})`)

  const parsed = await readMidi(join(dir, result.files[0]))
  assert(parsed.format === 0 && parsed.timeDivision === 480, `format 0 at 480 ppq, got ${parsed.format}/${parsed.timeDivision}`)
  const events = parsed.tracks.flatMap((track) => track.events)
  const on = events.filter((event) => (event.statusByte & 0xf0) === 0x90)
  const off = events.filter((event) => (event.statusByte & 0xf0) === 0x80)
  const cc11 = events.filter((event) => (event.statusByte & 0xf0) === 0xb0 && event.data[0] === 11)
  assert(on.length === 1 && off.length === 1, `one note on and off, got ${on.length}/${off.length}`)
  assert(on[0].data[0] === 50 && on[0].data[1] === 90 && on[0].ticks === 0, `the note keeps its pitch, velocity and start (${JSON.stringify({ note: on[0].data[0], vel: on[0].data[1], tick: on[0].ticks })})`)
  assert(cc11.length > 30, `the expression curve is in the file, got ${cc11.length} CC11 events`)
  assert(cc11[cc11.length - 1].data[1] === 60 && cc11[cc11.length - 1].ticks === 1920, 'the curve ends at the note end (2 s = 1920 ticks at 120 BPM)')
  assert(events.every((event) => !((event.statusByte & 0xf0) === 0xb0 && [7, 10, 91, 93].includes(event.data[0]))), 'mix CCs stay out of the file')

  const drumMidi = await readMidi(join(dir, result.files[1]))
  const drumOn = drumMidi.tracks.flatMap((track) => track.events).find((event) => (event.statusByte & 0xf0) === 0x90)
  assert((drumOn.statusByte & 0x0f) === 9, `a drum track keeps channel 10 (${drumOn.statusByte & 0x0f})`)

  const again = await exportProjectMidi({ workspaceRoot: repoRoot, projectId: project.id })
  const folder = again.files[0].split('/')[1]
  const written = await readdir(join(dir, 'midi', folder))
  assert(written.length === 2, `a second click replaces instead of piling up, got ${written.length} files`)
})

await test('two tracks with one name get distinct MIDI files', async () => {
  const score = {
    title: '同名',
    tracks: [
      { name: 'lead', instrument: 'violin', notes: [[0, 1, 'D4', 80]] },
      { name: 'lead', instrument: 'cello', notes: [[0, 1, 'D3', 80]] },
    ],
  }
  const { project } = await midiProject('verify-midi-names', score)
  const result = await exportProjectMidi({ workspaceRoot: repoRoot, projectId: project.id })
  assert(result.files.length === 2, `both tracks export, got ${result.files.length}`)
  assert(result.files.some((file) => file.endsWith('/lead.mid')), `first keeps the plain name (${result.files.join(', ')})`)
  assert(result.files.some((file) => file.endsWith('/lead-2.mid')), `the second is suffixed (${result.files.join(', ')})`)
})

await test('MIDI events at the same tick put the controller before the note', async () => {
  const compiled = compileScore({
    tracks: [{ name: 'lead', instrument: 'violin', notes: [{ t: 0, d: 1, p: 'D4', v: 88, expr: 60 }] }],
  })
  const bytes = buildTrackMidi(compiled.tracks[0])
  const parsed = BasicMIDI.fromArrayBuffer(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
  const voice = parsed.tracks[0].events.find((event) => (event.statusByte & 0xf0) === 0xb0 || (event.statusByte & 0xf0) === 0x90)
  assert(voice && (voice.statusByte & 0xf0) === 0xb0 && voice.data[0] === 11, `the curve comes first, got ${JSON.stringify(voice?.statusByte)}`)
})

await test('VST3 wiring hands over CC11 only, clamped inside the render length', async () => {
  const compiled = compileScore({
    tracks: [{
      name: 'lead',
      instrument: 'violin',
      pan: 0.3,
      reverb: 0.5,
      notes: [{ t: 0, d: 4, p: 'D4', v: 88, expr: 30 }],
    }],
  })
  const track = compiled.tracks[0]
  // The note ends exactly on the render length, so the curve's last point sits on it.
  const events = vst3NoteEvents(track, 4)
  assert(events.ccs.length > 50, `the curve is handed to the sidecar (${events.ccs.length})`)
  assert(events.ccs.every((cc) => cc.controller === 11), 'only the expression controller is handed over')
  assert(events.ccs.every((cc) => cc.t < 4), `no controller at or past the render length (max ${Math.max(...events.ccs.map((cc) => cc.t)).toFixed(3)})`)
  assert(events.ccs[events.ccs.length - 1].value === 30, 'the curve still arrives at the mark')
  assert(!events.ccs.some((cc) => [7, 10, 91, 93].includes(cc.controller)), 'mix CCs stay in the audio path')
})

await test('expr plus an expression automation curve is reported, not silently mixed', async () => {
  const compiled = compileScore({
    tracks: [{ name: 'pad', instrument: 'choir', notes: [{ t: 0, d: 2, p: 'C4', v: 80, expr: 60 }] }],
    automation: [{ track: 'pad', controller: 'expression', points: [[0, 127], [2, 60]] }],
  })
  assert(
    compiled.warnings.some((entry) => entry.includes('both drive CC11')),
    `expected the double-drive warning, got ${JSON.stringify(compiled.warnings)}`,
  )
})

await test('MIDI export on a project with no score writes nothing and says so', async () => {
  const project = await createProject(repoRoot, { name: 'verify-midi-none' })
  const result = await exportProjectMidi({ workspaceRoot: repoRoot, projectId: project.id })
  assert(result.files.length === 0, `nothing to export, got ${result.files.length}`)
  assert(result.dir === null, 'no folder is created for a project without scores')
})

await test('automation naming an unknown track lists what the score has', async () => {
  let message = ''
  try {
    compileScore({
      tracks: [
        { name: '卡林巴旋律', instrument: 'kalimba', notes: [[0, 1, 60, 80]] },
        { name: '贝斯', instrument: 'bass', notes: [[0, 1, 40, 80]] },
      ],
      // The real mistake: the track's index, not its name.
      automation: [{ track: 2, controller: 'volume', points: [[0, 90]] }],
    })
  } catch (error) {
    message = error.message
  }
  assert(message.includes('unknown track "2"'), `should name the bad value, got "${message}"`)
  assert(message.includes('卡林巴旋律') && message.includes('贝斯'), `should list the available tracks, got "${message}"`)
  assert(message.includes('not its index'), 'should name the index-versus-name confusion')
})

await test('drum tracks accept drum-kit names as pitches', async () => {
  const compiled = compileScore({
    tracks: [{ name: 'perc', instrument: 'drums', drums: true, notes: [[0, 0.2, 'kick'], [0.5, 0.2, 'taiko'], [1, 0.2, 'gong']] }],
  })
  const pitches = compiled.tracks[0].notes.map((note) => note.midi)
  assert(pitches.length === 3, `expected 3 drum notes, got ${pitches.length}`)
  assert(pitches[0] === 36 && pitches[1] === 41 && pitches[2] === 52, `unexpected drum pitches ${pitches.join(',')}`)
})

// The engine tests need a general-purpose bank: a single-instrument bank (an
// electric guitar, say) sorts first by file name and has no koto or cello, so
// picking fonts[0] would compare two fallbacks. Prefer the default bank.
const fontList = (await tools.get('anyaudio_sources').execute({ action: 'list' }, exec)).fonts
const font = fontList.find((item) => item.default) ?? fontList[0]
assert(font, 'a SoundFont must be installed for the engine tests (run node scripts/fetch-font.mjs)')

await test('per-track gainDb is the real relative level of each track', async () => {
  const levels = async (gains) => {
    const result = await tools.get('anyaudio_music').execute(
      {
        projectId: await freshAttach(),
        score: {
          tracks: gains.map((gainDb, index) => ({
            name: `t${index}`,
            instrument: 'strings',
            source: font.id,
            gainDb,
            reverb: 0,
            notes: [[0.2, 0.8, 'C4', 100], [0.2, 0.9, 'G4', 100]],
          })),
        },
        durationSec: 1.5,
        peakDb: null,
        analyze: true,
        output: `.anyaudio/test-tmp/gain-${gains.join('_').replace(/-/g, 'm')}.wav`,
      },
      exec,
    )
    const loudest = Math.max(...result.tracks.map((track) => track.rmsDb))
    return result.tracks.map((track) => track.rmsDb - loudest)
  }
  const pair = await levels([0, -6])
  near(pair[1], -6, 0.6, 'gainDb 0 vs -6 should be 6 dB apart')
  const positive = await levels([3, -2])
  near(positive[1], -5, 0.6, 'gainDb +3 vs -2 should be 5 dB apart')
  assert(positive[0] > -0.1, `the loudest track must sit at the top of the range, got ${positive[0].toFixed(2)}`)
  const single = await levels([0])
  near(single[0], 0, 0.001, 'a single track is the reference')
  const three = await levels([0, -3, -16])
  near(three[1], -3, 0.6, 'second track of [0,-3,-16]')
  near(three[2], -16, 0.8, 'third track of [0,-3,-16]')
})

await test('expr really turns a sustained note down in the render', async () => {
  // The event list is not the feature: what matters is that the SoundFont
  // synthesiser applies the curve to a note that is already sounding.
  const tailRatio = async (expr) => {
    const result = await tools.get('anyaudio_music').execute(
      {
        projectId: await freshAttach(),
        score: {
          tracks: [{
            name: 'cello',
            instrument: 'strings',
            source: font.id,
            reverb: 0,
            notes: [expr === undefined ? [0.2, 3, 'C4', 100] : { t: 0.2, d: 3, p: 'C4', v: 100, expr }],
          }],
        },
        durationSec: 3.6,
        peakDb: null,
        output: `.anyaudio/test-tmp/expr-${expr ?? 'none'}.wav`,
      },
      exec,
    )
    const channels = parseWav(await readFile(result.absolutePath)).channels
    const rmsOf = (fromSec, toSec) => {
      const from = Math.max(0, Math.floor(fromSec * 48000))
      const to = Math.min(channels[0].length, Math.floor(toSec * 48000))
      let sum = 0
      for (let i = from; i < to; i++) sum += channels[0][i] ** 2
      return Math.sqrt(sum / Math.max(1, to - from))
    }
    return rmsOf(2.2, 3.0) / Math.max(1e-9, rmsOf(0.4, 1.2))
  }
  const plain = await tailRatio(undefined)
  assert(plain > 0.6, `a note without expr keeps its level (tail/head ${plain.toFixed(2)})`)
  const shaped = await tailRatio(0)
  assert(shaped < plain * 0.3, `expr:0 must turn the note down audibly (tail/head ${shaped.toFixed(3)} vs ${plain.toFixed(3)})`)
})

await test('the font library is one shared directory, not per project', async () => {
  const { fontSearchDirs, userFontDir, listFonts } = await import('../src/audio/fonts.js')
  const dirs = fontSearchDirs()
  assert(dirs.includes(userFontDir()), 'the shared library must be searched')
  assert(dirs.every((dir) => !dir.includes('.anyaudio')), `no project-level font folder may be scanned, got ${dirs.join(' | ')}`)
  const first = await listFonts()
  const second = await listFonts()
  assert(JSON.stringify(first.map((entry) => entry.path)) === JSON.stringify(second.map((entry) => entry.path)), 'listing must not depend on the caller')
})

await test('deleting a font cannot escape the shared library', async () => {
  const { deleteFont } = await import('../src/audio/font-state.js')
  const libraryDir = join(tmpDir, 'font-library')
  const outsideDir = join(tmpDir, 'font-outside')
  await mkdir(libraryDir, { recursive: true })
  await mkdir(outsideDir, { recursive: true })
  const inside = join(libraryDir, 'allowed.sf2')
  const outside = join(outsideDir, 'secret.sf2')
  await writeFile(inside, 'allowed')
  await writeFile(outside, 'secret')

  const ok = await deleteFont(inside, { dirs: [libraryDir] })
  assert(ok.deleted.toLowerCase().endsWith('allowed.sf2'), `a file inside the library must be deletable, got ${JSON.stringify(ok)}`)

  await writeFile(join(outsideDir, 'dd.sf2'), 'secret')
  let message = ''
  try {
    await deleteFont(join(libraryDir, '..', 'font-outside', 'dd.sf2'), { dirs: [libraryDir] })
  } catch (error) {
    message = error.message
  }
  assert(/refusing/i.test(message), `".." must be refused, got "${message}"`)
  assert(existsSync(join(outsideDir, 'dd.sf2')), 'a refused ".." path must not delete anything')

  // A junction (the Windows equivalent of a symlink that needs no admin) that
  // points outside the library must be refused as well.
  const link = join(libraryDir, 'escape')
  let linked = true
  try {
    await symlink(outsideDir, link, 'junction')
  } catch {
    linked = false
  }
  if (linked) {
    let linkMessage = ''
    try {
      await deleteFont(join(link, 'dd.sf2'), { dirs: [libraryDir] })
    } catch (error) {
      linkMessage = error.message
    }
    assert(/refusing/i.test(linkMessage), `a link pointing outside must be refused, got "${linkMessage}"`)
    assert(existsSync(join(outsideDir, 'dd.sf2')), 'a refused link must not delete anything')
  }
})

await test('sources action "use" really persists the default bank', async () => {
  const { readConfig } = await import('../src/config.js')
  const general = (await tools.get('anyaudio_sources').execute({ action: 'list' }, exec)).fonts.find((entry) => entry.id === 'generaluser') ?? font
  const previous = process.env.ANYAUDIO_CONFIG
  const configPath = join(tmpDir, 'use-config.json')
  process.env.ANYAUDIO_CONFIG = configPath
  try {
    const before = (await readConfig()).config.music.font
    const used = await tools.get('anyaudio_sources').execute({ action: 'use', font: general.name }, exec)
    assert(used.ok === true, 'use must succeed')
    const after = (await readConfig()).config.music.font
    assert(after && after !== before, `config.music.font must change, was "${before}", now "${after}"`)
    // Drum kits are the one thing that still comes from the configured default
    // bank (every melodic track names its own source), so a drum track is what
    // proves "use" reached the renderer.
    const rendered = await tools.get('anyaudio_music').execute(
      {
        projectId: await freshAttach(),
        score: { tracks: [{ name: 'a', instrument: 'drums', drums: true, source: general.id, notes: [[0, 0.3, 'kick'], [0.4, 0.3, 'snare']] }] },
        durationSec: 1,
        output: '.anyaudio/test-tmp/use-default.wav',
      },
      exec,
    )
    assert(rendered.font && rendered.font.toLowerCase().endsWith(general.name.toLowerCase()), `the render must use the new default, got ${rendered.font}`)
  } finally {
    if (previous === undefined) delete process.env.ANYAUDIO_CONFIG
    else process.env.ANYAUDIO_CONFIG = previous
  }
})

await test('render produces audio with the requested exact duration', async () => {
  const result = await tools.get('anyaudio_music').execute(
    {
      projectId: await freshAttach(),
      score: { tracks: [{ name: 'lead', instrument: 'koto', source: font.id, notes: [[0, 1, 'D4', 80], [1, 1, 'A4', 90]] }] },
      durationSec: 2,
      output: '.anyaudio/test-tmp/render-exact.wav',
    },
    exec,
  )
  near(result.durationSec, 2, 0.001, 'duration')
  const wav = parseWav(await readFile(result.absolutePath))
  near(wav.durationSec, 2, 0.001, 'file duration')
  assert(wav.channels.length === 2, 'stereo output')
  assert(result.peakDb <= -2.9 && result.peakDb >= -3.1, `peak should be normalised to -3 dBFS, got ${result.peakDb}`)
})

await test('different instruments produce audibly different spectra', async () => {
  const render = async (instrument, file) => {
    const result = await tools.get('anyaudio_music').execute(
      { projectId: await freshAttach(), score: { tracks: [{ name: 'a', instrument, source: font.id, notes: [[0, 1.2, 'D4', 90]] }] }, durationSec: 1.5, output: file },
      exec,
    )
    return parseWav(await readFile(result.absolutePath))
  }
  const koto = await render('koto', '.anyaudio/test-tmp/koto.wav')
  const cello = await render('cello', '.anyaudio/test-tmp/cello.wav')
  const kotoRms = rmsOf(koto.channels)
  const celloRms = rmsOf(cello.channels)
  assert(kotoRms > 0.001 && celloRms > 0.001, 'both instruments must produce sound')
  let difference = 0
  let energy = 0
  for (let i = 0; i < koto.channels[0].length; i += 7) {
    difference += Math.abs(koto.channels[0][i] - cello.channels[0][i])
    energy += Math.abs(koto.channels[0][i])
  }
  assert(difference / energy > 0.2, `koto and cello should differ (relative difference ${(difference / energy).toFixed(2)})`)
})

await test('velocity controls loudness (dynamic response)', async () => {
  const render = async (velocity, file) => {
    const result = await tools.get('anyaudio_music').execute(
      { projectId: await freshAttach(), score: { tracks: [{ name: 'a', instrument: 'piano', source: font.id, notes: [[0, 1, 'C4', velocity]] }] }, durationSec: 1.2, peakDb: null, output: file },
      exec,
    )
    return parseWav(await readFile(result.absolutePath))
  }
  const soft = await render(30, '.anyaudio/test-tmp/vel-soft.wav')
  const loud = await render(120, '.anyaudio/test-tmp/vel-loud.wav')
  const ratio = toDb(rmsOf(loud.channels) / Math.max(1e-9, rmsOf(soft.channels)))
  assert(ratio > 8, `velocity 120 should be much louder than 30, measured ${ratio.toFixed(1)} dB`)
})

await test('sfx renderer is deterministic', async () => {
  const a = synthesizeSfx({ type: 'wind', durationSec: 1.5, sampleRate: 48000, params: { intensity: 0.6 }, seed: 42 })
  const b = synthesizeSfx({ type: 'wind', durationSec: 1.5, sampleRate: 48000, params: { intensity: 0.6 }, seed: 42 })
  assert(a[0].length === b[0].length && a[0].length === 72000, 'expected 1.5s at 48kHz')
  let maxDiff = 0
  for (let i = 0; i < a[0].length; i++) maxDiff = Math.max(maxDiff, Math.abs(a[0][i] - b[0][i]))
  assert(maxDiff === 0, `same seed must give identical audio, max difference ${maxDiff}`)
  // A different seed has to give different audio, or "deterministic" would also
  // be satisfied by a generator that ignores its seed entirely.
  const c = synthesizeSfx({ type: 'wind', durationSec: 1.5, sampleRate: 48000, params: { intensity: 0.6 }, seed: 43 })
  let different = 0
  for (let i = 0; i < a[0].length; i += 97) different = Math.max(different, Math.abs(a[0][i] - c[0][i]))
  assert(different > 1e-6, 'a different seed must give different audio')
})

await test('a failed mux reports the failure instead of claiming success', async () => {
  const sampleRate = 48000
  const path = await writeWav(join(tmpDir, 'mux-source.wav'), tone(2, sampleRate, { amplitude: 0.2 }), sampleRate)
  await writeFile(join(tmpDir, 'fake.mp4'), Buffer.from('not a real video'))
  const result = await muxVideo(join(tmpDir, 'fake.mp4'), path, join(tmpDir, 'mux-out.mp4'), { audioDurationSec: 2 })
  assert(result.ok === false, 'mux should report failure')
  assert(typeof result.error === 'string' && result.error.length > 0, 'the mux error must be explained')
})

await test('muxing keeps the video length when the audio is shorter or longer', async () => {
  const ffmpeg = findFfmpeg()
  if (!ffmpeg) return
  const sampleRate = 48000
  const videoPath = join(tmpDir, 'five-seconds.mp4')
  await runFfmpeg(ffmpeg.command, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=64x64:rate=10:duration=5', '-pix_fmt', 'yuv420p', videoPath])
  const short = await writeWav(join(tmpDir, 'short.wav'), tone(2, sampleRate, { amplitude: 0.2 }), sampleRate)
  const nearlyEqual = await writeWav(join(tmpDir, 'near.wav'), tone(4.8, sampleRate, { amplitude: 0.2 }), sampleRate)
  const long = await writeWav(join(tmpDir, 'long.wav'), tone(8, sampleRate, { amplitude: 0.2 }), sampleRate)

  const nearly = await muxVideo(videoPath, nearlyEqual, join(tmpDir, 'mux-near.mp4'), { audioDurationSec: 4.8 })
  assert(nearly.ok === true, `near-length mux failed: ${nearly.error ?? ''}`)
  near(nearly.durationSec, 5, 0.15, 'a 4.8s mix into a 5s video must still be 5s')

  const shorter = await muxVideo(videoPath, short, join(tmpDir, 'mux-short.mp4'), { audioDurationSec: 2 })
  assert(shorter.ok === true, `short audio mux failed: ${shorter.error ?? ''}`)
  near(shorter.durationSec, 5, 0.15, 'a 2s mix into a 5s video must keep 5s of picture')

  const longer = await muxVideo(videoPath, long, join(tmpDir, 'mux-long.mp4'), { audioDurationSec: 8 })
  assert(longer.ok === true, `long audio mux failed: ${longer.error ?? ''}`)
  near(longer.durationSec, 5, 0.15, 'an 8s mix into a 5s video must be cut at the picture end')
})

await test('tool definitions are complete and discoverable', async () => {
  assert(tools.size === 11, `expected 11 tools, got ${tools.size}: ${[...tools.keys()].join(', ')}`)
  for (const definition of tools.values()) {
    assert(typeof definition.name === 'string' && definition.name.startsWith('anyaudio_'), `bad tool name ${definition.name}`)
    assert(definition.description.length > 80, `${definition.name} needs a descriptive description`)
    assert(definition.parameters && definition.parameters.type === 'object', `${definition.name} needs object parameters`)
    assert(typeof definition.output?.render === 'function', `${definition.name} needs output.render`)
    assert(definition.output?.schema?.type === 'object', `${definition.name} needs an object output schema`)
  }
})

await test('every tool return value matches its declared output schema', async () => {
  // Regression: `defaultSource: config.music.font || null` shipped a null where
  // the schema promised a string, and the host threw the whole list result away.
  const emptyConfigPath = join(tmpDir, 'schema-config.json')
  const previous = process.env.ANYAUDIO_CONFIG
  process.env.ANYAUDIO_CONFIG = emptyConfigPath
  try {
    const listed = await tools.get('anyaudio_sources').execute({ action: 'list' }, exec)
    assertMatchesOutputSchema(tools.get('anyaudio_sources'), listed)
    assert(!('defaultSource' in listed), 'an unset default source must be omitted, not null')
    const used = await tools.get('anyaudio_sources').execute({ action: 'use', font: 'generaluser' }, exec)
    assertMatchesOutputSchema(tools.get('anyaudio_sources'), used)
    const relisted = await tools.get('anyaudio_sources').execute({ action: 'list' }, exec)
    assertMatchesOutputSchema(tools.get('anyaudio_sources'), relisted)
    assert(typeof relisted.defaultSource === 'string' && relisted.defaultSource.length > 0, 'a saved default should come back as a string')
  } finally {
    if (previous === undefined) delete process.env.ANYAUDIO_CONFIG
    else process.env.ANYAUDIO_CONFIG = previous
  }

  assertMatchesOutputSchema(tools.get('anyaudio_sources'), await tools.get('anyaudio_sources').execute({ action: 'instruments' }, exec))
  assertMatchesOutputSchema(tools.get('anyaudio_sources'), await tools.get('anyaudio_sources').execute({ action: 'kinds' }, exec))
  assertMatchesOutputSchema(tools.get('anyaudio_sources'), await tools.get('anyaudio_sources').execute({ action: 'presets', query: 'koto', limit: 5 }, exec))

  const scorePath = join(tmpDir, 'schema-score.json')
  await writeFile(scorePath, JSON.stringify({ tracks: [{ name: 'lead', instrument: 'koto', source: font.id, notes: [[0, 0.4, 'D4', 80]] }] }))
  const music = await tools.get('anyaudio_music').execute({ projectId: await freshAttach(), score: scorePath, output: '.anyaudio/test-tmp/schema-music.wav', tailSec: 0.2 }, exec)
  assertMatchesOutputSchema(tools.get('anyaudio_music'), music)
  assert(music.ok === true, 'a score given as a file path should render')

  const sfx = await tools.get('anyaudio_sfx').execute({ action: 'catalog' }, exec)
  assertMatchesOutputSchema(tools.get('anyaudio_sfx'), sfx)
  const sfxItems = await tools.get('anyaudio_sfx').execute(
    { projectId: await freshAttach(), items: [{ type: 'impact', startSec: 0, durationSec: 0.4 }], durationSec: 0.5, output: '.anyaudio/test-tmp/schema-sfx.wav' },
    exec,
  )
  assertMatchesOutputSchema(tools.get('anyaudio_sfx'), sfxItems)
})

await test('missing files fail with actionable messages', async () => {
  let message = ''
  try {
    await tools.get('anyaudio_project').execute({ mode: 'add_material', projectId: await freshAttach(), sourcePath: join(tmpDir, 'nope.wav') }, exec)
  } catch (error) {
    message = error.message
  }
  assert(message.length > 0, 'adding a missing file should fail')
})

await test('sources tool lists real instruments and presets', async () => {
  const instruments = await tools.get('anyaudio_sources').execute({ action: 'instruments' }, exec)
  const names = instruments.instruments.flatMap((group) => group.instruments.map((entry) => entry.name))
  for (const expected of ['guzheng', 'erhu', 'dizi', 'xiao', 'taiko', 'cello']) assert(names.includes(expected), `missing instrument alias ${expected}`)
  const presets = await tools.get('anyaudio_sources').execute({ action: 'presets', query: 'koto', limit: 10 }, exec)
  assert(presets.presets.length > 0, 'expected at least one koto preset')
})

await test('sources tool exposes extensible source kinds', async () => {
  const kinds = (await tools.get('anyaudio_sources').execute({ action: 'kinds' }, exec)).kinds
  const ids = kinds.map((kind) => kind.id)
  for (const expected of ['soundfont', 'procedural', 'sample-pack', 'voice']) assert(ids.includes(expected), `missing source kind ${expected}`)
  assert(kinds.find((kind) => kind.id === 'soundfont').status === 'stable', 'soundfont should be stable')
  assert(kinds.find((kind) => kind.id === 'sample-pack').status === 'planned', 'sample packs are not implemented yet')
})

await test('GM programs map to instrument families and scores respect overrides', async () => {
  assert(categoryOfProgram(0) === 'piano', `program 0 → piano, got ${categoryOfProgram(0)}`)
  assert(categoryOfProgram(24) === 'guitar', `program 24 → guitar, got ${categoryOfProgram(24)}`)
  assert(categoryOfProgram(40) === 'strings', `program 40 → strings, got ${categoryOfProgram(40)}`)
  assert(categoryOfProgram(112) === 'percussive', `program 112 → percussive, got ${categoryOfProgram(112)}`)
  const font = { id: 'a', presetScores: [{ bank: 0, program: 24, score: 9 }], scores: { guitar: 4, default: 5 } }
  assert(fontScore(font, 'guitar', 24) === 9, 'preset score should win')
  assert(fontScore(font, 'guitar', 25) === 4, 'category score should apply to other programs')
  assert(fontScore({ id: 'b', scores: {} }, 'strings', 40) === 5, 'default score is 5')
  const ranked = rankFonts([{ id: 'x', scores: { piano: 3 } }, { id: 'y', scores: { piano: 8 } }], 'piano', 0)
  assert(ranked[0].id === 'y' && ranked[1].id === 'x', 'fonts should rank by family score')
})

await test('bank offsets skip collisions and never overflow bank 127', async () => {
  const bankB = { presets: [{ bankMSB: 0, program: 0 }] }
  assert(planOffset(new Set(['0:0', '0:24']), bankB) === 1, 'offset 0 collides, so offset 1 is the smallest safe one')
  assert(planOffset(new Set(), bankB) === 0, 'an empty bank space starts at 0')
  const topBank = { presets: [{ bankMSB: 127, program: 0 }] }
  assert(planOffset(new Set(['127:0']), topBank) === null, 'no offset can keep a bank-127 preset out of collision/overflow')
})

await test('a single-instrument bank plays its own program; ambiguous banks refuse', async () => {
  const solo = { presets: [{ bankMSB: 0, program: 40 }] }
  assert(pickProgram(solo, 24) === 40, 'a one-preset bank should map any request to its preset')
  const exact = { presets: [{ bankMSB: 0, program: 24 }, { bankMSB: 0, program: 40 }] }
  assert(pickProgram(exact, 24) === 24, 'an exact program match wins')
  assert(pickProgram(exact, 56) === null, 'no matching program in a multi-preset bank means refuse')
})

await test('score tracks carry a source, and a missing or unknown one fails clearly', async () => {
  const compiled = compileScore({ tracks: [{ name: 'g', instrument: 'guitar', source: 'generaluser', notes: [[0, 0.5, 'E3', 80]] }] })
  assert(compiled.tracks[0].source === 'generaluser', 'compileScore should pass source through')

  const render = async (track) => {
    try {
      await tools.get('anyaudio_music').execute(
        { projectId: await freshAttach(), score: { tracks: [track] }, durationSec: 0.6, output: '.anyaudio/test-tmp/bad-source.wav' },
        exec,
      )
      return ''
    } catch (error) {
      return error.message
    }
  }

  const unknown = await render({ name: 'g', instrument: 'guitar', source: 'no-such-font', notes: [[0, 0.5, 'E3', 80]] })
  assert(/not installed|unknown sound source/.test(unknown), `expected an actionable source error, got "${unknown}"`)

  // A score written before source was required still plays: it falls back to the
  // first installed font, and the warning names it so the caller can fix the score.
  const loose = compileScore({ tracks: [{ name: 'g', instrument: 'guitar', notes: [[0, 0.5, 'E3', 80]] }] })
  const selected = await selectSources(loose, {})
  assert(selected.warnings.some((warning) => /no source named/.test(warning)), `a missing source should warn, got ${JSON.stringify(selected.warnings)}`)
  assert(loose.tracks[0].source === 'generaluser', 'a missing source falls back to the first installed font')
})

await test('per-track source is reported for every track', async () => {
  const result = await tools.get('anyaudio_music').execute(
    {
      projectId: await freshAttach(),
      score: {
        tracks: [
          { name: 'lead', instrument: 'koto', source: 'generaluser', notes: [[0, 1, 'D4', 80]] },
          { name: 'pad', instrument: 'flute', source: 'generaluser', notes: [[0, 1, 'A4', 70]] },
        ],
      },
      durationSec: 1.2,
      output: '.anyaudio/test-tmp/multi-source.wav',
    },
    exec,
  )
  assert(result.fonts.length >= 1, `explicit source should load at least its bank, got ${result.fonts.length}`)
  assert(result.fonts.some((font) => font.id === 'generaluser'), 'generaluser should be in the plan')
  for (const track of result.tracks) {
    assert(track.source === 'generaluser', `track "${track.name}" must report the source it named, got "${track.source}"`)
  }
})

await test('stems keep the authored balance instead of being re-normalised', async () => {
  const result = await tools.get('anyaudio_music').execute(
    {
      projectId: await freshAttach(),
      score: {
        title: 'balance',
        tracks: [
          { name: 'lead', instrument: 'koto', source: font.id, gainDb: -3, notes: [[0, 1, 'D5', 110], [1, 1, 'A5', 110]] },
          { name: 'pad', instrument: 'slow-strings', source: font.id, gainDb: -24, notes: [[0, 2.4, ['D4', 'A4'], 70]] },
        ],
      },
      durationSec: 2.5,
      stems: true,
      output: '.anyaudio/test-tmp/balance.wav',
    },
    exec,
  )
  const byName = new Map(result.tracks.map((track) => [track.name, track]))
  const drop = byName.get('lead').rmsDb - byName.get('pad').rmsDb
  assert(drop > 8, `the lead should sit clearly above the pad, measured ${drop.toFixed(1)} dB`)
  assert(result.stemsNormalized === false, 'stems must be reported as not normalised')
  assert(result.warnings.some((warning) => warning.includes('below the loudest')), 'a buried part must raise a balance warning')
  // Since I-39 the stem file is scratch: it is copied into materials/ and then
  // deleted, so `stems[]` names the project's own copy — the file the clip bay
  // plays. `stems` and `attached` are built in the same iteration, so the two
  // arrays line up and each path can be matched to the track it came from.
  const stemOf = (name) => result.stems[result.attached.findIndex((entry) => entry.trackName === name)]
  const lead = parseWav(await readFile(join(repoRoot, stemOf('lead'))))
  const pad = parseWav(await readFile(join(repoRoot, stemOf('pad'))))
  const fileRatio = toDb(rmsOf(lead.channels) / Math.max(1e-9, rmsOf(pad.channels)))
  assert(fileRatio > 8, `stem files must preserve the authored difference, measured ${fileRatio.toFixed(1)} dB`)
  // Each stem is its own clip on its own track, so a person can rebalance them.
  assert(result.attached.length === 2, `both stems must land in the project, got ${result.attached.length}`)
  assert(result.attached.every((entry) => entry.trackName && entry.clipId), 'each stem needs its own track and clip')
  // Improvement plan 03, I-39: the stems are material, not deliverables. out/
  // held 539 MB of byte-identical copies of what materials/ already had.
  const outDir = join(repoRoot, '.anyaudio', 'out')
  const outNames = existsSync(outDir) ? await readdir(outDir) : []
  assert(!outNames.some((name) => name.startsWith('stem-')), `no stem may be left in out/, found ${outNames.filter((name) => name.startsWith('stem-')).join(', ')}`)
})

await test('stems with Chinese track names get distinct files', async () => {
  // `\w` is ASCII-only, so every Chinese name collapsed to the same `_`: a
  // five-part score wrote all five stems to one path (only the last survived)
  // and the reply listed that same path five times. Measured on a real project:
  // out/ held a single `score-...-_.wav` for five tracks.
  const result = await tools.get('anyaudio_music').execute(
    {
      projectId: await freshAttach(),
      score: {
        title: 'chinese-stems',
        tracks: [
          { name: '卡林巴旋律', instrument: 'kalimba', source: font.id, gainDb: -4, notes: [[0, 0.6, 76, 90]] },
          { name: '贝斯', instrument: 'finger-bass', source: font.id, gainDb: -6, notes: [[0, 0.6, 40, 90]] },
          { name: '暖垫和声', instrument: 'warm-pad', source: font.id, gainDb: -10, notes: [[0, 0.8, [60, 64], 70]] },
        ],
      },
      durationSec: 1,
      stems: true,
      output: '.anyaudio/test-tmp/chinese-stems.wav',
    },
    exec,
  )
  assert(result.stems.length === 3, `three stems, got ${result.stems.length}`)
  const unique = new Set(result.stems)
  assert(unique.size === 3, `each stem needs its own path, got ${JSON.stringify(result.stems)}`)
  // I-39 moved the reported path to the project's own copy, whose name is the
  // material id; the track name survives on the material record instead, so this
  // checks the three stems really are three different files with their own names.
  const trackNames = result.attached.map((entry) => entry.trackName).sort()
  assert(unique.size === 3 && trackNames.length === 3, `three distinct stems on three tracks, saw ${JSON.stringify(trackNames)}`)
  assert(new Set(trackNames).size === 3, `each stem needs its own track, got ${JSON.stringify(trackNames)}`)
  // The files have to be readable at those paths, and hold different audio.
  const levels = await Promise.all(result.stems.map(async (entry) => rmsOf(parseWav(await readFile(join(repoRoot, entry))).channels)))
  assert(levels.every((level) => level > 0), `no stem may be empty, got ${JSON.stringify(levels)}`)
  // And they are not one file written three times: the three parts were authored
  // 4, 6 and 10 dB down from each other, so identical bytes would be a bug.
  assert(new Set(levels.map((level) => level.toFixed(6))).size === 3, `the three stems must differ, got ${JSON.stringify(levels)}`)
})

await test('a stem that renders to silence is reported as silent, not as quiet', async () => {
  // A pad whose automation was written in dB (CC7 is 0..127) clamped to 0 and
  // produced a file that is all zeros but for the first few samples, which slip
  // through before the CC curve lands. The only warning said it sat "91.3 dB
  // below the loudest track", which points at gainDb — a knob that cannot
  // restore a track something else silenced. Name the real condition.
  const result = await tools.get('anyaudio_music').execute(
    {
      projectId: await freshAttach(),
      score: {
        title: 'silent-pad',
        tracks: [
          { name: 'lead', instrument: 'koto', source: font.id, gainDb: 0, notes: [[0, 1.6, 'D5', 110]] },
          { name: 'pad', instrument: 'choir', source: font.id, gainDb: -4, notes: [[0, 1.6, 60, 80]] },
        ],
        automation: [{ track: 'pad', controller: 'volume', points: [[0, -26], [1.6, -20]] }],
      },
      durationSec: 1.8,
      analyze: true,
      output: '.anyaudio/test-tmp/silent-pad.wav',
    },
    exec,
  )
  const silenced = result.warnings.find((warning) => warning.includes('automation points') && warning.includes('pad'))
  assert(silenced, `a silenced track must be pointed at its automation, got ${JSON.stringify(result.warnings)}`)
  assert(
    !result.warnings.some((warning) => warning.includes('below the loudest track') && warning.includes('per-track gainDb is the balance knob') && warning.includes('pad')),
    'the generic "raise its gainDb" advice must not fire for a track something else silenced',
  )
  // And the clamp itself is reported by the score compiler, in the same reply.
  assert(
    result.warnings.some((warning) => warning.includes('automation for "pad"') && warning.includes('not dB')),
    'the dB-versus-CC mistake must also be named directly',
  )
})

await test('workspace comes from the working-directory service, not process.cwd()', async () => {
  const shared = await import('../src/tools/shared.js')
  const fakeRoot = join(repoRoot, '.anyaudio/test-tmp/fake-ws')
  shared.setWorkingDirectoryService({ ensure: async () => fakeRoot })
  const resolved = await shared.workspaceRootOf({ agent: {} })
  assert(resolved === resolve(fakeRoot), `workingDirectory should win, got ${resolved}`)
  const relative = shared.resolveOutputPath({ workspaceRoot: resolved, requested: 'assets/x.wav', defaultName: 'y.wav' })
  assert(relative === resolve(fakeRoot, 'assets/x.wav'), 'relative output resolves against the project')
  shared.setWorkingDirectoryService(null)
  const none = await shared.workspaceRootOf({ agent: {} })
  assert(none === null, `without the service the workspace must be null, got ${none}`)
  let threw = false
  try {
    shared.resolveOutputPath({ workspaceRoot: null, requested: 'x.wav', defaultName: 'y.wav' })
  } catch {
    threw = true
  }
  assert(threw, 'relative output without a workspace must fail instead of writing into the profile folder')
  assert(
    shared.resolveOutputPath({ workspaceRoot: null, requested: 'C:/tmp/x.wav', defaultName: 'y.wav' }) === 'C:/tmp/x.wav',
    'absolute output must work without a workspace',
  )
})

await test('the runtime skill declares a string source for the dsh-skill contract', async () => {
  const { apply } = await import('../src/index.js')
  let payload = null
  const ctx = {
    get: (id) => (id === 'skills' ? { register: (value) => { payload = value } } : undefined),
    tools: { register: () => {} },
    logger: { info: () => {} },
  }
  apply(ctx, { routes: false })
  for (let attempt = 0; attempt < 40 && !payload; attempt++) await new Promise((resolve) => setTimeout(resolve, 25))
  assert(payload, 'skill was not registered')
  assert(typeof payload.source === 'string' && payload.source.length > 0, `skill source must be a string, got ${JSON.stringify(payload.source)}`)
  assert(typeof payload.whenToUse === 'string' && payload.whenToUse.length > 0, 'skill should advertise whenToUse')
})

await test('the system prompt keeps the rules that decide whether a project survives', async () => {
  // The skill is only loaded when the agent thinks to load it. In the session
  // that prompted this, `skill` was called zero times in a whole build — so
  // everything that lived only in `anyaudio-clipbay.md` was invisible, and one
  // narrator ended up spread across eleven tracks. The rules that change whether
  // the deliverable is still editable therefore have to be in the prompt itself,
  // which is injected every turn.
  const { apply } = await import('../src/index.js')
  let text = null
  const ctx = {
    get: (id) => (id === 'systemPrompt' ? { section: (value) => { text = value.text } } : undefined),
    tools: { register: () => {} },
    logger: { info: () => {} },
  }
  apply(ctx, { routes: false })
  for (let attempt = 0; attempt < 40 && !text; attempt++) await new Promise((resolve) => setTimeout(resolve, 25))
  assert(text, 'the prompt section was not registered')

  // One assertion per rule, so deleting a rule fails here rather than showing up
  // as a bad project three turns later.
  assert(/never one track per sentence/i.test(text), 'the narration track rule has to be stated')
  assert(/every line of one voice/i.test(text), 'and it has to say what to do instead')
  assert(/never one track for everything/i.test(text), 'the opposite mistake must be closed too')
  assert(/mode:"read"/.test(text) && /only the range/i.test(text), 'reading first and staying inside the range')
  assert(/there is no undo/i.test(text), 'and why a broad edit is destructive')
  assert(/never overwrite or delete a material/i.test(text), 'frozen snapshots')
  assert(/no direct ffmpeg/i.test(text), 'the finished file comes from render only')
  assert(/do not re-normalise/i.test(text), 'normalisation happens once')
  assert(!/one track per narration line/i.test(text), 'the old wording that caused this must not come back')
})

await test('the prompt says rebalancing is a clip field, not a second render', async () => {
  // Improvement plan 03, I-42. The "render four times" loop was not the Agent
  // being careless: the guidance told it that per-track gainDb was the balance
  // knob, and the only way to change that was to render the score again.
  const { apply } = await import('../src/index.js')
  let text = null
  const ctx = {
    get: (id) => (id === 'systemPrompt' ? { section: (value) => { text = value.text } } : undefined),
    tools: { register: () => {} },
    logger: { info: () => {} },
  }
  apply(ctx, { routes: false })
  for (let attempt = 0; attempt < 40 && !text; attempt++) await new Promise((resolve) => setTimeout(resolve, 25))
  assert(text, 'the prompt section was not registered')
  assert(/change the balance with clip gain/i.test(text), 'the rule has to be stated, not implied')
  assert(/not by rendering the material again/i.test(text), 'and it has to name the wrong path it replaces')
  assert(/re-generating a whole score/i.test(text), 'including the exact waste it is meant to stop')
})

await test('the music tool no longer sells the old balance story', async () => {
  // The parameter text is what an Agent reads on *every* call, so it outranks the
  // skill. I-18 taught this: a rule that lives only in a skill is invisible to a
  // session that never loads it.
  const music = await readFile(join(repoRoot, 'src', 'tools', 'music.js'), 'utf8')
  assert(!/its real share of the music bus/.test(music), 'the "gainDb is the mix knob" wording must be gone')
  assert(!/Render with analyze:true \(or stems:true\) to see per-track RMS/.test(music), 'and the instruction to call again for RMS')
  assert(!/Use this to check the balance/.test(music), 'the analyze parameter must not promise to turn measurement on')
  assert(/its level is its stem is rendered at|the level its stem is rendered at/i.test(music), 'the new wording says gainDb is a fact about the file')
  assert(/measured during this render|measured as part of rendering/i.test(music), 'and that levels come back without asking')
  assert(/trackName.? is ignored/i.test(music), 'stems:true has to say that trackName is ignored')
})

await test('no document still calls a track a fader', async () => {
  // A track is a grouping now (I-41). "一条轨就是一个推子" was true for one round
  // and would send the next Agent looking for a control that no longer exists.
  for (const rel of ['src/skills/anyaudio-clipbay.md', 'src/skills/anyaudio-scoring.md']) {
    const text = await readFile(join(repoRoot, rel), 'utf8')
    assert(!/一条轨就是一个推子/.test(text), `${rel} still calls a track a fader`)
    assert(!/用那条轨道的 `?gainDb`? 修/.test(text), `${rel} still sends the Agent to the score's gainDb`)
  }
  const scoring = await readFile(join(repoRoot, 'src', 'skills', 'anyaudio-scoring.md'), 'utf8')
  assert(/改片段增益|改\*\*片段增益\*\*/.test(scoring), 'the skill has to name clip gain as the way to rebalance')
  assert(/为了调音量把整首曲子重新生成/.test(scoring), 'and the anti-pattern has to be written down somewhere')
})

await test('creating a project points at the clip bay skill', async () => {
  // B of the same fix: a file listed in the catalog does not tell an agent when
  // to open it, but a sentence in the reply it is already reading does.
  const result = await tools.get('anyaudio_project').execute({ mode: 'create', name: '提示用工程' }, { agent: { workspaceRoot: repoRoot } })
  const rendered = tools.get('anyaudio_project').output.render({ mode: 'create' }, result)
  const text = rendered.map((block) => block.text ?? '').join('\n')
  assert(/anyaudio-clipbay/.test(text), 'the reply has to name the skill')
  assert(/never/i.test(text) || /do not/i.test(text), 'and say what not to do')
  assert(!/give each generated file its own track/i.test(text), 'the sentence that split one narrator across eleven tracks must not come back')
  await rm(join(repoRoot, '.anyaudio', 'projects', result.projectId), { recursive: true, force: true })
})

await test('tts tool exposes edge, mimo and deepseek providers', async () => {
  const definition = tools.get('anyaudio_tts')
  assert(definition, 'anyaudio_tts should be registered')
  assert(definition.description.includes('MiMo'), 'description should name the second engine')
  assert(definition.description.includes('DeepSeek'), 'description should name the third engine')
  assert(/edge/i.test(definition.description), 'description should name the default engine')
  assert(definition.parameters.properties.text, 'text should be a single-shot input')
  assert(definition.parameters.properties.voice, 'voice should be selectable')
  assert(definition.parameters.properties.provider, 'provider should be selectable')
  assert(definition.parameters.properties.provider.enum.includes('deepseek'), 'deepseek should be selectable')
  // The service has no speed, pitch or volume control, so the caller has to be
  // told before it sends one and reads the reply as if it had been honoured.
  assert(/DeepSeek has none of them|no speed, pitch or volume/.test(definition.description), 'description should say DeepSeek has no delivery controls')
  assert(typeof definition.output?.render === 'function', 'tts needs a render summary')
})

await test('deepseek voices belong to deepseek and carry no delivery controls', async () => {
  const { DEEPSEEK_VOICES, providerForVoice, resolveVoice, deepSeekIgnoredControls, buildDeepSeekRequest } = await import('../src/audio/tts-providers.js')
  assert(DEEPSEEK_VOICES.length === 2, `expected two voices, got ${DEEPSEEK_VOICES.length}`)
  for (const voice of DEEPSEEK_VOICES) {
    assert(providerForVoice(voice) === 'deepseek', `${voice} should belong to deepseek`)
  }
  const switched = resolveVoice({ provider: 'edge', voice: 'stella', explicitProvider: false, fallbackVoice: 'zh-CN-YunjianNeural' })
  assert(switched.provider === 'deepseek' && switched.switched, 'a deepseek voice should settle the engine')
  assert(deepSeekIgnoredControls({ rate: '+0%', pitch: '+0Hz', volume: '+0%' }).length === 0, 'the zero defaults are not a request to change anything')
  assert(deepSeekIgnoredControls({ rate: '-12%' }).join() === 'rate', 'a non-zero rate should be reported as ignored')
  const body = buildDeepSeekRequest({ text: '你好', voice: 'tide' })
  assert(body.voice_id === 'tide' && body.format === 'wav', 'the request should carry the voice and ask for wav')
  assert(!('rate' in body) && !('speed' in body), 'the request must not pretend to send a rate')
})

await test('mimo requests go over node:https and honour a per-engine proxy', async () => {
  const { buildMimoRequest } = await import('../src/audio/tts-providers.js')
  const body = buildMimoRequest({ text: '你好', voice: 'mimo_default', style: '温柔地' })
  assert(body.messages.length === 2 && body.messages[1].role === 'assistant', 'text must stay in the assistant role')
  const { DEFAULTS } = await import('../src/config.js')
  assert(DEFAULTS.tts.mimo.proxy === '', 'MiMo must default to a direct connection')
  assert(DEFAULTS.tts.edge.proxy === '', 'Edge keeps its own proxy field')
  const parsed = JSON.parse(JSON.stringify(body))
  assert(parsed.audio.format === 'wav' && parsed.stream === false, 'MiMo still asks for a non-streaming WAV')
})

await test('sfx catalog lists default-bank presets by scene', async () => {
  const catalog = await tools.get('anyaudio_sfx').execute({ action: 'catalog' }, exec)
  assert(catalog.action === 'catalog', 'catalog action should be echoed')
  assert(catalog.presets.length >= 40, `expected a full catalog, got ${catalog.presets.length}`)
  const rain = catalog.presets.find((entry) => entry.id === 'rain')
  assert(rain && rain.zh === '雨' && rain.program === 122 && rain.bank === 1, 'rain should map to program 122 / bank 1')
  assert(rain.shape === 'sustained' && rain.lengthSec === null, 'rain is a sustained bed')
  const shot = catalog.presets.find((entry) => entry.id === 'gun-shot')
  assert(shot && shot.shape === 'one-shot' && shot.lengthSec > 0, 'gun shot is a one-shot with a natural tail')
  const weather = await tools.get('anyaudio_sfx').execute({ action: 'catalog', group: 'weather' }, exec)
  assert(weather.presets.every((entry) => entry.group === 'weather'), 'group filter should be applied')
  assert(weather.presets.some((entry) => entry.id === 'seashore'), 'seashore belongs to weather')
})

await test('sfx preset renders real audio, one file per effect', async () => {
  const output = join(tmpDir, 'sfx-preset')
  const result = await tools.get('anyaudio_sfx').execute(
    {
      projectId: await freshAttach(),
      items: [
        { preset: 'rain', startSec: 0.5, durationSec: 2.5, gainDb: -6 },
        { preset: 'gun-shot', startSec: 0, gainDb: -8 },
      ],
      peakDb: null,
      output,
    },
    exec,
  )
  // Each effect is its own file now, so there is no shared bed length to check:
  // the material length is what the clip plays, and it has to be real audio.
  assert(result.materials.length === 2, `expected 2 materials, got ${result.materials.length}`)
  for (const entry of result.materials) {
    const wav = parseWav(await readFile(entry.absolutePath))
    assert(peakOf(wav.channels) > 0.001, `${entry.file} must not be silent`)
    assert(Math.abs(wav.durationSec - entry.durationSec) < 0.05, `${entry.file}: report says ${entry.durationSec}s, file is ${wav.durationSec}s`)
  }
  const rain = result.materials.find((entry) => entry.preset === 'rain')
  assert(rain, 'the report should name the rain preset')
  assert(rain.presetName.includes('雨'), 'report should use the Chinese name')
  assert(Math.abs(rain.durationSec - 2.5) < 0.05, `rain should be cut at 2.5s, got ${rain.durationSec}`)
  assert(result.materials.every((entry) => entry.attached?.clipId), 'both effects must land as clips')
})

await test('unknown sfx preset points at the catalog', async () => {
  let error = null
  try {
    await tools.get('anyaudio_sfx').execute({ projectId: await freshAttach(), items: [{ preset: 'dragon-roar', startSec: 0 }], durationSec: 1 }, exec)
  } catch (caught) {
    error = caught
  }
  assert(error, 'unknown preset should fail')
  assert(/action:"catalog"/.test(error.message), 'error should point at the catalog')
})

await test('sfx materials mode writes one file per item, each from t=0', async () => {
  const dir = join(tmpDir, 'sfx-materials')
  const result = await tools.get('anyaudio_sfx').execute(
    {
      projectId: await freshAttach(),
      mode: 'materials',
      items: [
        { type: 'impact', durationSec: 0.8, params: { weight: 0.8 } },
        { preset: 'rain', durationSec: 1.5, gainDb: -6 },
        { type: 'whoosh', durationSec: 0.6 },
      ],
      output: dir,
      peakDb: null,
    },
    exec,
  )
  assert(result.mode === 'materials', 'the mode should be echoed')
  assert(result.materials.length === 3, `expected 3 materials, got ${result.materials.length}`)
  // Every material also becomes its own clip, so one effect can be moved without
  // re-rendering the others (improvement 01 / I-10).
  assert(result.materials.every((entry) => entry.attached?.clipId), 'every material must land as a clip')
  const categories = result.materials.map((entry) => entry.attached.trackName)
  assert(new Set(categories).size >= 2, `effects of different categories should not share a track, got ${categories.join(' | ')}`)
  // One file per entry, and every file starts at t=0: that is the whole point of
  // the materials split — placement belongs to the project, not the tool.
  for (const entry of result.materials) {
    const wav = parseWav(await readFile(entry.absolutePath))
    assert(wav.channels[0][0] !== undefined, `${entry.file} must exist and decode`)
    assert(peakOf(wav.channels) > 0.0005, `${entry.file} must not be silent`)
    assert(Math.abs(wav.durationSec - entry.durationSec) < 0.05, `${entry.file}: report says ${entry.durationSec}s, file is ${wav.durationSec}s`)
  }
  assert(result.materials[0].category === '动效', `impact is 动效, got ${result.materials[0].category}`)
  assert(result.materials[1].category === '环境音', `rain is 环境音, got ${result.materials[1].category}`)
  assert(result.materials[2].category === '其他', `whoosh is 其他, got ${result.materials[2].category}`)
  // The per-item length is honoured, not the preset's natural tail.
  assert(Math.abs(result.materials[1].durationSec - 1.5) < 0.02, `rain should be cut at 1.5s, got ${result.materials[1].durationSec}`)
  const manifestRaw = await readFile(join(dir, 'manifest.json'), 'utf8')
  const manifest = JSON.parse(manifestRaw)
  assert(manifest.materials.length === 3, 'the manifest must list every material')
  assert(manifest.materials.every((entry) => typeof entry.category === 'string'), 'each manifest row carries a category')
})

await test('sfx materials mode refuses an item without a length', async () => {
  let error = null
  try {
    await tools.get('anyaudio_sfx').execute({ projectId: await freshAttach(), mode: 'materials', items: [{ type: 'wind' }], output: join(tmpDir, 'sfx-materials-2') }, exec)
  } catch (caught) {
    error = caught
  }
  assert(error, 'an unbounded material should fail')
  assert(/needs durationSec/.test(error.message), `message should name the missing length, got: ${error.message}`)
})

await test('sfx has a single mode and it places events as clips', async () => {
  // Improvement plan 02, I-01. "timeline" mode used to bake every effect into one
  // full-length clip, so nothing inside it could be moved or rebalanced — the
  // exact shape a clip bay exists to prevent. It is gone, and the default with it.
  const output = join(tmpDir, 'sfx-default')
  const result = await tools.get('anyaudio_sfx').execute(
    {
      projectId: await freshAttach(),
      items: [
        { type: 'impact', startSec: 0.3, durationSec: 0.4 },
        { type: 'whoosh', durationSec: 0.4 },
      ],
      output,
      peakDb: null,
    },
    exec,
  )
  assert(result.mode === 'materials', `the only mode is materials, got ${result.mode}`)
  assert(result.materials.length === 2, `one file per effect, got ${result.materials.length}`)
  assert(result.materials.every((entry) => entry.attached?.clipId), 'each effect lands as its own clip')
  assert(result.materials.every((entry) => entry.file), 'and its own file')
  const placed = await readProject(repoRoot, result.projectId)
  const clips = placed.tracks.flatMap((track) => track.items)
  assert(clips.length === 2, `the project should hold two clips, it holds ${clips.length}`)
  assert(clips.some((item) => Math.abs(item.startSec - 0.3) < 1e-6), `the explicit startSec must be honoured, got ${clips.map((item) => item.startSec).join(', ')}`)
})

await test('sfx refuses mode:"timeline" and points at the alternative', async () => {
  let error = null
  try {
    await tools.get('anyaudio_sfx').execute(
      { projectId: await freshAttach(), mode: 'timeline', items: [{ type: 'wind', durationSec: 1 }] },
      exec,
    )
  } catch (caught) {
    error = caught
  }
  assert(error, 'the removed mode must fail')
  assert(/Use mode:"materials"/.test(error.message), `it must name the surviving mode, got: ${error.message}`)
})

await test('a batch of sfx without startSec chains onto one track instead of stacking at 0', async () => {
  // Improvement plan 02, I-02. Every effect used to land at 0s, so freeTrack saw
  // the track busy and opened the next one: ten effects became ten tracks and the
  // project hit its 20-track limit. The rule the person actually wants is
  // "same category that does not overlap shares a track", which needs the start
  // to advance along the category's tracks.
  const result = await tools.get('anyaudio_sfx').execute(
    {
      projectId: await freshAttach(),
      items: [
        { type: 'thunder', durationSec: 0.5 },
        { type: 'thunder', durationSec: 0.5 },
        { type: 'thunder', durationSec: 0.5 },
        { type: 'bell', durationSec: 0.5 },
      ],
      output: join(tmpDir, 'sfx-chain'),
      peakDb: null,
    },
    exec,
  )
  const placed = await readProject(repoRoot, result.projectId)
  const ambientTracks = placed.tracks.filter((track) => track.category === 'ambience')
  assert(ambientTracks.length === 1, `four ambient effects should share one track, they took ${ambientTracks.length}`)
  assert(placed.tracks.length === 2, `ambience + foley = 2 tracks, got ${placed.tracks.map((t) => `${t.name}[${t.category}]`).join(', ')}`)
  const starts = ambientTracks[0].items.map((item) => item.startSec).sort((a, b) => a - b)
  assert(starts.length === 3, `three thunder clips on the ambient track, got ${starts.length}`)
  assert(starts[0] === 0, `the first starts at 0, got ${starts[0]}`)
  for (let index = 1; index < starts.length; index++) {
    assert(starts[index] > starts[index - 1], `clips advance in time, got ${starts.join(', ')}`)
  }
  // And the fade of a clip is not what decides its place: the chain is by length.
  assert(Math.abs(starts[1] - 0.5) < 0.02, `the second starts after the first ends, got ${starts[1]}`)
})

await test('an explicit sfx startSec overlapping another effect gets its own track', async () => {
  // The other half of the same rule: overlapping effects must stay separable, so
  // asking for two sounds at the same instant has to open a second track.
  const result = await tools.get('anyaudio_sfx').execute(
    {
      projectId: await freshAttach(),
      items: [
        { type: 'bell', startSec: 0, durationSec: 1 },
        { type: 'bell', startSec: 0.2, durationSec: 1 },
      ],
      output: join(tmpDir, 'sfx-overlap'),
      peakDb: null,
    },
    exec,
  )
  const placed = await readProject(repoRoot, result.projectId)
  const foley = placed.tracks.filter((track) => track.category === 'foley')
  assert(foley.length === 2, `two overlapping bells are two tracks, got ${foley.length}`)
  assert(foley.map((track) => track.name).sort().join(' | ') === '音效 · 动效 | 音效 · 动效 2', `suffixes only appear when needed, got ${foley.map((t) => t.name).join(' | ')}`)
})

await test('both general banks are suggested, GeneralUser is the default', async () => {
  const { RECOMMENDED_FONTS } = await import('../src/audio/fonts.js')
  const suggested = RECOMMENDED_FONTS.filter((font) => font.suggested).map((font) => font.id)
  assert(suggested.includes('generaluser') && suggested.includes('musescore-general'), `suggested were ${suggested.join(',')}`)
  assert(suggested.length === 2, 'exactly two suggested banks')
  const defaults = RECOMMENDED_FONTS.filter((font) => font.default).map((font) => font.id)
  assert(defaults.length === 1 && defaults[0] === 'generaluser', `default bank should be GeneralUser only, got ${defaults.join(',')}`)
})

await test('the machine-wide state file was never touched', async () => {
  const after = await snapshot(realStatePath)
  assert(JSON.stringify(after) === JSON.stringify(realStateBefore), `real state file changed: ${realStatePath}`)
})

await rm(tmpDir, { recursive: true, force: true })
// Remove only what this run created: the scratch projects and staged files the
// generating tools wrote outside test-tmp. A project that was already in the
// workspace belongs to the user and must survive the test.
for (const name of await listing(outDirPath)) {
  if (!preexistingOut.has(name)) await rm(join(outDirPath, name), { recursive: true, force: true })
}
for (const name of await listing(projectsDirPath)) {
  if (!preexistingProjects.has(name)) await rm(join(projectsDirPath, name), { recursive: true, force: true })
}
// Restore the pre-run state of the scratch parent: when `.anyaudio` did not
// exist before the run, leave the tree exactly as it was.
await test('an unknown instrument names what is close instead of pointing at a list', async () => {
  // Improvement plan 03, I-48. "see the skill" is a round trip: read a long list,
  // come back, and still not find the name — `shaker` is not in the table at all,
  // so the closest thing has to be named for the answer to be usable.
  const { suggestInstruments } = await import('../src/audio/score.js')
  const nearby = suggestInstruments('shaker')
  assert(nearby.length > 0, 'shaker should have candidates')

  let message = ''
  try {
    compileScore({ tracks: [{ name: 'perc', instrument: 'shaker', notes: [[0, 0.2, 'C4', 80]] }] })
  } catch (error) {
    message = error.message
  }
  assert(/unknown instrument "shaker"/.test(message), `the error must still name the value, got "${message}"`)
  assert(nearby.some((name) => message.includes(name)), `the error must list a real instrument name, got "${message}"`)
  assert(/GM program number/.test(message), 'and keep the escape hatch: a numeric program')

  let nonsense = ''
  try {
    compileScore({ tracks: [{ name: 'x', instrument: 'zzzz', notes: [[0, 0.2, 'C4', 80]] }] })
  } catch (error) {
    nonsense = error.message
  }
  assert(/nothing close/i.test(nonsense), `a name with no neighbours must say so, got "${nonsense}"`)

  // A legal name is untouched.
  const { resolveInstrument } = await import('../src/audio/score.js')
  assert(resolveInstrument('piano').program === 0, 'a known instrument still resolves')
})

await test('anyaudio_music takes a .mid file straight, without a json detour', async () => {
  const { encodeMidiFile } = await import('../src/audio/midi-file.js')
  const { scoreFromMidiPath } = await import('../src/tools/music.js')
  const dir = await mkdtemp(join(tmpdir(), 'anyaudio-mid-'))
  try {
    const score = {
      title: 'handoff',
      tracks: [
        { name: 'bass', instrument: 'bass', notes: [[0, 1, 'E2', 100], [1, 1, 'G2']] },
        { name: 'kick', drums: true, notes: [[0, 0.2, 36, 110]] },
      ],
    }
    const file = join(dir, 'handoff.mid')
    await writeFile(file, encodeMidiFile(compileScore(score), { bpm: 120, title: score.title }))
    // A relative path is read from the workspace, an absolute one as given.
    const read = await scoreFromMidiPath(file, dir)
    assert(read.tracks.length === 2, `expected 2 parts, got ${read.tracks.length}`)
    const bass = read.tracks.find((track) => track.name === 'bass')
    assert(bass && bass.program === 33, `the program travel with the file (got ${bass?.program})`)
    const kit = read.tracks.find((track) => track.drums)
    assert(kit !== undefined, 'the drum channel comes back as a drum part')
    assert(read.durationSec > 0, 'the score carries its length')
    let missing = ''
    try { await scoreFromMidiPath(join(dir, 'nope.mid'), dir) } catch (error) { missing = error.message }
    assert(/cannot read/.test(missing), `a missing file names itself (${missing})`)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

await test('a score survives a round trip through a MIDI file', async () => {
  const { encodeMidiFile, parseMidiFile, scoreFromMidi } = await import('../src/audio/midi-file.js')
  const score = {
    title: 'roundtrip',
    tracks: [
      { name: 'piano', instrument: 'piano', notes: [[0, 4, 'C4', 90], [1, 4, 'C5'], [2, 4, 'C6'], [4, 8, ['C3', 'G3', 'C4'], 70]] },
      { name: 'drums', drums: true, notes: [[0, 0.5, 36], [0.5, 0.5, 38], [4, 0.5, 42]] },
    ],
  }
  const compiled = compileScore(score)
  const buffer = encodeMidiFile(compiled, { bpm: 120, title: score.title })
  const parsed = parseMidiFile(buffer)
  assert(parsed.format === 1, 'a score exports as format 1')
  assert(parsed.ppq === 480, 'default resolution is 480 ppq')
  near(parsed.bpm, 120, 0.01, 'tempo')
  const totalNotes = parsed.tracks.reduce((sum, track) => sum + track.notes.length, 0)
  // Four piano onsets (the last one a three-note chord) plus three drum hits:
  // the chord is three notes, not one.
  assert(totalNotes === 9, `expected 9 notes, got ${totalNotes}`)
  near(parsed.durationSec, 12, 0.001, 'the last note ends at 12s')

  const back = scoreFromMidi(parsed, { title: 'again' })
  const again = encodeMidiFile(compileScore(back), { bpm: 120, title: 'again' })
  const parsedAgain = parseMidiFile(again)
  // The bytes may differ (the title is part of the file, and the score gains
  // explicit channels); the music may not. Comparing note identity — channel,
  // pitch, start, length, velocity — is the check that says nothing was lost.
  const key = (note) => `${note.channel}:${note.midi}:${note.start.toFixed(3)}:${note.duration.toFixed(3)}:${note.velocity}`
  const before = parsed.tracks.flatMap((track) => track.notes.map(key)).sort()
  const after = parsedAgain.tracks.flatMap((track) => track.notes.map(key)).sort()
  assert(JSON.stringify(before) === JSON.stringify(after), `notes changed across the round trip:\n${before.join(', ')}\n${after.join(', ')}`)
  assert(back.tracks.some((track) => track.drums === true && track.channel === 9), 'channel 10 comes back as a drum kit')
})

await test('a VST2 part is written from the plain note arrays the tool receives', async () => {
  const { encodeMidiFile, parseMidiFile } = await import('../src/audio/midi-file.js')
  // The tool hands over [[start, duration, midi, velocity], …] while the writer
  // wants objects. Passing the arrays straight through made every note start at
  // tick 0, which renders as silence rather than as the wrong rhythm.
  const arrays = [[0, 0.8, 60, 100], [0.5, 0.8, 64, 100], [1, 1.2, 67, 100]]
  const track = {
    name: 'vst2',
    channel: 0,
    notes: arrays.map(([start, duration, midi, velocity]) => ({ start, duration, midi, velocity })),
  }
  const parsed = parseMidiFile(encodeMidiFile({ tracks: [track] }, { bpm: 120, title: 'vst2' }))
  const notes = parsed.tracks.flatMap((entry) => entry.notes).sort((a, b) => a.start - b.start)
  assert(notes.length === 3, `expected 3 notes, got ${notes.length}`)
  near(notes[0].start, 0, 0.01, 'the first note starts at zero')
  near(notes[1].start, 0.5, 0.01, 'the second note keeps its offset')
  near(notes[2].start, 1, 0.01, 'the third note keeps its offset')
  assert(notes.map((note) => note.midi).join(',') === '60,64,67', 'pitches travel with the notes')
})

await test('anyaudio_midi exports, imports and analyzes a real file', async () => {
  const definition = tools.get('anyaudio_midi')
  assert(definition, 'anyaudio_midi must be registered')
  const dir = join(repoRoot, '.anyaudio', 'test-tmp-midi')
  await mkdir(dir, { recursive: true })
  try {
    const exported = await definition.execute({
      action: 'export',
      score: { title: 'tool', tracks: [{ name: 'lead', instrument: 'flute', notes: [[0, 1, 'A4'], [1, 1, 'C5']] }] },
      output: join(dir, 'out.mid'),
    }, exec)
    assertMatchesOutputSchema(definition, exported)
    assert(exported.ok === true, 'export returns ok')
    const onDisk = await stat(join(dir, 'out.mid'))
    assert(onDisk.size === exported.bytes, 'the file on disk is the one the reply reported')
    assert(exported.tracks.length === 1 && exported.tracks[0].notes === 2, 'export names the part and its note count')

    const imported = await definition.execute({ action: 'import', file: join(dir, 'out.mid') }, exec)
    assertMatchesOutputSchema(definition, imported)
    assert(imported.score.tracks.length === 1, 'one part comes back')
    assert(imported.summary.notes === 2, 'both notes come back')
    assert(imported.score.tracks[0].notes[0].length === 4, 'notes are [start, duration, pitch, velocity]')

    const analyzed = await definition.execute({ action: 'analyze', file: join(dir, 'out.mid') }, exec)
    assertMatchesOutputSchema(definition, analyzed)
    assert(analyzed.analysis.tracks[0].range.length === 2, 'the pitch range is reported')
    assert(analyzed.analysis.grid !== null && analyzed.analysis.grid.onGridRatio >= 0, 'grid alignment is reported')

    let message = ''
    try {
      await definition.execute({ action: 'import' }, exec)
    } catch (error) {
      message = error.message
    }
    assert(/pass "file"/.test(message), `import without a file must say what to pass, got "${message}"`)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

await test('anyaudio_music can hand the arrangement back as a .mid', async () => {
  const { parseMidiFile } = await import('../src/audio/midi-file.js')
  const result = await tools.get('anyaudio_music').execute({
    projectId: await freshAttach(),
    score: { title: 'midi-from-render', tracks: [{ name: 'lead', source: 'generaluser', instrument: 'flute', notes: [[0, 1, 'A4'], [1, 1, 'C5']] }] },
    durationSec: 2,
    midi: true,
  }, exec)
  assert(typeof result.midi === 'string', 'the reply names the .mid it wrote')
  const parsed = parseMidiFile(await readFile(join(repoRoot, result.midi)))
  const notes = parsed.tracks.reduce((sum, track) => sum + track.notes.length, 0)
  assert(notes === 2, `both notes are in the exported file, got ${notes}`)
  near(parsed.durationSec, 2, 0.05, 'the arrangement keeps the render length')
})

await test('anyaudio_music plays a plugin part alongside SoundFont parts', async () => {
  const vst = tools.get('anyaudio_vst')
  const scanned = await vst.execute({ action: 'scan', limit: 200 }, exec)
  if (!scanned.available || scanned.count === 0) {
    console.log('     (no pedalboard, or no VST3 installed — the plugin half is skipped)')
    return
  }
  // Only a plugin that was measured to render headless: the others are a fact
  // about this machine, not a broken mix path.
  const target = scanned.plugins.find((entry) => /JUNO|JUPITER|SH-101|TB-303|SYSTEM/i.test(entry.name))
  if (!target) {
    console.log('     (no measured-working plugin installed — the plugin half is skipped)')
    return
  }
  const music = tools.get('anyaudio_music')
  const result = await music.execute({
    projectId: await freshAttach(),
    score: {
      title: 'hybrid',
      tracks: [
        { name: 'keys', source: 'generaluser', instrument: 'piano', notes: [[0, 1, 'C4', 90]] },
        { name: 'synth', vst: target.path, notes: [[0, 1, 'C3', 100]] },
      ],
    },
    durationSec: 2,
    tailSec: 0,
    peakDb: -3,
  }, exec)
  assertMatchesOutputSchema(music, result)
  assert(result.ok === true, 'the hybrid score renders')
  const synth = result.tracks.find((track) => track.name === 'synth')
  assert(synth && /^vst:/.test(synth.instrument), `the plugin part is named as a plugin, got ${synth?.instrument}`)
  // One normalisation for the whole mix: the SoundFont half and the plugin half
  // share the master gain instead of each being levelled on its own.
  assert(result.peakDb <= -2.5 && result.peakDb >= -3.5, `the master lands near -3 dBFS, got ${result.peakDb}`)
})

await test('a plugin part gets a stem of its own when the score asks for stems', async () => {
  const vst = tools.get('anyaudio_vst')
  const scanned = await vst.execute({ action: 'scan', limit: 200 }, exec)
  if (!scanned.available || scanned.count === 0) {
    console.log('     (no pedalboard, or no VST3 installed — the stem check is skipped)')
    return
  }
  const target = scanned.plugins.find((entry) => /JUNO|JUPITER|SH-101|TB-303|SYSTEM/i.test(entry.name))
  if (!target) {
    console.log('     (no measured-working plugin installed — the stem check is skipped)')
    return
  }
  const music = tools.get('anyaudio_music')
  const result = await music.execute({
    projectId: await freshAttach(),
    score: {
      title: 'stems',
      tracks: [
        { name: 'keys', source: 'generaluser', instrument: 'piano', notes: [[0, 1, 'C4', 90]] },
        { name: 'synth', vst: target.path, notes: [[0, 1, 'C3', 100]] },
      ],
    },
    stems: true,
    durationSec: 1.5,
    tailSec: 0,
  }, exec)
  assertMatchesOutputSchema(music, result)
  assert(result.stems.length === 2, `both parts got a stem file, got ${result.stems.length}`)
  const named = (result.attached ?? []).map((entry) => entry.trackName)
  assert(named.includes('synth'), `the plugin part has its own track, got ${named.join(', ')}`)
})

await test('anyaudio_style measures a score and keeps the card on the shelf', async () => {
  const styleDir = join(tmpDir, 'styles')
  const previous = process.env.ANYAUDIO_STYLE_DIR
  process.env.ANYAUDIO_STYLE_DIR = styleDir
  try {
    const learned = await tools.get('anyaudio_style').execute({
      action: 'learn',
      name: '风格测试',
      bpm: 100,
      score: {
        title: '风格测试',
        tracks: [
          { name: 'piano', instrument: 'piano', notes: [[0, 3.5, 'C3'], [0, 0.5, 'C4'], [0.5, 0.5, 'D4'], [1, 0.5, 'E4'], [1.5, 0.5, 'F4'], [2, 0.5, 'G4'], [2.5, 0.5, 'A4'], [3, 0.5, 'B4'], [3.5, 1, 'C5']] },
          { name: 'kit', drums: true, notes: [[0, 0.25, 36], [0.5, 0.25, 42]] },
        ],
      },
    }, exec)
    assert(learned.id === '风格测试', `the id comes from the name, got ${learned.id}`)
    assert(learned.card.key.label === 'C major', `C major is detected from the scale, got ${learned.card.key.label}`)
    assert(learned.card.size.parts === 2, 'both parts are measured')
    assert(learned.advice.length > 0, 'the card carries advice')
    const listed = await tools.get('anyaudio_style').execute({ action: 'list' }, exec)
    assert(listed.cards.length === 1, 'the card is on the shelf')
    const shown = await tools.get('anyaudio_style').execute({ action: 'show', id: learned.id }, exec)
    assert(shown.markdown.includes('风格卡'), 'the markdown page names the card')
    await tools.get('anyaudio_style').execute({ action: 'remove', id: learned.id }, exec)
    const after = await tools.get('anyaudio_style').execute({ action: 'list' }, exec)
    assert(after.cards.length === 0, 'removing takes it off the shelf')
  } finally {
    if (previous === undefined) delete process.env.ANYAUDIO_STYLE_DIR
    else process.env.ANYAUDIO_STYLE_DIR = previous
    await rm(styleDir, { recursive: true, force: true })
  }
})

await test('anyaudio_vst finds installed plugins and plays one when a bridge exists', async () => {
  const vst = tools.get('anyaudio_vst')
  const scanned = await vst.execute({ action: 'scan', limit: 200 }, exec)
  assertMatchesOutputSchema(vst, scanned)
  assert(Array.isArray(scanned.plugins), 'scan returns a plugin array')
  assert(typeof scanned.available === 'boolean', 'scan reports whether the python bridge is ready')
  if (!scanned.available || scanned.count === 0) {
    console.log('     (no pedalboard, or no VST3 installed — the render half is skipped)')
    return
  }
  // A plugin that waits for a licence window cannot be driven headless (measured:
  // Steinberg's Padshop hangs inside the loader). Prefer a software synth that was
  // measured to render, and treat a timeout or load failure as a fact about the
  // machine rather than a broken bridge.
  const target = scanned.plugins.find((entry) => /JUNO|JUPITER|SH-101|TB-303|SYSTEM/i.test(entry.name)) ?? scanned.plugins[0]
  let rendered
  try {
    rendered = await vst.execute({ action: 'render', plugin: target.path, notes: [[0, 1, 60, 100]], durationSec: 2 }, exec)
  } catch (error) {
    if (error.code === 'TIMEOUT' || error.code === 'LOAD_FAILED') {
      console.log(`     (${target.name} will not load headless: ${error.code} — skipped)`)
      return
    }
    throw error
  }
  assertMatchesOutputSchema(vst, rendered)
  assert(rendered.ok === true, 'render reports ok')
  assert(rendered.durationSec > 0, 'render reports a length')
  assert(typeof rendered.file === 'string' && rendered.file.length > 0, 'render names the file it wrote')
})

await test('a saved patch keeps a plugin and the knobs that made the sound', async () => {
  const vst = tools.get('anyaudio_vst')
  const shelf = join(tmpDir, 'vst-presets')
  const previous = process.env.ANYAUDIO_VST_PRESET_DIR
  process.env.ANYAUDIO_VST_PRESET_DIR = shelf
  try {
    const saved = await vst.execute({
      action: 'preset',
      presetAction: 'save',
      name: 'warm pad',
      plugin: 'C:\\Program Files\\Common Files\\VST3\\JUNO-106.vst3',
      params: { lfo_rate: 96, cutoff: 12 },
      note: '慢起音，不要混响',
    }, exec)
    assert(saved.id === 'warm-pad', `the id comes from the name, got ${saved.id}`)
    assert(saved.params === 2, `both knobs were kept, got ${saved.params}`)
    const listed = await vst.execute({ action: 'preset' }, exec)
    assert(listed.count === 1, 'the patch is on the shelf')
    assert(listed.presets[0].pluginName === 'JUNO-106.vst3', 'the plugin name is kept for reading')
    const shown = await vst.execute({ action: 'preset', presetAction: 'show', name: 'warm pad' }, exec)
    assert(shown.parameters.length === 2, 'show lists the knobs')
    const { resolveScorePresets } = await import('../src/audio/vst-preset.js')
    const resolved = await resolveScorePresets({ tracks: [{ name: 'pad', vst: { preset: 'warm pad', params: { cutoff: 99 } } }] })
    assert(String(resolved.tracks[0].vst.plugin).endsWith('JUNO-106.vst3'), 'the patch supplies the plugin path')
    assert(resolved.tracks[0].vst.params.cutoff === 99, 'a value written on the track wins over the patch')
    assert(resolved.tracks[0].vst.params.lfo_rate === 96, 'the other knobs still come from the patch')
    let missing = null
    try {
      await vst.execute({ action: 'preset', presetAction: 'show', name: 'nope' }, exec)
    } catch (error) {
      missing = error
    }
    assert(missing && /no saved patch/.test(missing.message), 'a patch that does not exist says so')
    await vst.execute({ action: 'preset', presetAction: 'remove', name: 'warm-pad' }, exec)
    const after = await vst.execute({ action: 'preset' }, exec)
    assert(after.count === 0, 'removing takes it off the shelf')
  } finally {
    if (previous === undefined) delete process.env.ANYAUDIO_VST_PRESET_DIR
    else process.env.ANYAUDIO_VST_PRESET_DIR = previous
    await rm(shelf, { recursive: true, force: true })
  }
})

await test('a patch the plugin saved itself can be registered and reaches the score', async () => {
  const vst = tools.get('anyaudio_vst')
  const shelf = join(tmpDir, 'vst-presets-state')
  const source = join(tmpDir, 'juno-warm.vstpreset')
  const previous = process.env.ANYAUDIO_VST_PRESET_DIR
  process.env.ANYAUDIO_VST_PRESET_DIR = shelf
  try {
    // The import path never parses the file: it belongs to the plugin, and the
    // point is to hand it back unchanged. So a header plus filler is enough to
    // prove the plumbing without needing a licensed plugin in the test suite.
    await writeFile(source, Buffer.concat([Buffer.from('VST3'), Buffer.alloc(64, 7)]))
    const imported = await vst.execute({
      action: 'preset',
      presetAction: 'import',
      name: 'juno warm',
      plugin: 'C:\\Program Files\\Common Files\\VST3\\JUNO-106.vst3',
      presetFile: source,
      note: 'made in the plugin window',
    }, exec)
    assert(imported.state === source, `the state file is remembered, got ${imported.state}`)
    assert(imported.format === 'vstpreset', `the format comes from the extension, got ${imported.format}`)
    const listed = await vst.execute({ action: 'preset' }, exec)
    assert(listed.presets[0].state === source, 'the list shows which file backs the patch')
    const { resolveScorePresets } = await import('../src/audio/vst-preset.js')
    const resolved = await resolveScorePresets({ tracks: [{ name: 'lead', vst: { preset: 'juno warm' } }] })
    assert(resolved.tracks[0].vst.state.path === source, 'a score track carries the state file')
    assert(resolved.tracks[0].vst.state.format === 'vstpreset', 'and its format, so the right loader is used')
    // An explicit state on the track replaces the one from the patch.
    const overridden = await resolveScorePresets({
      tracks: [{ name: 'lead', vst: { preset: 'juno warm', state: join(tmpDir, 'other.fxp') } }],
    })
    assert(overridden.tracks[0].vst.state.format === 'fxp', 'a track can name its own state file')
    let empty = null
    try {
      await writeFile(join(tmpDir, 'empty.fxp'), '')
      await vst.execute({ action: 'preset', presetAction: 'import', name: 'gone', presetFile: join(tmpDir, 'empty.fxp') }, exec)
    } catch (error) {
      empty = error
    }
    assert(empty && /empty/.test(empty.message), 'an empty preset file is refused rather than registered')
  } finally {
    if (previous === undefined) delete process.env.ANYAUDIO_VST_PRESET_DIR
    else process.env.ANYAUDIO_VST_PRESET_DIR = previous
    await rm(shelf, { recursive: true, force: true })
    await rm(source, { force: true })
    await rm(join(tmpDir, 'empty.fxp'), { force: true })
  }
})

await test('a score can hand one part to a plugin without stealing a SoundFont channel', async () => {
  const compiled = compileScore({
    title: 'hybrid',
    tracks: [
      { name: 'keys', source: 'generaluser', instrument: 'piano', notes: [[0, 1, 'C4', 90]] },
      { name: 'synth', vst: 'C:/plugins/Juno.vst3', notes: [[0, 1, 'C3', 100]] },
      { name: 'lead', instrument: 'flute', notes: [[0, 1, 'A4', 80]] },
    ],
  }, { sampleRate: 48000 })
  const synth = compiled.tracks.find((track) => track.name === 'synth')
  assert(synth.vst?.plugin === 'C:/plugins/Juno.vst3', 'the short form "vst": "path" is kept')
  assert(synth.channel === 0, 'a plugin part sits on channel 0 unless it asks for another')
  const fontChannels = compiled.tracks.filter((track) => !track.vst).map((track) => track.channel)
  assert(fontChannels.length === 2 && new Set(fontChannels).size === 2, 'the SoundFont parts still get distinct channels')
  const synthPatch = synth.events.filter((event) => event.type === 'bank' || event.type === 'program')
  assert(synthPatch.length === 1 && synthPatch[0].type === 'program' && synthPatch[0].channel === 0,
    'a plugin part is told its patch on its own channel, and no bank unless it asked')
  // A multi-timbral instrument (one plugin instance, one channel per module)
  // needs both the channel and the bank: Super Quartet picks piano/guitar/bass/
  // drums with CC0 0/1/2/3 and answers each module on its own MIDI channel.
  const multi = compileScore({
    tracks: [
      { name: 'piano', vst: { plugin: 'C:/sq.dll', channel: 0, bank: 0 }, instrument: 0, notes: [[0, 1, 60, 90]] },
      { name: 'bass', vst: { plugin: 'C:/sq.dll', channel: 2, bank: 0, bankLsb: 2 }, instrument: 33, notes: [[0, 1, 36, 90]] },
    ],
  })
  const bass = multi.tracks.find((track) => track.name === 'bass')
  assert(bass.channel === 2 && bass.vst.channel === 2, 'a plugin part keeps the channel it asked for')
  assert(bass.vst.bank === 0 && bass.vst.bankLsb === 2, 'both bank bytes survive normalization')
  const bankEvent = bass.events.find((event) => event.type === 'bank')
  const bankLsbEvent = bass.events.find((event) => event.type === 'banklsb')
  const programEvent = bass.events.find((event) => event.type === 'program')
  assert(bankEvent && bankEvent.bank === 0 && bankEvent.channel === 2, 'the bank MSB goes out as a bank event on that channel')
  assert(bankLsbEvent && bankLsbEvent.bank === 2 && bankLsbEvent.channel === 2,
    'the bank LSB goes out as its own event — the EDIROL modules put the family there')
  assert(programEvent && programEvent.program === 33 && programEvent.channel === 2, 'the program goes out on the same channel')
  assert(bankEvent.t === 0 && programEvent.t === 0, 'bank and program sit at the start')
  const cc0 = bass.events.filter((event) => event.type === 'cc' && event.controller === 0)
  assert(cc0.length === 0, 'a vst part does not emit a raw CC0 — the bank event carries it')

  // The SoundFont engine must name the reason instead of playing the default
  // piano for a part it cannot render.
  const { renderCompiled } = await import('../src/audio/synth.js')
  let message = ''
  try {
    await renderCompiled(compiled, { soundBank: {}, onlyTrack: 'synth' })
  } catch (error) {
    message = error.message
  }
  assert(/VST part/.test(message), `the SoundFont engine explains a plugin part belongs to the bridge, got: ${message}`)

  let refused = ''
  try {
    compileScore({ tracks: [{ name: 'x', vst: {}, notes: [[0, 1, 60, 90]] }] })
  } catch (error) {
    refused = error.message
  }
  assert(/needs a "plugin" path/.test(refused), `a vst object without a plugin path is refused, got: ${refused}`)

  const long = compileScore({
    tracks: [{ name: 'y', vst: { plugin: 'C:/a.vst3', params: { cutoff: 40 } }, notes: [[0, 1, 60, 90]] }],
  })
  assert(long.tracks[0].vst.params.cutoff === 40, 'the long form keeps its parameters')

  // A score made only of plugin parts must not demand a SoundFont: the point of
  // the plugin path is that it works on a machine with no font installed.
  const { planFonts } = await import('../src/audio/banks.js')
  const onlyPlugins = compileScore({
    tracks: [{ name: 'x', vst: 'C:/a.vst3', notes: [[0, 1, 60, 90]] }],
  }, { sampleRate: 48000 })
  const planned = await planFonts(onlyPlugins, {})
  assert(planned.banks.length === 0, 'a pure-plugin score loads no SoundFont bank')
  assert(planned.fonts.length === 0, 'a pure-plugin score reports no fonts')
})

await test('anyaudio_record lists inputs and captures whatever the cable carries', async () => {
  const record = tools.get('anyaudio_record')
  const offered = await record.execute({ action: 'devices' }, exec)
  assertMatchesOutputSchema(record, offered)
  assert(Array.isArray(offered.inputs), 'devices returns an input array')
  assert(typeof offered.count === 'number', 'devices counts the inputs')
  if (offered.count === 0) {
    console.log('     (this machine exposes no audio input — the capture half is skipped)')
    return
  }
  // A capture must be honest about silence, not fail: this machine's inputs may
  // be held by an ASIO driver or carry nothing at all. The contract under test
  // is "the WAV exists and its level is measured", plus the silence warning.
  const chosen = offered.inputs.find((entry) => entry.hostApi?.toUpperCase().includes('WASAPI')) ?? offered.inputs[0]
  let captured
  try {
    captured = await record.execute({ action: 'record', device: String(chosen.index), durationSec: 0.4, warmupSec: 0 }, exec)
  } catch (error) {
    if (error.code === 'TIMEOUT' || /not importable/.test(error.message)) {
      console.log(`     (capture bridge unavailable: ${error.code ?? error.message} — skipped)`)
      return
    }
    throw error
  }
  assertMatchesOutputSchema(record, captured)
  assert(captured.ok === true, 'record reports ok')
  assert(captured.durationSec > 0, 'record reports a length')
  assert(typeof captured.file === 'string' && captured.file.length > 0, 'record names the file it wrote')
  if (captured.peakDb <= -120) {
    assert(Array.isArray(captured.warnings) && captured.warnings.some((line) => /silence/.test(line)),
      'a silent capture says so instead of failing')
  }
})

await test('a hardware part claims no SoundFont channel and still compiles', async () => {
  const compiled = compileScore({
    title: 'hw',
    tracks: [
      { name: 'piano', instrument: 'piano', notes: [[0, 1, 'C4']] },
      { name: 'strings', hw: { port: 'SD-20 PART A', channel: 1, program: 48, latencyMs: 66 }, notes: [[0, 1, 'C4']] },
    ],
  })
  const part = compiled.tracks.find((track) => track.name === 'strings')
  assert(part.hw.port === 'SD-20 PART A', 'the port is kept')
  assert(part.hw.channel === 1, 'the channel is kept')
  assert(part.hw.program === 48, 'the program is kept')
  assert(part.hw.latencyMs === 66, 'the latency is kept')
  // A module is not a SoundFont voice: sending it bank/program/CC7 events would
  // make the SoundFont engine try to play the part it cannot hear.
  assert(part.events.every((event) => event.type !== 'program' && event.type !== 'bank'), 'no SoundFont program events are generated')
  assert(Number.isInteger(compiled.tracks.find((track) => track.name === 'piano').channel), 'the SoundFont part still got a real channel')
  // The hardware part does not reserve channel 0, so a SoundFont part may still
  // take it: the two live in different machines.
  const shared = compileScore({
    tracks: [
      { name: 'h', hw: 'SD-20 PART A', notes: [[0, 1, 'C4']] },
      { name: 'p', channel: 0, instrument: 'piano', notes: [[0, 1, 'C4']] },
    ],
  })
  assert(shared.tracks.find((track) => track.name === 'p').channel === 0, 'channel 0 is free for a SoundFont part')

  const pure = compileScore({ tracks: [{ name: 'only', hw: 'SD-20 PART A', notes: [[0, 1, 'C4']] }] })
  const planned = await planFonts(pure, {})
  assert(planned.banks.length === 0, 'a pure-hardware score loads no SoundFont bank')

  let both = null
  try {
    compileScore({ tracks: [{ name: 'x', vst: 'a.vst3', hw: 'SD-20 PART A', notes: [[0, 1, 'C4']] }] })
  } catch (error) {
    both = error
  }
  assert(both && /both vst and hw/.test(both.message), 'a part with two sound sources is refused')

  let noPort = null
  try {
    compileScore({ tracks: [{ name: 'x', hw: { channel: 1 }, notes: [[0, 1, 'C4']] }] })
  } catch (error) {
    noPort = error
  }
  assert(noPort && /hw needs a "port"/.test(noPort.message), 'a hardware part without a port says what it needs')

  // A module answers a fixed number of voices, so the score has to know how many
  // notes sound at once: past that count the extra notes are silent, not broken.
  const voiced = compileScore({
    tracks: [{ name: 'v', hw: { port: 'SD-20 PART A', voices: 32 }, notes: [[0, 1, 'C4']] }],
  })
  assert(voiced.tracks[0].hw.voices === 32, 'a voice count on the module is kept')
  assert(peakPolyphony([[0, 1, 60, 100], [0, 1, 64, 100], [0.5, 1, 67, 100]]) === 3, 'simultaneous notes count together')
  assert(peakPolyphony([[0, 1, 60, 100], [1, 1, 64, 100], [2, 1, 67, 100]]) === 1, 'separate notes count one at a time')
  assert(peakPolyphony([[0, 2, 60, 100], [0.5, 0.5, 64, 100], [1, 0.5, 67, 100]]) === 2, 'a note that ends as another starts is counted once')
})

await test('a named rig fills in the port, the input and the latency at once', async () => {
  const rigs = [{ name: 'SD-20', port: 'SD-20 PART A', device: '麦克风 (3- USB Audio Device)', latencyMs: 65.92, voices: 64 }]
  const named = compileScore({ tracks: [{ name: 'p', hw: 'SD-20', notes: [[0, 1, 'C4']] }] }, { externals: rigs })
  const part = named.tracks[0]
  assert(part.hw.port === 'SD-20 PART A', 'the stored port is used')
  assert(part.hw.captureDevice === '麦克风 (3- USB Audio Device)', 'the stored input is used')
  assert(part.hw.latencyMs === 65.92, 'the measured latency is used')
  assert(part.hw.voices === 64, 'the voice count on the module is used')
  // The track still wins: a rig is a default, not a lock.
  const overridden = compileScore(
    { tracks: [{ name: 'p', hw: { name: 'SD-20', channel: 3 }, notes: [[0, 1, 'C4']] }] },
    { externals: rigs },
  )
  assert(overridden.tracks[0].hw.channel === 3, 'the track value wins over the rig')
  assert(overridden.tracks[0].hw.port === 'SD-20 PART A', 'the rest still comes from the rig')
  // A name that matches no rig is still a port name; that path must not break.
  const plain = compileScore({ tracks: [{ name: 'p', hw: 'SD-20 PART B', notes: [[0, 1, 'C4']] }] }, { externals: rigs })
  assert(plain.tracks[0].hw.port === 'SD-20 PART B', 'an unknown name is treated as a port')
})

await test('the settings keep VST folders and named hardware rigs', async () => {
  const { normalizeConfig } = await import('../src/config.js')
  const { config } = normalizeConfig({
    sources: {
      vstDirs: ['D:\\VST3', 'd:\\VST3', '   ', 'E:\\Plugins'],
      external: [
        { name: 'SD-20', port: 'SD-20 PART A', device: '29', latencyMs: 65.92, voices: 64 },
        { name: 'SD-20', port: 'duplicate name' },
        { name: 'no-port' },
      ],
    },
  })
  assert(config.sources.vstDirs.length === 2, 'duplicate folders collapse and blanks are dropped')
  assert(config.sources.vstDirs[0] === 'D:\\VST3', 'the first spelling of a folder is kept')
  assert(config.sources.external.length === 1, 'a rig without a port, or with a name already used, is dropped')
  const rig = config.sources.external[0]
  assert(rig.device === '29' && rig.latencyMs === 65.92 && rig.voices === 64, 'the measured numbers survive a save')
  // Old configs have no such keys at all; they must read as empty, not undefined.
  const { config: plain } = normalizeConfig({})
  assert(Array.isArray(plain.sources.vstDirs) && plain.sources.vstDirs.length === 0, 'a config without VST folders reads as empty')
  assert(Array.isArray(plain.sources.external) && plain.sources.external.length === 0, 'a config without rigs reads as empty')
})

await test('anyaudio_midiout lists ports and refuses a performance with nothing to play', async () => {
  const midiout = tools.get('anyaudio_midiout')
  const status = await midiout.execute({ action: 'status' }, exec)
  assertMatchesOutputSchema(midiout, status)
  if (!status.available) {
    console.log(`     (MIDI bridge unavailable: ${status.error ?? 'unknown'} — skipped)`)
    return
  }
  const ports = await midiout.execute({ action: 'ports' }, exec)
  assertMatchesOutputSchema(midiout, ports)
  assert(Array.isArray(ports.outputs) && Array.isArray(ports.inputs), 'ports returns both directions')
  // No notes are sent here on purpose: a test that plays the user's rack module
  // is a sound, not a check. What a regression breaks is the refusal paths.
  let refused = false
  try {
    await midiout.execute({ action: 'play' }, exec)
  } catch (error) {
    refused = /needs notes/.test(error.message)
  }
  assert(refused, 'play without notes is refused')
  let needsDevice = false
  try {
    await midiout.execute({ action: 'calibrate', port: '0' }, exec)
  } catch (error) {
    needsDevice = /needs device/.test(error.message)
  }
  assert(needsDevice, 'calibrate without an input is refused')
})

await test('a manual about a source lives under one slug no matter how it is spelled', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'anyaudio-manual-'))
  const previous = process.env.ANYAUDIO_MANUALS
  process.env.ANYAUDIO_MANUALS = dir
  try {
    assert(manualSlug('SD-20 / PART A') === 'sd-20-part-a', 'the slug folds case and separators')
    const saved = saveManual('SD-20 PART A', '# SD-20\nprogram 0 is the piano')
    assert(existsSync(saved.path), 'the note is written to disk')
    assert(listManuals().length === 1, 'one manual is listed')
    assert(readManual('sd-20 part a').text.includes('program 0 is the piano'), 'another spelling finds the same file')
    assert(readManual('no-such-source') === null, 'a source without notes reads as null')
    assert(removeManual('SD-20 PART A').removed === true, 'remove reports that it removed the file')
    assert(listManuals().length === 0, 'nothing is left behind')
  } finally {
    if (previous === undefined) delete process.env.ANYAUDIO_MANUALS
    else process.env.ANYAUDIO_MANUALS = previous
    await rm(dir, { recursive: true, force: true })
  }
})

await test('a manual can be registered now and read only when it is needed', async () => {
  // A vendor PDF is often hundreds of pages. Naming it must not cost a parse;
  // the path waits in a list until an agent is about to compose for that source.
  const dir = await mkdtemp(join(tmpdir(), 'anyaudio-pending-'))
  const previous = process.env.ANYAUDIO_MANUALS
  process.env.ANYAUDIO_MANUALS = dir
  const sourceDir = await mkdtemp(join(tmpdir(), 'anyaudio-source-'))
  try {
    const file = join(sourceDir, 'module.pdf')
    await writeFile(file, 'not a real pdf', 'utf8')
    const queued = addPending({ name: 'XV-5080', path: file })
    assert(queued.pending === true, 'registering returns a pending row')
    assert(listPending().length === 1, 'one source waits to be read')
    assert(pendingFor('xv 5080').path === file, 'another spelling finds the same row')
    assert(listManuals().length === 0, 'registering writes no manual yet')
    assert(removePending('XV-5080').removed === true, 'the row can be dropped')
    assert(listPending().length === 0, 'nothing is left behind')
    let refused = false
    try {
      addPending({ name: 'gone', path: join(sourceDir, 'missing.pdf') })
    } catch (error) {
      refused = /nothing at/.test(error.message)
    }
    assert(refused, 'a path that does not exist is refused')
  } finally {
    if (previous === undefined) delete process.env.ANYAUDIO_MANUALS
    else process.env.ANYAUDIO_MANUALS = previous
    await rm(dir, { recursive: true, force: true })
    await rm(sourceDir, { recursive: true, force: true })
  }
})

await test('a drum kit only answers the keys its own instruments map', () => {
  // A GM drum preset wraps every key, but the audible keys are the instruments'
  // ranges underneath. A bank that answers a handful of keys renders the rest
  // as silence, so the list has to be exact.
  const bank = {
    presets: [
      {
        isGMGSDrum: true,
        bankMSB: 128,
        zones: [
          { keyRange: { min: 0, max: 127 }, _instrument: { zones: [{ keyRange: { min: 36, max: 36 } }, { keyRange: { min: 38, max: 38 } }] } },
          { keyRange: { min: 49, max: 49 }, _instrument: { zones: [] } },
        ],
      },
      { isGMGSDrum: false, bankMSB: 0, zones: [{ keyRange: { min: 0, max: 127 } }] },
    ],
  }
  const keys = drumKeys(bank)
  assert([...keys].sort((a, b) => a - b).join(',') === '36,38,49', `expected 36,38,49 — got ${[...keys].sort((a, b) => a - b).join(',')}`)
  assert(drumKeys({ presets: [] }).size === 0, 'a bank without drums answers no keys')
})

await test('a written .fxp is the bytes a VST2 plugin reads back', () => {
  const bytes = encodeFxp({ name: 'night', values: [0.25, 0.5, 1] })
  assert(bytes.subarray(0, 4).toString('latin1') === 'CcnK', 'the outer chunk is CcnK')
  assert(bytes.readInt32BE(4) === bytes.length - 8, 'the outer length covers everything after it')
  assert(bytes.subarray(8, 12).toString('latin1') === 'FxCk', 'the payload is a FxCk program chunk')
  assert(bytes.readInt32BE(24) === 3, 'the program says how many values follow')
  assert(bytes.subarray(28, 33).toString('latin1') === 'night', 'the program carries a name')
  assert(Math.abs(bytes.readFloatBE(56) - 0.25) < 1e-6, 'the first value is where the float table starts')
  assert(bytes.length === 8 + 48 + 12, 'eight bytes of wrapper, forty-eight of header, four per value')
})

await test('the plugin scan reads the PE header instead of guessing the bitness', () => {
  const info = peInfo(process.execPath)
  assert(info && info.machine === 0x8664, 'this node binary is a 64-bit PE image')
  assert(info.isDll === false, 'an executable is reported as not a DLL')
  assert(vst2Kind(process.execPath) === null, 'an executable without a VSTPluginMain export is not a VST2 plugin')
  const library = scanVstLibrary([])
  assert(Array.isArray(library.plugins) && Array.isArray(library.legacy32) && Array.isArray(library.dirs), 'the library result carries plugins, legacy32 and dirs')
  assert(library.plugins.every((entry) => entry.format === 'vst3' || entry.format === 'vst2'), 'every plugin is labelled VST3 or VST2')
})

await test('preset files the hosts left behind can be listed without opening the plugins', async () => {
  const root = join(tmpDir, 'preset-shelf')
  const vendor = join(root, 'Wizoo _ Steinberg')
  const plugin = join(vendor, 'Virtual Electric Guitar_64')
  await mkdir(plugin, { recursive: true })
  await writeFile(join(plugin, 'Clean SM57.vstpreset'), 'VST3' + '0'.repeat(60))
  await writeFile(join(plugin, 'Dirty Overdrive.fxp'), 'CcnK' + '0'.repeat(20))
  await writeFile(join(plugin, 'readme.txt'), 'not a preset')

  const { scanPresetFiles } = await import('../src/audio/vst-preset.js')
  const all = await scanPresetFiles({ dirs: [root] })
  assert(all.found === 2, `two preset files are found, not ${all.found}`)
  const clean = all.files.find((row) => row.name === 'Clean SM57')
  assert(clean, 'a .vstpreset is listed')
  assert(clean.format === 'vstpreset', `the format is named, not "${clean.format}"`)
  assert(clean.plugin === 'Virtual Electric Guitar_64', `the plugin is read from the folder, not "${clean.plugin}"`)
  assert(clean.vendor === 'Wizoo _ Steinberg', `the vendor is read from the folder, not "${clean.vendor}"`)
  assert(all.files.every((row) => row.format === 'vstpreset' || row.format === 'fxp' || row.format === 'fxb'),
    'a text file in the same folder is not a preset')

  const filtered = await scanPresetFiles({ dirs: [root], query: 'sm57' })
  assert(filtered.found === 1 && filtered.files[0].name === 'Clean SM57', 'the query narrows the list by name')

  const missing = await scanPresetFiles({ dirs: [join(root, 'nowhere')] })
  assert(missing.found === 0 && missing.scanned === 0, 'a folder that does not exist is not an error')

  await rm(root, { recursive: true, force: true })
})

await test('expression writes the bend and the swell as events a plugin plays', async () => {
  const compiled = compileScore({
    title: 'expression',
    tracks: [{ name: 'lead', instrument: 'flute', notes: [[0, 2, 'A4', 90], [2, 2, 'C5', 90]] }],
    expression: [
      { type: 'pitchbend_line', track: 'lead', start: 0, end: 2, from: 0, to: 2047 },
      { type: 'cc_line', track: 'lead', control: 11, start: 2, end: 4, from: 20, to: 120 },
    ],
  }, { sampleRate: 48000 })
  const lead = compiled.tracks.find((track) => track.name === 'lead')
  const bends = lead.events.filter((event) => event.type === 'pitch')
  assert(bends.length > 8, `a bend is written as many small steps, not one (${bends.length})`)
  assert(bends[0].value === 8192, `the bend starts at centre 8192, not ${bends[0]?.value}`)
  assert(bends.at(-1).value > 10000, `the bend ends high, not ${bends.at(-1)?.value}`)
  assert(bends.every((event) => event.value >= 0 && event.value <= 16383), 'every bend stays inside the 14-bit range')
  const swell = lead.events.filter((event) => event.type === 'cc' && event.controller === 11)
  assert(swell.length > 8, 'a controller line is written as steps')
  assert(swell.every((event) => event.t >= 2 && event.t <= 4), 'the swell stays inside its window')
  assert(compiled.expression?.[0]?.type === 'pitchbend_line', 'the compiled score reports what it applied')

  // A name that is not in the score is a mistake to name, not to swallow.
  let message = ''
  try {
    compileScore({ title: 'x', tracks: [{ name: 'lead', notes: [[0, 1, 'C4', 90]] }], expression: [{ type: 'sustain', track: 'bass', start: 0, end: 2 }] }, {})
  } catch (error) {
    message = error.message
  }
  assert(/names track "bass"/.test(message), `the unknown track is named, got "${message}"`)
})

await test('the pedal is a switch, and the velocity line moves the notes themselves', async () => {
  const compiled = compileScore({
    title: 'pedal',
    tracks: [{ name: 'piano', instrument: 'grand-piano', notes: [[0, 1, 'C4', 40], [2, 1, 'E4', 40], [4, 1, 'G4', 40]] }],
    expression: [
      { type: 'sustain', start: 0, end: 4 },
      { type: 'velocity_line', start: 0, end: 4, from: 30, to: 120 },
    ],
  }, { sampleRate: 48000 })
  const piano = compiled.tracks.find((track) => track.name === 'piano')
  const pedal = piano.events.filter((event) => event.type === 'cc' && event.controller === 64)
  assert(pedal.length === 2 && pedal[0].value === 127 && pedal[1].value === 0,
    `the pedal goes down once and up once, got ${JSON.stringify(pedal.map((event) => event.value))}`)
  const velocities = piano.notes.map((note) => note.velocity)
  assert(velocities[0] < velocities[1] && velocities[1] < velocities[2],
    `the line rises across the phrase, got ${velocities.join(',')}`)
  const onEvents = piano.events.filter((event) => event.type === 'on').map((event) => event.velocity)
  assert(JSON.stringify(onEvents) === JSON.stringify(velocities),
    'the note-on events carry the same velocities as the notes themselves')
})

await test('humanize is a repeatable shuffle, not a different take every run', async () => {
  const score = {
    title: 'shuffle',
    tracks: [{ name: 'gtr', instrument: 'steel-guitar', notes: [[0, 1, 'E3', 70], [1, 1, 'G3', 70], [2, 1, 'B3', 70]] }],
    expression: [{ type: 'humanize', amount: 12, timing: 0.01, seed: 42 }],
  }
  const first = compileScore(score, {}).tracks[0].notes.map((note) => [note.velocity, Number(note.start.toFixed(4))])
  const second = compileScore(score, {}).tracks[0].notes.map((note) => [note.velocity, Number(note.start.toFixed(4))])
  assert(JSON.stringify(first) === JSON.stringify(second), 'the same seed gives the same shuffle')
  const other = compileScore({ ...score, expression: [{ type: 'humanize', amount: 12, timing: 0.01, seed: 7 }] }, {})
    .tracks[0].notes.map((note) => [note.velocity, Number(note.start.toFixed(4))])
  assert(JSON.stringify(first) !== JSON.stringify(other), 'a different seed is a different shuffle')

  const empty = compileScore({
    title: 'nothing-here',
    tracks: [{ name: 'gtr', instrument: 'steel-guitar', notes: [[5, 1, 'E3', 70]] }],
    expression: [{ type: 'velocity_line', start: 0, end: 1, from: 20, to: 100 }],
  }, {})
  assert(empty.warnings.some((line) => /found no note/.test(line)), 'a gesture over no notes is reported, not silently dropped')
})

await test('the measuring note tells the recorder how late it started', async () => {
  const rate = 48000
  const frames = rate
  const channels = [new Float32Array(frames), new Float32Array(frames)]
  const at = Math.round(0.42 * rate)
  channels[0][at] = 0.9
  channels[1][at] = 0.9
  const offset = firstPeakOffset(channels, rate, { searchSec: 1, floorDb: -50 })
  assert(Math.abs(offset - 0.42) < 0.001, `first sound at ${offset.toFixed(3)}s, expected 0.42s`)

  const silent = [new Float32Array(frames)]
  assert(firstPeakOffset(silent, rate) === null, 'silence has no first sound to report')

  const moved = [Float32Array.from({ length: 8 }, (_, i) => i + 1)]
  shiftChannels(moved, 3 / rate, rate)
  assert(moved[0][0] === 4, `a late take moves one way: ${moved[0][0]}`)
  shiftChannels(moved, -2 / rate, rate)
  assert(moved[0][0] === 0 && moved[0][1] === 0 && moved[0][2] === 4, 'and the other way')
})

await test('a drum kit answers the nearest key it actually has', async () => {
  const available = new Set([36, 38, 42])
  const match = nearestDrumKey(48, available)
  assert(match && available.has(match.key), 'the answer is a key the kit has')
  assert(match.key === 38 || match.key === 42 || match.key === 36, `got ${match.key}`)
  assert(nearestDrumKey(38, available) === null, 'a key the kit already has needs no move')

  const track = {
    name: 'kit',
    channel: 9,
    notes: [
      { start: 0, duration: 0.2, midi: 48, velocity: 100 },
      { start: 0.5, duration: 0.2, midi: 38, velocity: 100 },
    ],
    events: [
      { t: 0, type: 'on', note: 48, velocity: 100, channel: 9 },
      { t: 0.2, type: 'off', note: 48, channel: 9 },
      { t: 0.5, type: 'on', note: 38, velocity: 100, channel: 9 },
      { t: 0.7, type: 'off', note: 38, channel: 9 },
    ],
  }
  const moves = remapDrumTrack(track, new Set([36, 38, 42]))
  assert(moves.length === 1, `expected one move, got ${moves.length}`)
  assert(track.notes[0].midi !== 48, 'the note was moved to a key the kit has')
  assert(track.events.some((event) => event.type === 'on' && event.note === track.notes[0].midi), 'the events moved with the notes')
})

if (!hadAnyAudioDir) {
  const leftover = await readdir(anyaudioDir).catch(() => [])
  if (leftover.length === 0) await rm(anyaudioDir, { recursive: true, force: true })
}
await test('an orchestration table says which source each instrument came from', async () => {
  const csv = [
    'Instrument,Source,Path/Bank,Preset,Notes,Demo',
    '1. Test Song --- A Test',
    'Acoustic Piano,EDIROL - Super Quartet,Preset Piano,001 St.Concert,layered,',
    'Acoustic Piano,Steinberg - The Grand 3,02 Model D -> Close,,,',
    'Drum Kit,Steinberg - LM-4 MarkII,Processed Studio Kits,01 Gator Kit,,',
    'BPM: 120 -> 128, Time: 3/4,',
  ].join('\n')
  const table = parseOrchestrationCsv(csv, { name: 'test', sheet: 'era' })
  assert(table.sections.length === 1, 'one section')
  assert(table.sections[0].title.startsWith('1. Test Song'), 'the title line is kept')
  assert(table.sections[0].rows.length === 3, 'three instrument rows')
  assert(table.sections[0].sheet === 'era', 'the sheet name travels with the section')
  assert(table.sections[0].rows[0].program === 1, 'a two-number cell keeps its program')
  assert(table.sections[0].rows[0].preset === 'St.Concert', 'and its name')
  assert(table.sections[0].rows[2].program === 1 && table.sections[0].rows[2].bank === null, 'bank may be absent')
  const merged = mergeOrchestrationSheets({ one: csv, two: csv }, { name: 'both' })
  assert(merged.sections.length === 2 && merged.sheets.length === 2, 'two sheets merge into two sections')
  const summary = summarizeOrchestration(table, { instrument: 'piano' })
  assert(summary.instruments.length === 1, 'the filter keeps only piano')
  assert(summary.instruments[0].choices.length === 2, 'both piano sources are listed')
  assert(summary.sources.some(row => row.name.includes('Super Quartet')), 'sources are counted')
})

await test('many clips land in one call, and a clip with no start follows the one before it', async () => {
  const projectId = await freshAttach()
  const a = await writeWav(join(tmpDir, 'place-a.wav'), tone(1.0, 48000))
  const b = await writeWav(join(tmpDir, 'place-b.wav'), tone(0.8, 48000))
  const placed = await tools.get('anyaudio_project').execute({
    mode: 'place',
    projectId,
    items: [
      { path: a, trackName: 'lead', label: 'A' },
      { path: b, trackName: 'lead', label: 'B' },
      { path: b, trackName: 'bass', startSec: 2.5, label: 'C' },
    ],
  }, exec)
  assert(placed.placed.length === 3, 'all three clips are placed')
  assert(placed.placed[1].startSec === 1, 'the second clip starts where the first ended')
  assert(placed.placed[2].startSec === 2.5, 'an explicit start is kept')
  assert(placed.tracks.length === 2, 'two tracks were created')

  let message = ''
  try {
    await tools.get('anyaudio_project').execute({ mode: 'place', projectId, items: [] }, exec)
  } catch (error) {
    message = error.message
  }
  assert(/at least one clip/.test(message), 'an empty items list is refused')
})
await test('a .mid can be sliced to a bar range a person counts out loud', async () => {
  const { encodeMidiFile } = await import('../src/audio/midi-file.js')
  const { scoreFromMidiPath } = await import('../src/tools/music.js')
  const dir = await mkdtemp(join(tmpdir(), 'anyaudio-bars-'))
  try {
    const path = join(dir, 'eight-bars.mid')
    // Eight bars of 4/4 at 120 BPM: a note on the first beat of every bar.
    const notes = []
    for (let bar = 0; bar < 8; bar += 1) notes.push({ start: bar * 2, duration: 1, midi: 60 + bar, velocity: 100 })
    await writeFile(path, encodeMidiFile({ title: 'bars', tracks: [{ name: 'piano', channel: 0, program: 0, notes }] }))
    const whole = await scoreFromMidiPath(path, dir)
    assert(whole.durationSec >= 15, 'the whole file should be about 16 s', String(whole.durationSec))
    const sliced = await scoreFromMidiPath(path, dir, { bars: '3-5' })
    assert(Math.abs(sliced.durationSec - 6) < 0.01, 'bars 3-5 of 4/4 at 120 BPM are 6 s', String(sliced.durationSec))
    assert(sliced.bars.from === 3 && sliced.bars.to === 5, 'the reply repeats the range')
    const starts = sliced.tracks[0].notes.map((note) => note[0]).sort((a, b) => a - b)
    assert(Math.abs(starts[0]) < 0.01, 'the first kept note lands on zero', String(starts[0]))
    assert(sliced.tracks[0].notes.length === 3, 'three bars keep three notes', String(sliced.tracks[0].notes.length))
    const padded = await scoreFromMidiPath(path, dir, { bars: '3-5', pad: 1 })
    assert(Math.abs(padded.durationSec - 10) < 0.01, 'pad 1 makes it five bars', String(padded.durationSec))
    let threw = null
    try { await scoreFromMidiPath(path, dir, { bars: '99-100' }) } catch (error) { threw = error.message }
    assert(threw && /has \d+ bar\(s\)/.test(threw), 'a range past the end says how many bars there are', String(threw))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

await test('a tempo map decides where the bar lines fall, not where the notes sound', async () => {
  const { buildTempoMap, barSeconds, secondsToTicks, ticksToSeconds } = await import('../src/audio/tempo.js')
  const { compileScore } = await import('../src/audio/score.js')
  const { encodeMidiFile, parseMidiFile } = await import('../src/audio/midi-file.js')
  // r is the number of whole notes in a bar, not the numerator: 3/4 is 0.75.
  const waltz = buildTempoMap([{ bar: 1, bpm: 90, meter: [3, 4] }])
  assert(Math.abs(barSeconds(waltz[0].bpm, waltz[0].meter) - 2) < 1e-9, '3/4 at 90 bpm is one bar every 2s')
  const odd = buildTempoMap([{ bar: 1, bpm: 120, meter: '5/4' }])
  assert(Math.abs(barSeconds(odd[0].bpm, odd[0].meter) - 2.5) < 1e-9, '5/4 at 120 bpm is 2.5s a bar')
  const eight = buildTempoMap([{ bar: 1, bpm: 120, meter: [7, 8] }])
  assert(Math.abs(barSeconds(eight[0].bpm, eight[0].meter) - 1.75) < 1e-9, '7/8 at 120 bpm is 1.75s a bar')
  const map = buildTempoMap([{ bar: 1, bpm: 120, meter: [4, 4] }, { bar: 3, bpm: 90 }])
  assert(map[1].startSec === 4, 'two 2s bars put bar 3 at 4s')
  assert(secondsToTicks(map, 4, 480) === 3840, '4s is 8 quarter notes at 120 bpm')
  assert(secondsToTicks(map, 6, 480) === 5280, 'after 4s the tempo is 90, so 2s is 3 more quarters')
  assert(Math.abs(ticksToSeconds(map, 3840, 480) - 4) < 1e-9, 'ticks round-trip back to seconds')
  const compiled = compileScore({ title: 'tempo', tempo: [{ bar: 1, bpm: 120, meter: [4, 4] }, { bar: 3, bpm: 90 }], tracks: [{ name: 'a', instrument: 'grand-piano', notes: [[0, 1, 60, 80], [4, 1, 64, 80]] }] })
  assert(compiled.tempo.length === 2, 'the compiled score carries the map')
  const back = parseMidiFile(encodeMidiFile(compiled, { title: 'tempo' }))
  assert(JSON.stringify(back.tempos.map((t) => t.tick)) === '[0,3840]', 'both tempo changes land on their tick')
  assert(back.tempos[0].usPerQuarter === 500000 && back.tempos[1].usPerQuarter === 666667, 'the microseconds per quarter follow the bpm')
  const notes = back.tracks.slice(1).flatMap((track) => track.notes ?? [])
  assert(notes.length === 2 && notes[0].start === 0 && notes[1].start === 4, 'the second note still starts at 4s')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
