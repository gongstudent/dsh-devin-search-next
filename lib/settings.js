/**
 * The two feature switches, owned by this plugin and nothing else.
 *
 * Precedence: a value the user changed from the settings page (persisted in
 * `settings.json`) wins over the value in the bundle patch (`cordis.patch.yml`),
 * which wins over the built-in default `true`. The patch layer is re-applied on
 * every boot, so treating it as "defaults" is what lets a runtime toggle
 * survive a restart; deleting `settings.json` restores the patch values.
 */

const DEFAULTS = { webSearch: true, codeSearch: true }

/** @param {unknown} value @returns {boolean|undefined} */
function triState(value) {
  return typeof value === 'boolean' ? value : undefined
}

/**
 * Read the initial switches synchronously from the loader config. The loader
 * may hand us a plain object, or a Schemastery-resolved object exposing `.get()`
 * for volatile fields — support both without importing Schemastery.
 *
 * @param {unknown} config
 */
export function readConfig(config) {
  const out = { ...DEFAULTS }
  if (!config || typeof config !== 'object') return out
  for (const key of Object.keys(DEFAULTS)) {
    let raw
    try {
      raw = /** @type {Record<string, unknown>} */ (config)[key]
    } catch {
      continue
    }
    if (raw && typeof raw === 'object' && typeof raw.get === 'function') {
      try {
        raw = raw.get()
      } catch {
        raw = undefined
      }
    }
    const value = triState(raw)
    if (value !== undefined) out[key] = value
  }
  return out
}

/**
 * @param {{ store: { readSettings(): Promise<Record<string, unknown>|undefined>, writeSettings(value: Record<string, unknown>): Promise<void> }, config?: unknown }} options
 */
export async function createSettings(options) {
  const { store, config } = options
  const seed = readConfig(config)
  const state = { ...seed }
  /** @type {Set<(state: { webSearch: boolean, codeSearch: boolean }, reason: string) => void>} */
  const listeners = new Set()
  let writing = Promise.resolve()

  // A persisted override only replaces keys it explicitly stores as booleans.
  try {
    const saved = await store.readSettings()
    if (saved) {
      for (const key of Object.keys(DEFAULTS)) {
        const value = triState(saved[key])
        if (value !== undefined) state[key] = value
      }
    }
  } catch {
    // Unreadable settings must not stop the plugin; the patch values stand.
  }

  /** @param {string} reason */
  const emit = (reason) => {
    const snapshot = { ...state }
    for (const listener of [...listeners]) {
      try {
        listener(snapshot, reason)
      } catch {
        // A broken subscriber must not break the others.
      }
    }
  }

  return {
    /** @returns {{ webSearch: boolean, codeSearch: boolean }} */
    get() {
      return { ...state }
    },

    /** @param {'webSearch'|'codeSearch'} key */
    isEnabled(key) {
      return state[key] !== false
    },

    /**
     * Apply and persist a partial change. Unknown keys are ignored; a value that
     * already matches is a no-op so subscribers are not woken for nothing.
     *
     * @param {Record<string, unknown>} partial
     * @returns {Promise<{ webSearch: boolean, codeSearch: boolean }>}
     */
    async patch(partial) {
      let changed = false
      for (const key of Object.keys(DEFAULTS)) {
        if (!partial || !(key in partial)) continue
        const value = triState(partial[key])
        if (value === undefined || value === state[key]) continue
        state[key] = value
        changed = true
      }
      if (!changed) return { ...state }
      const snapshot = { ...state }
      // Serialize writes; a failed write keeps the in-memory value (the running
      // session still behaves as the user asked) and is reported to the caller.
      writing = writing.then(
        () => store.writeSettings(snapshot),
        () => store.writeSettings(snapshot),
      )
      emit('patch')
      await writing
      return { ...state }
    },

    /**
     * @param {(state: { webSearch: boolean, codeSearch: boolean }, reason: string) => void} listener
     * @returns {() => void} unsubscribe
     */
    subscribe(listener) {
      if (typeof listener !== 'function') return () => {}
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    /** @param {string} reason */
    notify(reason) {
      emit(reason)
    },
  }
}
