/**
 * One-time import of the Devin session that the previous plugin stored in the
 * harness credential file.
 *
 * The old `dsh-devin-search` wrote a `devin-search/session` grant record into
 * `$DSH_HOME/.credentials.yaml`. This plugin deliberately keeps its own file
 * (the credentials seam is harness-internal and changed shape between releases),
 * so without this migration every existing user would have to sign in again.
 *
 * Rules:
 *   - read-only on the harness file; never modify it;
 *   - only import when this plugin has no session yet, and only an unexpired,
 *     well-formed grant;
 *   - a missing, unreadable or unfamiliar file is silently ignored.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const RECORD_NAME = 'devin-search/session'
/**
 * One-shot marker. Without it, `/devin-logout` followed by a restart would find
 * an empty store and resurrect the old grant from the harness credential file,
 * which reads as "signing out does not stick". One migration attempt per
 * installation, whatever its outcome, is also the least surprising rule.
 */
const MARKER_FILE = 'legacy-import.json'

/** Strip a YAML scalar's quotes/whitespace; returns '' for anything exotic. */
function scalar(raw) {
  let value = String(raw || '').trim()
  if (!value) return ''
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1)
  }
  return value
}

/** Indentation width of a line (spaces; tabs count as one). */
function indentOf(line) {
  const match = /^[ \t]*/.exec(line)
  return match ? match[0].length : 0
}

/**
 * Extract the `payload` map of one record from the tiny YAML subset the harness
 * writes. This is intentionally not a YAML parser: it recognises exactly the
 * shape the harness serializes and returns nothing otherwise.
 *
 * @param {string} text
 * @returns {Record<string, string> | undefined}
 */
export function parseLegacyGrant(text) {
  if (typeof text !== 'string' || !text) return undefined
  const lines = text.split(/\r?\n/)
  /** @type {Record<string, string> | undefined} */
  let payload
  let sectionIndent = -1
  let recordIndent = -1
  let inRecord = false
  let inPayload = false
  let payloadIndent = -1

  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith('#')) continue
    const indent = indentOf(line)
    const trimmed = line.trim()

    if (trimmed === 'records:') {
      sectionIndent = indent
      continue
    }
    if (sectionIndent < 0) continue

    // Leaving the records block ends the search.
    if (indent <= sectionIndent && !inRecord) continue

    if (!inRecord) {
      // `<name>:` at the record level.
      if (trimmed.endsWith(':') && indent > sectionIndent) {
        const name = trimmed.slice(0, -1).trim()
        inRecord = name === RECORD_NAME
        recordIndent = indent
        inPayload = false
        if (inRecord) payload = {}
      }
      continue
    }

    if (indent <= recordIndent) {
      // Next record: stop at the first one after ours.
      inRecord = false
      inPayload = false
      continue
    }

    if (trimmed === 'payload:') {
      inPayload = true
      payloadIndent = indent
      continue
    }
    if (!inPayload) continue
    if (indent <= payloadIndent) {
      inPayload = false
      continue
    }

    const separator = trimmed.indexOf(':')
    if (separator <= 0) continue
    const key = trimmed.slice(0, separator).trim()
    const value = scalar(trimmed.slice(separator + 1))
    if (!payload) payload = {}
    payload[key] = value
  }

  if (!payload) return undefined
  return payload
}

/** Validate a parsed payload into a grant this plugin can store. */
export function grantFromPayload(payload, now = Date.now()) {
  if (!payload) return undefined
  const token = typeof payload.token === 'string' ? payload.token.trim() : ''
  if (!token || token.length > 16384) return undefined
  const expiresAt = Number(payload.expiresAt)
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return undefined
  const expirySource = payload.expirySource === 'jwt' ? 'jwt' : 'fallback'
  if (payload.version !== undefined && String(payload.version).trim() !== '1') return undefined
  return { version: 1, token, expiresAt, expirySource }
}

/**
 * Import the legacy grant once — and only once — for this installation.
 *
 * @param {{ store: { readSession(): Promise<object|undefined>, writeSession(grant: object): Promise<void>, dir?: string } }} input
 * @returns {Promise<'imported'|'skipped'|'absent'>}
 */
export async function importLegacySession(input) {
  const store = input.store
  try {
    if (await store.readSession()) return 'skipped'
  } catch {
    return 'skipped'
  }
  const marker = typeof store.dir === 'string' && store.dir ? join(store.dir, MARKER_FILE) : undefined
  if (marker) {
    try {
      await readFile(marker, 'utf8')
      return 'skipped'
    } catch {
      // No marker yet: this installation has never tried.
    }
  }

  /** @param {'imported'|'absent'} outcome */
  const stamp = async (outcome) => {
    if (!marker) return
    try {
      await mkdir(dirname(marker), { recursive: true })
      await writeFile(marker, `${JSON.stringify({ outcome, at: new Date().toISOString() })}\n`, 'utf8')
    } catch {
      // A marker that cannot be written only risks one more attempt.
    }
  }

  const candidates = []
  try {
    if (typeof store.dir === 'string' && store.dir) candidates.push(join(dirname(store.dir), '.credentials.yaml'))
  } catch {
    // Fall through to no candidates.
  }
  if (typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim()) {
    candidates.push(join(process.env.DSH_HOME.trim(), '.credentials.yaml'))
  }

  for (const file of candidates) {
    let text
    try {
      text = await readFile(file, 'utf8')
    } catch {
      continue
    }
    const grant = grantFromPayload(parseLegacyGrant(text))
    if (!grant) continue
    try {
      await store.writeSession(grant)
      await stamp('imported')
      return 'imported'
    } catch {
      return 'skipped'
    }
  }
  await stamp('absent')
  return 'absent'
}
