/**
 * Slash commands: `/devin-login`, `/devin-status`, `/devin-logout`,
 * `/devin-cancel`, `/devin-settings`.
 *
 * Commands are the plugin's floor: even when the web client half cannot load
 * (new DSH release, broken slot, unauthenticated page), the host still serves
 * these, so the user can always sign in and flip the switches.
 */

import { lookup } from './adapter-api.js'

/**
 * Register one command on whatever command service exists.
 *
 * @param {object} ctx
 * @param {{ name: string, description: string, run: (invocation: any) => Promise<string> }} definition
 * @param {{ warn: (message: string) => void }} log
 * @returns {(() => void) | undefined}
 */
function registerOne(ctx, definition, log) {
  return withService(ctx, 'commands', log, (commands) => {
    const register = commands && commands.register
    if (typeof register !== 'function') throw new Error('commands.register is not a function')
    const dispose = register.call(commands, {
      name: definition.name,
      description: definition.description,
      // Arguments are not conversation content; keep them out of the log.
      recordInput: false,
      handler: async (invocation) => {
        try {
          const text = await definition.run(invocation || {})
          return { kind: 'success', text: typeof text === 'string' ? text : 'Done.' }
        } catch (error) {
          return { kind: 'error', text: messageOf(error) }
        }
      },
    })
    return () => {
      if (typeof dispose === 'function') dispose()
    }
  })
}

/** @param {unknown} error */
function messageOf(error) {
  if (error && typeof error === 'object' && typeof (/** @type {any} */ (error).message) === 'string') {
    return /** @type {any} */ (error).message
  }
  return 'Devin command failed.'
}

/**
 * Resolve a service lazily: `ctx.inject` when it exists (so a service that
 * loads later still gets our registration), otherwise a plain lookup.
 *
 * @param {object} ctx
 * @param {string} name
 * @param {{ warn: (message: string) => void }} log
 * @param {(service: any) => (() => void) | undefined} use
 * @returns {(() => void) | undefined} disposer if registered synchronously
 */
export function withService(ctx, name, log, use) {
  const disposers = []
  const run = (scope) => {
    const service = lookup(scope, name)
    if (!service) return
    try {
      const dispose = use(service)
      if (typeof dispose === 'function') disposers.push(dispose)
    } catch (error) {
      log.warn(`${name}: ${messageOf(error)}`)
    }
  }
  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject([name], (scope) => {
        run(scope)
        return () => {
          for (const dispose of disposers.splice(0)) {
            try {
              dispose()
            } catch {
              // Already gone.
            }
          }
        }
      })
      return undefined
    } catch {
      // Fall through to a direct lookup.
    }
  }
  run(ctx)
  return () => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose()
      } catch {
        // Already gone.
      }
    }
  }
}

/** Parse `/devin-login local` and `/devin-login` (the default code flow). */
function parseLoginMode(raw) {
  const value = String(raw || '').trim().toLowerCase()
  if (!value) return 'code'
  if (value === 'local' || value === 'loopback') return 'loopback'
  throw new Error('Use /devin-login or /devin-login local. Never paste an authorization code into chat.')
}

/** Parse `/devin-settings`, `/devin-settings web on`, `/devin-settings code off`. */
function parseSettings(raw) {
  const parts = String(raw || '').trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return undefined
  const kind = parts[0]
  const value = parts[1]
  if (!['web', 'code', 'websearch', 'codesearch'].includes(kind) || !['on', 'off'].includes(value)) {
    throw new Error('Use /devin-settings, /devin-settings web on|off, or /devin-settings code on|off.')
  }
  return kind.startsWith('web') ? { webSearch: value === 'on' } : { codeSearch: value === 'on' }
}

/**
 * @param {{ ctx: object, sessions: object, settings: object, log: { warn: Function, info?: Function } }} input
 * @returns {Array<() => void>} disposers
 */
export function mountCommands(input) {
  const { ctx, sessions, settings, log } = input
  const disposers = []

  const push = (definition) => {
    const dispose = registerOne(ctx, definition, log)
    if (typeof dispose === 'function') disposers.push(dispose)
  }

  push({
    name: 'devin-login',
    description: 'Start Devin sign-in; add "local" for a same-machine browser callback.',
    async run(invocation) {
      const mode = parseLoginMode(invocation.rawInput)
      const started = await sessions.beginLogin(mode)
      // Signing in while already signed in is a normal request, not a failure:
      // say so as a successful result instead of an error row.
      if (started.status === 'already-signed-in') return started.message
      if (started.status === 'pending') {
        const url = started.url ? `\nOpen this URL: ${started.url}` : ''
        return `Sign-in already pending.\nLogin attempt: ${started.attemptId}${url}`
      }
      const hint = mode === 'loopback'
        ? 'Finish the browser sign-in; this machine receives the callback automatically.'
        : 'Open the URL, then paste the one-time authorization code into the Devin sign-in card in the chat (never into chat text).'
      return `Sign-in started.\nLogin attempt: ${started.attemptId}\nMode: ${started.mode}\nOpen this URL: ${started.url}\n${hint}`
    },
  })

  push({
    name: 'devin-status',
    description: 'Show Devin sign-in state without exposing credentials.',
    run: () => sessions.statusText(),
  })

  push({
    name: 'devin-logout',
    description: 'Cancel any pending sign-in and delete the stored Devin session.',
    async run() {
      await sessions.logout()
      return 'Signed out; the stored Devin session was cleared.'
    },
  })

  push({
    name: 'devin-cancel',
    description: 'Cancel the pending Devin sign-in attempt.',
    run() {
      const state = sessions.loginState()
      const pending = !!state && (state.phase === 'pending' || state.phase === 'exchanging')
      sessions.cancel()
      return pending ? 'Sign-in cancelled.' : 'No sign-in is pending.'
    },
  })

  push({
    name: 'devin-settings',
    description: 'Show or change the web_search and code_search switches.',
    async run(invocation) {
      const patch = parseSettings(invocation.rawInput)
      if (patch) await settings.patch(patch)
      const state = settings.get()
      return [
        `web_search: ${state.webSearch ? 'on' : 'off'}`,
        `code_search: ${state.codeSearch ? 'on' : 'off'}`,
        'Change with: /devin-settings web on|off, /devin-settings code on|off',
      ].join('\n')
    },
  })

  return () => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose()
      } catch {
        // Already gone.
      }
    }
  }
}
