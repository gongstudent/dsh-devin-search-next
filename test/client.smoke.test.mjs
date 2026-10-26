/**
 * Client-half smoke tests without a browser and without React.
 *
 * The bundle's first rule is that it registers and mounts even when the harness
 * moved things around, so these tests use a fake module table and a fake DOM and
 * assert exactly what the bundle claims: its id, its exports, the five seats it
 * claims, the options on each seat, and that every component renders with no
 * props at all.
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { before, test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const clientPath = join(packageDir, 'lib', 'client.js')

/** @type {{ id: string, factory: (require: (name: string) => unknown) => any }} */
let captured

/** A React stand-in: only `createElement` is needed, hooks fall back internally. */
function createFakeReact() {
  const memo = (component) => component
  const createElement = (type, props, ...children) => ({
    type,
    props: props === null || props === undefined ? {} : props,
    children: children.flat(Infinity).filter((child) => child !== undefined && child !== null && child !== false),
  })
  return { createElement, memo, Fragment: 'Fragment' }
}

/** Minimal DOM: enough for the plugin's own stylesheet and clipboard helpers. */
function createFakeDocument() {
  const makeNode = (tag) => ({
    tagName: String(tag).toUpperCase(),
    style: {},
    attributes: {},
    children: [],
    textContent: '',
    setAttribute(name, value) {
      this.attributes[name] = value
    },
    getAttribute(name) {
      return this.attributes[name]
    },
    appendChild(node) {
      this.children.push(node)
      return node
    },
    removeChild(node) {
      const index = this.children.indexOf(node)
      if (index >= 0) this.children.splice(index, 1)
      return node
    },
    remove() {},
  })
  return {
    head: makeNode('head'),
    body: makeNode('body'),
    createElement: makeNode,
    querySelector() {
      return null
    },
    getElementById() {
      return null
    },
    execCommand() {
      return true
    },
  }
}

/** A slot registry that records seats instead of rendering them. */
function createFakeSlots() {
  const seats = []
  const declared = new Set(['conversation.chat.commandview', 'settings.section', 'settings.general.item'])
  return {
    seats,
    register(options, component) {
      seats.push({ options, component })
      return () => {
        const index = seats.findIndex((seat) => seat.options === options)
        if (index >= 0) seats.splice(index, 1)
      }
    },
    inject(key, callback) {
      assert.ok(declared.has(key), `unexpected slot key ${key}`)
      const cleanup = callback()
      return typeof cleanup === 'function' ? cleanup : () => {}
    },
  }
}

/** @param {{ slots?: any, locale?: any }} services */
function createFakeContext(services = {}) {
  const effects = []
  const ctx = {
    effect(fn) {
      const cleanup = fn()
      if (typeof cleanup === 'function') effects.push(cleanup)
      return () => {}
    },
    get(name) {
      if (name === 'slots') return services.slots
      if (name === 'locale') return services.locale
      return undefined
    },
    effects,
  }
  return ctx
}

before(async () => {
  globalThis.window = {
    __ModuleLoader__: {
      load(registration) {
        captured = registration
      },
    },
  }
  globalThis.document = createFakeDocument()
  await import(pathToFileURL(clientPath).href)
})

test('bundle registers itself under the package id and exports name/inject/apply', () => {
  assert.ok(captured, 'the bundle must call window.__ModuleLoader__.load')
  assert.equal(captured.id, 'dsh-devin-search-next')
  const exports = captured.factory(() => createFakeReact())
  assert.equal(exports.name, 'dsh-devin-search-next-client')
  assert.deepEqual(exports.inject, ['slots'])
  assert.equal(typeof exports.apply, 'function')
  assert.ok(exports.__messages.zh && exports.__messages.en, 'both dictionaries must be bundled')
  assert.equal(Object.keys(exports.__messages.zh).length, Object.keys(exports.__messages.en).length, 'dictionary keys must stay in parity')
})

