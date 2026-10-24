// Smoke tests for the dependency-free core port (packages/dsh-devin-search-next/lib/core).
//
// No network: the OAuth loopback listener is never started (only the preabort path
// of oauth() is exercised) and token exchange uses a fake `fetcher`, mirroring the
// fake-fetch assertions from the repo-root vitest suite.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { relative, sep, join } from 'node:path'
import { tmpdir } from 'node:os'
import { after, describe, it } from 'node:test'
import { gzipSync } from 'node:zlib'

import * as safety from '../lib/core/safety.js'
import * as protobuf from '../lib/core/protobuf.js'
import * as protocol from '../lib/core/protocol.js'
import * as oauthModule from '../lib/core/oauth.js'
import * as completionModule from '../lib/core/completion.js'
import * as codeSearchModule from '../lib/core/code-search.js'
import * as localModule from '../lib/core/local.js'
import * as gitignoreModule from '../lib/core/gitignore.js'

const { DevinError, FALLBACK_EXPIRES_MS, fail, check, safeError, deadline, abortable, boundedBody, request, toDevinSessionToken, expiry, redact } = safety
const { Writer, decode, stringField } = protobuf
const { JWT_PATH, MODEL, STREAM_PATH, metadata, jwtRequest, jwtResponse, chatRequest, frame, gzipFrame, streamText, toolMarker } = protocol
const { oauth, oauthCode, validateCode } = oauthModule
const { WindsurfCompletion } = completionModule
const { SEARCH_TURNS, SYSTEM, FINAL_TOOLS, TOOLS, codeSearch, parseAnswer, parseStructuredAnswer } = codeSearchModule
const { LocalWorkspace, LIMITS, command } = localModule
const { createIgnore } = gitignoreModule

const liveSignal = () => new AbortController().signal
const done = () => frame(Buffer.from('{}'), 2)

/** Compose per-directory .gitignore matchers exactly like LocalWorkspace.ignored(). */
function nestedIgnored(rules, rel) {
  return rules.some(({ base, matcher }) => {
    const r = relative(base, rel).split(sep).join('/')
    return r && !r.startsWith('../') && matcher.ignores(r)
  })
}

describe('core export surface', () => {
  it('matches the API the Host adapter is written against', () => {
    assert.deepEqual(Object.keys(safety).sort(), [
      'DEVIN_SESSION_TOKEN_PREFIX', 'DevinError', 'FALLBACK_EXPIRES_MS', 'abortable', 'boundedBody', 'check',
      'deadline', 'expiry', 'fail', 'json', 'object', 'redact', 'request', 'safeError', 'sessionSecrets',
      'toDevinSessionToken',
    ])
    assert.deepEqual(Object.keys(protobuf).sort(), ['Writer', 'decode', 'stringField'])
    assert.deepEqual(Object.keys(protocol).sort(), [
      'JWT_PATH', 'MODEL', 'STREAM_PATH', 'chatRequest', 'frame', 'gzipFrame', 'jwtRequest', 'jwtResponse',
      'metadata', 'streamText', 'toolMarker',
    ])
    assert.deepEqual(Object.keys(oauthModule).sort(), ['oauth', 'oauthCode', 'validateCode'])
    assert.deepEqual(Object.keys(completionModule).sort(), ['WindsurfCompletion'])
    assert.deepEqual(Object.keys(codeSearchModule).sort(), [
      'FINAL_TOOLS', 'SEARCH_TURNS', 'SYSTEM', 'TOOLS', 'codeSearch', 'parseAnswer', 'parseStructuredAnswer',
    ])
    assert.deepEqual(Object.keys(localModule).sort(), ['LIMITS', 'LocalWorkspace', 'command', 'contains'])
    assert.deepEqual(Object.keys(gitignoreModule).sort(), ['createIgnore', 'default', 'ignore'])
    assert.equal(MODEL, 'swe-1-6-fast')
  })
})

