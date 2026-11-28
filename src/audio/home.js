import { readFileSync } from 'node:fs'
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

/**
 * Where the data lives. The config file itself stays at anyaudioHome(); this is
 * the directory fonts, singing, styles, manuals and the rest read from, so the
 * settings page can point a 3 GB library at another drive without touching the
 * environment. No cache: the file is small and a restart is what makes a change
 * visible anyway.
 */
export function anyaudioRoot() {
  const env = process.env.ANYAUDIO_HOME
  if (env && env.trim()) return resolve(env.trim())
  try {
    const raw = JSON.parse(readFileSync(join(anyaudioHome(), 'config.json'), 'utf8'))
    const home = raw && raw.ui && typeof raw.ui.home === 'string' ? raw.ui.home.trim() : ''
    if (home) return resolve(home)
  } catch {
    // no config yet, or it is being written; fall through to the default
  }
  return anyaudioHome()
}
