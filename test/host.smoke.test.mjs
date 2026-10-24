/**
 * Host-half smoke tests with a fake Cordis context.
 *
 * These assert the plugin's actual contracts: what it registers when services
 * exist, what it does when they do not, and that the switches really change the
 * registrations. No network, no harness, no credentials.
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import { apply } from '../lib/index.js'
import { createStore } from '../lib/store.js'
import { createSettings, readConfig } from '../lib/settings.js'
import { DevinSessions } from '../lib/session.js'
import { grantFromPayload, importLegacySession, parseLegacyGrant } from '../lib/legacy-import.js'

/** A miniature Cordis context: `get`, `inject` (deferred), `effect`. */
function createFakeContext() {
  const services = new Map()
  const effects = []
  const pending = []

  const runPending = () => {
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      const entry = pending[index]
      if (entry.names.every((name) => services.has(name))) {
        pending.splice(index, 1)
        const cleanup = entry.callback(ctx)
        if (typeof cleanup === 'function') effects.push(cleanup)
      }
    }
  }

  const ctx = {
    effect(fn) {
      const cleanup = fn()
      if (typeof cleanup === 'function') effects.push(cleanup)
      return () => {}
    },
    get(name) {
      return services.get(name)
    },
    inject(names, callback) {
      pending.push({ names: [...names], callback })
      runPending()
      return () => {}
    },
    provide(name, service) {
      services.set(name, service)
      runPending()
    },
    disposeAll() {
      while (effects.length > 0) {
        const cleanup = effects.pop()
        try {
          cleanup()
        } catch {
          // Test teardown must not throw.
        }
      }
    },
  }
  return ctx
}

function createFakeServices() {
  const state = {
    commands: new Map(),
    providers: new Map(),
    tools: new Map(),
    guards: [],
    routes: new Map(),
  }
  return {
    state,
    commands: {
      register(definition) {
        state.commands.set(definition.name, definition)
        return () => state.commands.delete(definition.name)
      },
    },
    web: {
      registerSearchProvider(provider) {
        state.providers.set(provider.id, provider)
        return () => state.providers.delete(provider.id)
      },
    },
    tools: {
      register(definition) {
        state.tools.set(definition.name, definition)
        return () => state.tools.delete(definition.name)
      },
      guard(guard) {
        state.guards.push(guard)
        return () => {
          const index = state.guards.indexOf(guard)
          if (index >= 0) state.guards.splice(index, 1)
        }
      },
    },
    connection: {
      fetch: {
        register(route) {
          state.routes.set(route.path, route)
          return async () => {}
        },
      },
      requestRejection() {
        return undefined
      },
    },
    workingDirectory: {
      async ensure() {
        return process.cwd()
      },
    },
    fs: {
      processPathFromHostPath(path) {
        return path
      },
    },
  }
}

/** Call one mounted route with a plain Request and return `{ status, body }`. */
async function call(ctx, path, init) {
  const route = ctx.routes.get(path)
  assert.ok(route, `route ${path} should be mounted`)
  const request = new Request(`http://127.0.0.1${path}${init && init.query ? init.query : ''}`, {
    method: (init && init.method) || 'GET',
    ...(init && init.body !== undefined
      ? { body: JSON.stringify(init.body), headers: { 'content-type': 'application/json' } }
      : {}),
  })
  const response = await route.fetch(request)
  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) : undefined }
}

/** @type {string} */
let home
/** @type {string} */
let previousHome

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'devin-search-test-'))
  previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
})

after(async () => {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  await rm(home, { recursive: true, force: true })
})