describe('safety', () => {
  it('creates DevinError, hides provider details and honours cancellation', async () => {
    const error = new DevinError('protocol', 'Devin fixture failure.')
    assert.equal(error.name, 'DevinError')
    assert.equal(error.code, 'protocol')
    assert.equal(error.message, 'Devin fixture failure.')
    assert.equal(safeError(error), 'Devin fixture failure.')
    assert.equal(safeError(new Error('provider body SECRET')), 'Devin operation failed. No provider details were retained.')
    assert.throws(() => fail('bounds', 'fixture bound.'), (thrown) => thrown instanceof DevinError && thrown.code === 'bounds')
    const controller = new AbortController()
    controller.abort()
    assert.throws(() => check(controller.signal), (thrown) => thrown.code === 'cancelled')
    assert.equal(deadline(controller.signal, 1000).aborted, true)
    // A promise that only settles later still counts as "pending" at abort time,
    // and settles before the process ends so no dangling promise is left behind
    // (Node's test runner cancels a whole suite over one of those).
    const pending = new Promise((resolve) => { setTimeout(() => resolve('late'), 50) })
    await assert.rejects(abortable(pending, controller.signal), (thrown) => thrown.code === 'cancelled')
  })

  it('round-trips session tokens, derives expiry and redacts every wire form', () => {
    assert.equal(toDevinSessionToken(' bare-token '), 'devin-session-token$bare-token')
    assert.equal(toDevinSessionToken('devin-session-token$bare-token'), 'devin-session-token$bare-token')
    assert.equal(toDevinSessionToken('sk-ws-fixture'), 'sk-ws-fixture')
    assert.equal(toDevinSessionToken('   '), '')
    const jwt = `header.${Buffer.from(JSON.stringify({ exp: 2_000_000_000 })).toString('base64url')}.sig`
    assert.deepEqual(expiry(jwt), { expiresAt: 2_000_000_000_000 - 60_000, expirySource: 'jwt' })
    assert.deepEqual(expiry('opaque', 100), { expiresAt: 100 + FALLBACK_EXPIRES_MS, expirySource: 'fallback' })
    assert.equal(redact('a fixture-token b', ['fixture-token']), 'a [redacted] b')
    assert.equal(redact('x devin-session-token$fixture-token y', ['fixture-token']), 'x [redacted] y')
    assert.equal(redact('untouched', []), 'untouched')
  })

  it('wraps fetch under the caller signal and enforces the body byte budget', async () => {
    const calls = []
    const fetcher = (url, init) => { calls.push({ url: String(url), init }); return Promise.resolve(new Response('ok')) }
    const response = await request('https://fixture.invalid/ingest', { method: 'POST' }, liveSignal(), fetcher)
    assert.equal(response.ok, true)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].init.redirect, 'error')
    assert.equal(calls[0].init.method, 'POST')
    assert.ok(calls[0].init.signal instanceof AbortSignal)
    await assert.rejects(request('https://fixture.invalid/ingest', {}, liveSignal(), async () => { throw new Error('boom') }),
      (thrown) => thrown.code === 'network')
    await assert.rejects(boundedBody(new Response(Buffer.alloc(2048)), liveSignal(), 1024), (thrown) => thrown.code === 'bounds')
    const empty = await boundedBody(new Response(null), liveSignal(), 1024)
    assert.equal(empty.length, 0)
  })
})

describe('protobuf', () => {
  it('round-trips varints, strings and nested bytes', () => {
    const encoded = new Writer().int(2, 300).string(3, 'héllo').bytes(6, new Writer().int(1, 7).build()).build()
    const fields = decode(encoded)
    assert.deepEqual(fields.map(field => field.field), [2, 3, 6])
    assert.equal(fields[0].value, 300)
    assert.deepEqual(fields[1].value, Buffer.from('héllo'))
    assert.equal(stringField(fields, 3), 'héllo')
    assert.equal(stringField(fields, 2), undefined)
    assert.deepEqual(decode(fields[2].value), [{ field: 1, value: 7 }])
    const max = new Writer().int(1, Number.MAX_SAFE_INTEGER).build()
    assert.equal(decode(max)[0].value, Number.MAX_SAFE_INTEGER)
  })

  it('fails closed on negative, unsafe and malformed encodings', () => {
    assert.throws(() => new Writer().int(1, -1), (thrown) => thrown.code === 'protocol')
    assert.throws(() => new Writer().int(1, 1.5), (thrown) => thrown.code === 'protocol')
    for (const bytes of [Buffer.from([0]), Buffer.from([11]), Buffer.from([128]), Buffer.from([10, 20, 1]), Buffer.from([8, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255])]) {
      assert.throws(() => decode(bytes))
    }
  })
})

