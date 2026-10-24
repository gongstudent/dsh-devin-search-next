/**
 * Devin as the `web_search` provider.
 *
 * The provider object is structural — `{ id, available, search }` — because the
 * harness resolves providers by duck typing at call time. Nothing here imports
 * the harness: a renamed or restructured web service costs us the registration,
 * not the plugin.
 */

import { boundedBody, check, deadline, DevinError, fail, json, object, redact, request } from './core/safety.js'
import { lookup } from './adapter-api.js'

export const PROVIDER_ID = 'devin'
export const WEB_PATH = '/exa.api_server_pb.ApiServerService/GetWebSearchResults'
export const DEFAULT_HOSTS = ['https://server.codeium.com', 'https://server.self-serve.windsurf.com']

/**
 * Build the provider. `sessions` only needs `{ available, access, revoke }`.
 *
 * `available()` intentionally reports the **switch**, not the sign-in state. The
 * web seam treats a configured-but-unavailable provider as a hard
 * `WEB_PROVIDER_CONFIGURED_UNAVAILABLE` error, which tells the model nothing
 * actionable; staying "available" and failing at call time lets us return the
 * real instruction ("run /devin-login") instead.
 *
 * @param {{ sessions: { available(): boolean, access(signal?: AbortSignal): Promise<{ token: string, signal: AbortSignal }>, revoke(token: string): Promise<void> }, isEnabled?: () => boolean }} input
 * @param {{ hosts?: readonly string[], fetcher?: typeof fetch, timeoutMs?: number }} [options]
 */
export function createSearchProvider(input, options = {}) {
  const sessions = input.sessions
  const isEnabled = typeof input.isEnabled === 'function' ? input.isEnabled : () => true
  return {
    id: PROVIDER_ID,
    available() {
      try {
        return isEnabled() !== false
      } catch {
        return false
      }
    },
    async search(request_, caller) {
      let enabled = true
      try {
        enabled = isEnabled() !== false
      } catch {
        enabled = false
      }
      if (!enabled) return fail('login', 'web_search is disabled in the Devin search settings (/devin-settings web on).')
      const query = request_ && typeof request_.query === 'string' ? request_.query : ''
      if (!query.trim() || query.length > 8192) return fail('bounds', 'Devin search query is empty or too long.')
      const rawLimit = request_ && typeof request_.maxResults === 'number' ? request_.maxResults : 5
      const limit = Math.min(10, Math.max(1, Math.trunc(Number.isFinite(rawLimit) ? rawLimit : 5)))
      const access = await sessions.access(caller)
      const signal = deadline(access.signal, options.timeoutMs ?? 20_000)
      let authRejected = 0
      let hostsTried = 0
      for (const host of options.hosts ?? DEFAULT_HOSTS) {
        try {
          hostsTried += 1
          const response = await request(`${host}${WEB_PATH}`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'connect-protocol-version': '1',
              accept: 'application/json',
              'user-agent': 'windsurf/1.9600.41',
            },
            body: JSON.stringify({
              metadata: {
                apiKey: access.token,
                ideName: 'windsurf',
                ideVersion: '1.9600.41',
                extensionName: 'windsurf',
                extensionVersion: '1.9600.41',
                locale: 'en',
              },
              query: query.trim(),
              limit,
            }),
          }, signal, options.fetcher)
          if (response.status === 401 || response.status === 403) {
            await response.body?.cancel()
            authRejected += 1
            continue
          }
          if (!response.ok) {
            await response.body?.cancel()
            continue
          }
          const payload = object(json(await boundedBody(response, signal, 1024 * 1024)))
          if (!Array.isArray(payload?.results)) return fail('protocol', 'Invalid Devin web search response.')
          const sources = []
          let valid = 0
          const first = (row, keys, cap) => {
            for (const key of keys) {
              const value = row[key]
              if (typeof value === 'string' && value.trim()) return redact(value.trim().slice(0, cap), [access.token])
            }
            return ''
          }
          for (const raw of payload.results) {
            const row = object(raw)
            if (!row) continue
            const url = first(row, ['url', 'sourceUrl', 'webUrl', 'link'], 4096)
            try {
              const parsed = new URL(url)
              if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) continue
            } catch {
              continue
            }
            valid += 1
            if (sources.length < limit) {
              sources.push({
                url,
                title: first(row, ['title', 'name', 'webTitle'], 512),
                snippet: first(row, ['snippet', 'summary', 'text', 'content'], 4096),
              })
            }
          }
          check(signal)
          return { sources, truncated: valid > limit }
        } catch (error) {
          if (error instanceof DevinError && error.code === 'login') throw error
          check(signal)
          if (error instanceof DevinError && error.code !== 'network') throw error
        }
      }
      // Revoke only when every tried host refused auth, never after one blip.
      if (hostsTried > 0 && authRejected === hostsTried) {
        await sessions.revoke(access.token)
        return fail('login', 'Devin rejected the stored session; run /devin-login.')
      }
      return fail('network', 'Devin web search failed on every host.')
    },
  }
}

/**
 * Mount the provider when the web service appears. Returns a disposer bundle so
 * the caller can keep the registry in sync with the on/off switch.
 *
 * @param {{ ctx: object, sessions: object, settings?: { isEnabled(key: string): boolean }, log: { warn: Function }, options?: object }} input
 */
export function mountWebProvider(input) {
  const { ctx, sessions, log } = input
  const disposeFns = []
  const provider = createSearchProvider({
    sessions,
    isEnabled: input.settings ? () => input.settings.isEnabled('webSearch') : undefined,
  }, input.options)

  const attach = (scope) => {
    const web = lookup(scope, 'web')
    const register = web && web.registerSearchProvider
    if (typeof register !== 'function') {
      log.warn('the web service has no registerSearchProvider(); web_search stays on the built-in provider.')
      return
    }
    try {
      const dispose = register.call(web, provider)
      if (typeof dispose === 'function') disposeFns.push(() => void dispose())
    } catch (error) {
      // A duplicate id here means another Devin plugin is already registered.
      log.warn(`could not register the Devin web search provider: ${error && error.message ? error.message : error}`)
    }
  }

  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['web'], (scope) => attach(scope))
    } catch {
      attach(ctx)
    }
  } else {
    attach(ctx)
  }

  return {
    provider,
    dispose() {
      for (const dispose of disposeFns.splice(0)) {
        try {
          dispose()
        } catch {
          // Already disposed with its fiber.
        }
      }
    },
  }
}
