/**
 * dsh-devin-search-next — Host entry.
 *
 * Design rules (these are the reason this plugin survives harness upgrades):
 *
 * 1. **No harness runtime imports.** Only Node built-ins and this package's own
 *    modules. The plugin never locks a `peerDependencies` range, so the bundle
 *    compatibility gate cannot silently drop the whole patch layer.
 * 2. **No exported `Config`.** The harness requires a real Schemastery instance
 *    for that, which would be a runtime dependency; the two switches live in the
 *    plugin's own settings file instead.
 * 3. **Every capability is mounted separately and defensively.** A missing or
 *    renamed service costs that one capability, never the plugin.
 * 4. **Registrations are effects owned by this context**, so unload removes them.
 */

import { createStore } from './store.js'
import { createSettings } from './settings.js'
import { importLegacySession } from './legacy-import.js'
import { DevinSessions } from './session.js'
import { WindsurfCompletion } from './core/completion.js'
import { mountCommands } from './adapter-commands.js'
import { mountWebProvider } from './adapter-web.js'
import { mountCodeSearch } from './adapter-tools.js'
import { registerHostApi } from './adapter-api.js'

export const name = 'devin-search-next'

/** @param {unknown} error */
function messageOf(error) {
  if (error && typeof error === 'object' && typeof (/** @type {any} */ (error).message) === 'string') {
    return /** @type {any} */ (error).message
  }
  return String(error)
}

/** @param {boolean} verbose */
function createLogger(verbose) {
  return {
    warn(message) {
      try {
        console.warn(`[devin-search] ${message}`)
      } catch {
        // A closed stdio must not break the plugin.
      }
    },
    info(message) {
      if (!verbose) return
      try {
        console.log(`[devin-search] ${message}`)
      } catch {
        // A closed stdio must not break the plugin.
      }
    },
  }
}

/**
 * Plugin body.
 *
 * @param {any} ctx cordis context
 * @param {unknown} config the row's patch config; may be undefined
 */
export async function apply(ctx, config) {
  const log = createLogger(process.env.DSH_DEVIN_DEBUG === '1')
  /** @type {Array<() => void>} */
  const cleanups = []

  /** Run one mounting step; a failure is logged and never fatal. */
  const step = (label, fn) => {
    try {
      const cleanup = fn()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
    } catch (error) {
      log.warn(`${label} is unavailable: ${messageOf(error)}`)
    }
  }

  // ---- durable state -----------------------------------------------------
  const store = createStore()
  // Existing users of the old plugin keep their Devin session: import it once.
  try {
    const imported = await importLegacySession({ store })
    if (imported === 'imported') log.info('imported the existing Devin session from the harness credential file')
  } catch {
    // Migration is best effort; signing in again always works.
  }
  const settings = await createSettings({ store, config })
  const sessions = new DevinSessions({ store })
  await sessions.reload()

  // The private completion client is shared by code_search so its JWT cache and
  // invalidation follow the same credential lifecycle as the session.
  const completion = new WindsurfCompletion(sessions)
  cleanups.push(() => {
    try {
      completion.invalidate()
    } catch {
      // Best effort.
    }
  })
  // A new grant invalidates the cached search JWT inside the completion client.
  const unsubscribeSession = sessions.subscribe((_status, reason) => {
    if (reason === 'login' || reason === 'logout' || reason === 'revoked') {
      try {
        completion.invalidate()
      } catch {
        // Best effort.
      }
    }
  })
  cleanups.push(() => {
    try {
      unsubscribeSession()
    } catch {
      // Already released.
    }
  })

  // ---- slash commands ----------------------------------------------------
  step('commands', () => mountCommands({ ctx, sessions, settings, log }))

  // ---- web_search provider ----------------------------------------------
  step('the web search provider', () => {
    const mounted = mountWebProvider({ ctx, sessions, settings, log })
    return () => mounted.dispose()
  })

  // ---- code_search tool + web_search guard -------------------------------
  step('the code search tool', () => {
    const mounted = mountCodeSearch({ ctx, sessions, settings, log, completion })
    return () => mounted.dispose()
  })

  // ---- browser API for the plugin UI -------------------------------------
  step('the browser API', () => {
    registerHostApi({ ctx, api: { sessions, settings }, log })
    return undefined
  })

  // ---- teardown ----------------------------------------------------------
  try {
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => () => {
        for (const cleanup of cleanups.splice(0)) {
          try {
            cleanup()
          } catch {
            // Already released.
          }
        }
        void sessions.dispose()
      })
    }
  } catch {
    // A context without effect support still disposes registrations by fiber.
  }

  log.info(`ready; switches web_search=${settings.isEnabled('webSearch') ? 'on' : 'off'} code_search=${settings.isEnabled('codeSearch') ? 'on' : 'off'}`)
}
