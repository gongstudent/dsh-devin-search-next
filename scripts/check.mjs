#!/usr/bin/env node
/**
 * Offline conformance check for the bundle.
 *
 * It answers one question: would the harness accept this package, and does it
 * still keep the promises that make it upgrade-proof (no harness imports, a
 * real client bundle, locales, an icon, resolvable imports)?
 *
 * Usage: node scripts/check.mjs      (exit 0 = pass)
 */

import { execFileSync } from 'node:child_process'
import { readFile, readdir, stat } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** @type {string[]} */
const problems = []
/** @type {string[]} */
const notes = []

/** @param {boolean} condition @param {string} message */
function check(condition, message) {
  if (!condition) problems.push(message)
}

/** @param {string} file */
async function exists(file) {
  try {
    const info = await stat(file)
    return info.isFile()
  } catch {
    return false
  }
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'))
}

/** Recursively list files under a directory. */
async function walk(dir) {
  /** @type {string[]} */
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await walk(full)))
    else out.push(full)
  }
  return out
}

const pkg = await readJson(join(packageDir, 'package.json'))

// --- manifest -------------------------------------------------------------
check(pkg.name === 'dsh-devin-search-next', 'package name must stay dsh-devin-search-next (the client bundle id and the route prefix are derived from it)')
check(typeof pkg.version === 'string' && pkg.version.length > 0, 'package version is missing')
check(pkg.type === 'module', 'package must be ESM ("type": "module")')
check(pkg.main === './lib/index.js', 'package main must be ./lib/index.js')
check(pkg.exports && pkg.exports['.'] === './lib/index.js', 'exports["."] must point at ./lib/index.js')
check(pkg.exports && typeof pkg.exports['./client'] === 'string', 'exports["./client"] is required for the web client half')
check(pkg.exports && pkg.exports['./icon'] === './icon.svg', 'exports["./icon"] must not be empty')
check(pkg.exports && typeof pkg.exports['./locale/*.json'] === 'string', 'exports["./locale/*.json"] is required for display metadata')

// The whole point of the rewrite: no harness package may be required.
check(!pkg.dependencies || Object.keys(pkg.dependencies).length === 0, 'runtime dependencies must stay empty (zero-install plugin)')
check(!pkg.peerDependencies || Object.keys(pkg.peerDependencies).length === 0, 'peerDependencies must stay empty: an exact DSH peer range is what let the old bundle be silently dropped by the version gate')
check(!pkg.engines || typeof pkg.engines.dsh !== 'string', 'engines.dsh must not be declared: it is a hard bundle-activation gate')

// --- bundle patch ---------------------------------------------------------
const patchRel = pkg.dsh?.bundle?.patch
check(typeof patchRel === 'string', 'dsh.bundle.patch is missing')
if (typeof patchRel === 'string') {
  const patchPath = join(packageDir, patchRel)
  check(await exists(patchPath), `${patchRel} does not exist`)
  if (await exists(patchPath)) {
    const patch = await readFile(patchPath, 'utf8')
    check(patch.startsWith('- id:') || patch.startsWith('#') || patch.startsWith('- insert:'), 'patch must be a YAML array of loader entries')
    check(/id:\s*devin-search-next/.test(patch), 'patch must insert the devin-search-next row')
    check(/name:\s*dsh-devin-search-next/.test(patch), 'patch row must name the package')
    check(/searchProvider:\s*devin/.test(patch), 'patch must select the devin web search provider')
  }
}

// --- client manifest ------------------------------------------------------
const client = pkg.dsh?.client
check(client && typeof client === 'object', 'dsh.client is missing')
if (client) {
  check(client.platform === 'web', 'dsh.client.platform must be "web"')
  check(client.immediately === true, 'dsh.client.immediately should be true so the cards exist before a session starts')
  check(!('inject' in client) || Array.isArray(client.inject), 'dsh.client.inject, when present, must be an array of package names')
  check(!('external' in client) || Array.isArray(client.external), 'dsh.client.external, when present, must be an array')
}

