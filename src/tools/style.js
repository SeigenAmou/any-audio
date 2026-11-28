import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { anyaudioHome } from '../audio/home.js'
import { compileScore } from '../audio/score.js'
import { parseMidiFile, scoreFromMidi } from '../audio/midi-file.js'
import { analyzeStyle, describeCard, STYLE_SCHEMA } from '../audio/style.js'
import {
  finalizeTool, readJsonParam, textRenderer, workspaceRootOf,
} from './shared.js'

/**
 * Style cards: the one thing that survives between pieces.
 *
 * Everything else in this toolchain produces an artefact — a WAV, a .mid, a
 * project. None of them says *how* the piece was built, so the next score starts
 * from nothing and the agent re-invents a sound each time. A card measures what
 * can be measured (tempo, groove, register, density, intervals, dynamics) and
 * writes it down as a few hundred bytes of JSON plus a page a person can read.
 *
 * They live outside the project on purpose. A way of writing is a property of the
 * author, not of one video: the same "sparse minor strings at 78 BPM" serves the
 * next episode too. Putting them under `~/.dsh/anyaudio/styles` means every
 * project and every session sees the same shelf.
 */

const STYLE_EXT = '.json'
const STYLE_MD_EXT = '.md'

function styleDir() {
  return process.env.ANYAUDIO_STYLE_DIR || join(anyaudioHome(), 'styles')
}

function slugOf(text, fallback) {
  const cleaned = String(text ?? '').trim().replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '')
  return cleaned || fallback
}

