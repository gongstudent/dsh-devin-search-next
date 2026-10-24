/**
 * dsh-devin-search-next — browser half of the Devin Search plugin bundle.
 *
 * Written as plain dependency-free JavaScript on purpose. The old client bundle
 * imported harness-internal client packages (a UI primitives package plus two
 * client services that no longer exist), so it silently stopped loading on the
 * next harness release. This file must survive DSH upgrades, therefore:
 *
 *   1. No import/require of ANY harness package. The only module-table word this
 *      bundle asks for is `react`; every service is feature-detected through
 *      `ctx.get(...)`.
 *   2. Nothing may throw out of `apply()` or out of a component. Every service
 *      lookup, every slot registration and every HTTP call is individually
 *      guarded, and a soft failure only costs the feature that needed it.
 *   3. Components render correctly with no props at all (a slot owner may pass
 *      an empty owner share), so every field is read through a shape check.
 *   4. The only top-level side effect is the `__ModuleLoader__` registration.
 *   5. The one-time authorization code lives in a password field, is sent once
 *      in a POST body, is cleared immediately, and is never echoed or logged.
 *
 * The host half owns the Devin session and every upstream request. This file
 * only calls the plugin's own `/api/devin/*` JSON routes.
 *
 * @module dsh-devin-search-next/client
 */