describe('protocol', () => {
  it('encodes metadata, message roles, tool references and tools', () => {
    assert.equal(stringField(decode(metadata('fixture-api', 'fixture-jwt')), 3), 'fixture-api')
    assert.equal(stringField(decode(metadata('fixture-api', 'fixture-jwt')), 21), 'fixture-jwt')
    assert.equal(decode(jwtRequest('fixture'))[0].field, 1)
    const data = decode(chatRequest('api', 'jwt', 'sys', [
      { role: 'user', content: 'u' },
      { role: 'assistant', content: 'a', call: { id: 'c', name: 'restricted_exec', args: {} } },
      { role: 'tool', content: 'result', callId: 'c' },
    ], '[]'))
    assert.equal(stringField(data, 3), '[]')
    const messages = data.filter(field => field.field === 2).map(field => decode(field.value))
    assert.deepEqual(messages.map(message => message.find(field => field.field === 2).value), [5, 1, 2, 4])
    assert.equal(messages[2].some(field => field.field === 6), true)
    assert.equal(stringField(messages[3], 7), 'c')
  })

  it('reads gzip/frame text, strips the EOS token and parses both tool markers', () => {
    const text = streamText(Buffer.concat([
      gzipFrame(new Writer().string(2, 'hello ').build()),
      frame(new Writer().string(3, 'world').build()),
      done(),
    ]))
    assert.equal(text, 'hello world')
    assert.equal(streamText(Buffer.concat([frame(new Writer().string(2, '<ANSWER></ANSWER></s>').build()), done()])), '<ANSWER></ANSWER>')
    assert.deepEqual(toolMarker('thinking[TOOL_CALLS]restricted_exec[ARGS]{"command1":{"op":"rg","pattern":"a}b"}}</s>'),
      { name: 'restricted_exec', args: { command1: { op: 'rg', pattern: 'a}b' } } })
    assert.deepEqual(toolMarker('thinking[TOOL_CALLS]restricted_exec{"command1":{"op":"ls","path":"/codebase"}}</s>'),
      { name: 'restricted_exec', args: { command1: { op: 'ls', path: '/codebase' } } })
    assert.equal(toolMarker('plain answer'), undefined)
    assert.throws(() => toolMarker('[TOOL_CALLS]evil[ARGS]{broken'), /JSON/)
  })

  it('fails closed on malformed streams without echoing provider bodies', () => {
    const cases = [
      ['partial header', Buffer.from([1, 0])],
      ['partial payload', frame(Buffer.from('x')).subarray(0, 5)],
      ['missing trailer', frame(new Writer().string(2, 'x').build())],
      ['invalid gzip', Buffer.concat([frame(Buffer.from('not gzip'), 1), done()])],
      ['bad trailer', frame(Buffer.from('not json'), 2)],
      ['trailer error', frame(Buffer.from('{"error":{"code":"internal","message":"SECRET"}}'), 2)],
      ['trailing frames', Buffer.concat([done(), done()])],
      ['unknown flag', frame(Buffer.from('x'), 4)],
    ]
    for (const [, bytes] of cases) {
      assert.throws(() => streamText(bytes))
      try { streamText(bytes) } catch (error) { assert.ok(!String(error).includes('SECRET')) }
    }
    assert.throws(() => streamText(Buffer.alloc(4 * 1024 * 1024 + 1)), /budget/)
    assert.throws(() => streamText(Buffer.concat([frame(gzipSync(Buffer.alloc(5000)), 1), done()]), 1024), /gzip/)
    assert.throws(() => streamText(Buffer.concat([
      frame(new Writer().string(2, 'x'.repeat(600)).build()),
      frame(new Writer().string(2, 'x'.repeat(600)).build()),
      done(),
    ]), 1024), /budget/)
  })
})

