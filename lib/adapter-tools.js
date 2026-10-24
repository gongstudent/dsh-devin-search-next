/**
 * The `code_search` tool, and the `web_search` on/off guard.
 *
 * The tool definition is written as **raw JSON Schema**, not through the
 * harness's `defineTool` author-DSL helper: `defineTool` and its schema compiler
 * live in `@deepseek-ai/dsh-tools`, and importing that package is exactly what
 * makes a plugin die on the next release. The registry validates only
 * `output.schema`, while `parameters` reaches the model verbatim, so both are
 * written as plain, valid JSON Schema here.
 *
 * Everything is registered lazily through `ctx.inject(['tools'], …)`: a harness
 * without a tools service keeps the sign-in and settings features intact.
 */

import { codeSearch } from './core/code-search.js'
import { safeError } from './core/safety.js'
import { lookup } from './adapter-api.js'

export const CODE_SEARCH = 'code_search'
export const WEB_SEARCH = 'web_search'

const ALLOWED_ARGS = new Set(['search_term', 'search_folder_absolute_uri'])

/**
 * Model-facing description. Kept intentionally close to the original wording:
 * the wording is what teaches the model when (and when not) to call this tool.
 */
const DESCRIPTION = [
  '<scope>Cloud-assisted read-only semantic code search in the local session workspace. Selected code is sent to Devin/Windsurf cloud. Never remote workspaces.</scope>',
  '<usage>Call code_search FIRST, before manual repository exploration, when the relevant file or symbol is unknown: locating behavior from a natural-language description, exploring unfamiliar code, or tracing a cross-file flow. If the exact file path or symbol is already known, use direct file reads or exact local search instead. Ask one focused question per call and use the narrowest relevant folder within the session workspace.</usage>',
  '<verification>Treat returned files and line ranges as leads, not proof of an interpretation. Read the relevant code to verify behavior before editing or answering.</verification>',
].join(' ')

/** Valid JSON Schema: object nodes declare `additionalProperties` explicitly. */
const PARAMETERS = {
  type: 'object',
  properties: {
    search_term: {
      type: 'string',
      description: 'What code to find: a natural-language description, symbol, or behavior.',
    },
    search_folder_absolute_uri: {
      type: 'string',
      description: 'Absolute local folder inside the session workspace, as narrow as possible.',
    },
  },
  required: ['search_term', 'search_folder_absolute_uri'],
}

const RANGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    start: { type: 'integer' },
    end: { type: 'integer' },
    content: { type: 'string' },
  },
  required: ['start', 'end', 'content'],
}

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'string', enum: ['success', 'error'] },
    files: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string' },
          ranges: { type: 'array', items: RANGE_SCHEMA },
        },
        required: ['path', 'ranges'],
      },
    },
    content: { type: 'string' },
  },
  required: ['status', 'files', 'content'],
}

/** @param {unknown} args */
function normalizeArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('code_search expects an object argument.')
  const record = /** @type {Record<string, unknown>} */ (args)
  const unknown = Object.keys(record).filter((key) => !ALLOWED_ARGS.has(key))
  if (unknown.length > 0) throw new Error(`code_search accepts only search_term and search_folder_absolute_uri (got ${unknown.join(', ')}).`)
  const term = record.search_term
  const folder = record.search_folder_absolute_uri
  if (typeof term !== 'string' || !term.trim()) throw new Error('search_term must be a non-empty string.')
  if (typeof folder !== 'string' || !folder.trim()) throw new Error('search_folder_absolute_uri must be a non-empty string.')
  return { search_term: term, search_folder_absolute_uri: folder }
}

/**
 * Resolve the session workspace directory. There is no `cwd` on the tool
 * execution object; the harness owns it through `workingDirectory`.
 *
 * @param {any} ctx
 * @param {any} exec
 */
async function resolveWorkspaceDir(ctx, exec) {
  const agent = exec && exec.agent
  const workingDirectory = lookup(ctx, 'workingDirectory')
  if (workingDirectory && typeof workingDirectory.ensure === 'function' && agent) {
    try {
      const dir = await workingDirectory.ensure(agent, exec.signal)
      if (typeof dir === 'string' && dir) return dir
    } catch {
      // Fall through to the session header.
    }
  }
  const header = agent && agent.session && agent.session.header
  if (header && typeof header.cwd === 'string' && header.cwd) return header.cwd
  return undefined
}

/**
 * Map a host path into the harness's process-path form when that service exists.
 * `LocalWorkspace` requires the mapping to round-trip to the same absolute path,
 * so an unavailable or changed mapping degrades to the identity.
 *
 * @param {any} ctx
 */