if (typeof window !== 'undefined' && window !== null && window.__ModuleLoader__ !== undefined
  && window.__ModuleLoader__ !== null && typeof window.__ModuleLoader__.load === 'function') {
  window.__ModuleLoader__.load({
    id: 'dsh-devin-search-next',
    factory: function (require) {
      const module = { exports: {} }
      const exports = module.exports
      try {
        Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
      } catch (ignored) {
        // A frozen/odd exports object is not a reason to fail the bundle.
      }

      //#region module table
      let React = null
      let h = null
      try {
        React = require('react')
        if (React !== null && React !== undefined && typeof React.createElement === 'function') {
          h = React.createElement
        }
      } catch (error) {
        React = null
        h = null
      }

      /** A hook, or a harmless stand-in: a component must render even without it. */
      function hook(name, fallback) {
        if (React !== null && React !== undefined && typeof React[name] === 'function') return React[name]
        return fallback
      }

      const useState = hook('useState', function (initial) {
        return [typeof initial === 'function' ? initial() : initial, function () {}]
      })
      const useEffect = hook('useEffect', function () {})
      const useRef = hook('useRef', function (initial) { return { current: initial } })
      //#endregion


      //#region constants
      const NS = 'devin-search'
      const BUNDLE_ID = 'dsh-devin-search-next'
      const CLIENT_NAME = 'dsh-devin-search-next-client'
      const COMMAND_SLOT = 'conversation.chat.commandview'
      const SECTION_SLOT = 'settings.section'
      const GENERAL_SLOT = 'settings.general.item'
      const SECTION_ID = 'devin-search'
      const GENERAL_ORDER = 40
      const SECTION_ORDER = 60
      const CSS_TAG_ID = BUNDLE_ID + '/client.css'

      /**
       * Host routes, exactly as the plugin's `adapter-api.js` mounts them. The
       * harness only accepts connection Fetch routes under `/api`, so every path
       * carries that prefix; responses are `{ ok: true, ... }` on success and
       * `{ ok: false, error }` with 4xx/5xx on failure.
       */
      const API = {
        state: '/api/devin/state',
        login: '/api/devin/login',
        loginCode: '/api/devin/login/code',
        settings: '/api/devin/settings',
        logout: '/api/devin/logout',
        cancel: '/api/devin/cancel',
      }
      const REQUEST_TIMEOUT_MS = 5000
      const POLL_INTERVAL_MS = 1500
      const PENDING_PHASES = { pending: true, exchanging: true }
      const COMMAND_NAMES = ['devin-login', 'devin-status', 'devin-logout', 'devin-cancel']
      //#endregion


      //#region small helpers
      /** Object shape probe that never throws on exotic values. */
      function isObject(value) {
        return value !== null && value !== undefined && typeof value === 'object' && Array.isArray(value) === false
      }

      function hasOwn(value, key) {
        try {
          return Object.prototype.hasOwnProperty.call(value, key)
        } catch (error) {
          return false
        }
      }

      /** Never let diagnostics become the failure they are reporting. */
      function warn(where, error) {
        try {
          if (typeof console === 'undefined' || console === null) return
          const message = '[devin-search] ' + String(where) + ' failed'
          if (typeof console.warn === 'function') console.warn(message, error)
          else if (typeof console.log === 'function') console.log(message, error)
        } catch (ignored) {
          // A host without a usable console is not a reason to throw.
        }
      }

      /** Human text for anything thrown by fetch, a route or JSON parsing. */
      function messageOf(error) {
        if (error === null || error === undefined) return ''
        if (typeof error === 'string') return error
        if (typeof error.message === 'string' && error.message.length > 0) return error.message
        return String(error)
      }

      function text(value, fallback) {
        return typeof value === 'string' ? value : (fallback === undefined ? '' : fallback)
      }

      function formatTime(value) {
        const raw = text(value)
        if (raw === '') return ''
        try {
          const date = new Date(raw)
          const time = date.getTime()
          if (time !== time) return raw
          return date.toLocaleString()
        } catch (error) {
          return raw
        }
      }

      function isPendingPhase(phase) {
        return phase === 'pending' || phase === 'exchanging'
      }

      /** Copy an object into a fresh null-prototype-free record (never mutate shared state). */
      function assign(base, patch) {
        const target = {}
        if (isObject(base)) {
          for (const key in base) {
            if (hasOwn(base, key)) target[key] = base[key]
          }
        }
        if (isObject(patch)) {
          for (const key in patch) {
            if (hasOwn(patch, key)) target[key] = patch[key]
          }
        }
        return target
      }
      //#endregion


      //#region http
      function httpError(status, message) {
        const error = new Error(message === undefined || message === '' ? 'request failed' : String(message))
        error.status = typeof status === 'number' ? status : 0
        return error
      }

      function errorText(props, error) {
        const status = error !== null && error !== undefined && typeof error.status === 'number' ? error.status : 0
        const detail = messageOf(error)
        if (status === 0) {
          const base = tr(props, 'networkError')
          return detail === '' ? base : base + ' (' + detail + ')'
        }
        const base = tr(props, 'requestFailed', { status: String(status) })
        return detail === '' ? base : base + '：' + detail
      }

      function readJsonBody(response) {
        try {
          if (response !== null && response !== undefined && typeof response.json === 'function') {
            const parsed = response.json()
            return Promise.resolve(parsed)
          }
        } catch (error) {
          // fall through to the rejection below
        }
        return Promise.reject(new Error('response body is not JSON'))
      }

      function errorBodyText(payload) {
        if (isObject(payload) && typeof payload.error === 'string' && payload.error.length > 0) return payload.error
        return ''
      }

      /**
       * One JSON request against this plugin's own host routes.
       * Never rejects without a readable message; 5s AbortController timeout.
       */
      function requestJson(path, options) {
        const init = isObject(options) ? options : {}
        return new Promise(function (resolve, reject) {
          if (typeof fetch !== 'function') {
            reject(httpError(0, 'fetch is unavailable in this renderer'))
            return
          }
          let controller = null
          let timer = null
          try {
            if (typeof AbortController === 'function') controller = new AbortController()
          } catch (error) {
            controller = null
          }
          if (controller !== null && typeof setTimeout === 'function') {
            try {
              timer = setTimeout(function () {
                try {
                  controller.abort()
                } catch (ignored) {
                  // Abort on an already-settled request is harmless.
                }
              }, REQUEST_TIMEOUT_MS)
            } catch (error) {
              timer = null
            }
          }
          /** Clear the timeout exactly once. */
          function clearTimer() {
            if (timer === null || typeof clearTimeout !== 'function') return
            try {
              clearTimeout(timer)
            } catch (ignored) {
              // ignore
            }
            timer = null
          }
          const requestInit = {
            method: init.method === 'POST' ? 'POST' : 'GET',
            cache: 'no-store',
            credentials: 'same-origin',
          }
          if (controller !== null) requestInit.signal = controller.signal
          if (init.body !== undefined && init.body !== null) {
            requestInit.headers = { 'content-type': 'application/json' }
            requestInit.body = JSON.stringify(init.body)
          }
          let pending
          try {
            pending = fetch(path, requestInit)
          } catch (error) {
            clearTimer()
            reject(httpError(0, messageOf(error)))
            return
          }
          Promise.resolve(pending).then(function (response) {
            clearTimer()
            const status = isObject(response) && typeof response.status === 'number' ? response.status : 0
            const ok = isObject(response) && response.ok === true
            readJsonBody(response).then(function (payload) {
              if (!ok) {
                reject(httpError(status, errorBodyText(payload)))
                return
              }
              if (!isObject(payload)) {
                reject(httpError(status, 'response was not a JSON object'))
                return
              }
              if (payload.ok === false) {
                reject(httpError(status, errorBodyText(payload)))
                return
              }
              resolve(payload)
            }, function () {
              reject(httpError(status, 'response was not JSON'))
            })
          }, function (error) {
            clearTimer()
            const detail = messageOf(error)
            if (isObject(error) && error.name === 'AbortError') {
              reject(httpError(0, 'request timed out'))
              return
            }
            reject(httpError(0, detail))
          })
        })
      }
      //#endregion


      //#region dictionaries
      /**
       * Bilingual copy. Both dictionaries declare exactly the same keys, so a
       * one-sided edit cannot ship half a translation (the smoke test asserts
       * key parity between them).
       */
      const MESSAGES = {
        zh: {
          title: 'Devin 搜索',
          subtitle: '由 Devin 提供的网页搜索与代码检索',
          settingsSubtitle: '登录一次即生效；关闭搜索开关不会退出登录。',
          accountTitle: 'Devin 账号',
          accountSignedIn: '已登录',
          accountSignedOut: '未登录',
          accountPending: '等待授权',
          accountExchanging: '正在验证授权码',
          accountCancelled: '登录已取消',
          accountError: '登录失败',
          sessionExpires: '有效期至 {when}',
          expiresLabel: '有效期',
          settingsSectionAria: 'Devin 搜索设置',
          loadingState: '正在读取状态…',
          signIn: '登录 Devin',
          signInStarting: '正在创建授权链接…',
          signOut: '退出登录',
          cancelLogin: '取消登录等待',
          startHint: '点击登录后会生成一条授权链接；在浏览器里完成 Devin 授权，再把一次性授权码粘贴回来。',
          authUrlLabel: '授权链接',
          copyUrl: '复制链接',
          copied: '已复制',
          openInBrowser: '在新标签页打开',
          codeLabel: '一次性授权码',
          codePlaceholder: '粘贴 Devin 页面显示的授权码',
          codeHelp: '授权码只会提交给本机 DSH 服务，不会回显，也不会写入日志。',
          submitCode: '提交授权码',
          submitting: '正在验证…',
          waitingHint: '等待浏览器授权；完成后这里会自动更新。',
          waitingNoUrl: '授权链接还没生成，稍等片刻…',
          loopbackHint: '本机回调模式：在这台机器的浏览器里完成授权即可，授权完成后这里会自动更新，不需要粘贴授权码。',
          loginSuccess: '授权成功，凭据已保存在本机。',
          alreadySignedIn: '当前已登录（有效期至 {when}）。如需换账号，请先退出登录。',
          loginError: '授权失败：{detail}',
          loginCancelled: '登录等待已取消。',
          logoutDone: '已退出登录，本机凭据已清除。',
          cancelDone: '登录等待已取消，已有登录状态不受影响。',
          refresh: '刷新',
          refreshing: '刷新中…',
          requestFailed: '请求失败（HTTP {status}）',
          networkError: '网络请求失败，请检查连接。',
          invalidResponse: 'DSH 返回了无法识别的响应。',
          staleAttempt: '这次登录请求已失效，请重新开始。',
          emptyCode: '请先粘贴授权码。',
          loginTitle: 'Devin 登录',
          statusTitle: 'Devin 状态',
          logoutTitle: 'Devin 退出登录',
          cancelTitle: 'Devin 取消登录',
          running: '处理中…',
          failed: '失败',
          done: '完成',
          signedInStatus: '已登录',
          signedOutStatus: '未登录',
          pendingStatus: '等待授权',
          enabled: '已开启',
          disabled: '已关闭',
          webSearch: '网页搜索',
          webSearchHint: '把 web_search 交给 Devin 处理',
          codeSearch: '代码搜索',
          codeSearchHint: '在当前工作区内做语义代码检索',
          switchAria: '{title}开关',
          statusHint: '运行 /devin-login 开始授权，/devin-logout 退出登录。',
          reloadHint: '如需重新建立授权，运行 /devin-login。',
          commandFailed: '命令执行失败：{detail}',
          commandDone: '已完成。',
          unknownPhase: '未知状态',
        },
        en: {
          title: 'Devin Search',
          subtitle: 'Web search and code search backed by Devin',
          settingsSubtitle: 'One sign-in covers every conversation; turning a search switch off never signs you out.',
          accountTitle: 'Devin account',
          accountSignedIn: 'Signed in',
          accountSignedOut: 'Not signed in',
          accountPending: 'Waiting for authorization',
          accountExchanging: 'Verifying the authorization code',
          accountCancelled: 'Sign-in cancelled',
          accountError: 'Sign-in failed',
          sessionExpires: 'Expires {when}',
          expiresLabel: 'Expires',
          settingsSectionAria: 'Devin Search settings',
          loadingState: 'Reading status…',
          signIn: 'Sign in to Devin',
          signInStarting: 'Creating the authorization link…',
          signOut: 'Sign out',
          cancelLogin: 'Cancel sign-in',
          startHint: 'Signing in creates an authorization link. Finish the Devin authorization in your browser, then paste the one-time code back here.',
          authUrlLabel: 'Authorization link',
          copyUrl: 'Copy link',
          copied: 'Copied',
          openInBrowser: 'Open in a new tab',
          codeLabel: 'One-time authorization code',
          codePlaceholder: 'Paste the code shown on the Devin page',
          codeHelp: 'The code is sent only to the local DSH service. It is never echoed back and never logged.',
          submitCode: 'Submit code',
          submitting: 'Verifying…',
          waitingHint: 'Waiting for the browser authorization; this view updates by itself.',
          waitingNoUrl: 'The authorization link is not ready yet…',
          loopbackHint: 'Same-machine callback mode: finish the authorization in a browser on this machine. This view updates by itself; there is no code to paste.',
          loginSuccess: 'Authorized. The credential is stored on this machine.',
          alreadySignedIn: 'Already signed in (expires {when}). Sign out first to switch accounts.',
          loginError: 'Authorization failed: {detail}',
          loginCancelled: 'The sign-in wait was cancelled.',
          logoutDone: 'Signed out; the stored Devin session was cleared.',
          cancelDone: 'The sign-in wait was cancelled; an existing session is untouched.',
          refresh: 'Refresh',
          refreshing: 'Refreshing…',
          requestFailed: 'Request failed (HTTP {status})',
          networkError: 'Network request failed. Check your connection.',
          invalidResponse: 'DSH returned an unrecognized response.',
          staleAttempt: 'This sign-in request is no longer active. Start again.',
          emptyCode: 'Paste the authorization code first.',
          loginTitle: 'Devin sign-in',
          statusTitle: 'Devin status',
          logoutTitle: 'Devin sign-out',
          cancelTitle: 'Devin cancel sign-in',
          running: 'Working…',
          failed: 'Failed',
          done: 'Done',
          signedInStatus: 'Signed in',
          signedOutStatus: 'Not signed in',
          pendingStatus: 'Waiting for authorization',
          enabled: 'On',
          disabled: 'Off',
          webSearch: 'Web search',
          webSearchHint: 'Route web_search through Devin',
          codeSearch: 'Code search',
          codeSearchHint: 'Semantic search over the current workspace',
          switchAria: '{title} switch',
          statusHint: 'Run /devin-login to authorize; run /devin-logout to sign out.',
          reloadHint: 'Run /devin-login to authorize again.',
          commandFailed: 'The command failed: {detail}',
          commandDone: 'Done.',
          unknownPhase: 'Unknown state',
        },
      }

      /** The locale service, when it exists (assigned once in apply). */
      let localeService = null

      /** Active locale id: host locale first, browser language second, zh last. */
      function activeLocaleId() {
        try {
          if (localeService !== null && typeof localeService.getLocale === 'function') {
            const snapshot = localeService.getLocale()
            const active = isObject(snapshot) ? text(snapshot.active) : ''
            if (active.length > 0) return active.toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en'
          }
          if (localeService !== null && typeof localeService.getSnapshot === 'function') {
            const snapshot = localeService.getSnapshot()
            const active = isObject(snapshot) ? text(snapshot.active) : ''
            if (active.length > 0) return active.toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en'
          }
        } catch (error) {
          // fall through to the browser language
        }
        try {
          if (typeof navigator !== 'undefined' && navigator !== null && typeof navigator.language === 'string') {
            return navigator.language.toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en'
          }
        } catch (error) {
          // fall through to the default
        }
        return 'zh'
      }

      function substitute(template, vars) {
        let result = template
        if (!isObject(vars)) return result
        for (const name in vars) {
          if (!hasOwn(vars, name)) continue
          result = result.split('{' + name + '}').join(String(vars[name]))
        }
        return result
      }

      /** Bundled translate: always resolves, even with neither locale service nor host t. */
      function t(key, vars) {
        const dictionary = activeLocaleId() === 'en' ? MESSAGES.en : MESSAGES.zh
        let template = dictionary[key]
        if (typeof template !== 'string') template = MESSAGES.zh[key]
        if (typeof template !== 'string') template = MESSAGES.en[key]
        if (typeof template !== 'string') return String(key)
        return substitute(template, vars)
      }

      /**
       * Component translate: prefer the host-injected `t` seat (declared through
       * the slot's `locale:` option) and fall back to the bundled dictionary when
       * it is missing, throws, or cannot resolve the key.
       */
      function tr(props, key, vars) {
        if (isObject(props) && typeof props.t === 'function') {
          try {
            const value = vars === undefined ? props.t(key) : props.t(key, vars)
            if (typeof value === 'string' && value.length > 0 && value !== key) return value
          } catch (error) {
            // fall through to the bundled dictionary
          }
        }
        return t(key, vars)
      }
      //#endregion


      //#region shared store
      let shared = {
        loaded: false,
        loading: false,
        signedIn: false,
        login: null,
        settings: { webSearch: true, codeSearch: true },
        message: '',
        expiresAt: '',
        error: '',
      }
      const sharedListeners = []
      let sharedInflight = null
      let sharedAt = 0

      function publishShared(patch) {
        shared = assign(shared, patch)
        const listeners = sharedListeners.slice()
        for (let index = 0; index < listeners.length; index += 1) {
          try {
            listeners[index]()
          } catch (error) {
            warn('store listener', error)
          }
        }
      }

      function subscribeShared(listener) {
        if (typeof listener !== 'function') return function () {}
        sharedListeners.push(listener)
        return function () {
          const index = sharedListeners.indexOf(listener)
          if (index >= 0) sharedListeners.splice(index, 1)
        }
      }

      function adaptLogin(value) {
        if (!isObject(value)) return null
        const phase = text(value.phase, 'idle')
        const attemptId = text(value.attemptId)
        if (phase === 'idle' && attemptId === '') return null
        return {
          phase: phase,
          pending: value.pending === true || isPendingPhase(phase),
          attemptId: attemptId,
          mode: text(value.mode),
          url: text(value.url),
          detail: text(value.detail),
        }
      }

      function adaptSettings(value) {
        const source = isObject(value) ? value : {}
        return {
          webSearch: source.webSearch !== false,
          codeSearch: source.codeSearch !== false,
        }
      }

      function adaptState(payload) {
        const value = isObject(payload) ? payload : {}
        let expiresAt = ''
        if (typeof value.expiresAt === 'string') expiresAt = value.expiresAt
        else if (typeof value.expiresAt === 'number') {
          try {
            expiresAt = new Date(value.expiresAt).toISOString()
          } catch (error) {
            expiresAt = ''
          }
        }
        return {
          signedIn: value.signedIn === true,
          login: adaptLogin(value.login),
          settings: adaptSettings(value.settings),
          message: text(value.message),
          expiresAt: expiresAt,
        }
      }

      function applyLogin(value) {
        const login = adaptLogin(value)
        publishShared({ login: login })
        return login
      }

      /** GET /api/devin/state; never rejects (the failure text lands on the store). */
      function loadShared(force) {
        if (sharedInflight !== null) return sharedInflight
        if (force !== true && shared.loaded === true) return Promise.resolve(shared)
        publishShared({ loading: true })
        sharedInflight = requestJson(API.state).then(function (payload) {
          sharedInflight = null
          sharedAt = Date.now()
          const next = adaptState(payload)
          publishShared({
            loaded: true,
            loading: false,
            signedIn: next.signedIn,
            login: next.login,
            settings: next.settings,
            message: next.message,
            expiresAt: next.expiresAt,
            error: '',
          })
          return shared
        }, function (error) {
          sharedInflight = null
          publishShared({ loading: false, error: errorText(null, error) })
          return shared
        })
        return sharedInflight
      }

      /** Refresh the shared snapshot, but skip the request when it is fresh enough. */
      function refreshShared(minAgeMs) {
        const age = sharedAt === 0 ? Infinity : Date.now() - sharedAt
        if (shared.loaded === true && age < (typeof minAgeMs === 'number' ? minAgeMs : 0)) return Promise.resolve(shared)
        return loadShared(true)
      }

      /** Subscribe a component to the shared snapshot. */
      function useShared() {
        const pair = useState(shared)
        const snapshot = pair[0]
        const setSnapshot = pair[1]
        useEffect(function () {
          let alive = true
          setSnapshot(shared)
          const unsubscribe = subscribeShared(function () {
            if (alive) setSnapshot(shared)
          })
          return function () {
            alive = false
            unsubscribe()
          }
        }, [])
        return snapshot
      }
      //#endregion


      //#region login polling
      const pollState = { refs: 0, timer: null, stopped: true }

      function stopPolling() {
        pollState.stopped = true
        if (pollState.timer !== null && typeof clearTimeout === 'function') {
          try {
            clearTimeout(pollState.timer)
          } catch (error) {
            // ignore
          }
        }
        pollState.timer = null
      }

      function schedulePoll(delay) {
        if (pollState.stopped === true || typeof setTimeout !== 'function') return
        if (pollState.timer !== null) {
          try {
            clearTimeout(pollState.timer)
          } catch (error) {
            // ignore
          }
        }
        pollState.timer = setTimeout(function () {
          pollState.timer = null
          pollOnce()
        }, typeof delay === 'number' ? delay : POLL_INTERVAL_MS)
      }

      function pollOnce() {
        if (pollState.stopped === true) return
        const login = shared.login
        const attemptId = isObject(login) ? text(login.attemptId) : ''
        if (attemptId === '') {
          stopPolling()
          return
        }
        requestJson(API.login + '?attemptId=' + encodeURIComponent(attemptId)).then(function (payload) {
          if (pollState.stopped === true) return
          const next = adaptLogin({
            attemptId: attemptId,
            phase: text(isObject(payload) ? payload.phase : '', 'idle'),
            pending: isObject(payload) ? payload.pending === true : false,
            detail: isObject(payload) ? payload.detail : '',
          })
          publishShared({ login: next })
          if (next === null || next.pending !== true) {
            stopPolling()
            if (next !== null && next.phase === 'authorized') refreshShared(0)
            return
          }
          schedulePoll()
        }, function (error) {
          if (pollState.stopped === true) return
          const status = isObject(error) && typeof error.status === 'number' ? error.status : 0
          publishShared({ error: errorText(null, error) })
          if (status === 401 || status === 403 || status === 404) {
            stopPolling()
            return
          }
          // Transient: keep trying, the card shows the last failure text.
          schedulePoll()
        })
      }

      /**
       * Ref-counted poll controller: several cards (and the settings page) can be
       * mounted at once, and unmounting every one of them stops the timer.
       */
      function acquirePolling() {
        pollState.refs += 1
        if (pollState.stopped === true) {
          pollState.stopped = false
          schedulePoll(0)
        }
        let released = false
        return function () {
          if (released) return
          released = true
          pollState.refs -= 1
          if (pollState.refs <= 0) {
            pollState.refs = 0
            stopPolling()
          }
        }
      }
      //#endregion


      //#region clipboard
      function writeClipboard(value) {
        return new Promise(function (resolve, reject) {
          try {
            if (typeof navigator !== 'undefined' && navigator !== null && navigator.clipboard !== null
              && navigator.clipboard !== undefined && typeof navigator.clipboard.writeText === 'function') {
              navigator.clipboard.writeText(value).then(resolve, function () { fallback() })
              return
            }
            fallback()
          } catch (error) {
            reject(error)
          }
          /** Old-school path for a renderer without the async clipboard API. */
          function fallback() {
            try {
              if (typeof document === 'undefined' || document === null || document.body === null
                || document.body === undefined) {
                reject(new Error('clipboard is unavailable'))
                return
              }
              const area = document.createElement('textarea')
              area.value = value
              area.setAttribute('readonly', 'readonly')
              area.style.position = 'fixed'
              area.style.left = '-10000px'
              area.style.opacity = '0'
              document.body.appendChild(area)
              if (typeof area.select === 'function') area.select()
              const copied = typeof document.execCommand === 'function' && document.execCommand('copy') === true
              document.body.removeChild(area)
              if (copied) resolve()
              else reject(new Error('copy failed'))
            } catch (error) {
              reject(error)
            }
          }
        })
      }
      //#endregion


      //#region stylesheet
      const CSS = [
        '.dvn-card{display:flex;flex-direction:column;gap:8px;box-sizing:border-box;max-width:720px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));border-radius:10px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#0f1115);font-size:13px;line-height:20px;text-align:left}',
        '.dvn-card[data-tone=error]{border-color:var(--dsw-alias-state-error-primary,#ec1313)}',
        '.dvn-card[data-tone=warn]{border-color:var(--dsw-alias-state-warn-primary,#f59e0b)}',
        '.dvn-card-head{display:flex;align-items:center;gap:8px;min-width:0}',
        '.dvn-mark{flex:none;display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;box-sizing:border-box;border-radius:5px;background:var(--dsw-alias-state-business-primary,#4176e6);color:var(--dsw-alias-label-primary-foreground,#fff);font-size:11px;font-weight:600;line-height:1}',
        '.dvn-card-title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,#0f1115)}',
        '.dvn-badge{flex:none;margin-left:auto;padding:1px 8px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));border-radius:999px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary,#61666b);white-space:nowrap}',
        '.dvn-badge[data-tone=error]{color:var(--dsw-alias-state-error-primary,#ec1313);border-color:currentColor}',
        '.dvn-badge[data-tone=ok]{color:var(--dsw-alias-state-success-primary,#22c55e);border-color:currentColor}',
        '.dvn-badge[data-tone=warn]{color:var(--dsw-alias-state-warn-label,#dd8629);border-color:currentColor}',
        '.dvn-card-sub{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#81858c);overflow-wrap:anywhere}',
        '.dvn-card-body{display:flex;flex-direction:column;gap:8px;min-width:0}',
        '.dvn-line{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#61666b)}',
        '.dvn-note{margin:0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#81858c);overflow-wrap:anywhere}',
        '.dvn-error{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary,#ec1313);overflow-wrap:anywhere}',
        '.dvn-url{margin:0;padding:6px 8px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.06));border-radius:8px;background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.06));color:var(--dsw-alias-label-secondary,#61666b);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;line-height:16px;word-break:break-all;user-select:all}',
        '.dvn-actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px}',
        '.dvn-btn{display:inline-flex;align-items:center;justify-content:center;gap:4px;margin:0;padding:3px 10px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,#61666b);font:inherit;font-size:12px;line-height:18px;white-space:nowrap;text-decoration:none;cursor:pointer}',
        '.dvn-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.08));color:var(--dsw-alias-label-primary,#0f1115)}',
        '.dvn-btn:disabled{opacity:.5;cursor:default}',
        '.dvn-btn:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-alias-state-business-primary,#4176e6)}',
        '.dvn-btn[data-primary=true]{border-color:transparent;background:var(--dsw-alias-state-business-primary,#4176e6);color:var(--dsw-alias-label-primary-foreground,#fff)}',
        '.dvn-btn[data-primary=true]:hover:not(:disabled){background:var(--dsw-alias-state-business-primary,#4176e6);opacity:.92;color:var(--dsw-alias-label-primary-foreground,#fff)}',
        '.dvn-form{display:flex;flex-direction:column;gap:6px;min-width:0}',
        '.dvn-label{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#61666b)}',
        '.dvn-input{box-sizing:border-box;width:100%;margin:0;padding:5px 8px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary,#0f1115);font:inherit;font-size:12px;line-height:18px}',
        '.dvn-input:focus-visible{outline:none;border-color:transparent;box-shadow:0 0 0 2px var(--dsw-alias-state-business-primary,#4176e6)}',
        '.dvn-input::placeholder{color:var(--dsw-alias-label-dimmed,#e1e5ee)}',
        '.dvn-kv{display:flex;align-items:baseline;justify-content:space-between;gap:12px;font-size:12px;line-height:18px}',
        '.dvn-kv-key{flex:none;color:var(--dsw-alias-label-tertiary,#81858c)}',
        '.dvn-kv-val{min-width:0;text-align:right;overflow-wrap:anywhere;color:var(--dsw-alias-label-primary,#0f1115)}',
        '.dvn-kv-val[data-tone=ok]{color:var(--dsw-alias-state-success-primary,#22c55e)}',
        '.dvn-kv-val[data-tone=error]{color:var(--dsw-alias-state-error-primary,#ec1313)}',
        '.dvn-kv-val[data-tone=muted]{color:var(--dsw-alias-label-tertiary,#81858c)}',
        '.dvn-switch{position:relative;flex:none;box-sizing:border-box;width:34px;height:20px;padding:0;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));border-radius:999px;background:var(--dsw-alias-interactive-bg-active,rgba(38,49,72,.1));cursor:pointer;transition:background .15s ease,border-color .15s ease}',
        '.dvn-switch[data-checked=true]{border-color:transparent;background:var(--dsw-alias-state-business-primary,#4176e6)}',
        '.dvn-switch[data-disabled=true]{opacity:.5;cursor:default}',
        '.dvn-switch:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-alias-state-business-primary,#4176e6)}',
        '.dvn-switch-knob{position:absolute;top:2px;left:2px;display:block;width:14px;height:14px;border-radius:999px;background:var(--dsw-alias-label-primary-foreground,#fff);box-shadow:0 1px 2px rgba(0,0,0,.2);transition:transform .15s ease}',
        '.dvn-switch[data-checked=true] .dvn-switch-knob{transform:translateX(14px)}',
        '.dvn-flow{display:flex;flex-direction:column;gap:8px;min-width:0}',
        '.dvn-account{display:flex;flex-direction:column;min-width:0}',
        '.dvn-section{display:flex;flex-direction:column;width:100%;box-sizing:border-box;color:var(--dsw-alias-label-primary,#0f1115);font-size:14px;line-height:22px}',
        '.dvn-section-head{display:flex;flex-direction:column;gap:2px;padding:0 0 6px}',
        '.dvn-section-title{margin:0;font-size:16px;font-weight:500;line-height:24px;color:var(--dsw-alias-label-primary,#0f1115)}',
        '.dvn-section-sub{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#81858c)}',
        '.dvn-item{display:flex;align-items:flex-start;justify-content:space-between;gap:24px;padding:16px 0;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1))}',
        '.dvn-item-main{display:flex;flex-direction:column;gap:2px;min-width:0}',
        '.dvn-item-title{font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary,#0f1115)}',
        '.dvn-item-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#81858c);overflow-wrap:anywhere}',
        '.dvn-item-side{display:flex;flex:none;align-items:center;gap:8px}',
        '.dvn-inline{padding:0 0 16px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1))}',
        '.dvn-foot{margin:0;padding:12px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#81858c)}',
        '@media (prefers-reduced-motion:reduce){.dvn-switch,.dvn-switch-knob{transition:none}}',
      ].join('')

      /** Install the stylesheet, comparing content so an HMR swap still updates it. */
      function injectCss() {
        try {
          if (typeof document === 'undefined' || document === null || document.head === undefined
            || document.head === null) return
          const selector = 'style[data-plugin-css=' + JSON.stringify(CSS_TAG_ID) + ']'
          let existing = null
          try {
            existing = document.querySelector(selector)
          } catch (error) {
            existing = null
          }
          if (existing !== null && existing !== undefined && existing.textContent === CSS) return
          const tag = existing !== null && existing !== undefined ? existing : document.createElement('style')
          if (tag === null || tag === undefined) return
          if (tag.dataset !== undefined && tag.dataset !== null) {
            tag.dataset.plugin = BUNDLE_ID
            tag.dataset.pluginCss = CSS_TAG_ID
          } else if (typeof tag.setAttribute === 'function') {
            tag.setAttribute('data-plugin', BUNDLE_ID)
            tag.setAttribute('data-plugin-css', CSS_TAG_ID)
          }
          tag.textContent = CSS
          if (existing === null || existing === undefined) document.head.appendChild(tag)
        } catch (error) {
          warn('stylesheet', error)
        }
      }

      /** Remove only OUR stylesheet content (a newer release's node must survive). */
      function removeCss() {
        try {
          if (typeof document === 'undefined' || document === null) return
          const tag = document.querySelector('style[data-plugin-css=' + JSON.stringify(CSS_TAG_ID) + ']')
          if (tag !== null && tag !== undefined && tag.textContent === CSS && typeof tag.remove === 'function') tag.remove()
        } catch (error) {
          warn('stylesheet removal', error)
        }
      }
      //#endregion


      //#region props helpers
      function propsOf(value) {
        return isObject(value) ? value : {}
      }

      function nodeOf(props) {
        const p = propsOf(props)
        return isObject(p.node) ? p.node : null
      }

      /** Command name from the owner's CommandNode (never assume it exists). */
      function commandName(props) {
        const node = nodeOf(props)
        if (node !== null && typeof node.name === 'string' && node.name.length > 0) return node.name
        const p = propsOf(props)
        return typeof p.name === 'string' ? p.name : ''
      }

      function outcomeOf(props) {
        const node = nodeOf(props)
        if (node === null) return null
        const outcome = node.outcome
        if (!isObject(outcome)) return null
        return {
          kind: outcome.kind === 'error' ? 'error' : 'success',
          text: text(outcome.text),
        }
      }

      function isCommandRunning(props) {
        const node = nodeOf(props)
        if (node === null) return false
        return node.outcome === null || node.outcome === undefined
      }
      //#endregion


      //#region switch
      /**
       * The switch owned by this bundle: role="switch", aria-checked, and
       * Enter/Space activation. A div (not a button) is deliberate — keyboard
       * handling is explicit here, so a key can never toggle twice through the
       * browser's own button activation.
       */
      function Switch(props) {
        const p = propsOf(props)
        const checked = p.checked === true
        const disabled = p.disabled === true
        const label = text(p.label)
        const labelledBy = text(p.labelledBy)
        const onChange = typeof p.onChange === 'function' ? p.onChange : null

        function commit() {
          if (disabled || onChange === null) return
          try {
            onChange(!checked)
          } catch (error) {
            warn('switch change', error)
          }
        }

        function onKeyDown(event) {
          if (event === null || event === undefined) return
          const key = event.key
          if (key !== 'Enter' && key !== ' ' && key !== 'Spacebar') return
          if (typeof event.preventDefault === 'function') event.preventDefault()
          commit()
        }

        return h('div', {
          className: 'dvn-switch',
          role: 'switch',
          tabIndex: disabled ? -1 : 0,
          'aria-checked': checked ? 'true' : 'false',
          'aria-disabled': disabled ? 'true' : 'false',
          'aria-label': label === '' ? undefined : label,
          'aria-labelledby': labelledBy === '' ? undefined : labelledBy,
          'data-checked': checked ? 'true' : 'false',
          'data-disabled': disabled ? 'true' : 'false',
          onClick: disabled ? undefined : commit,
          onKeyDown: disabled ? undefined : onKeyDown,
        }, h('span', { className: 'dvn-switch-knob', 'aria-hidden': 'true' }))
      }
      //#endregion


      //#region login journey
      /** Monotonic local id suffix for label/input wiring (no DOM id generator needed). */
      let localIdSeq = 0
      function nextLocalId(prefix) {
        localIdSeq += 1
        return prefix + '-' + String(localIdSeq)
      }

      /**
       * Everything the login UI needs: shared snapshot, local busy/notice state,
       * the code field, and the five actions. Called by LoginPanel only, so the
       * hook order is stable.
       */
      function useLoginJourney(props) {
        const p = propsOf(props)
        const snapshot = useShared()
        const busyPair = useState('')
        const busy = busyPair[0]
        const setBusy = busyPair[1]
        const codePair = useState('')
        const code = codePair[0]
        const setCode = codePair[1]
        const noticePair = useState('')
        const notice = noticePair[0]
        const setNotice = noticePair[1]
        const copiedPair = useState(false)
        const copied = copiedPair[0]
        const setCopied = copiedPair[1]
        const idRef = useRef(null)
        const timerRef = useRef(null)
        if (idRef.current === null || idRef.current === undefined) idRef.current = nextLocalId('dvn-code')

        const login = isObject(snapshot.login) ? snapshot.login : null
        const pending = login !== null && login.pending === true
        const phase = login !== null ? login.phase : 'idle'
        const url = login !== null ? login.url : ''
        const detail = login !== null ? login.detail : ''
        const signedIn = snapshot.signedIn === true
        const expiresAt = snapshot.expiresAt

        useEffect(function () {
          // A command just changed host state before this card mounted, so a
          // cached snapshot is not trustworthy here: 250ms only deduplicates
          // the several components a single page mount creates at once.
          refreshShared(250)
          return function () {
            if (timerRef.current !== null && typeof clearTimeout === 'function') {
              try {
                clearTimeout(timerRef.current)
              } catch (error) {
                // ignore
              }
              timerRef.current = null
            }
          }
        }, [])

        // One poll timer for the whole page; released on unmount.
        useEffect(function () {
          if (!pending) return undefined
          return acquirePolling()
        }, [pending])

        // Leaving the pending phase wipes any half-typed code.
        useEffect(function () {
          if (!pending) setCode('')
          return undefined
        }, [pending])

        function start() {
          if (busy !== '') return
          setBusy('starting')
          setNotice('')
          requestJson(API.login, { method: 'POST', body: { mode: 'code' } }).then(function (payload) {
            const status = isObject(payload) ? text(payload.status) : ''
            // Signing in while already signed in is an informational answer from
            // the Host, not a failed request: show it as a note, never as an error.
            if (status === 'already-signed-in') {
              const rawWhen = isObject(payload) && typeof payload.expiresAt === 'number'
                ? new Date(payload.expiresAt).toISOString()
                : (isObject(payload) ? text(payload.expiresAt) : '')
              setBusy('')
              setNotice(tr(p, 'alreadySignedIn', { when: formatTime(rawWhen) }))
              loadShared(true)
              return
            }
            const attemptId = isObject(payload) ? text(payload.attemptId) : ''
            if (attemptId === '') {
              setBusy('')
              setNotice(tr(p, 'invalidResponse'))
              loadShared(true)
              return
            }
            const next = adaptLogin({
              attemptId: attemptId,
              mode: isObject(payload) ? payload.mode : 'code',
              phase: 'pending',
              pending: true,
              url: isObject(payload) ? payload.url : '',
            })
            publishShared({ login: next, error: '' })
            setBusy('')
            if (next === null || next.url === '') loadShared(true)
          }, function (error) {
            setBusy('')
            setNotice(errorText(p, error))
            // The host may already hold an attempt we did not know about.
            loadShared(true)
          })
        }

        function submit(event) {
          if (event !== null && event !== undefined && typeof event.preventDefault === 'function') event.preventDefault()
          if (busy !== '' || !pending) return
          const attemptId = login !== null ? login.attemptId : ''
          if (attemptId === '') {
            setNotice(tr(p, 'staleAttempt'))
            loadShared(true)
            return
          }
          const entered = String(code === null || code === undefined ? '' : code).trim()
          if (entered === '') {
            setNotice(tr(p, 'emptyCode'))
            return
          }
          // Clear the field before the request: the code is never kept in state.
          setCode('')
          setBusy('submitting')
          setNotice('')
          requestJson(API.loginCode, { method: 'POST', body: { attemptId: attemptId, code: entered } }).then(function (payload) {
            setBusy('')
            const nextPhase = text(isObject(payload) ? payload.phase : '', 'exchanging')
            const next = adaptLogin({
              attemptId: attemptId,
              phase: nextPhase,
              pending: isObject(payload) ? payload.pending === true : isPendingPhase(nextPhase),
            })
            publishShared({ login: next, error: '' })
            if (next === null || next.pending !== true) {
              stopPolling()
              refreshShared(0)
            }
          }, function (error) {
            setBusy('')
            setNotice(errorText(p, error))
            // The attempt may have ended on the host; refresh instead of sticking.
            loadShared(true)
          })
        }

        function cancel() {
          if (busy !== '') return
          setBusy('cancelling')
          setNotice('')
          requestJson(API.cancel, { method: 'POST', body: {} }).then(function () {
            setBusy('')
            stopPolling()
            applyLogin({ attemptId: login !== null ? login.attemptId : '', phase: 'cancelled', pending: false })
            loadShared(true)
          }, function (error) {
            setBusy('')
            setNotice(errorText(p, error))
          })
        }

        function signOut() {
          if (busy !== '') return
          setBusy('signing-out')
          setNotice('')
          requestJson(API.logout, { method: 'POST', body: {} }).then(function (payload) {
            setBusy('')
            stopPolling()
            publishShared({
              signedIn: false,
              login: null,
              settings: adaptSettings(isObject(payload) ? payload.settings : undefined),
              error: '',
            })
            loadShared(true)
          }, function (error) {
            setBusy('')
            setNotice(errorText(p, error))
          })
        }

        function copy() {
          if (url === '') return
          writeClipboard(url).then(function () {
            setCopied(true)
            if (timerRef.current !== null && typeof clearTimeout === 'function') {
              try {
                clearTimeout(timerRef.current)
              } catch (error) {
                // ignore
              }
            }
            if (typeof setTimeout === 'function') {
              timerRef.current = setTimeout(function () {
                timerRef.current = null
                setCopied(false)
              }, 2000)
            }
          }, function (error) {
            warn('clipboard', error)
          })
        }

        function onCodeChange(event) {
          const next = isObject(event) && isObject(event.target) ? event.target.value : ''
          setCode(typeof next === 'string' ? next : '')
        }

        return {
          st: snapshot,
          busy: busy,
          code: code,
          notice: notice,
          copied: copied,
          inputId: String(idRef.current),
          signedIn: signedIn,
          expiresAt: expiresAt,
          login: login,
          mode: login !== null ? login.mode : '',
          pending: pending,
          phase: phase,
          url: url,
          detail: detail,
          loading: snapshot.loading === true,
          loaded: snapshot.loaded === true,
          setCode: setCode,
          onCodeChange: onCodeChange,
          start: start,
          submit: submit,
          cancel: cancel,
          signOut: signOut,
          copy: copy,
        }
      }

      /** Localized one-line account state. */
      function journeyStatusText(props, journey) {
        // Never claim "signed out" before the first snapshot lands: the host may
        // already hold a pending attempt started by the slash command.
        if (!journey.loaded) return tr(props, 'loadingState')
        if (journey.signedIn) {
          const expires = formatTime(journey.expiresAt)
          return expires === ''
            ? tr(props, 'signedInStatus')
            : tr(props, 'signedInStatus') + ' · ' + tr(props, 'sessionExpires', { when: expires })
        }
        if (journey.phase === 'pending') return tr(props, 'accountPending')
        if (journey.phase === 'exchanging') return tr(props, 'accountExchanging')
        if (journey.phase === 'authorized') return tr(props, 'signedInStatus')
        if (journey.phase === 'cancelled') return tr(props, 'accountCancelled')
        if (journey.phase === 'error') return tr(props, 'accountError')
        return tr(props, 'signedOutStatus')
      }

      /** Primary account action (one button, state-dependent). */
      function journeyAction(props, journey) {
        if (!journey.loaded) {
          return h('button', { key: 'loading', type: 'button', className: 'dvn-btn', disabled: true }, tr(props, 'loadingState'))
        }
        if (journey.busy === 'starting') {
          return h('button', { key: 'starting', type: 'button', className: 'dvn-btn', disabled: true }, tr(props, 'signInStarting'))
        }
        if (journey.signedIn) {
          return h('button', {
            key: 'signout',
            type: 'button',
            className: 'dvn-btn',
            disabled: journey.busy !== '',
            onClick: journey.signOut,
          }, journey.busy === 'signing-out' ? tr(props, 'refreshing') : tr(props, 'signOut'))
        }
        if (journey.pending) {
          return h('button', {
            key: 'cancel',
            type: 'button',
            className: 'dvn-btn',
            disabled: journey.busy !== '',
            onClick: journey.cancel,
          }, journey.busy === 'cancelling' ? tr(props, 'refreshing') : tr(props, 'cancelLogin'))
        }
        return h('button', {
          key: 'signin',
          type: 'button',
          className: 'dvn-btn',
          'data-primary': 'true',
          disabled: journey.busy !== '',
          onClick: journey.start,
        }, tr(props, 'signIn'))
      }

      /** Authorization URL, its copy button and the open-in-new-tab anchor. */
      function journeyUrlBlock(props, journey) {
        if (!journey.pending) return null
        const block = []
        if (journey.url === '') {
          block.push(h('p', { key: 'wait', className: 'dvn-note', role: 'status' }, tr(props, 'waitingNoUrl')))
          return block
        }
        block.push(h('div', { key: 'label', className: 'dvn-label' }, tr(props, 'authUrlLabel')))
        block.push(h('div', { key: 'url', className: 'dvn-url' }, journey.url))
        block.push(h('div', { key: 'actions', className: 'dvn-actions' }, [
          h('button', { key: 'copy', type: 'button', className: 'dvn-btn', onClick: journey.copy },
            journey.copied ? tr(props, 'copied') : tr(props, 'copyUrl')),
          h('a', {
            key: 'open',
            className: 'dvn-btn',
            href: journey.url,
            target: '_blank',
            rel: 'noopener noreferrer',
          }, tr(props, 'openInBrowser')),
        ]))
        return block
      }

      /**
       * The one-time code form. The field is a password input, the value is a
       * controlled string that is cleared on submit, and nothing here ever
       * writes the code anywhere but the POST body.
       */
      function journeyCodeForm(props, journey) {
        if (!journey.pending) return null
        // The host reports 'loopback' for the same-machine callback flow; there
        // the browser returns to the host by itself and no code is involved.
        if (journey.mode === 'loopback') {
          return h('p', { key: 'loopback', className: 'dvn-note', role: 'status' }, tr(props, 'loopbackHint'))
        }
        const exchanging = journey.phase === 'exchanging'
        const disabled = journey.busy !== '' || exchanging
        const submitLabel = journey.busy === 'submitting' || exchanging
          ? tr(props, 'submitting')
          : tr(props, 'submitCode')
        return h('form', { key: 'code-form', className: 'dvn-form', onSubmit: journey.submit }, [
          h('label', { key: 'label', className: 'dvn-label', htmlFor: journey.inputId }, tr(props, 'codeLabel')),
          h('input', {
            key: 'input',
            id: journey.inputId,
            className: 'dvn-input',
            type: 'password',
            value: journey.code,
            placeholder: tr(props, 'codePlaceholder'),
            autoComplete: 'off',
            autoCorrect: 'off',
            autoCapitalize: 'none',
            spellCheck: false,
            maxLength: 8192,
            disabled: disabled,
            onChange: journey.onCodeChange,
            'aria-describedby': journey.inputId + '-help',
          }),
          h('p', { key: 'help', className: 'dvn-note', id: journey.inputId + '-help' }, tr(props, 'codeHelp')),
          h('button', {
            key: 'submit',
            type: 'submit',
            className: 'dvn-btn',
            'data-primary': 'true',
            disabled: disabled || String(journey.code === null || journey.code === undefined ? '' : journey.code).trim() === '',
          }, submitLabel),
        ])
      }

      /** Error / notice lines shared by the card and the settings page. */
      function journeyMessages(props, journey) {
        const nodes = []
        if (journey.notice !== '') {
          nodes.push(h('p', { key: 'notice', className: 'dvn-error', role: 'alert' }, journey.notice))
        }
        if (journey.phase === 'error' && journey.detail !== '') {
          nodes.push(h('p', { key: 'detail', className: 'dvn-error', role: 'alert' }, tr(props, 'loginError', { detail: journey.detail })))
        }
        if (journey.st.error !== '') {
          nodes.push(h('p', { key: 'store', className: 'dvn-note' }, journey.st.error))
        }
        return nodes
      }

      /** Status / hint line for the journey (success, cancelled, hint). */
      function journeyFootnotes(props, journey) {
        const nodes = []
        if (journey.signedIn && journey.phase === 'authorized') {
          nodes.push(h('p', { key: 'ok', className: 'dvn-line', role: 'status' }, tr(props, 'loginSuccess')))
        }
        if (!journey.signedIn && journey.phase === 'cancelled') {
          nodes.push(h('p', { key: 'cancelled', className: 'dvn-line', role: 'status' }, tr(props, 'loginCancelled')))
        }
        if (!journey.signedIn && !journey.pending && journey.loaded) {
          nodes.push(h('p', { key: 'hint', className: 'dvn-note' }, tr(props, 'startHint')))
        }
        return nodes
      }

      /**
       * The account panel. `mode: 'account'` renders the settings-page row shape;
       * anything else renders the compact chat-card body. Both drive the same
       * journey and the same host endpoints.
       */
      function LoginPanel(props) {
        const p = propsOf(props)
        const mode = p.mode === 'account' ? 'account' : 'card'
        const journey = useLoginJourney(p)
        const messages = journeyMessages(p, journey)
        const footnotes = journeyFootnotes(p, journey)
        if (mode === 'account') {
          const inline = journey.pending
            ? [h('div', { key: 'flow', className: 'dvn-inline' }, [].concat(journeyUrlBlock(p, journey) || [], [journeyCodeForm(p, journey)]))]
            : []
          return h('div', { className: 'dvn-account' }, [
            h('div', { key: 'row', className: 'dvn-item' }, [
              h('div', { key: 'main', className: 'dvn-item-main' }, [
                h('div', { key: 'title', className: 'dvn-item-title' }, tr(p, 'accountTitle')),
                h('div', { key: 'state', className: 'dvn-item-hint', role: 'status' }, journeyStatusText(p, journey)),
              ]),
              h('div', { key: 'side', className: 'dvn-item-side' }, [journeyAction(p, journey)]),
            ]),
          ].concat(inline, messages, footnotes))
        }
        const waiting = journey.pending
          ? [h('p', { key: 'waiting', className: 'dvn-note', role: 'status' }, tr(p, 'waitingHint'))]
          : []
        return h('div', { className: 'dvn-flow' }, []
          .concat([
            h('p', { key: 'state', className: 'dvn-line', role: 'status' }, journeyStatusText(p, journey)),
            h('div', { key: 'actions', className: 'dvn-actions' }, [journeyAction(p, journey)]),
          ])
          .concat(journeyUrlBlock(p, journey) || [])
          .concat(waiting)
          .concat([journeyCodeForm(p, journey)])
          .concat(messages)
          .concat(footnotes))
      }
      //#endregion


      //#region cards
      /** Shared compact card chrome for the chat command rows. */
      function Card(props) {
        const p = propsOf(props)
        const tone = text(p.tone, 'idle')
        const children = []
        children.push(h('div', { key: 'head', className: 'dvn-card-head' }, [
          h('span', { key: 'mark', className: 'dvn-mark', 'aria-hidden': 'true' }, 'D'),
          h('span', { key: 'title', className: 'dvn-card-title' }, text(p.title)),
          p.badge === undefined || p.badge === null || p.badge === ''
            ? null
            : h('span', { key: 'badge', className: 'dvn-badge', 'data-tone': tone }, text(p.badge)),
        ]))
        if (text(p.subtitle) !== '') children.push(h('p', { key: 'sub', className: 'dvn-card-sub' }, text(p.subtitle)))
        if (p.children !== undefined && p.children !== null) children.push(h('div', { key: 'body', className: 'dvn-card-body' }, p.children))
        return h('div', { className: 'dvn-card', 'data-tone': tone }, children)
      }

      /** /devin-login — the full authorization journey. */
      function LoginCard(props) {
        const p = propsOf(props)
        const outcome = outcomeOf(props)
        const subtitle = outcome !== null && outcome.kind === 'error' && outcome.text !== ''
          ? tr(p, 'commandFailed', { detail: outcome.text })
          : ''
        return h(Card, { tone: 'idle', title: tr(p, 'loginTitle'), badge: '', subtitle: subtitle },
          h(LoginPanel, { mode: 'card', t: p.t }))
      }

      /** /devin-status — a status card with live data and a refresh action. */
      function StatusCard(props) {
        const p = propsOf(props)
        const snapshot = useShared()
        const busyPair = useState(false)
        const busy = busyPair[0]
        const setBusy = busyPair[1]
        const outcome = outcomeOf(props)
        const commandText = outcome !== null ? outcome.text : ''
        const login = isObject(snapshot.login) ? snapshot.login : null
        const pending = login !== null && login.pending === true
        const settings = adaptSettings(snapshot.settings)

        useEffect(function () {
          refreshShared(1000)
          return undefined
        }, [])

        const tone = snapshot.signedIn ? 'ok' : pending ? 'warn' : (snapshot.error !== '' ? 'error' : 'idle')
        const badge = snapshot.loaded !== true
          ? tr(p, 'loadingState')
          : snapshot.signedIn
            ? tr(p, 'signedInStatus')
            : pending ? tr(p, 'pendingStatus') : tr(p, 'signedOutStatus')
        const expires = formatTime(snapshot.expiresAt)

        const rows = [
          h('div', { key: 'state', className: 'dvn-kv' }, [
            h('span', { key: 'k', className: 'dvn-kv-key' }, tr(p, 'statusTitle')),
            h('span', { key: 'v', className: 'dvn-kv-val', 'data-tone': snapshot.signedIn ? 'ok' : 'muted' }, badge),
          ]),
          h('div', { key: 'expires', className: 'dvn-kv' }, [
            h('span', { key: 'k', className: 'dvn-kv-key' }, tr(p, 'expiresLabel')),
            h('span', { key: 'v', className: 'dvn-kv-val', 'data-tone': expires === '' ? 'muted' : undefined }, expires === '' ? '—' : expires),
          ]),
          h('div', { key: 'web', className: 'dvn-kv' }, [
            h('span', { key: 'k', className: 'dvn-kv-key' }, tr(p, 'webSearch')),
            h('span', { key: 'v', className: 'dvn-kv-val', 'data-tone': 'muted' }, settings.webSearch ? tr(p, 'enabled') : tr(p, 'disabled')),
          ]),
          h('div', { key: 'code', className: 'dvn-kv' }, [
            h('span', { key: 'k', className: 'dvn-kv-key' }, tr(p, 'codeSearch')),
            h('span', { key: 'v', className: 'dvn-kv-val', 'data-tone': 'muted' }, settings.codeSearch ? tr(p, 'enabled') : tr(p, 'disabled')),
          ]),
        ]

        if (snapshot.message !== '') rows.push(h('p', { key: 'message', className: 'dvn-note' }, snapshot.message))
        if (commandText !== '') rows.push(h('p', { key: 'command', className: 'dvn-note' }, commandText))
        if (snapshot.error !== '') rows.push(h('p', { key: 'error', className: 'dvn-error', role: 'alert' }, snapshot.error))
        rows.push(h('div', { key: 'actions', className: 'dvn-actions' }, [
          h('button', {
            key: 'refresh',
            type: 'button',
            className: 'dvn-btn',
            disabled: busy,
            onClick: function () {
              if (busy) return
              setBusy(true)
              loadShared(true).then(function () { setBusy(false) }, function () { setBusy(false) })
            },
          }, busy ? tr(p, 'refreshing') : tr(p, 'refresh')),
        ]))
        rows.push(h('p', { key: 'hint', className: 'dvn-note' }, tr(p, 'statusHint')))

        return h(Card, { tone: tone, title: tr(p, 'statusTitle'), badge: badge, subtitle: '' }, rows)
      }

      /** /devin-logout and /devin-cancel — compact settlement rows. */
      function ActionCard(props) {
        const p = propsOf(props)
        const name = commandName(props)
        const declared = text(p.action)
        const action = name === 'devin-cancel' || declared === 'cancel'
          ? 'cancel'
          : name === 'devin-logout' || declared === 'logout' ? 'logout' : ''
        const running = isCommandRunning(props)
        const outcome = outcomeOf(props)
        const isError = running === false && outcome !== null && outcome.kind === 'error'
        const snapshot = useShared()

        useEffect(function () {
          if (running) return undefined
          // The command settled on the host: pick up the new signed-in state.
          refreshShared(1000)
          return undefined
        }, [running, name])

        const title = action === 'cancel' ? tr(p, 'cancelTitle') : action === 'logout' ? tr(p, 'logoutTitle') : tr(p, 'statusTitle')
        const tone = running ? 'warn' : isError ? 'error' : 'ok'
        const badge = running ? tr(p, 'running') : isError ? tr(p, 'failed') : tr(p, 'done')

        const rows = []
        if (running) rows.push(h('p', { key: 'running', className: 'dvn-line', role: 'status' }, tr(p, 'running')))
        if (isError) {
          const detail = outcome !== null && outcome.text !== '' ? outcome.text : tr(p, 'failed')
          rows.push(h('p', { key: 'error', className: 'dvn-error', role: 'alert' }, detail))
        }
        if (running === false && isError === false) {
          rows.push(h('p', { key: 'ok', className: 'dvn-line', role: 'status' },
            action === 'cancel' ? tr(p, 'cancelDone') : action === 'logout' ? tr(p, 'logoutDone') : tr(p, 'commandDone')))
        }
        if (snapshot.signedIn) {
          const expires = formatTime(snapshot.expiresAt)
          if (expires !== '') rows.push(h('p', { key: 'expires', className: 'dvn-note' }, tr(p, 'sessionExpires', { when: expires })))
        }
        rows.push(h('p', { key: 'hint', className: 'dvn-note' }, tr(p, 'reloadHint')))

        return h(Card, { tone: tone, title: title, badge: badge, subtitle: '' }, rows)
      }

      function LogoutCard(props) {
        return ActionCard(assign(props, { action: 'logout' }))
      }

      function CancelCard(props) {
        return ActionCard(assign(props, { action: 'cancel' }))
      }
      //#endregion


      //#region settings
      /** One preference row with the bundle's own switch. */
      function SwitchRow(props) {
        const p = propsOf(props)
        const field = p.field === 'codeSearch' ? 'codeSearch' : 'webSearch'
        const title = field === 'codeSearch' ? tr(p, 'codeSearch') : tr(p, 'webSearch')
        const hint = field === 'codeSearch' ? tr(p, 'codeSearchHint') : tr(p, 'webSearchHint')
        const snapshot = useShared()
        const settings = adaptSettings(snapshot.settings)
        const busyPair = useState('')
        const busy = busyPair[0]
        const setBusy = busyPair[1]
        const noticePair = useState('')
        const notice = noticePair[0]
        const setNotice = noticePair[1]
        const idRef = useRef(null)
        if (idRef.current === null || idRef.current === undefined) idRef.current = nextLocalId('dvn-switch')

        useEffect(function () {
          refreshShared(1000)
          return undefined
        }, [])

        const checked = settings[field] === true
        const unavailable = snapshot.loaded !== true || snapshot.error !== ''
        const disabled = unavailable || busy !== ''

        function change(next) {
          if (disabled) return
          const patch = {}
          patch[field] = next === true
          setBusy(field)
          setNotice('')
          requestJson(API.settings, { method: 'POST', body: patch }).then(function (payload) {
            setBusy('')
            publishShared({ settings: adaptSettings(isObject(payload) ? payload.settings : patch), error: '' })
          }, function (error) {
            setBusy('')
            setNotice(errorText(p, error))
            loadShared(true)
          })
        }

        const labelId = String(idRef.current) + '-label'
        let hintText = hint
        if (notice !== '') hintText = notice
        else if (unavailable && snapshot.error !== '') hintText = snapshot.error
        else if (unavailable && snapshot.loading === true) hintText = tr(p, 'loadingState')
        return h('div', { className: 'dvn-item' }, [
          h('div', { key: 'main', className: 'dvn-item-main' }, [
            h('div', { key: 'title', className: 'dvn-item-title', id: labelId }, title),
            h('div', { key: 'hint', className: 'dvn-item-hint' }, hintText),
          ]),
          h('div', { key: 'side', className: 'dvn-item-side' }, [
            h(Switch, {
              key: 'switch',
              checked: checked,
              disabled: disabled,
              labelledBy: labelId,
              label: tr(p, 'switchAria', { title: title }),
              onChange: change,
            }),
          ]),
        ])
      }

      /** Per-field wrappers, so each row is a real component with its own label. */
      function WebSearchRow(props) {
        return SwitchRow(assign(props, { field: 'webSearch' }))
      }

      function CodeSearchRow(props) {
        return SwitchRow(assign(props, { field: 'codeSearch' }))
      }

      /** The settings page: account journey plus the two search switches. */
      function SettingsSection(props) {
        const p = propsOf(props)
        return h('section', {
          className: 'dvn-section',
          'aria-label': tr(p, 'settingsSectionAria'),
        }, [
          h('div', { key: 'head', className: 'dvn-section-head' }, [
            h('h2', { key: 'title', className: 'dvn-section-title' }, tr(p, 'title')),
            h('p', { key: 'sub', className: 'dvn-section-sub' }, tr(p, 'settingsSubtitle')),
          ]),
          h(LoginPanel, { key: 'account', mode: 'account', t: p.t }),
          h(WebSearchRow, { key: 'web', t: p.t }),
          h(CodeSearchRow, { key: 'code', t: p.t }),
          h('p', { key: 'foot', className: 'dvn-foot' }, tr(p, 'statusHint')),
        ])
      }
      //#endregion


      //#region apply
      /**
       * Claim one seat through slots.inject. The slot key may never be declared
       * (another composition, a newer harness), and a missing slot must not
       * throw here: slots.register alone would throw in that case.
       */
      function makeSeat(slots, localeReady) {
        return function seat(slotKey, extraOptions, component) {
          try {
            const dispose = slots.inject(slotKey, function () {
              const noop = function () {}
              try {
                if (typeof slots.register !== 'function') return noop
                const options = { name: slotKey }
                if (isObject(extraOptions)) {
                  for (const key in extraOptions) {
                    if (hasOwn(extraOptions, key)) options[key] = extraOptions[key]
                  }
                }
                if (localeReady === true) options.locale = NS
                const registered = slots.register(options, component)
                return typeof registered === 'function' ? registered : noop
              } catch (error) {
                warn(slotKey + ' register', error)
                return noop
              }
            })
            return typeof dispose === 'function' ? dispose : undefined
          } catch (error) {
            warn(slotKey + ' inject', error)
            return undefined
          }
        }
      }

      /** Client plugin body: every step is individually guarded. */
      function apply(ctx) {
        if (ctx === null || ctx === undefined) return
        try {
          applySteps(ctx)
        } catch (error) {
          warn('apply', error)
        }
      }

      function applySteps(ctx) {
        if (h === null) {
          warn('module table', new Error('react is unavailable, the Devin search UI cannot mount'))
          return
        }

        // 1. Stylesheet (theme tokens only); cleaned up with the plugin fiber.
        try {
          injectCss()
          if (typeof ctx.effect === 'function') {
            ctx.effect(function () { return removeCss() }, 'devin-search: stylesheet')
          }
        } catch (error) {
          warn('stylesheet', error)
        }

        // 2. Dictionaries plus the slot `locale:` option, which are a matched
        //    pair: a declared namespace without the locale face fails at render.
        let localeReady = false
        try {
          const locale = typeof ctx.get === 'function' ? ctx.get('locale') : undefined
          localeService = locale === undefined ? null : locale
          if (locale !== null && locale !== undefined && typeof locale.register === 'function') {
            if (typeof ctx.effect === 'function') {
              ctx.effect(function () { return locale.register(NS, MESSAGES) }, 'devin-search: dictionaries')
            } else {
              locale.register(NS, MESSAGES)
            }
            localeReady = true
          }
        } catch (error) {
          localeReady = false
          warn('locale', error)
        }

        // 3. The slot registry is the one required service.
        let slots = null
        try {
          slots = typeof ctx.get === 'function' ? ctx.get('slots') : undefined
        } catch (error) {
          warn('service lookup', error)
          return
        }
        if (slots === null || slots === undefined || typeof slots.inject !== 'function') {
          warn('slots', new Error('the slots service is unavailable, no seat can be claimed'))
          return
        }

        // 4. The `locale` register option puts the framework `t` seat on the
        //    component and fails at render when the renderer has no installed
        //    locale face. A locale service registered by the locale plugin
        //    implies that face, and the slot service exposes installLocale as
        //    the capability probe; require both before declaring the option.
        const localeFaceCapable = typeof slots.installLocale === 'function'
        const declareLocale = localeReady === true && localeFaceCapable === true

        // 5. Chat command rows (keyed by the slash-command name).
        const seat = makeSeat(slots, declareLocale)
        seat(COMMAND_SLOT, { key: 'devin-login' }, LoginCard)
        seat(COMMAND_SLOT, { key: 'devin-status' }, StatusCard)
        seat(COMMAND_SLOT, { key: 'devin-logout' }, LogoutCard)
        seat(COMMAND_SLOT, { key: 'devin-cancel' }, CancelCard)

        // 6. Settings page (a fresh list id, never replacing a shipped section).
        seat(SECTION_SLOT, {
          id: SECTION_ID,
          order: SECTION_ORDER,
          label: t('title'),
        }, SettingsSection)

        // 7. Two compact General rows reusing the same switch + shared store.
        seat(GENERAL_SLOT, { id: 'devin-web-search', order: GENERAL_ORDER }, WebSearchRow)
        seat(GENERAL_SLOT, { id: 'devin-code-search', order: GENERAL_ORDER + 1 }, CodeSearchRow)
      }
      //#endregion


      exports.name = CLIENT_NAME
      /**
       * Wait for the slot registry before applying. Declaring nothing made the
       * client loader run apply() before the renderer provides slots, which
       * silently registered nothing.
       */
      exports.inject = ['slots']
      exports.apply = apply
      /** Exposed for the dictionary-parity smoke test; not a public API. */
      exports.__messages = MESSAGES
      /** Internal seams for the harness-free render smoke test; not a public API. */
      exports.__debug = {
        Switch: Switch,
        read: function () { return shared },
        publish: function (patch) { publishShared(patch) },
      }
      return module.exports
    },
  })
} else {
  try {
    if (typeof console !== 'undefined' && console !== null && typeof console.warn === 'function') {
      console.warn('[devin-search] window.__ModuleLoader__ is unavailable; the client bundle was not registered.')
    }
  } catch (ignored) {
    // A page without a console is not a reason to throw.
  }
}
