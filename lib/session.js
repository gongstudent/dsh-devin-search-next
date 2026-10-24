/**
 * The Devin session state machine.
 *
 * This module is deliberately free of DeepSeek Harness imports: it owns the
 * OAuth flow, the in-memory snapshot, the login attempt lifecycle and the
 * credential file, and exposes a narrow structural API that the adapters
 * (`adapter-web`, `adapter-tools`, `adapter-auth`, `host-api`) consume.
 *
 * The search/completion clients only need `{ available, access, revoke }`, so
 * they can be unit-tested against a stub.
 */

import { randomBytes } from 'node:crypto'
import { check, deadline, expiry, fail, safeError, toDevinSessionToken } from './core/safety.js'
import { oauth, oauthCode, validateCode } from './core/oauth.js'

/** @typedef {'code'|'loopback'} LoginMode */
/** @typedef {'idle'|'pending'|'exchanging'|'authorized'|'cancelled'|'error'} LoginPhase */

const ATTEMPT_ID = /^[A-Za-z0-9_-]{32}$/
const PENDING = new Set(['pending', 'exchanging'])

/** How long beginLogin() waits for the provider to hand us an authorization URL. */
const URL_TIMEOUT_MS = 20_000

function canonical(token) {
  return toDevinSessionToken(token)
}

/**
 * @typedef {object} DevinSessionsOptions
 * @property {string} [accountId] unused placeholder kept for future headers
 * @property {object} oauth options forwarded to core/oauth (base urls, fetcher, ports)
 * @property {(event: string, detail?: unknown) => void} [onEvent] structured observability hook
 */

export class DevinSessions {
  /**
   * @param {{ store: { readSession(): Promise<object|undefined>, writeSession(grant: object): Promise<void>, clearSession(): Promise<void> }, options?: DevinSessionsOptions }} input
   */
  constructor({ store, options = {} }) {
    this.store = store
    this.options = options
    /** @type {{version:1,token:string,expiresAt:number,expirySource:'jwt'|'fallback',revoked?:boolean}|undefined} */
    this.snapshot = undefined
    /** @type {Set<(status: object, reason: string) => void>} */
    this.listeners = new Set()
    this.readVersion = 0
    this.epoch = 0
    this.clearing = false
    this.disposed = false
    /** @type {AbortController|undefined} */
    this.controller = undefined
    this.searches = new AbortController()
    /** @type {Promise<unknown>} */
    this.gate = Promise.resolve()
    /** @type {Promise<void>|undefined} */
    this.background = undefined
    /** @type {Set<Promise<void>>} */
    this.runs = new Set()
    /** @type {object|undefined} */
    this.attempt = undefined
    this.last = 'Not signed in.'
  }

  // ---------------------------------------------------------------- events