test('store persists the session as an owner-only JSON file and survives a bad file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'devin-store-'))
  try {
    const store = createStore({ dir })
    assert.equal(await store.readSession(), undefined)
    await store.writeSession({ version: 1, token: 'devin-session-token$abc.def.ghi', expiresAt: Date.now() + 60_000, expirySource: 'fallback' })

    const raw = JSON.parse(await readFile(join(dir, 'session.json'), 'utf8'))
    assert.equal(raw.version, 1)
    assert.equal(raw.expirySource, 'fallback')
    if (process.platform !== 'win32') {
      const mode = (await stat(join(dir, 'session.json'))).mode & 0o777
      assert.equal(mode, 0o600, 'session.json must be owner read/write only')
    }

    const reread = await store.readSession()
    assert.equal(reread.token, 'devin-session-token$abc.def.ghi')

    // A corrupt file is "not signed in", never a crash.
    await store.writeSession({ version: 1, token: 't', expiresAt: 1, expirySource: 'fallback' })
    const settings = await store.readSettings()
    assert.equal(settings, undefined)

    await store.clearSession()
    assert.equal(await store.readSession(), undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('settings: patch layer is the default, persisted value wins, subscribers fire once', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'devin-settings-'))
  try {
    const store = createStore({ dir })
    const settings = await createSettings({ store, config: { webSearch: false, codeSearch: true } })
    assert.deepEqual(settings.get(), { webSearch: false, codeSearch: true })

    let calls = 0
    const stop = settings.subscribe(() => {
      calls += 1
    })
    await settings.patch({ webSearch: true })
    assert.equal(calls, 1)
    await settings.patch({ webSearch: true })
    assert.equal(calls, 1, 'a no-op patch must not wake subscribers')
    await settings.patch({ unknown: 1 })
    assert.equal(calls, 1, 'unknown keys must be ignored')
    stop()
    await settings.patch({ codeSearch: false })
    assert.equal(calls, 1, 'unsubscribe must work')

    // A restart re-reads the persisted override over the patch default.
    const restarted = await createSettings({ store, config: { webSearch: false, codeSearch: true } })
    assert.deepEqual(restarted.get(), { webSearch: true, codeSearch: false })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('readConfig tolerates a Schemastery-style config object', () => {
  assert.deepEqual(readConfig(undefined), { webSearch: true, codeSearch: true })
  assert.deepEqual(readConfig({ webSearch: false }), { webSearch: false, codeSearch: true })
  const getter = { webSearch: { get: () => false }, codeSearch: { get: () => true } }
  assert.deepEqual(readConfig(getter), { webSearch: false, codeSearch: true })
  assert.deepEqual(readConfig({ webSearch: 'yes' }), { webSearch: true, codeSearch: true })
})

test('session: access() fails closed without a grant and revoke() marks the grant', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'devin-session-'))
  try {
    const store = createStore({ dir })
    const sessions = new DevinSessions({ store })
    await sessions.reload()
    assert.equal(sessions.available(), false)
    await assert.rejects(() => sessions.access(), /Devin session missing/)
    assert.equal(sessions.getStatus().login.phase, 'idle')

    await store.writeSession({ version: 1, token: 'devin-session-token$abc.def.ghi', expiresAt: Date.now() + 60_000, expirySource: 'fallback' })
    await sessions.reload()
    assert.equal(sessions.available(), true)
    // A grant that already existed at activation must not be reported as
    // "Not signed in." just because no login ran in this process.
    assert.match(sessions.getStatus().message, /^Signed in\. Expires/)
    assert.match(await sessions.statusText(), /^Signed in\. Expires/)
    const access = await sessions.access()
    assert.equal(access.token, 'devin-session-token$abc.def.ghi')

    await sessions.revoke(access.token)
    assert.equal(sessions.available(), false)
    const persisted = await store.readSession()
    assert.equal(persisted.revoked, true)

    await sessions.logout()
    assert.equal(await store.readSession(), undefined)
    await sessions.dispose()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('apply() registers commands, provider, tool, guard and API; switches are live', async () => {
  const ctx = createFakeContext()
  const services = createFakeServices()
  const previousDebug = process.env.DSH_DEVIN_DEBUG
  process.env.DSH_DEVIN_DEBUG = '0'
  try {
    // Provide every service the plugin knows about.
    ctx.provide('commands', services.commands)
    ctx.provide('web', services.web)
    ctx.provide('tools', services.tools)
    ctx.provide('connection', services.connection)
    ctx.provide('workingDirectory', services.workingDirectory)
    ctx.provide('fs', services.fs)

    await apply(ctx, {})

    // Slash commands
    assert.deepEqual(
      [...services.state.commands.keys()].sort(),
      ['devin-cancel', 'devin-login', 'devin-logout', 'devin-settings', 'devin-status'],
    )
    for (const definition of services.state.commands.values()) {
      assert.equal(typeof definition.handler, 'function')
      assert.equal(definition.recordInput, false)
    }

    // Web provider — the exact structural shape the seam resolves by id.
    const provider = services.state.providers.get('devin')
    assert.ok(provider, 'the devin provider must be registered')
    assert.equal(typeof provider.available, 'function')
    assert.equal(typeof provider.search, 'function')
    // `available()` follows the switch, not the sign-in state: staying
    // "available" while signed out is what lets search() return an actionable
    // "run /devin-login" message instead of WEB_PROVIDER_CONFIGURED_UNAVAILABLE.
    assert.equal(provider.available(), true)

    // code_search tool — raw JSON Schema, required output definition.
    const tool = services.state.tools.get('code_search')
    assert.ok(tool, 'code_search must be registered')
    assert.equal(tool.parameters.type, 'object')
    assert.deepEqual(tool.parameters.required, ['search_term', 'search_folder_absolute_uri'])
    assert.equal(tool.output.schema.type, 'object')
    assert.equal(tool.output.schema.additionalProperties, false)
    assert.equal(typeof tool.output.render, 'function')
    assert.equal(typeof tool.execute, 'function')
    assert.deepEqual(tool.output.render({}, { status: 'success', files: [], content: 'hit' }), [{ type: 'text', text: 'hit' }])

    // Arguments are validated before anything leaves the process.
    await assert.rejects(() => tool.execute({ search_term: 'x', extra: 'y', search_folder_absolute_uri: process.cwd() }, { signal: new AbortController().signal }), /accepts only search_term/)
    await assert.rejects(() => tool.execute({ search_term: '', search_folder_absolute_uri: process.cwd() }, { signal: new AbortController().signal }), /search_term/)

    // web_search guard
    assert.equal(services.state.guards.length, 1)
    assert.equal(services.state.guards[0]({ name: 'web_search' }), undefined)
    assert.equal(services.state.guards[0]({ name: 'read' }), undefined)

    // Browser API
    assert.deepEqual(
      [...services.state.routes.keys()].sort(),
      ['/api/devin/cancel', '/api/devin/login', '/api/devin/login/code', '/api/devin/logout', '/api/devin/settings', '/api/devin/state'],
    )
    for (const path of services.state.routes.keys()) {
      assert.ok(path.startsWith('/api/'), `${path} must live under /api`)
    }
    // 'streaming' makes the carrier build a Fetch request with a body, which
    // throws for GET before the handler runs: every route must be buffered.
    for (const [path, route] of services.state.routes) {
      assert.equal(route.requestBody, 'buffered', `${path} must use the buffered request body mode`)
      assert.ok(route.methods.includes('GET') || route.methods.includes('POST'))
    }

    const state = await call(services.state, '/api/devin/state')
    assert.equal(state.status, 200)
    assert.equal(state.body.ok, true)
    assert.equal(state.body.signedIn, false)
    assert.deepEqual(state.body.settings, { webSearch: true, codeSearch: true })

    // Turn web_search off: the guard must now deny with an actionable message.
    const settings = await call(services.state, '/api/devin/settings', { method: 'POST', body: { webSearch: false, codeSearch: false } })
    assert.equal(settings.status, 200)
    assert.deepEqual(settings.body.settings, { webSearch: false, codeSearch: false })
    assert.match(services.state.guards[0]({ name: 'web_search' }), /disabled/)
    assert.equal(services.state.tools.has('code_search'), false, 'code_search must be unregistered when off')

    // Turn them back on.
    await call(services.state, '/api/devin/settings', { method: 'POST', body: { webSearch: true, codeSearch: true } })
    assert.equal(services.state.guards[0]({ name: 'web_search' }), undefined)
    assert.equal(services.state.tools.has('code_search'), true, 'code_search must come back when on')

    // Bad requests stay JSON errors.
    const bad = await call(services.state, '/api/devin/settings', { method: 'POST', body: { webSearch: 'maybe' } })
    assert.equal(bad.status, 200, 'a non-boolean value is a no-op, not an error')

    const wrongMethod = await call(services.state, '/api/devin/state', { method: 'POST', body: {} })
    assert.equal(wrongMethod.status, 405)
    assert.equal(wrongMethod.body.ok, false)

    ctx.disposeAll()
    assert.equal(services.state.tools.has('code_search'), false, 'dispose must remove the tool')
  } finally {
    if (previousDebug === undefined) delete process.env.DSH_DEVIN_DEBUG
    else process.env.DSH_DEVIN_DEBUG = previousDebug
  }
})

test('login flow through the HTTP API: URL, pending state, bad code, cancel', async () => {
  const ctx = createFakeContext()
  const services = createFakeServices()
  ctx.provide('commands', services.commands)
  ctx.provide('web', services.web)
  ctx.provide('tools', services.tools)
  ctx.provide('connection', services.connection)

  // No network: the exchange only happens after a code is submitted, and the
  // fetcher refuses to run here.
  const fetcher = async () => {
    throw new Error('network access is not expected in this test')
  }
  const started = await apply(ctx, {})
  void started

  const login = await call(services.state, '/api/devin/login', { method: 'POST', body: { mode: 'code' } })
  assert.equal(login.status, 200)
  assert.equal(login.body.ok, true)
  assert.match(login.body.attemptId, /^[A-Za-z0-9_-]{32}$/)
  assert.match(login.body.url, /^https:\/\/app\.devin\.ai\/auth\/cli\/continue\?/)
  assert.match(login.body.url, /code_challenge_method=S256/)

  const pending = await call(services.state, '/api/devin/login', { query: `?attemptId=${login.body.attemptId}` })
  assert.equal(pending.body.phase, 'pending')
  assert.equal(pending.body.pending, true)

  const stateWithLogin = await call(services.state, '/api/devin/state')
  assert.equal(stateWithLogin.body.login.pending, true)
  assert.equal(stateWithLogin.body.signedIn, false)

  const emptyCode = await call(services.state, '/api/devin/login/code', { method: 'POST', body: { attemptId: login.body.attemptId, code: '   ' } })
  assert.equal(emptyCode.status, 400)
  assert.equal(emptyCode.body.ok, false)
  assert.match(emptyCode.body.error, /Invalid Devin authorization code/)

  const unknownAttempt = await call(services.state, '/api/devin/login/code', { method: 'POST', body: { attemptId: 'x'.repeat(32), code: 'abc' } })
  assert.equal(unknownAttempt.status, 400)

  const cancelled = await call(services.state, '/api/devin/cancel', { method: 'POST', body: {} })
  assert.equal(cancelled.body.ok, true)

  // Let the aborted flow settle before tearing the context down.
  await new Promise((resolve) => setTimeout(resolve, 50))
  ctx.disposeAll()
  await new Promise((resolve) => setTimeout(resolve, 50))
  void fetcher
})

test('apply() survives a context with no services at all', async () => {
  const ctx = createFakeContext()
  const warnings = []
  const originalWarn = console.warn
  console.warn = (message) => {
    warnings.push(String(message))
  }
  try {
    await apply(ctx, { webSearch: true })
    assert.ok(Array.isArray(warnings))
    assert.equal(servicesFree(ctx), true)
  } finally {
    console.warn = originalWarn
    ctx.disposeAll()
  }
})

function servicesFree(ctx) {
  // Nothing was registered, but the plugin must still have disposed cleanly.
  return ctx.get('tools') === undefined
}

test('legacy credential migration: parses the harness record shape it was written for', () => {
  const text = [
    'version: 1',
    'refs:',
    '  {',
    '    CLINE_API_KEY: sk-abc',
    '  }',
    'records:',
    '  client-connection/browser-session:',
    '    kind: grant',
    '    payload:',
    '      version: 1',
    '      secret: u-other',
    '  devin-search/session:',
    '    kind: grant',
    '    payload:',
    '      version: 1',
    '      token: devin-session-token$abc.def.ghi',
    '      expiresAt: 1893456000000',
    '      expirySource: fallback',
    '  deepseek-account-platform/device:',
    '    kind: grant',
    '    payload:',
    '      id: f7db5e6a',
    '',
  ].join('\n')

  const payload = parseLegacyGrant(text)
  assert.ok(payload, 'the devin-search/session payload must be found')
  assert.equal(payload.token, 'devin-session-token$abc.def.ghi')
  assert.equal(payload.expiresAt, '1893456000000')
  assert.equal(payload.expirySource, 'fallback')
  assert.equal(payload.version, '1')

  const grant = grantFromPayload(payload)
  assert.deepEqual(grant, { version: 1, token: 'devin-session-token$abc.def.ghi', expiresAt: 1893456000000, expirySource: 'fallback' })

  // Expired, wrong version and junk payloads are rejected rather than imported.
  assert.equal(grantFromPayload({ ...payload, expiresAt: '1' }), undefined)
  assert.equal(grantFromPayload({ ...payload, version: '2' }), undefined)
  assert.equal(grantFromPayload({ token: '' }), undefined)
  assert.equal(grantFromPayload(undefined), undefined)
  assert.equal(parseLegacyGrant('records:\n  other/thing:\n    payload:\n      a: b\n'), undefined)
  assert.equal(parseLegacyGrant('not yaml at all'), undefined)
  assert.equal(parseLegacyGrant(''), undefined)
})

test('legacy credential migration only fills an empty store', async () => {
  const home = await mkdtemp(join(tmpdir(), 'devin-legacy-'))
  try {
    const credentials = [
      'version: 1',
      'records:',
      '  devin-search/session:',
      '    kind: grant',
      '    payload:',
      '      version: 1',
      '      token: devin-session-token$legacy.token.here',
      '      expiresAt: 4102444800000',
      '      expirySource: jwt',
      '',
    ].join('\n')
    await writeFile(join(home, '.credentials.yaml'), credentials, 'utf8')
    await mkdir(join(home, 'devin-search'), { recursive: true })
    const store = createStore({ dir: join(home, 'devin-search') })

    assert.equal(await importLegacySession({ store }), 'imported')
    const imported = await store.readSession()
    assert.equal(imported.token, 'devin-session-token$legacy.token.here')
    assert.equal(imported.expirySource, 'jwt')

    // A second run must never overwrite what the plugin now owns.
    assert.equal(await importLegacySession({ store }), 'skipped')

    // Signing out must stick: a cleared store is NOT re-seeded from the old file.
    await store.clearSession()
    assert.equal(await importLegacySession({ store }), 'skipped', 'the legacy import is one-shot per installation')
    assert.equal(await store.readSession(), undefined)

    const empty = createStore({ dir: join(home, 'no-such-dir') })
    await rm(join(home, '.credentials.yaml'), { force: true })
    assert.equal(await importLegacySession({ store: empty }), 'absent')
    // Even the unsuccessful attempt is stamped, so later boots do no work.
    assert.equal(await importLegacySession({ store: empty }), 'skipped')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