function createPathMapping(ctx) {
  const fsService = lookup(ctx, 'fs')
  return (hostPath) => {
    try {
      const mapped = fsService && typeof fsService.processPathFromHostPath === 'function'
        ? fsService.processPathFromHostPath(hostPath)
        : undefined
      return typeof mapped === 'string' && mapped ? mapped : hostPath
    } catch {
      return hostPath
    }
  }
}

/**
 * Build the tool definition.
 *
 * @param {{ ctx: any, sessions: any, settings: any, completion: any }} input
 */
export function createCodeSearchTool(input) {
  const { ctx, sessions, settings, completion } = input
  const mapping = createPathMapping(ctx)

  return {
    name: CODE_SEARCH,
    description: DESCRIPTION,
    parameters: PARAMETERS,
    output: {
      schema: OUTPUT_SCHEMA,
      render(_args, value) {
        const text = value && typeof value.content === 'string' ? value.content : ''
        return [{ type: 'text', text }]
      },
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      if (!settings.isEnabled('codeSearch')) {
        throw new Error('code_search is disabled in the Devin search settings (/devin-settings code on).')
      }
      const parsed = normalizeArgs(args)
      const cwd = await resolveWorkspaceDir(ctx, exec)
      let result
      try {
        const access = await sessions.access(exec.signal)
        result = await codeSearch(parsed, cwd, mapping, completion, access.signal)
      } catch (error) {
        throw new Error(safeError(error))
      }
      // A resolved value with status:error would still render as a successful
      // tool row, so fail loudly instead.
      if (!result || result.status === 'error') throw new Error(result && result.content ? result.content : 'Devin code search failed.')
      return result
    },
  }
}

/**
 * Register the web_search on/off guard on the tools service.
 *
 * @param {any} scope
 * @param {any} settings
 * @returns {(() => void) | undefined}
 */
function mountWebSearchGuard(scope, settings) {
  const tools = lookup(scope, 'tools')
  if (!tools || typeof tools.guard !== 'function') return undefined
  try {
    const dispose = tools.guard((execution) => {
      if (!execution || execution.name !== WEB_SEARCH) return undefined
      return settings.isEnabled('webSearch')
        ? undefined
        : 'web_search is disabled in the Devin search settings (/devin-settings web on).'
    })
    return typeof dispose === 'function' ? () => void dispose() : undefined
  } catch {
    return undefined
  }
}

/**
 * Mount `code_search`, following the on/off switch for its whole lifetime.
 *
 * @param {{ ctx: any, sessions: any, settings: any, log: { warn: Function }, completion: any }} input
 */
export function mountCodeSearch(input) {
  const { ctx, sessions, settings, log, completion } = input
  /** @type {any} */
  let toolScope
  /** @type {(() => void) | undefined} */
  let toolDispose
  /** @type {(() => void) | undefined} */
  let guardDispose

  const unregisterTool = () => {
    const dispose = toolDispose
    toolDispose = undefined
    if (!dispose) return
    try {
      dispose()
    } catch {
      // Already disposed with its fiber.
    }
  }

  const registerTool = () => {
    if (!toolScope || toolDispose) return
    const tools = lookup(toolScope, 'tools')
    if (!tools || typeof tools.register !== 'function') return
    try {
      const dispose = tools.register(createCodeSearchTool({ ctx: toolScope, sessions, settings, completion }))
      toolDispose = typeof dispose === 'function' ? () => void dispose() : undefined
    } catch (error) {
      log.warn(`could not register code_search: ${error && error.message ? error.message : error}`)
      toolDispose = undefined
    }
  }

  const sync = () => {
    if (!toolScope) return
    if (settings.isEnabled('codeSearch')) registerTool()
    else unregisterTool()
  }

  const attach = (scope) => {
    if (toolScope) return
    toolScope = scope
    guardDispose = mountWebSearchGuard(scope, settings)
    sync()
    const cleanup = () => {
      toolScope = undefined
      unregisterTool()
      const dispose = guardDispose
      guardDispose = undefined
      if (dispose) {
        try {
          dispose()
        } catch {
          // Already gone.
        }
      }
    }
    try {
      if (typeof scope.effect === 'function') scope.effect(() => cleanup)
    } catch {
      // A context without effect support still gets cleanup on plugin unload
      // through the tools service's own fiber scoping.
    }
  }

  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['tools'], (scope) => attach(scope))
    } catch {
      attach(ctx)
    }
  } else {
    attach(ctx)
  }

  const unsubscribe = settings.subscribe(() => sync())

  return {
    dispose() {
      try {
        unsubscribe()
      } catch {
        // Already released.
      }
      unregisterTool()
    },
  }
}