describe('oauth', () => {
  it('accepts trimmed codes and rejects malformed, oversized or non-string input', () => {
    assert.equal(validateCode('  fixture-code  '), 'fixture-code')
    for (const value of ['', '   ', 'secret\nvalue', 'a b', 'S'.repeat(8193), 42, null, undefined, {}]) {
      assert.throws(() => validateCode(value), (thrown) => thrown instanceof DevinError && thrown.code === 'bounds')
    }
  })

  it('builds the no-redirect PKCE URL and exchanges the trimmed code with the matching verifier', async () => {
    const urls = []
    const calls = []
    let promptSignal
    const fetcher = (url, init) => {
      calls.push({ url: String(url), init })
      return Promise.resolve(new Response(JSON.stringify({ token: 'fixture-token' }), { status: 200 }))
    }
    const token = await oauthCode(liveSignal(), url => urls.push(url), async (signal) => {
      promptSignal = signal
      return '  fixture-code  '
    }, { apiBase: 'https://fixture.invalid', fetcher })

    assert.equal(token, 'fixture-token')
    assert.ok(promptSignal instanceof AbortSignal)
    assert.equal(urls.length, 1)
    const url = new URL(urls[0])
    assert.equal(url.pathname, '/auth/cli/continue')
    assert.equal(url.searchParams.has('redirect_uri'), false)
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
    assert.equal(url.searchParams.get('prompt'), 'select_account')
    assert.ok(url.searchParams.get('state'))
    assert.equal(calls.length, 1)
    assert.equal(new URL(calls[0].url).pathname, '/auth/cli/token')
    const payload = JSON.parse(calls[0].init.body)
    assert.equal(payload.code, 'fixture-code')
    assert.equal(createHash('sha256').update(payload.code_verifier).digest('base64url'), url.searchParams.get('code_challenge'))
  })

  it('never contacts the provider for invalid codes, preabort or an expired prompt', async () => {
    const notified = []
    let fetched = 0
    const fetcher = async () => { fetched += 1; return new Response('{}') }
    await assert.rejects(oauthCode(liveSignal(), url => notified.push(url), async () => 'secret\nvalue', { fetcher }),
      /Invalid Devin authorization code/)
    const aborted = new AbortController(); aborted.abort()
    await assert.rejects(oauthCode(aborted.signal, url => notified.push(url), async () => 'unused', { fetcher }),
      (thrown) => thrown.code === 'cancelled')
    // The prompt never answers in time; it still settles afterwards so neither
    // the test nor the runner is left holding an unresolved promise.
    const slowPrompt = () => new Promise((resolve) => { setTimeout(() => resolve('too-late'), 80) })
    await assert.rejects(oauthCode(liveSignal(), url => notified.push(url), slowPrompt, { timeoutMs: 20, fetcher }),
      (thrown) => thrown.code === 'cancelled')
    assert.equal(fetched, 0)
    assert.equal(notified.length, 2)
  })

  it('redacts provider error bodies and never starts the loopback listener before the preabort check', async () => {
    await assert.rejects(
      oauthCode(liveSignal(), () => {}, async () => 'fixture-code', { fetcher: async () => new Response('SUPER_SECRET_TOKEN', { status: 500 }) }),
      (thrown) => thrown.code === 'network' && thrown.message === 'Devin token exchange failed. Please retry login.',
    )
    let notified = false
    const aborted = new AbortController(); aborted.abort()
    await assert.rejects(oauth(aborted.signal, () => { notified = true }), (thrown) => thrown.code === 'cancelled')
    assert.equal(notified, false)
  })
})