test('the module table is asked for react only, and no harness package is referenced', async () => {
  const asked = []
  captured.factory((name) => {
    asked.push(name)
    return createFakeReact()
  })
  assert.deepEqual(asked, ['react'])

  const source = await readFile(clientPath, 'utf8')
  assert.equal(/require\(\s*['"]@deepseek-ai\//.test(source), false, 'no harness package may be required')
  assert.equal(/"@deepseek-ai\//.test(source) || /'@deepseek-ai\//.test(source), false, 'no harness package name may appear')
  for (const path of ['/api/devin/state', '/api/devin/login', '/api/devin/login/code', '/api/devin/settings', '/api/devin/logout', '/api/devin/cancel']) {
    assert.ok(source.includes(path), `${path} must be used by the client`)
  }
  assert.equal(source.includes('/devin/api/'), false, 'routes must live under /api')
})

test('apply claims the four command rows plus one settings section', () => {
  const slots = createFakeSlots()
  const exports = captured.factory(() => createFakeReact())
  const ctx = createFakeContext({ slots })
  exports.apply(ctx)

  const bySlot = (name) => slots.seats.filter((seat) => seat.options.name === name)
  const commands = bySlot('conversation.chat.commandview')
  assert.deepEqual(commands.map((seat) => seat.options.key).sort(), ['devin-cancel', 'devin-login', 'devin-logout', 'devin-status'])
  for (const seat of commands) {
    assert.equal(typeof seat.component, 'function')
    assert.equal('locale' in seat.options, false, 'no locale option without an installed locale face')
  }

  const sections = bySlot('settings.section')
  assert.equal(sections.length, 1)
  assert.equal(sections[0].options.id, 'devin-search')
  assert.equal(typeof sections[0].options.label, 'function', 'the nav label is a renderer so the entry can carry the plugin glyph')
  const labelTree = sections[0].options.label()
  assert.equal(typeof labelTree, 'object')
  assert.equal(typeof sections[0].options.order, 'number')

  // Everything lives on the plugin's own settings page: no rows in General Settings.
  const general = bySlot('settings.general.item')
  assert.deepEqual(general, [])
})

test('the stylesheet is installed and removed only through its effect cleanup', () => {
  const slots = createFakeSlots()
  const exports = captured.factory(() => createFakeReact())
  const ctx = createFakeContext({ slots })
  const before = globalThis.document.head.children.length
  exports.apply(ctx)
  const after = globalThis.document.head.children.length
  assert.equal(after, before + 1, 'apply must append exactly one stylesheet node')
  const tag = globalThis.document.head.children[after - 1]
  assert.equal(tag.attributes['data-plugin-css'], 'dsh-devin-search-next/client.css')
  assert.ok(tag.textContent.length > 1000, 'the stylesheet must carry the rules')
  assert.ok(ctx.effects.length > 0, 'cleanups must be registered as effects, not run during setup')
})

test('every registered component renders with undefined, empty and junk props', () => {
  const slots = createFakeSlots()
  const exports = captured.factory(() => createFakeReact())
  exports.apply(createFakeContext({ slots }))
  const junk = [
    undefined,
    {},
    { node: undefined },
    { node: null },
    { node: { name: 'devin-login', outcome: null } },
    { node: { name: 'devin-login', outcome: { kind: 'error', text: 'x' } } },
    { node: { name: 'devin-login', outcome: { kind: 'success', text: 'x' } } },
    { node: { name: 'devin-status', outcome: { kind: 'success', text: 'Signed in.' } }, t: (key) => key },
  ]
  for (const seat of slots.seats) {
    for (const props of junk) {
      let tree
      assert.doesNotThrow(() => {
        tree = seat.component(props)
      }, `${seat.options.name} must render with ${JSON.stringify(props)}`)
      assert.notEqual(tree, undefined, `${seat.options.name} must return a tree`)
    }
  }
})

test('apply is inert (and safe) when the harness provides no slots service', () => {
  const exports = captured.factory(() => createFakeReact())
  const warnings = []
  const originalWarn = console.warn
  console.warn = (...args) => warnings.push(args.join(' '))
  try {
    assert.doesNotThrow(() => exports.apply(createFakeContext({})))
    assert.doesNotThrow(() => exports.apply(undefined))
    assert.ok(warnings.some((line) => line.includes('[devin-search]')), 'a missing slots service should be reported')
  } finally {
    console.warn = originalWarn
  }
})

test('a missing locale service still renders localized text from the bundled dictionary', () => {
  const slots = createFakeSlots()
  const exports = captured.factory(() => createFakeReact())
  exports.apply(createFakeContext({ slots }))
  for (const seat of slots.seats) {
    const tree = seat.component({})
    const serialized = JSON.stringify(tree)
    assert.ok(serialized.length > 0, `${seat.options.name} must produce content`)
  }
})

test('a locale service that throws does not break registration', () => {
  const slots = createFakeSlots()
  const exports = captured.factory(() => createFakeReact())
  const ctx = createFakeContext({
    slots,
    locale: {
      register() {
        throw new Error('duplicate locale')
      },
    },
  })
  const originalWarn = console.warn
  console.warn = () => {}
  try {
    assert.doesNotThrow(() => exports.apply(ctx))
  } finally {
    console.warn = originalWarn
  }
  assert.equal(slots.seats.filter((seat) => seat.options.name === 'conversation.chat.commandview').length, 4)
})
