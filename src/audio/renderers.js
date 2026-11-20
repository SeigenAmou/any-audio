/**
 * A renderer turns a compiled score into audio.
 *
 * Today there is exactly one — the SoundFont engine — and `anyaudio_music`
 * reaches it through this registry instead of importing `synth.js` directly.
 * That indirection is the whole point: a second backend (a VST3 host, or a
 * hardware module fed over MIDI) becomes available by registering it here,
 * without editing the tool that scores the music.
 *
 * The contract is what `renderCompiled` already returns: `channels` (two
 * Float32Array), `sampleRate`, `frames`, `durationSec`, `appliedGain`,
 * `peakBeforeDb`, plus whatever the backend wants to say about itself. A
 * backend that cannot produce a stereo pair is not a backend.
 */
import { renderCompiled } from './synth.js'

const RENDERERS = new Map()
const DEFAULT_RENDERER = 'soundfont'

export function registerRenderer(id, renderer) {
  if (!id || typeof id !== 'string') throw new Error('a renderer needs an id')
  if (typeof renderer?.render !== 'function') throw new Error(`renderer "${id}" needs a render function`)
  RENDERERS.set(id, { offline: true, ...renderer, id })
}

export function listRenderers() {
  return [...RENDERERS.values()].map(({ id, label, offline, description }) => ({ id, label, offline, description }))
}

export function getRenderer(id) {
  const found = RENDERERS.get(id ?? DEFAULT_RENDERER)
  if (!found) {
    throw new Error(`unknown renderer "${id ?? DEFAULT_RENDERER}"; available: ${[...RENDERERS.keys()].join(', ')}`)
  }
  return found
}

/** Render a compiled score with the named backend (the SoundFont engine by default). */
export async function renderScore(compiled, options = {}) {
  return getRenderer(options.renderer).render(compiled, options)
}

registerRenderer('soundfont', {
  label: 'SoundFont (spessasynth)',
  offline: true,
  description: 'Renders every track through one SoundFont synth, so reverb and chorus behave like one ensemble.',
  render: renderCompiled,
})