describe('gitignore matcher', () => {
  it('handles comments, blank lines, negation and trailing spaces', () => {
    const matcher = createIgnore().add('# comment\n\n*.log\n!keep.log\ntrailing.txt    \n')
    assert.equal(matcher.ignores('a.log'), true)
    assert.equal(matcher.ignores('nested/a.log'), true)
    assert.equal(matcher.ignores('keep.log'), false)
    assert.equal(matcher.ignores('nested/keep.log'), false)
    assert.equal(matcher.ignores('trailing.txt'), true)
    assert.equal(matcher.ignores('#comment'), false)
    assert.equal(matcher.ignores(''), false)
  })

  it('anchors leading and middle separators to the .gitignore directory', () => {
    const anchored = createIgnore().add('/root.txt\nsrc/gen.ts\n')
    assert.equal(anchored.ignores('root.txt'), true)
    assert.equal(anchored.ignores('sub/root.txt'), false)
    assert.equal(anchored.ignores('src/gen.ts'), true)
    assert.equal(anchored.ignores('other/src/gen.ts'), false)
  })

  it('supports directory-only patterns, wildcards, character classes and escapes', () => {
    const matcher = createIgnore().add('build/\n*.ts\nfile[0-9].txt\ncache?/\n\\#literal\n')
    assert.equal(matcher.ignores('build/'), true)
    assert.equal(matcher.ignores('build'), false)
    assert.equal(matcher.ignores('build/out.js'), true)
    assert.equal(matcher.ignores('src/build/out.js'), true)
    assert.equal(matcher.ignores('a.ts'), true)
    assert.equal(matcher.ignores('x/y/a.ts'), true)
    assert.equal(matcher.ignores('file3.txt'), true)
    assert.equal(matcher.ignores('filex.txt'), false)
    assert.equal(matcher.ignores('cache1/'), true)
    assert.equal(matcher.ignores('#literal'), true)
  })

  it('supports ** for zero or more directories and trailing subtree matches', () => {
    const matcher = createIgnore().add('docs/**/*.md\n**/cache/\nassets/**\n')
    assert.equal(matcher.ignores('docs/a.md'), true)
    assert.equal(matcher.ignores('docs/x/y/a.md'), true)
    assert.equal(matcher.ignores('docs/a.txt'), false)
    assert.equal(matcher.ignores('cache/'), true)
    assert.equal(matcher.ignores('a/b/cache/'), true)
    assert.equal(matcher.ignores('a/b/cache/x.js'), true)
    assert.equal(matcher.ignores('assets/logo.svg'), true)
    assert.equal(matcher.ignores('assets'), false)
  })

  it('scopes nested .gitignore files to their own base directory like LocalWorkspace', () => {
    const rules = [
      { base: '.', matcher: createIgnore().add('ignored.txt\n*.log\n!keep.log\n/build/\n') },
      { base: 'src', matcher: createIgnore().add('secret.ts\ngenerated/\n') },
    ]
    assert.equal(nestedIgnored(rules, 'ignored.txt'), true)
    assert.equal(nestedIgnored(rules, 'src/ignored.txt'), true)
    assert.equal(nestedIgnored(rules, 'src/drop.log'), true)
    assert.equal(nestedIgnored(rules, 'src/keep.log'), false)
    assert.equal(nestedIgnored(rules, 'build/out.js'), true)
    assert.equal(nestedIgnored(rules, 'src/secret.ts'), true)
    assert.equal(nestedIgnored(rules, 'src/generated/x.ts'), true)
    assert.equal(nestedIgnored(rules, 'src/app.ts'), false)
    // A rule inside src/.gitignore is relative to src, not to the root.
    assert.equal(nestedIgnored(rules, 'generated/x.ts'), false)
  })
})

describe('local command validation', () => {
  it('accepts the restricted command shape', () => {
    assert.deepEqual(command({ op: 'ls' }), { op: 'ls' })
    assert.deepEqual(command({ op: 'rg', path: '/codebase/src', pattern: 'target', start: 1, end: 20 }),
      { op: 'rg', path: '/codebase/src', pattern: 'target', start: 1, end: 20 })
    for (const op of ['rg', 'readfile', 'tree', 'ls', 'glob']) assert.equal(command({ op }).op, op)
  })

  it('rejects malformed, oversized and unknown commands', () => {
    for (const value of [undefined, null, 'ls', 42, [], {}, { op: 'bash' }, { op: 'ls', shell: { op: 'bash' } }]) {
      assert.throws(() => command(value), (thrown) => thrown instanceof DevinError && thrown.code === 'protocol')
    }
    assert.throws(() => command({ op: 'rg', path: 'a'.repeat(1025) }), (thrown) => thrown.code === 'bounds')
    assert.throws(() => command({ op: 'rg', pattern: 'x'.repeat(257) }), (thrown) => thrown.code === 'bounds')
    assert.throws(() => command({ op: 'rg', path: 42 }), (thrown) => thrown.code === 'bounds')
    for (const window of [{ start: 0 }, { start: 1.5 }, { start: '1' }, { end: 1_000_001 }]) {
      assert.throws(() => command({ op: 'readfile', ...window }), (thrown) => thrown.code === 'bounds')
    }
    // Ordering of start/end is enforced by LocalWorkspace.execute(), not command().
    assert.deepEqual(command({ op: 'readfile', start: 2, end: 1 }), { op: 'readfile', start: 2, end: 1 })
    assert.equal(LIMITS.finalFiles, 8)
    assert.equal(LIMITS.snippetBytes, 48 * 1024)
  })
})