// --- files listed for packing --------------------------------------------
const requiredFiles = [
  'lib/index.js',
  'lib/client.js',
  'cordis.patch.yml',
  'icon.svg',
  'locale/en.json',
  'locale/zh.json',
  'README.md',
]
for (const rel of requiredFiles) check(await exists(join(packageDir, rel)), `${rel} is required but missing`)
const filesField = Array.isArray(pkg.files) ? pkg.files : []
check(filesField.includes('lib'), 'package files[] must include "lib"')
check(filesField.includes('cordis.patch.yml'), 'package files[] must include the patch')
check(filesField.includes('icon.svg'), 'package files[] must include the icon')
check(filesField.includes('locale/*.json'), 'package files[] must include the locale files')

// --- display metadata -----------------------------------------------------
for (const language of ['en', 'zh']) {
  const file = join(packageDir, 'locale', `${language}.json`)
  if (!(await exists(file))) continue
  const dict = await readJson(file)
  check(dict?.meta && typeof dict.meta.title === 'string' && dict.meta.title.length > 0, `locale/${language}.json meta.title is required`)
  check(dict?.meta && typeof dict.meta.description === 'string' && dict.meta.description.length > 0, `locale/${language}.json meta.description is required`)
}
const iconPath = join(packageDir, 'icon.svg')
if (await exists(iconPath)) {
  const info = await stat(iconPath)
  check(info.size <= 256 * 1024, 'icon must stay under 256 KiB')
  const svg = await readFile(iconPath, 'utf8')
  check(svg.trimStart().startsWith('<svg'), 'icon.svg must be valid SVG')
}

// --- module graph: resolvable local imports, no harness imports -----------
const libFiles = await walk(join(packageDir, 'lib'))
for (const file of libFiles) {
  const rel = relative(packageDir, file)
  if (!rel.endsWith('.js')) continue
  const source = await readFile(file, 'utf8')

  if (rel === 'lib/client.js') {
    // The client factory may only reach the browser seed table.
    const required = [...source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((match) => match[1])
    const banned = required.filter((name) => name.startsWith('@deepseek-ai/'))
    check(banned.length === 0, `${rel} must not require harness packages (found ${banned.join(', ')})`)
    check(source.includes('__ModuleLoader__.load'), `${rel} must register through window.__ModuleLoader__.load`)
    check(/exports\.apply\s*=/.test(source) || /apply:\s*apply/.test(source), `${rel} must export apply`)
    check(!/^\s*import\s/m.test(source), `${rel} must not use static ESM imports; the module table provides react`)
    continue
  }

  const specifiers = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((match) => match[1])
  for (const specifier of specifiers) {
    if (!specifier.startsWith('.')) {
      check(specifier.startsWith('node:'), `${rel} imports a non-builtin bare package: ${specifier}`)
      continue
    }
    const target = resolve(dirname(file), specifier)
    check(await exists(target), `${rel} imports ${specifier}, which does not resolve to a file`)
  }
}

const hostEntry = await readFile(join(packageDir, 'lib/index.js'), 'utf8')
check(/export\s+async\s+function\s+apply/.test(hostEntry) || /export\s+function\s+apply/.test(hostEntry), 'lib/index.js must export apply')
check(!/export\s+const\s+Config/.test(hostEntry), 'lib/index.js must not export Config: the harness requires a real Schemastery instance and that is a runtime dependency')

// --- syntax ---------------------------------------------------------------
let checked = 0
for (const file of libFiles.filter((candidate) => candidate.endsWith('.js'))) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })
    checked += 1
  } catch (error) {
    problems.push(`${relative(packageDir, file)} fails node --check: ${String(error.stderr || error.message).split('\n')[0]}`)
  }
}

// --- report ---------------------------------------------------------------
notes.push(`${libFiles.length} runtime files scanned, ${checked} syntax-checked`)
notes.push(`package ${pkg.name}@${pkg.version}`)

for (const note of notes) console.log(`  · ${note}`)
if (problems.length > 0) {
  console.error(`\n✗ ${problems.length} problem(s):`)
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}
console.log('\n✓ bundle conformance check passed')
