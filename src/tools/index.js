import { registerMidiTool } from './midi.js'
import { registerMidioutTool } from './midiout.js'
import { registerMusicTool } from './music.js'
import { registerProjectTool } from './project.js'
import { registerRecordTool } from './record.js'
import { registerSingTool } from './sing.js'
import { registerSfxTool } from './sfx.js'
import { registerSourcesTool } from './sources.js'
import { registerStyleTool } from './style.js'
import { registerTtsTool } from './tts.js'
import { registerVstTool } from './vst.js'

export const TOOL_REGISTRARS = [
  ['anyaudio_music', registerMusicTool],
  ['anyaudio_midi', registerMidiTool],
  ['anyaudio_midiout', registerMidioutTool],
  ['anyaudio_style', registerStyleTool],
  ['anyaudio_vst', registerVstTool],
  ['anyaudio_record', registerRecordTool],
  ['anyaudio_sing', registerSingTool],
  ['anyaudio_tts', registerTtsTool],
  ['anyaudio_sfx', registerSfxTool],
  ['anyaudio_sources', registerSourcesTool],
  ['anyaudio_project', registerProjectTool],
]

export function registerAllTools(ctx, log = () => {}) {
  let registered = 0
  for (const [name, register] of TOOL_REGISTRARS) {
    try {
      register(ctx)
      registered++
    } catch (error) {
      log(`could not register ${name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return registered
}

export { sourcesToolDefinition } from './sources.js'
export { midiToolDefinition } from './midi.js'
export { midioutToolDefinition } from './midiout.js'
export { styleToolDefinition } from './style.js'
export { vstToolDefinition } from './vst.js'
export { recordToolDefinition } from './record.js'
export { musicToolDefinition } from './music.js'
export { projectToolDefinition } from './project.js'
export { singToolDefinition } from './sing.js'
export { sfxToolDefinition } from './sfx.js'
export { ttsToolDefinition } from './tts.js'
