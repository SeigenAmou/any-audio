// anyaudio_vst — play an installed VST3 plugin from a note list.
//
// Why this exists: the scoring pipeline only knew SoundFonts, so every timbre
// had to come from a .sf2. A plugin sitting in C:\Program Files\Common Files\VST3
// is a whole synthesiser with a sound nobody can reproduce from a sample
// library — and the machine already has dozens of them licensed and working.
// What was missing was a way to ask one for a note without opening a DAW.
//
// The result is an ordinary material on an ordinary track, exactly like a
// SoundFont render: it can be mixed, faded, cut and re-rendered per track, and
// nothing downstream needs to know it came from a plugin.

import { mkdir, readFile, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { parseWav, toDb } from '../audio/wav.js'
import { attachMaterialFile } from '../project/attach.js'
import { projectDir } from '../project/paths.js'
import { readConfig } from '../config.js'
import { describeVst, renderVst, scanVstPlugins, vstStatus } from '../audio/vst-host.js'
import { findPreset, listPresets, presetDir, removePreset, savePreset } from '../audio/vst-preset.js'
import {
  deliverCopy, deliveryPath, finalizeTool, nowStamp, readJsonParam, relativeToWorkspace,
  requireProjectId, scratchPath, textRenderer, workspaceRootOf,
} from './shared.js'

/** `JUNO-106(VST3 64bit).vst3` → `JUNO-106`. The parenthesised bit and the
 *  extension are install details, not a name a person would recognise. */
function friendlyName(pluginPath) {
  return basename(pluginPath)
    .replace(/\.vst3$/i, '')
    .replace(/\s*\((VST3|VST2|64bit|32bit)[^)]*\)/gi, '')
    .trim() || basename(pluginPath)
}

function normalizeNotes(raw) {
  if (!Array.isArray(raw)) throw new Error('notes must be an array of [startSec, durSec, midi, velocity]')
  return raw.map((note, index) => {
    if (!Array.isArray(note) || note.length < 3) {
      throw new Error(`notes[${index}] must be [startSec, durSec, midi, velocity, channel?]`)
    }
    const start = Number(note[0])
    const duration = Number(note[1])
    const midi = Number(note[2])
    const velocity = note[3] === undefined ? 100 : Number(note[3])
    if (!Number.isFinite(start) || start < 0) throw new Error(`notes[${index}]: startSec must be a non-negative number`)
    if (!Number.isFinite(duration) || duration <= 0) throw new Error(`notes[${index}]: durSec must be greater than 0`)
    if (!Number.isInteger(midi) || midi < 0 || midi > 127) throw new Error(`notes[${index}]: midi must be an integer 0..127`)
    if (!Number.isFinite(velocity) || velocity < 1 || velocity > 127) throw new Error(`notes[${index}]: velocity must be 1..127`)
    const channel = note[4] === undefined ? undefined : Number(note[4])
    if (channel !== undefined && (!Number.isInteger(channel) || channel < 0 || channel > 15)) {
      throw new Error(`notes[${index}]: channel must be an integer 0..15`)
    }
    return channel === undefined ? [start, duration, midi, velocity] : [start, duration, midi, velocity, channel]
  })
}

/** Take one part out of a score so a plugin can play it. The first track with
 *  notes wins: `anyaudio_vst` renders one plugin voice, not an arrangement. */
function notesFromScore(score) {
  const tracks = Array.isArray(score?.tracks) ? score.tracks : []
  const track = tracks.find((entry) => Array.isArray(entry?.notes) && entry.notes.length > 0)
  if (!track) throw new Error('score has no track with notes')
  const notes = []
  for (const note of track.notes) {
    if (!Array.isArray(note) || note.length < 3) continue
    if (Array.isArray(note[2])) {
      // A chord written as one note row: expand it, same pitches, same window.
      for (const pitch of note[2]) notes.push([Number(note[0]), Number(note[1]), Number(pitch), Number(note[3] ?? 100)])
      continue
    }
    notes.push([Number(note[0]), Number(note[1]), Number(note[2]), Number(note[3] ?? 100)])
  }
  return { track, notes }
}

