import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * Where this plugin keeps its data.
 *
 * The default is ~/.dsh/anyaudio, which on this machine is a junction to another
 * drive. ANYAUDIO_HOME points the whole plugin somewhere else without every
 * caller having to know: config.json, fonts, singing, styles, manuals and the
 * rest all ask here. That is what the "data directory" switch exposes to the
 * person; the Agent never needs it.
 */
export function anyaudioHome() {
  const override = process.env.ANYAUDIO_HOME
  return override && override.trim() ? resolve(override.trim()) : join(homedir(), '.dsh', 'anyaudio')
}
