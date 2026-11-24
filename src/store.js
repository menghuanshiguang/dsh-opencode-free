// @ts-check
/**
 * Local state directory for the free lane.
 *
 * The upstream store also held user settings, usage history, probe results and
 * a proxy key ring. None of that survives here: this package keeps one session
 * map (written by src/upstream.js) and the Bun worker file, so the only thing
 * left to resolve is where those two live.
 *
 * @module src/store.js
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Same resolution the harness home-paths helper uses: `$DSH_HOME` else `~/.dsh`. */
export function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return path.join(os.homedir(), '.dsh')
}

export const DATA_DIR_NAME = 'opencode-free'

/** Create the lane's data directory, owner-only. Returns its path. */
export function ensureDataDir() {
  const dir = path.join(resolveDshHome(), DATA_DIR_NAME)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}