describe('local workspace + gitignore integration', () => {
  let dir
  after(async () => { if (dir) await rm(dir, { recursive: true, force: true }) })

  it('walks the temp tree while honouring root and nested .gitignore files', async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'dsh-devin-core-')))
    await mkdir(join(dir, 'src'))
    await mkdir(join(dir, 'build'))
    await writeFile(join(dir, '.gitignore'), 'ignored.txt\n/build/\n*.log\n!keep.log\n')
    await writeFile(join(dir, 'ignored.txt'), 'ignore me')
    await writeFile(join(dir, 'keep.log'), 'kept')
    await writeFile(join(dir, 'drop.log'), 'dropped')
    await writeFile(join(dir, 'build', 'out.js'), 'generated')
    await writeFile(join(dir, 'src', '.gitignore'), 'hidden.ts\n')
    await writeFile(join(dir, 'src', 'app.ts'), 'export const app = 1;\n')
    await writeFile(join(dir, 'src', 'hidden.ts'), 'fixture hidden')

    const workspace = await LocalWorkspace.create(dir, dir, path => path, liveSignal())
    const files = await workspace.inventory()
    assert.ok(files.includes('src/app.ts'))
    assert.ok(files.includes('keep.log'))
    assert.ok(!files.includes('ignored.txt'))
    assert.ok(!files.includes('drop.log'))
    assert.ok(!files.includes('build/out.js'))
    assert.ok(!files.includes('src/hidden.ts'))

    const listing = await workspace.execute({ op: 'ls' })
    assert.ok(listing.includes('/codebase/src/'))
    assert.ok(listing.includes('/codebase/keep.log'))
    assert.ok(!listing.includes('/codebase/ignored.txt'))
    assert.ok(!listing.includes('/codebase/build/'))
    await assert.rejects(workspace.execute({ op: 'readfile', path: '/codebase/ignored.txt' }), /Ignored/)
    await assert.rejects(workspace.execute({ op: 'readfile', path: '/codebase/src/hidden.ts' }), /Ignored/)
    assert.match(await workspace.execute({ op: 'readfile', path: '/codebase/src/app.ts', start: 1, end: 1 }), /export const app/)
  })

  it('refuses a relative or foreign search folder', async () => {
    await assert.rejects(LocalWorkspace.create(dir, 'src', path => path, liveSignal()), (thrown) => thrown.code === 'path')
    await assert.rejects(LocalWorkspace.create(undefined, dir, path => path, liveSignal()), (thrown) => thrown.code === 'path')
  })
})