  /** @param {(status: object, reason: string) => void} listener */
  subscribe(listener) {
    if (typeof listener !== 'function') return () => {}
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** @param {string} reason */
  emit(reason) {
    const status = this.getStatus()
    for (const listener of [...this.listeners]) {
      try {
        listener(status, reason)
      } catch {
        // A broken observer must never break the session.
      }
    }
    try {
      if (typeof this.options.onEvent === 'function') this.options.onEvent(reason, status)
    } catch {
      // Observability is best effort.
    }
  }

  // ---------------------------------------------------------------- snapshot

  /** Serialize mutating operations (login commit, logout, revoke). */
  locked(fn) {
    const next = this.gate.then(fn, fn)
    this.gate = next.catch(() => {})
    return next
  }

  /** Drop the cached snapshot and cancel in-flight searches that used it. */
  invalidate() {
    this.readVersion += 1
    this.snapshot = undefined
    this.searches.abort()
    this.searches = new AbortController()
  }

  async reload() {
    const version = this.readVersion
    let current
    try {
      current = await this.store.readSession()
    } catch {
      // An unreadable credential file is treated as "not signed in" rather than
      // a hard failure: the user can always sign in again.
      current = undefined
    }
    if (version !== this.readVersion) return
    const previous = this.snapshot
    if (previous?.token !== current?.token) {
      this.searches.abort()
      this.searches = new AbortController()
    }
    this.snapshot = current
  }

  /** @returns {boolean} */
  available() {
    const snapshot = this.snapshot
    return !this.disposed && !this.clearing && !!snapshot && snapshot.revoked !== true && snapshot.expiresAt > Date.now()
  }

  /**
   * @param {AbortSignal} [signal]
   * @returns {Promise<{ token: string, signal: AbortSignal }>}
   */
  async access(signal) {
    if (signal?.aborted) check(signal)
    await this.reload()
    if (!this.available() || !this.snapshot) {
      fail('login', 'Devin session missing, expired or revoked; run /devin-login.')
    }
    const combined = signal ? AbortSignal.any([this.searches.signal, signal]) : this.searches.signal
    return { token: canonical(this.snapshot.token), signal: deadline(combined, 90_000) }
  }

  /** @param {string} token */
  async revoke(token) {
    const target = canonical(token)
    await this.locked(async () => {
      const current = await this.store.readSession()
      if (!current || canonical(current.token) !== target) return
      await this.store.writeSession({ ...current, revoked: true })
    })
    await this.reload()
    this.emit('revoked')
  }

  // ---------------------------------------------------------------- login

  /**
   * Start a login attempt and resolve as soon as the provider produced an
   * authorization URL. The exchange continues in the background and is observed
   * through `loginState()` / `subscribe()`.
   *
   * @param {LoginMode} mode
   * @returns {Promise<{ attemptId: string, mode: LoginMode, url: string, alreadyPending?: boolean }>}
   */
  async beginLogin(mode = 'code') {
    if (this.disposed || this.clearing) fail('cancelled', 'Devin sign-in is unavailable during sign-out or unload.')
    await this.reload()
    if (this.available() && this.snapshot) {
      const until = new Date(this.snapshot.expiresAt).toISOString()
      fail('login', `Already signed in until ${until}. Sign out first to use a different account.`)
    }
    if (this.attempt && PENDING.has(this.attempt.phase)) {
      return { attemptId: this.attempt.attemptId, mode: this.attempt.mode, url: this.attempt.url || '', alreadyPending: true }
    }

    const attempt = {
      attemptId: randomBytes(24).toString('base64url'),
      mode: mode === 'loopback' ? 'loopback' : 'code',
      phase: /** @type {LoginPhase} */ ('pending'),
      url: '',
      detail: undefined,
      acceptCode: undefined,
    }
    this.attempt = attempt
    this.epoch += 1
    const epoch = this.epoch

    /** @type {(value: string) => void} */
    let settleUrl = () => {}
    const urlReady = new Promise((resolve) => {
      settleUrl = resolve
    })
    const notify = (url) => {
      if (!url || typeof url !== 'string') return
      attempt.url = url
      settleUrl(url)
      this.last = 'Sign-in pending.'
      this.emit('login')
    }
    // The core hands the prompt the flow's life signal as its only argument.
    // Settle on abort so a cancelled sign-in never leaves an unresolved promise
    // behind (Node's test runner cancels a whole suite over one of those).
    const promptCode = (life) => new Promise((resolve, reject) => {
      attempt.acceptCode = resolve
      if (!life || typeof life.addEventListener !== 'function') return
      const onAbort = () => {
        if (attempt.acceptCode !== resolve) return
        attempt.acceptCode = undefined
        reject(new Error('Devin sign-in cancelled.'))
      }
      if (life.aborted) onAbort()
      else life.addEventListener('abort', onAbort, { once: true })
    })

    const background = this.runAttempt(attempt, epoch, notify, promptCode)
    this.background = background
    // Observe settlement without creating an unhandled rejection.
    void background.then(() => {}, () => {}).finally(() => {
      if (this.background === background) this.background = undefined
    })

    // Resolve as soon as the provider produced the URL, but stop waiting if the
    // attempt already ended (port in use, provider refused, cancelled) or the
    // provider stays silent. The caller gets a readable DevinError either way.
    const raced = await Promise.race([
      urlReady.then((url) => ({ url })),
      background.then(
        () => ({ failed: 'Devin sign-in ended before an authorization URL was ready.' }),
        (error) => ({ failed: safeError(error) }),
      ),
      new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ failed: 'Devin sign-in did not produce an authorization URL in time. Try again.' }), URL_TIMEOUT_MS)
        if (typeof timer.unref === 'function') timer.unref()
      }),
    ])
    if (!raced || 'failed' in raced) fail('network', raced?.failed || 'Devin sign-in failed to start.')
    return { attemptId: attempt.attemptId, mode: attempt.mode, url: raced.url }
  }

  /**
   * @param {object} attempt
   * @param {number} epoch
   * @param {(url: string) => void} notify
   * @param {() => Promise<string>} promptCode
   */
  runAttempt(attempt, epoch, notify, promptCode) {
    const controller = new AbortController()
    this.controller = controller
    const signal = controller.signal
    return (async () => {
      try {
        const token = attempt.mode === 'code'
          ? await oauthCode(signal, notify, promptCode, this.options.oauth || {})
          : await oauth(signal, notify, this.options.oauth || {})
        check(signal)
        if (epoch !== this.epoch || this.clearing || this.disposed) {
          fail('cancelled', 'Devin sign-in was withdrawn.')
        }
        const sessionToken = canonical(token)
        await this.locked(async () => {
          if (epoch !== this.epoch || this.clearing || this.disposed) fail('cancelled', 'Devin sign-in was withdrawn.')
          await this.store.writeSession({ version: 1, token: sessionToken, ...expiry(sessionToken) })
        })
        await this.reload()
        attempt.phase = epoch === this.epoch ? 'authorized' : 'cancelled'
        if (epoch === this.epoch) this.last = 'Signed in.'
      } catch (error) {
        attempt.phase = signal.aborted ? 'cancelled' : 'error'
        attempt.detail = safeError(error)
        if (epoch === this.epoch) this.last = attempt.detail
        throw error
      } finally {
        attempt.acceptCode = undefined
        if (this.controller === controller) this.controller = undefined
        this.emit('login')
      }
    })()
  }

  /** @param {string} attemptId @returns {object|undefined} */
  loginState(attemptId) {
    const attempt = this.attempt
    if (!attempt) return undefined
    if (attemptId && attempt.attemptId !== attemptId) return undefined
    return {
      attemptId: attempt.attemptId,
      mode: attempt.mode,
      phase: attempt.phase,
      pending: PENDING.has(attempt.phase),
      ...(attempt.url ? { url: attempt.url } : {}),
      ...(attempt.detail ? { detail: attempt.detail } : {}),
    }
  }

  /**
   * Resolve the pending prompt with the pasted one-time code. The code never
   * leaves this call: it is not stored, echoed, or logged.
   *
   * @param {string} attemptId
   * @param {unknown} value
   * @returns {Promise<{ attemptId: string, phase: LoginPhase }>}
   */
  async submitCode(attemptId, value) {
    const attempt = this.attempt
    if (!attempt || !ATTEMPT_ID.test(String(attemptId || '')) || attempt.attemptId !== attemptId) {
      fail('login', 'This sign-in attempt is no longer active. Run /devin-login again.')
    }
    if (attempt.mode !== 'code' || attempt.phase !== 'pending' || typeof attempt.acceptCode !== 'function') {
      fail('login', 'This sign-in attempt is not waiting for an authorization code.')
    }
    const code = validateCode(value)
    const accept = attempt.acceptCode
    attempt.acceptCode = undefined
    attempt.phase = 'exchanging'
    accept(code)
    this.emit('login')
    try {
      await this.background
    } catch {
      // The failure is already projected into attempt.phase/detail.
    }
    return { attemptId: attempt.attemptId, phase: attempt.phase }
  }

  cancel() {
    this.epoch += 1
    const attempt = this.attempt
    if (attempt && PENDING.has(attempt.phase)) {
      attempt.phase = 'cancelled'
      attempt.acceptCode = undefined
    }
    this.controller?.abort()
    this.last = 'Sign-in cancelled.'
    this.emit('login')
  }

  async logout() {
    this.clearing = true
    this.cancel()
    this.invalidate()
    try {
      await this.locked(() => this.store.clearSession())
      this.last = 'Signed out; the stored Devin session was cleared.'
    } finally {
      this.clearing = false
      await this.reload()
      this.emit('logout')
    }
  }

  // ------------------------------------------------------- native flow seam

  /**
   * Run one host-provided authorization attempt (the optional native sign-in
   * UI). The session object is structural: `{ signal, method, notify, prompt,
   * commit }`; nothing here imports the authorization package.
   *
   * @param {{ signal: AbortSignal, method?: string, notify?: (notice: { message?: string, url?: string }) => void, prompt?: (question: object) => Promise<string>, commit?: (grant: object) => Promise<void>, [key: string]: unknown }} flow
   */
  async run(flow) {
    if (!flow || typeof flow !== 'object' || !flow.signal) fail('bounds', 'Invalid authorization attempt.')
    const running = this.runFlow(flow)
    this.runs.add(running)
    void running.finally(() => this.runs.delete(running)).catch(() => {})
    return running
  }

  /** @param {object} flow */
  async runFlow(flow) {
    const mode = flow.method === 'code' ? 'code' : 'loopback'
    const epoch = this.epoch
    const controller = new AbortController()
    this.controller = controller
    const signal = AbortSignal.any([flow.signal, controller.signal])
    const attempt = {
      attemptId: randomBytes(24).toString('base64url'),
      mode: /** @type {LoginMode} */ (mode),
      phase: /** @type {LoginPhase} */ ('pending'),
      url: '',
      detail: undefined,
      acceptCode: undefined,
    }
    this.attempt = attempt

    /** @param {string} url */
    const notify = (url) => {
      if (!url) return
      attempt.url = url
      try {
        if (typeof flow.notify === 'function') {
          flow.notify({
            message: mode === 'code'
              ? 'Open Devin in your browser, then paste the one-time authorization code into DSH.'
              : 'Continue Devin sign-in in your browser.',
            url,
          })
        }
      } catch {
        // A host that rejects the notice must not break the attempt.
      }
      this.emit('login')
    }
    // Same abort settlement as the command flow: never leave the prompt pending.
    const promptCode = (life) => new Promise((resolve, reject) => {
      attempt.acceptCode = resolve
      const watch = life && typeof life.addEventListener === 'function' ? life : signal
      const onAbort = () => {
        if (attempt.acceptCode !== resolve) return
        attempt.acceptCode = undefined
        reject(new Error('Devin sign-in cancelled.'))
      }
      if (watch.aborted) onAbort()
      else watch.addEventListener('abort', onAbort, { once: true })
    })

    try {
      const token = mode === 'code'
        ? await oauthCode(signal, notify, async (life) => {
          // Prefer the host's secure prompt (native UI); fall back to our own.
          if (typeof flow.prompt === 'function') {
            const answer = await flow.prompt({
              kind: 'secret',
              message: 'Paste the one-time Devin authorization code (not a session token).',
              signal: life,
            })
            return answer
          }
          return promptCode()
        }, this.options.oauth || {})
        : await oauth(signal, notify, this.options.oauth || {})
      check(signal)
      const sessionToken = canonical(token)
      const grant = { version: 1, token: sessionToken, ...expiry(sessionToken) }
      if (epoch !== this.epoch || this.disposed) fail('cancelled', 'Devin sign-in was withdrawn.')
      if (typeof flow.commit === 'function') {
        await flow.commit({ kind: 'grant', payload: grant })
      } else {
        await this.store.writeSession(grant)
      }
      await this.reload()
      attempt.phase = 'authorized'
      this.last = 'Signed in.'
    } catch (error) {
      attempt.phase = signal.aborted ? 'cancelled' : 'error'
      attempt.detail = safeError(error)
      if (epoch === this.epoch) this.last = attempt.detail
      throw error
    } finally {
      attempt.acceptCode = undefined
      if (this.controller === controller) this.controller = undefined
      this.emit('login')
    }
  }

  // ---------------------------------------------------------------- status

  /**
   * Credential-free one-line status derived from the live snapshot, never from a
   * remembered string: a store that already held a grant at activation must not
   * report "Not signed in." just because no login ran in this process.
   *
   * @returns {string}
   */
  summary() {
    const attempt = this.attempt
    if (attempt && PENDING.has(attempt.phase)) return `Sign-in pending (${attempt.mode}).`
    const snapshot = this.snapshot
    if (!snapshot) return this.last
    if (snapshot.revoked === true) return 'Session rejected by the provider; sign in again.'
    const when = new Date(snapshot.expiresAt).toISOString()
    return this.available()
      ? `Signed in. Expires ${when} (${snapshot.expirySource}; no automatic refresh).`
      : `Session expired; sign in again. Expired at ${when}.`
  }

  /** @returns {object} a safe, credential-free projection for the UI */
  getStatus() {
    const snapshot = this.snapshot
    const attempt = this.attempt
    const login = attempt
      ? {
        attemptId: attempt.attemptId,
        mode: attempt.mode,
        phase: attempt.phase,
        pending: PENDING.has(attempt.phase),
        ...(attempt.url ? { url: attempt.url } : {}),
        ...(attempt.detail ? { detail: attempt.detail } : {}),
      }
      : { phase: 'idle', pending: false }
    return {
      signedIn: this.available(),
      ...(snapshot ? {
        expiresAt: snapshot.expiresAt,
        expirySource: snapshot.expirySource,
        ...(snapshot.revoked === true ? { revoked: true } : {}),
      } : {}),
      message: this.summary(),
      login,
    }
  }

  /** @returns {string} one-line human status for slash commands */
  async statusText() {
    await this.reload()
    const attempt = this.attempt
    if (attempt && PENDING.has(attempt.phase)) {
      const url = attempt.url ? `\nOpen this URL: ${attempt.url}` : ''
      const code = attempt.mode === 'code' ? '\nThen submit the one-time code in the sign-in card or with /devin-login (never paste it into chat).' : ''
      return `Sign-in pending (${attempt.mode}).${url}${code}`
    }
    return this.summary()
  }

  async dispose() {
    this.disposed = true
    this.controller?.abort()
    this.invalidate()
    await Promise.allSettled([...this.runs, ...(this.background ? [this.background] : [])])
    this.listeners.clear()
  }
}