/** A stable id even when the person names two cards the same thing. */
async function uniqueId(dir, wanted) {
  const base = slugOf(wanted, 'style')
  const existing = new Set((await readdir(dir).catch(() => [])).map((file) => file.replace(/\.(json|md)$/u, '')))
  if (!existing.has(base)) return base
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base}-${index}`
    if (!existing.has(candidate)) return candidate
  }
  return `${base}-${Date.now()}`
}

async function loadCard(id) {
  const dir = styleDir()
  const direct = join(dir, `${id}${STYLE_EXT}`)
  try {
    return JSON.parse(await readFile(direct, 'utf8'))
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  // Fall back to matching the display name, so a person can say "show 黑色爵士".
  const files = (await readdir(dir).catch(() => [])).filter((file) => file.endsWith(STYLE_EXT))
  for (const file of files) {
    const card = JSON.parse(await readFile(join(dir, file), 'utf8'))
    if (card.id === id || card.name === id) return card
  }
  throw new Error(`no style card named "${id}" in ${dir}`)
}

function learnFromScore(args, workspaceRoot) {
  return readJsonParam(args.score, 'score', { workspaceRoot })
}

export const styleToolDefinition = finalizeTool({
  name: 'anyaudio_style',
  description:
    'Keep a measured description of how a piece is written, and read it back before writing the next one. ' +
    'A style card records tempo, meter, key, groove (grid alignment, swing, syncopation), texture (parts, polyphony, register), per-part density and dynamics, and the interval mix — plus advice generated from those numbers. ' +
    'Actions: "learn" (measure a score object/path or a .mid file and save it), "list" (what is on the shelf), "show" (one card, as the markdown page), "remove". ' +
    'Cards are stored machine-wide in ~/.dsh/anyaudio/styles, so they carry across projects and sessions — that is the point: the next episode should not start from a generic idea of "cinematic strings". ' +
    'A card does not generate notes. It is evidence and constraints: read it, then write the score yourself and pass it to anyaudio_music.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['learn', 'list', 'show', 'remove'], description: 'What to do. Default "list".' },
      score: { oneOf: [{ type: 'object' }, { type: 'string' }], description: 'learn: the score to measure, same format anyaudio_music takes (object, or path to a .json).' },
      file: { type: 'string', description: 'learn: a .mid to measure instead of a score — the way to learn from someone else\'s arrangement or an old project\'s export.' },
      name: { type: 'string', description: 'learn: display name for the card (default the score title or file name). Also the id when id is omitted.' },
      id: { type: 'string', description: 'learn: explicit id; show/remove: which card.' },
      bpm: { type: 'number', description: 'learn: the tempo the piece is heard at, default 120. Needed because a score stores seconds, and groove is a fact about beats.' },
      meter: { type: 'string', description: 'learn: time signature as text, default "4/4". Recorded, not measured.' },
      save: { type: 'boolean', description: 'learn: write the card down (default true). Pass false to just measure and look.' },
    },
    required: [],
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: true,
      properties: {
        ok: { type: 'boolean' },
        action: { type: 'string' },
        id: { type: 'string' },
        name: { type: 'string' },
        summary: { type: 'string' },
        advice: { type: 'array', items: { type: 'string' } },
        saved: { type: 'string' },
        markdown: { type: 'string' },
        cards: { type: 'array', items: { type: 'object', additionalProperties: true } },
        card: { type: 'object', additionalProperties: true },
      },
    },
    render: textRenderer((args, value) => {
      if (value.action === 'list') {
        const cards = value.cards ?? []
        if (!cards.length) return `No style cards yet. Make one with anyaudio_style {action:"learn", score:{...}} — the shelf is ${styleDir()}.`
        return [`${cards.length} style card(s) in ${styleDir()}:`, ...cards.map((card) => `- ${card.id} — ${card.name}: ${card.summary}`)].join('\n')
      }
      if (value.action === 'show') return [value.markdown ?? '', '', `Stored at ${value.saved ?? ''}`].join('\n')
      if (value.action === 'remove') return `Removed style card "${value.id}".`
      const lines = [
        `Learned "${value.name}" (id ${value.id}).`,
        value.summary ?? '',
        '',
        'What this says about writing the next one:',
        ...(value.advice ?? []).map((line) => `- ${line}`),
      ]
      if (value.saved) lines.push('', `Saved: ${value.saved}`, 'Read it back with anyaudio_style {action:"show", id:"' + value.id + '"} before writing a piece in this style.')
      else lines.push('', 'Not saved (save:false).')
      return lines.join('\n')
    }),
  },
  async execute(args, exec) {
    const workspaceRoot = await workspaceRootOf(exec)
    const action = String(args.action ?? 'list')
    const dir = styleDir()

    if (action === 'list') {
      const files = (await readdir(dir).catch(() => [])).filter((file) => file.endsWith(STYLE_EXT)).sort()
      const cards = []
      for (const file of files) {
        const card = JSON.parse(await readFile(join(dir, file), 'utf8'))
        cards.push({ id: card.id ?? file.replace(STYLE_EXT, ''), name: card.name, createdAt: card.createdAt, summary: card.summary, bpm: card.clock?.bpm })
      }
      return { ok: true, action, cards }
    }

    if (action === 'show') {
      const wanted = String(args.id ?? args.name ?? '').trim()
      if (!wanted) throw new Error('pass "id": which style card to show')
      const card = await loadCard(wanted)
      const markdown = describeCard(card)
      return { ok: true, action, id: card.id, name: card.name, summary: card.summary, advice: card.advice, card, markdown, saved: join(dir, `${card.id}${STYLE_EXT}`) }
    }

    if (action === 'remove') {
      const wanted = String(args.id ?? args.name ?? '').trim()
      if (!wanted) throw new Error('pass "id": which style card to remove')
      const card = await loadCard(wanted)
      await rm(join(dir, `${card.id}${STYLE_EXT}`), { force: true })
      await rm(join(dir, `${card.id}${STYLE_MD_EXT}`), { force: true })
      return { ok: true, action, id: card.id, name: card.name }
    }

    if (action !== 'learn') throw new Error(`unknown action "${action}"; use learn, list, show or remove`)

    // Two ways in, one measurement: a score the agent wrote, or a .mid it found.
    let score
    let learnedFrom
    if (typeof args.file === 'string' && args.file.trim()) {
      const path = args.file.trim()
      const buffer = await readFile(path)
      const parsed = parseMidiFile(buffer)
      score = scoreFromMidi(parsed)
      learnedFrom = { kind: 'midi', title: score.title, file: path }
    } else if (args.score !== undefined && args.score !== null) {
      score = await learnFromScore(args, workspaceRoot)
      learnedFrom = { kind: 'score', title: score.title ?? null }
    } else {
      throw new Error('pass "score" (or its path) or "file" (a .mid) to learn from')
    }

    const compiled = compileScore(score, { sampleRate: 48000 })
    const bpm = Number.isFinite(Number(args.bpm)) ? Number(args.bpm) : 120
    const card = analyzeStyle(compiled, {
      name: args.name ?? score.title ?? 'untitled',
      bpm,
      meter: typeof args.meter === 'string' ? args.meter : '4/4',
      learnedFrom,
    })

    const save = args.save !== false
    if (!save) {
      return { ok: true, action, id: null, name: card.name, summary: card.summary, advice: card.advice, card, markdown: describeCard(card) }
    }

    await mkdir(dir, { recursive: true })
    const id = await uniqueId(dir, args.id ?? args.name ?? card.name)
    card.id = id
    card.schema = STYLE_SCHEMA
    await writeFile(join(dir, `${id}${STYLE_EXT}`), `${JSON.stringify(card, null, 2)}\n`)
    await writeFile(join(dir, `${id}${STYLE_MD_EXT}`), `${describeCard(card)}\n`)
    return {
      ok: true,
      action,
      id,
      name: card.name,
      summary: card.summary,
      advice: card.advice,
      card,
      saved: join(dir, `${id}${STYLE_EXT}`),
    }
  },
})

export function registerStyleTool(ctx) {
  ctx.tools.register(styleToolDefinition)
}