describe('code-search', () => {
  it('exposes the prompt constants and tools JSON', () => {
    assert.equal(SEARCH_TURNS, 6)
    assert.ok(SYSTEM.includes('/codebase'))
    assert.ok(SYSTEM.includes('ANSWER'))
    assert.ok(SYSTEM.includes('restricted_exec'))
    const finalTools = JSON.parse(FINAL_TOOLS)
    const tools = JSON.parse(TOOLS)
    assert.equal(finalTools.length, 1)
    assert.equal(finalTools[0].function.name, 'ANSWER')
    assert.equal(tools.length, 2)
    assert.equal(tools[0].function.name, 'restricted_exec')
    assert.deepEqual(tools[0].function.parameters.required, ['command1'])
    assert.equal(tools[1].function.name, 'ANSWER')
  })

  it('parses the strict legacy XML answer and structured ANSWER refs', () => {
    assert.deepEqual(parseAnswer('<ANSWER><file path="/codebase/src/a.ts"><range>1-3</range><range>5-6</range></file></ANSWER>'),
      [{ path: '/codebase/src/a.ts', start: 1, end: 3 }, { path: '/codebase/src/a.ts', start: 5, end: 6 }])
    assert.throws(() => parseAnswer('raw text'), /canonical/)
    assert.throws(() => parseAnswer('<ANSWER><file path="/codebase/a&amp;b"><range>1-1</range></file></ANSWER>'), /entities/)
    assert.throws(() => parseAnswer(`<ANSWER>${Array.from({ length: 9 }, (_, i) => `<file path="/codebase/${i}"><range>1-1</range></file>`).join('')}</ANSWER>`), /eight/)
    assert.deepEqual(parseStructuredAnswer({ files: [] }), [])
    assert.deepEqual(parseStructuredAnswer({ files: [{ path: '/codebase/a.ts', ranges: [{ start: 1, end: 3 }] }] }),
      [{ path: '/codebase/a.ts', start: 1, end: 3 }])
    assert.throws(() => parseStructuredAnswer({ files: [{ path: '/codebase/a.ts', ranges: [{ start: 1, end: 401 }] }] }), /range/)
    assert.throws(() => parseStructuredAnswer({ files: [], shell: 'bash' }), /files/)
    assert.throws(() => parseStructuredAnswer({ files: [{ path: '/codebase/a.ts', ranges: [{ start: 0, end: 3 }] }] }), /range/)
  })

  it('runs a fake-completion search loop against a real temp workspace', async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'dsh-devin-search-')))
    try {
      await mkdir(join(dir, 'src'))
      await writeFile(join(dir, 'src', 'a.ts'), 'export function target() {\n  return 42;\n}\n')
      const answers = [
        '[TOOL_CALLS]restricted_exec{"command1":{"op":"readfile","path":"/codebase/src/a.ts"}}',
        '[TOOL_CALLS]ANSWER{"files":[{"path":"/codebase/src/a.ts","ranges":[{"start":1,"end":3}]}]}',
      ]
      const calls = []
      const completion = { complete: async (system, messages, tools, signal) => { calls.push({ system, messages, tools }); return answers.shift() } }
      const result = await codeSearch({ search_term: 'find target', search_folder_absolute_uri: dir }, dir, path => path, completion, liveSignal())
      assert.equal(result.status, 'success')
      assert.equal(result.files[0].path, join(dir, 'src', 'a.ts'))
      assert.match(result.files[0].ranges[0].content, /2: {3}return 42;/)
      assert.equal(calls.length, 2)
      assert.ok(JSON.stringify(calls[0].messages).includes('/codebase/src/a.ts'))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('completion transport', () => {
  const jwtPayload = new Writer().string(1, 'fixture-jwt').build()
  const streamPayload = Buffer.concat([
    gzipFrame(new Writer().string(2, 'hello ').build()),
    frame(new Writer().string(2, 'world').build()),
    done(),
  ])
  const access = (signal) => ({ token: 'fixture-token', signal })

  it('exchanges the JWT and streams text through a fake fetcher', async () => {
    const urls = []
    const fetcher = (url) => {
      urls.push(String(url))
      return Promise.resolve(new Response(String(url).endsWith(JWT_PATH) ? jwtPayload : streamPayload))
    }
    const sessions = { access: async (signal) => access(signal), revoke: async () => {} }
    const completion = new WindsurfCompletion(sessions, { fetcher })
    assert.equal(completion.model, MODEL)
    const text = await completion.complete('system prompt', [{ role: 'user', content: 'fixture' }], '[]', liveSignal())
    assert.equal(text, 'hello world')
    assert.deepEqual(urls.map(url => new URL(url).pathname), [JWT_PATH, STREAM_PATH])
    assert.equal(jwtResponse(jwtPayload), 'fixture-jwt')
  })

  it('invalidates and revokes on a rejected session', async () => {
    const revoked = []
    const fetcher = async () => new Response('', { status: 401 })
    const sessions = { access: async (signal) => access(signal), revoke: async token => { revoked.push(token) } }
    const completion = new WindsurfCompletion(sessions, { fetcher })
    await assert.rejects(completion.complete('system', [], '[]', liveSignal()),
      (thrown) => thrown instanceof DevinError && thrown.code === 'login')
    assert.deepEqual(revoked, ['fixture-token'])
  })
})