async function measure(path, sampleRateFallback) {
  const wav = parseWav(await readFile(path))
  let peak = 0
  let sum = 0
  let count = 0
  for (const channel of wav.channels) {
    for (let index = 0; index < channel.length; index++) {
      const sample = channel[index]
      const magnitude = sample < 0 ? -sample : sample
      if (magnitude > peak) peak = magnitude
      sum += sample * sample
      count++
    }
  }
  const rms = count ? Math.sqrt(sum / count) : 0
  return {
    sampleRate: wav.sampleRate || sampleRateFallback,
    durationSec: wav.frames / (wav.sampleRate || sampleRateFallback),
    // -120 dBFS is the number this toolchain uses for "no signal": the host's
    // schema checker rejects a `null` in a typed field (that is why vst, record
    // and midiout failed to register at first), so silence is a number and
    // `silent` carries the meaning.
    peakDb: Number.isFinite(peak) && peak > 0 ? toDb(peak) : -120,
    rmsDb: Number.isFinite(rms) && rms > 0 ? toDb(rms) : -120,
    silent: !(peak > 1e-5),
  }
}

export const vstToolDefinition = finalizeTool({
  name: 'anyaudio_vst',
  description:
    'Play an installed VST3 instrument plugin: notes in → a rendered WAV out, added to the clip bay project as ordinary material. ' +
    'Use it when the person asks for a specific plugin sound (a Roland Cloud synth, a piano library, a drum machine) or when a SoundFont cannot get close. ' +
    'action "scan" lists the plugins installed on this machine; action "info" dumps one plugin\'s parameters; action "render" plays notes. ' +
    'Notes are [startSec, durSec, midi, velocity, channel?]; channel defaults to 0. ' +
    'Unlike a SoundFont render this is one plugin at a time. For a part inside a multi-instrument arrangement, do not render it separately and paste it: write vst:"<plugin path>" on a track of anyaudio_music instead, and it is mixed into the score with one shared master gain. Use this tool to audition a patch, or when the plugin part is the whole piece. ' +
    'SoundFonts are still the right default for a full arrangement: they load in-process, need no licence and render the whole score at once. ' +
    'A plugin that waits for a licence window cannot be driven headless; those report a timeout instead of hanging the host.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['scan', 'info', 'render', 'status', 'preset'], description: 'scan = list installed plugins; info = describe one plugin; render = play notes through one plugin; status = is the Python bridge ready; preset = save/list/show/remove a patch.' },
      plugin: { type: 'string', description: 'Full path to the .vst3 (from action "scan"). Required for info and render.' },
      notes: { type: 'array', description: 'Notes as [startSec, durSec, midi, velocity, channel?]. Seconds on the clip timeline, midi 0..127, velocity 1..127; channel defaults to 0.', items: { type: 'array', items: { type: 'number' } } },
      score: { oneOf: [{ type: 'object' }, { type: 'string' }], description: 'Alternative to notes: a score object (or .json path) whose first track with notes is played. Useful when the part was already written for anyaudio_music.' },
      params: { oneOf: [{ type: 'object' }, { type: 'string' }], description: 'Parameter values by name, e.g. {"lfo_rate": 96}. Names come from action "info". Values are the plugin\'s own raw range, not 0..1.' },
      durationSec: { type: 'number', description: 'Length of the rendered file. Defaults to the last note end plus 2 s of release.' },
      sampleRate: { type: 'number', description: 'Default 48000.' },
      projectId: { type: 'string', description: 'Project to add the render to. Optional: without it the WAV is still written, which is how a person auditions a patch.' },
      trackName: { type: 'string', description: 'Track for this render, default the plugin name (e.g. JUNO-106).' },
      startSec: { type: 'number', description: 'Where the clip starts on the project timeline, default 0.' },
      query: { type: 'string', description: 'With action "scan": only list plugins whose name or path contains this text.' },
      output: { type: 'string', description: 'Optional extra copy at this path.' },
      preset: { type: 'string', description: 'A saved patch name (from action "preset"). With action "render" it supplies the plugin path and the parameter values, so "plugin" and "params" can be left out.' },
      presetAction: { type: 'string', enum: ['save', 'list', 'show', 'remove'], description: 'With action "preset": what to do with the saved patches. Default "list".' },
      name: { type: 'string', description: 'With action "preset": the patch name to save, show or remove.' },
      note: { type: 'string', description: 'With action "preset": a remark stored next to the patch, e.g. "only the chorus, no reverb".' },
      limit: { type: 'number', description: 'With action "scan": max rows, default 60.' },
    },
    required: ['action'],
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: true,
      properties: {
        ok: { type: 'boolean' },
        action: { type: 'string' },
        available: { type: 'boolean' },
        python: { type: 'string' },
        pedalboard: { type: 'string' },
        count: { type: 'number' },
        plugins: { type: 'array', items: { type: 'object', additionalProperties: true } },
        plugin: { type: 'string' },
        instrument: { type: 'boolean' },
        parameters: { type: 'array', items: { type: 'object', additionalProperties: true } },
        file: { type: 'string' },
        absolutePath: { type: 'string' },
        delivered: { type: 'string' },
        durationSec: { type: 'number' },
        sampleRate: { type: 'number' },
        peakDb: { type: 'number', description: 'Peak level in dBFS; -120 means the plugin rendered silence.' },
        rmsDb: { type: 'number', description: 'RMS level in dBFS; -120 means silence.' },
        attached: { type: 'array', items: { type: 'object', additionalProperties: true } },
        warnings: { type: 'array', items: { type: 'string' } },
      },
    },
    render: textRenderer((args, value) => {
      if (value.action === 'scan') {
        const rows = (value.plugins ?? []).map((entry) => `- ${entry.name} — ${entry.path}`)
        return [`${value.count} plugin(s) found${value.count > rows.length ? ` (showing ${rows.length})` : ''}`, ...rows].join('\n')
      }
      if (value.action === 'info') {
        const names = (value.parameters ?? []).map((entry) => entry.name)
        return [
          `${value.plugin}`,
          `instrument: ${value.instrument ? 'yes' : 'no'}; ${names.length} parameter(s)`,
          names.length ? `parameters: ${names.slice(0, 40).join(', ')}${names.length > 40 ? ` … +${names.length - 40}` : ''}` : 'no parameters',
        ].join('\n')
      }
      if (value.action === 'status') {
        return value.available
          ? `VST bridge ready: python ${value.python}, pedalboard ${value.pedalboard}`
          : `VST bridge not ready: ${value.error ?? 'unknown'} (run pip install pedalboard for ${value.python})`
      }
      if (value.action === 'preset') {
        if (value.presetAction === 'save') return `Saved patch "${value.name}" (${value.params} parameter(s)) → ${value.saved}`
        if (value.presetAction === 'remove') return `Removed patch "${value.name}"`
        if (value.presetAction === 'show') {
          const rows = (value.parameters ?? []).map((entry) => `  ${entry.name} = ${entry.value}`)
          return [`Patch "${value.name}" on ${value.plugin}`, ...rows].join('\\n')
        }
        const rows = (value.presets ?? []).map((entry) => `- ${entry.name} — ${entry.pluginName} (${entry.params} parameter(s))${entry.note ? ` · ${entry.note}` : ''}`)
        return [`${value.count} saved patch(es)`, ...rows].join('\\n')
      }
      const lines = [
        `Played ${value.durationSec?.toFixed(2)}s @ ${value.sampleRate} Hz → ${value.file}`,
        `peak ${Number(value.peakDb ?? 0).toFixed(1)} dBFS, RMS ${Number(value.rmsDb ?? 0).toFixed(1)} dBFS`,
      ]
      if (value.warnings?.length) lines.push(`Warnings:\n${value.warnings.map((warning) => `- ${warning}`).join('\n')}`)
      const placed = value.attached ?? []
      lines.push(placed.length
        ? `In project: ${placed.map((entry) => `${entry.clipId} "${entry.trackName}" @ ${Number(entry.startSec).toFixed(2)}s`).join(', ')}`
        : 'Not added to a project (no projectId given); the WAV is still on disk.')
      if (value.delivered) lines.push(`Delivered copy: ${value.delivered}`)
      return lines.join('\n')
    }),
  },
  async execute(args, exec) {
    const workspaceRoot = await workspaceRootOf(exec)
    const action = String(args.action ?? '').trim() || 'scan'

    if (action === 'status') {
      const status = await vstStatus()
      return { ok: status.available, action, ...status }
    }

    if (action === 'preset') {
      const sub = String(args.presetAction ?? 'list').trim().toLowerCase() || 'list'
      if (sub === 'list') {
        const { presets, broken } = await listPresets()
        return {
          ok: true,
          action,
          presetAction: sub,
          count: presets.length,
          presets: presets.map((entry) => ({
            id: entry.id,
            name: entry.name,
            plugin: entry.plugin,
            pluginName: entry.pluginName,
            params: Object.keys(entry.params).length,
            note: entry.note,
            createdAt: entry.createdAt,
          })),
          ...(broken.length ? { warnings: broken.map((entry) => `${entry.file}: ${entry.error}`) } : {}),
        }
      }

      const name = String(args.name ?? args.preset ?? '').trim()
      if (!name) throw new Error(`preset ${sub} needs "name": the patch you want to ${sub}`)

      if (sub === 'save') {
        const pluginPath = String(args.plugin ?? '').trim()
        if (!pluginPath) throw new Error('preset save needs "plugin": the .vst3 the patch was tuned on (action "scan" lists them)')
        const params = args.params === undefined ? {} : await readJsonParam(args.params, 'params', { workspaceRoot })
        const record = await savePreset({ name, plugin: pluginPath, params, note: args.note })
        return {
          ok: true,
          action,
          presetAction: sub,
          id: record.id,
          name: record.name,
          plugin: record.plugin,
          params: Object.keys(record.params).length,
          note: record.note,
          saved: relativeToWorkspace(workspaceRoot, join(presetDir(), `${record.id}.json`)),
        }
      }

      if (sub === 'show') {
        const found = await findPreset(name)
        if (!found) throw new Error(`no saved patch named "${name}"`)
        return {
          ok: true,
          action,
          presetAction: sub,
          id: found.id,
          name: found.name,
          plugin: found.plugin,
          parameters: Object.entries(found.params).map(([key, value]) => ({ name: key, value })),
          note: found.note,
          createdAt: found.createdAt,
        }
      }

      if (sub === 'remove') {
        const gone = await removePreset(name)
        if (!gone) throw new Error(`no saved patch named "${name}"`)
        return { ok: true, action, presetAction: sub, id: gone.id, name: gone.name, removed: true }
      }

      throw new Error(`unknown presetAction "${sub}"; use save, list, show or remove`)
    }

    if (action === 'scan') {
      const query = String(args.query ?? '').trim().toLowerCase()
      const limitArg = Number(args.limit)
      const limit = Number.isFinite(limitArg) && limitArg > 0 ? Math.min(Math.floor(limitArg), 500) : 60
      const { config } = await readConfig()
      const all = scanVstPlugins(config.sources?.vstDirs ?? []).map((entry) => ({ name: friendlyName(entry.path), path: entry.path, bytes: entry.bytes }))
      const matched = query
        ? all.filter((entry) => entry.path.toLowerCase().includes(query) || entry.name.toLowerCase().includes(query))
        : all
      const status = await vstStatus()
      return {
        ok: true,
        action,
        available: status.available,
        python: status.python,
        pedalboard: status.pedalboard ?? null,
        count: matched.length,
        plugins: matched.slice(0, limit),
      }
    }

    // A saved patch can stand in for the plugin path and the parameter block;
    // values given explicitly still win, so one knob can be changed on top of it.
    let plugin = String(args.plugin ?? '').trim()
    let presetParams = null
    if (args.preset !== undefined && String(args.preset).trim()) {
      const found = await findPreset(String(args.preset))
      if (!found) {
        const { presets } = await listPresets()
        const available = presets.map((entry) => `"${entry.name}"`).join(', ') || '(none saved yet)'
        throw new Error(`no saved patch named "${args.preset}". Saved patches: ${available}. Save one with action "preset", presetAction "save".`)
      }
      if (!plugin) plugin = found.plugin
      presetParams = found.params
    }
    if (!plugin) throw new Error(`${action} needs "plugin": the full path to a .vst3 (get one from action "scan"), or "preset": a saved patch`)

    if (action === 'info') {
      const info = await describeVst(plugin)
      return { ok: true, action, plugin, instrument: info.instrument, parameters: info.parameters }
    }

    if (action !== 'render') throw new Error(`unknown action "${action}"; use scan, info, render or status`)

    const sampleRateArg = Number(args.sampleRate)
    const sampleRate = Number.isFinite(sampleRateArg) && sampleRateArg >= 8000 ? Math.round(sampleRateArg) : 48000

    let notes
    let track = null
    if (args.notes !== undefined) {
      notes = normalizeNotes(args.notes)
    } else if (args.score !== undefined) {
      const score = await readJsonParam(args.score, 'score', { workspaceRoot })
      const picked = notesFromScore(score)
      notes = normalizeNotes(picked.notes)
      track = picked.track
    } else {
      throw new Error('render needs notes: [[startSec, durSec, midi, velocity], …] or a score with a track that has notes')
    }

    const lastEnd = notes.reduce((end, note) => Math.max(end, note[0] + note[1]), 0)
    const durationArg = Number(args.durationSec)
    const durationSec = Number.isFinite(durationArg) && durationArg > 0 ? Math.min(durationArg, 900) : Math.min(lastEnd + 2, 900)
    const explicit = args.params === undefined ? null : await readJsonParam(args.params, 'params', { workspaceRoot })
    const params = explicit && presetParams
      ? { ...presetParams, ...explicit }
      : (explicit ?? presetParams ?? undefined)

    const target = scratchPath(workspaceRoot, `vst-${nowStamp()}.wav`)
    await mkdir(dirname(target), { recursive: true })
    const warnings = []
    let rendered
    try {
      rendered = await renderVst({ plugin, notes, params, durationSec, sampleRate, out: target })
    } catch (error) {
      error.message = `${error.message}\n(plugin: ${plugin})`
      throw error
    }
    if (rendered.warnings?.length) warnings.push(...rendered.warnings)

    const measured = await measure(target, sampleRate)
    if (measured.silent) {
      warnings.push(
        'the plugin produced silence. On this machine that is what an unlicensed plugin does: '
        + 'Roland TR-808/909 load with every parameter and still render 0.0000 on all 16 channels. '
        + 'A patch with no notes in this register, or an output routed nowhere, also renders silence — '
        + 'tell the user rather than retrying every channel.',
      )
    }

    const projectId = typeof args.projectId === 'string' && args.projectId.trim() ? args.projectId.trim() : ''
    const trackName = String(args.trackName ?? '').trim() || track?.name || friendlyName(plugin)
    let attached = []
    if (projectId) {
      requireProjectId(args, 'anyaudio_vst')
      const landed = await attachMaterialFile(workspaceRoot, projectId, target, {
        kind: 'music',
        trackName,
        category: 'music',
        snapshot: { plugin, notes, params: params ?? null, durationSec, sampleRate },
        snapshotKind: 'vst-render',
        tool: 'anyaudio_vst',
        label: trackName,
        startSec: Number(args.startSec ?? 0),
        peakDb: measured.peakDb,
        rmsDb: measured.rmsDb,
        note: `${friendlyName(plugin)} plugin render`,
      })
      attached = [landed]
    }

    let delivered = null
    if (args.output) {
      const { config } = await readConfig()
      delivered = await deliverCopy(target, deliveryPath({
        workspaceRoot,
        outputDir: config.output?.dir,
        requested: args.output,
        stagedPath: target,
      }))
    }

    // The material copy is what the project owns; the scratch file is only the
    // vehicle that carried the samples into it. Auditioning without a project
    // keeps the scratch file, because that WAV is then the only copy.
    const absolutePath = attached.length > 0 && projectId
      ? join(projectDir(workspaceRoot, projectId), attached[0].file)
      : target
    if (attached.length > 0) await rm(target, { force: true })

    return {
      ok: true,
      action,
      plugin,
      file: relativeToWorkspace(workspaceRoot, absolutePath),
      absolutePath,
      ...(delivered
        ? { delivered: relativeToWorkspace(workspaceRoot, delivered), deliveredAbsolutePath: delivered }
        : {}),
      durationSec: measured.durationSec,
      sampleRate: measured.sampleRate,
      peakDb: measured.peakDb,
      rmsDb: measured.rmsDb,
      attached,
      warnings,
    }
  },
})

export function registerVstTool(ctx) {
  ctx.tools.register(vstToolDefinition)
}
