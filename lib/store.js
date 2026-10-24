/**
 * Durable, DSH-agnostic storage for this plugin.
 *
 * Why not `ctx.credentials`?
 *   The credentials seam is a DSH-internal service whose key/value types have
 *   already changed shape between releases (`credentialKey()` helper, grant
 *   record envelopes). A plugin that persists plain JSON in its own directory
 *   cannot be broken by a DSH upgrade: the worst case is a missing file.
 *
 * Security:
 *   `session.json` holds a bearer token, so it is written atomically with mode
 *   0600 (owner read/write only) on POSIX and left to the default ACL owner
 *   rights on Windows, where chmod is a no-op for the owning user.
 */

import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const DIR_NAME = 'devin-search'
const SESSION_FILE = 'session.json'
const SETTINGS_FILE = 'settings.json'

/**
 * Resolve the plugin's private directory, in order of preference:
 *   1. `<DSH_HOME>/devin-search`          — the harness home when it is exported
 *   2. `~/.dsh/devin-search`              — the harness home default
 *   3. `<tmp>/dsh-devin-search`           — last resort so the plugin still works
 *
 * @returns {string} absolute directory path
 */
export function resolveDir() {
  const candidates = []
  const home = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  if (home) candidates.push(join(home, DIR_NAME))
  try {
    candidates.push(join(homedir(), '.dsh', DIR_NAME))
  } catch {
    // homedir() can throw in exotic sandboxes; fall through to the temp dir.
  }
  if (candidates.length === 0) candidates.push(join(process.cwd(), '.dsh', DIR_NAME))
  return candidates[0]
}

/** @param {string} file @returns {Promise<unknown|undefined>} parsed JSON or undefined */
async function readJson(file) {
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return undefined
    throw error
  }
  try {
    return JSON.parse(text)
  } catch {
    // A truncated or hand-edited file must not brick the plugin.
    return undefined
  }
}

/** Atomic, owner-only write: temp file in the same directory, then rename. */
async function writeJson(file, value, secret) {
  await mkdir(dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`
  const body = `${JSON.stringify(value, null, 2)}\n`
  await writeFile(temp, body, secret ? { encoding: 'utf8', mode: 0o600 } : { encoding: 'utf8' })
  if (secret) {
    // Best effort: umask may already have widened the temp file.
    try {
      await chmod(temp, 0o600)
    } catch {
      // Windows ignores POSIX modes.
    }
  }
  await rename(temp, file)
  if (secret) {
    try {
      await chmod(file, 0o600)
    } catch {
      // Windows ignores POSIX modes.
    }
  }
}

/** Validate a persisted session grant; anything unexpected is treated as absent. */
function parseGrant(value) {
  if (!value || typeof value !== 'object') return undefined
  const token = typeof value.token === 'string' ? value.token.trim() : ''
  const expiresAt = typeof value.expiresAt === 'number' ? value.expiresAt : NaN
  if (!token || token.length > 16384) return undefined
  if (!Number.isFinite(expiresAt)) return undefined
  const expirySource = value.expirySource === 'jwt' ? 'jwt' : 'fallback'
  const grant = { version: 1, token, expiresAt, expirySource }
  if (value.revoked === true) grant.revoked = true
  return grant
}

/**
 * @param {{ dir?: string }} [options]
 */
export function createStore(options = {}) {
  const dir = options.dir || resolveDir()
  const sessionFile = join(dir, SESSION_FILE)
  const settingsFile = join(dir, SETTINGS_FILE)

  return {
    dir,
    sessionFile,
    settingsFile,

    /** @returns {Promise<{version:1,token:string,expiresAt:number,expirySource:'jwt'|'fallback',revoked?:boolean}|undefined>} */
    async readSession() {
      return parseGrant(await readJson(sessionFile))
    },

    /** @param {object} grant */
    async writeSession(grant) {
      const parsed = parseGrant(grant)
      if (!parsed) throw new Error('Refusing to persist an invalid Devin session.')
      await writeJson(sessionFile, parsed, true)
    },

    async clearSession() {
      try {
        await unlink(sessionFile)
      } catch (error) {
        if (!error || error.code !== 'ENOENT') throw error
      }
    },

    /** @returns {Promise<Record<string, unknown>|undefined>} */
    async readSettings() {
      const value = await readJson(settingsFile)
      return value && typeof value === 'object' ? value : undefined
    },

    /** @param {Record<string, unknown>} value */
    async writeSettings(value) {
      await writeJson(settingsFile, value, false)
    },
  }
}
