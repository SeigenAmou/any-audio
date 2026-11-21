import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

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
      const message = error instanceof Error ? error.message : String(error)
      // A tool that fails to register simply vanishes from the agent, so leave
      // a trace on disk: the host log is not always reachable from the plugin.
      noteRegistrationFailure(name, message, error)
      log(`could not register ${name}: ${message}`)
    }
  }
  return registered
}

/** Where the last registration failures are written; shared by every session. */
export function registrationFailurePath() {
  return join(homedir(), '.dsh', 'anyaudio', 'tool-register.log')
}

function noteRegistrationFailure(name, message, error) {
  try {
    const file = registrationFailurePath()
    mkdirSync(dirname(file), { recursive: true })
    const detail = error instanceof Error && error.stack ? `\n${error.stack}` : ''
    appendFileSync(file, `${new Date().toISOString()} ${name}: ${message}${detail}\n`)
  } catch {
    // logging must never break plugin loading
  }
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
