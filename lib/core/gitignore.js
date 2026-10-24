// Self-contained .gitignore matcher — dependency-free replacement for the npm
// `ignore` package used by src/local.ts. local.js scopes one matcher per
// .gitignore file (relative to that file's directory), as local.ts did.
//
// Call surface (mirrors the `ignore` API local.js actually uses):
//   const matcher = createIgnore()   // also the default export
//   matcher.add(text)                // gitignore text or array of lines; chainable
//   matcher.ignores(path)            // path relative to the gitignore directory
//
// Supported: comment/blank lines, `!` negation, leading `/` anchoring, trailing
// `/` directory-only patterns, `*`, `**`, `?`, `[...]` character classes and
// `\` escapes. Rules are evaluated in insertion order and the last matching rule
// wins (gitignore order semantics). A path ending in `/` is treated as a
// directory. A rule matching a leading directory portion of the path also covers
// everything beneath it, which is how a walker sees inherited directories.

const REGEX_SPECIAL = new Set(['\\', '^', '$', '.', '*', '+', '?', '(', ')', '[', ']', '{', '}', '|'])

const escaped = ch => (REGEX_SPECIAL.has(ch) ? `\\${ch}` : ch)

/** Strip gitignore's unescaped trailing spaces. */
function trimTrailingSpaces(line) {
  let end = line.length
  while (end > 0 && line[end - 1] === ' ') {
    let slashes = 0
    let i = end - 2
    while (i >= 0 && line[i] === '\\') { slashes += 1; i -= 1 }
    if (slashes % 2 === 1) break
    end -= 1
  }
  return line.slice(0, end)
}

/** Compile one glob body into a full-path RegExp. */
function compile(pattern, anchored) {
  let source = ''
  let i = 0
  const n = pattern.length
  while (i < n) {
    const ch = pattern[i]
    if (ch === '\\') {
      const next = pattern[i + 1]
      if (next === undefined) { source += '\\\\'; i += 1; continue }
      source += escaped(next); i += 2; continue
    }
    if (ch === '*') {
      let end = i
      while (pattern[end] === '*') end += 1
      const before = i === 0 ? '/' : pattern[i - 1]
      const after = end >= n ? '/' : pattern[end]
      if (end - i >= 2 && before === '/' && after === '/') {
        // `**/` at the start or after a slash: zero or more directories.
        // Trailing `/**`: everything inside the preceding directory.
        if (i === 0 && end >= n) { source += '.*'; i = end }
        else if (i === 0) { source += '(?:[^/]+/)*'; i = end + 1 }
        else if (end >= n) { source += '.*'; i = end }
        else { source += '(?:[^/]+/)*'; i = end + 1 }
      } else {
        // `**` not spanning a whole segment is a plain `*`.
        source += '[^/]*'; i = end
      }
      continue
    }
    if (ch === '?') { source += '[^/]'; i += 1; continue }
    if (ch === '[') {
      const close = pattern.indexOf(']', i + 2)
      if (close < 0) { source += '\\['; i += 1; continue }
      let body = pattern.slice(i + 1, close)
      let negated = false
      if (body[0] === '!' || body[0] === '^') { negated = true; body = body.slice(1) }
      let content = ''
      for (const c of body) content += c === '\\' || c === ']' || c === '^' ? `\\${c}` : c
      if (!content) { source += '\\['; i += 1; continue }
      source += negated ? `[^/${content}]` : `[${content}]`
      i = close + 1
      continue
    }
    source += escaped(ch); i += 1
  }
  return new RegExp(`^${anchored ? '' : '(?:.*/)?'}${source}$`)
}

/** Parse one gitignore line into a rule, or undefined for blank/comment lines. */
function parseLine(line) {
  const text = trimTrailingSpaces(line)
  if (!text || text[0] === '#') return undefined
  let negated = false
  let body = text
  if (body[0] === '!') { negated = true; body = body.slice(1) }
  let dirOnly = false
  if (body.endsWith('/')) { dirOnly = true; body = body.replace(/\/+$/, '') }
  let anchored = false
  if (body.startsWith('/')) { anchored = true; body = body.replace(/^\/+/, '') }
  if (!body) return undefined
  if (body.includes('/')) anchored = true
  return { negated, dirOnly, re: compile(body, anchored) }
}

/** Does `rule` match `parts` (a split relative path), directly or as an ancestor? */
function matches(rule, parts, isDir) {
  const path = parts.join('/')
  if (rule.re.test(path) && (!rule.dirOnly || isDir)) return true
  for (let i = 1; i < parts.length; i++) if (rule.re.test(parts.slice(0, i).join('/'))) return true
  return false
}

export function createIgnore() {
  const rules = []
  const matcher = {
    add(pattern) {
      const lines = Array.isArray(pattern) ? pattern : String(pattern).split(/\r?\n/)
      for (const raw of lines) {
        const rule = parseLine(String(raw).replace(/^\uFEFF/, ''))
        if (rule) rules.push(rule)
      }
      return matcher
    },
    ignores(pathname) {
      if (typeof pathname !== 'string') throw new TypeError('ignore path must be a string')
      if (!pathname) return false
      const normalized = pathname.replace(/\\/g, '/')
      const isDir = normalized.endsWith('/')
      const path = normalized.replace(/\/+$/, '').replace(/^\.\//, '')
      if (!path || path === '.' || path === '..') return false
      const parts = path.split('/')
      let ignored = false
      for (const rule of rules) if (matches(rule, parts, isDir)) ignored = !rule.negated
      return ignored
    },
  }
  return matcher
}

/** Alias matching the `ignore` package's factory name. */
export const ignore = createIgnore

export default createIgnore
