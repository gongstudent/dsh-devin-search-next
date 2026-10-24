/**
 * The browser-facing JSON API for this plugin.
 *
 * There is no public "register a plugin RPC" service in the harness, so the UI
 * talks to the Host over plain HTTP routes mounted on the authenticated browser
 * connection: `ctx.connection.fetch.register({ path, methods, requestBody,
 * fetch })`. Paths must live under `/api`, methods must be GET/HEAD/POST, and
 * the handler is Web-Fetch (`Request` in, `Response` out).
 *
 * The connection service is part of the web GUI itself, so if it is missing
 * this plugin simply has no live cards: commands and tools keep working. Every
 * registration is a soft, warning-only attempt; nothing here may throw out of
 * `apply`.
 */

const MAX_BODY = 16 * 1024

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
}

/** @param {unknown} value @param {number} [status] */
function reply(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: JSON_HEADERS })
}

/** @param {unknown} value @param {number} [status] */
function failure(value, status = 400) {
  const message = value && typeof (/** @type {any} */ (value).message) === 'string'
    ? /** @type {any} */ (value).message
    : String(value || 'Request failed.')
  return reply({ ok: false, error: message.slice(0, 512) }, status)
}

/** Read a bounded JSON object body; anything else is a client error. */
async function readBody(request) {
  const type = (request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
  if (type && type !== 'application/json') throw new Error('Expected application/json.')
  const text = await new Response(request.body).text()
  if (text.length > MAX_BODY) throw new Error('Request body too large.')
  if (!text.trim()) return {}
  let value
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error('Invalid JSON body.')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object.')
  return value
}

/** Wrap one route handler: no throw escapes, every response is JSON. */
function wrap(route) {
  return async (request) => {
    try {
      const method = String(request.method || 'GET').toUpperCase()
      if (!route.methods.includes(method)) return failure('Method not allowed.', 405)
      const url = new URL(request.url, 'http://127.0.0.1')
      const body = method === 'POST' ? await readBody(request) : {}
      const result = await route.handler({ method, url, body, request })
      if (result instanceof Response) return result
      return reply({ ok: true, ...(result && typeof result === 'object' ? result : {}) })
    } catch (error) {
      return failure(error)
    }
  }
}

/** Read a service without letting a missing registry throw. */
export function lookup(ctx, name) {
  try {
    if (ctx && typeof ctx.get === 'function') return ctx.get(name)
  } catch {
    // Service resolution failed; try the property form below.
  }
  try {
    return ctx ? ctx[name] : undefined
  } catch {
    return undefined
  }
}

/**
 * Every endpoint the web client calls. The transport wrapper never changes this
 * table, so the client contract and the Host behaviour stay in one place.
 *
 * @param {{ sessions: any, settings: any }} api
 */
export function createRoutes(api) {
  const state = async () => {
    // Read the store before projecting: a credential file changed outside this
    // process (another harness window, a manual migration) must not be reported
    // from the in-memory snapshot alone.
    try {
      await api.sessions.reload()
    } catch {
      // An unreadable store projects as "not signed in" through the snapshot.
    }
    const status = api.sessions.getStatus()
    return {
      signedIn: status.signedIn,
      login: status.login,
      message: status.message,
      ...(status.expiresAt ? { expiresAt: status.expiresAt } : {}),
      ...(status.expirySource ? { expirySource: status.expirySource } : {}),
      ...(status.revoked ? { revoked: true } : {}),
      settings: api.settings.get(),
    }
  }

  return [
    {
      path: '/api/devin/state',
      methods: ['GET'],
      handler: state,
    },
    {
      path: '/api/devin/login',
      methods: ['GET', 'POST'],
      async handler({ method, url, body }) {
        if (method === 'GET') {
          const attemptId = url.searchParams.get('attemptId') || ''
          const attempt = api.sessions.loginState(attemptId)
          if (!attempt) return { attemptId, phase: 'idle', pending: false }
          return {
            attemptId: attempt.attemptId,
            phase: attempt.phase,
            pending: attempt.pending,
            ...(attempt.detail ? { detail: attempt.detail } : {}),
          }
        }
        // The web client's "same-machine browser callback" choice maps to
        // 'local'; everything else uses the paste-the-code flow.
        const mode = body.mode === 'local' || body.mode === 'loopback' ? 'loopback' : 'code'
        const started = await api.sessions.beginLogin(mode)
        // `already-signed-in` is a 200 with a message, not a failed request: the
        // UI shows it as an informational note next to the existing session.
        return {
          status: started.status,
          ...(started.attemptId ? { attemptId: started.attemptId } : {}),
          ...(started.mode ? { mode: started.mode } : {}),
          ...(started.url ? { url: started.url } : {}),
          ...(started.expiresAt ? { expiresAt: started.expiresAt } : {}),
          ...(started.message ? { message: started.message } : {}),
          ...(started.alreadyPending ? { alreadyPending: true } : {}),
        }
      },
    },
    {
      path: '/api/devin/login/code',
      methods: ['POST'],
      async handler({ body }) {
        const attemptId = typeof body.attemptId === 'string' ? body.attemptId : ''
        const result = await api.sessions.submitCode(attemptId, body.code)
        return { attemptId: result.attemptId, phase: result.phase }
      },
    },
    {
      path: '/api/devin/settings',
      methods: ['GET', 'POST'],
      async handler({ method, body }) {
        if (method === 'POST') {
          const patch = {}
          if ('webSearch' in body) patch.webSearch = body.webSearch
          if ('codeSearch' in body) patch.codeSearch = body.codeSearch
          await api.settings.patch(patch)
        }
        return { settings: api.settings.get() }
      },
    },
    {
      path: '/api/devin/logout',
      methods: ['POST'],
      async handler() {
        await api.sessions.logout()
        return { signedIn: false, settings: api.settings.get() }
      },
    },
    {
      path: '/api/devin/cancel',
      methods: ['POST'],
      async handler() {
        api.sessions.cancel()
        return { cancelled: true }
      },
    },
  ]
}

/**
 * Mount the API on the authenticated connection carrier, once it exists.
 *
 * @param {{ ctx: any, api: { sessions: any, settings: any }, log: { warn: Function, info?: Function } }} input
 */
export function registerHostApi({ ctx, api, log }) {
  const routes = createRoutes(api)

  const mount = (scope) => {
    const connection = lookup(scope, 'connection')
    const register = connection && connection.fetch && connection.fetch.register
    if (typeof register !== 'function') {
      log.warn('the browser connection service is unavailable; the Devin cards will be static.')
      return
    }
    for (const route of routes) {
      const handle = wrap(route)
      const guarded = (request) => {
        try {
          const rejection = typeof connection.requestRejection === 'function'
            ? connection.requestRejection(request)
            : undefined
          if (rejection) return reply({ ok: false, error: 'Harness authentication required.' }, rejection)
        } catch {
          // A missing or changed fence must not lock the user out of their own UI.
        }
        return handle(request)
      }
      try {
        // Registration is fiber-scoped by the connection service itself, so the
        // returned disposer needs no extra bookkeeping here.
        register.call(connection.fetch, {
          path: route.path,
          methods: route.methods,
          // 'buffered' is required: the carrier builds the Fetch request from a
          // live stream for 'streaming' routes, and a GET with a body throws
          // before the handler ever runs. Our JSON bodies are tiny anyway.
          requestBody: 'buffered',
          fetch: guarded,
        })
      } catch (error) {
        log.warn(`${route.path}: ${error && error.message ? error.message : error}`)
      }
    }
    if (typeof log.info === 'function') log.info(`mounted ${routes.length} Devin browser routes`)
  }

  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['connection'], (scope) => mount(scope))
      return
    } catch {
      // A context without ctx.inject: fall through to a plain mount.
    }
  }
  mount(ctx)
}
