# 内部实现契约 · dsh-devin-search-next

这份文档是 Host 半边与 Client 半边之间的**同步点**。改接口先改这里。

## 为什么要重写

`dsh-devin-search@0.2.9`（仓库根那个包）在 DSH 升级后整行消失。根因：DSH
`dsh-app-boot` 的 bundle 兼容性闸门——版本声明不满足时，**整个 patch 层被丢弃**，
只记进 `skippedBundles`，不打印任何日志。旧版把一串 `@deepseek-ai/dsh-*` 写成精确版本
白名单（最高 `0.2.1-rc.2`），运行环境是 `0.2.1-rc.3` → 静默摘除。

旧版另外的漂移点：运行时 import `defineTool` / `credentialKey` / `Schema`；
Client import `@deepseek-ai/dsh-client-ui-primitives`；Client `inject` 依赖已不存在的
`configForms`、`uiConversation`；`conversation.chat.node` 使用非法自定义 key。

新包四条硬规则：

1. **零 DSH 运行时 import。** Host 只用 Node 内建；Client 只 `require('react')`。
   `dependencies`、`peerDependencies`、`engines.dsh` 全空。
2. **不导出 `Config`。** DSH 要求真正的 Schemastery 实例（`isNativeConfigSchema` 身份校验），
   那是运行时依赖。开关存插件自己的 `settings.json`。
3. **能力逐个探测、逐个降级。** 任何一步失败只 `console.warn`，绝不让 `apply` 抛出。
4. **只用稳定扩展点。** `ctx.get(name)`、`ctx.inject([...])`、`ctx.slots.inject/register`。

## 目录

```
packages/dsh-devin-search-next/
├── package.json            # 无 deps / 无 peerDeps；dsh.bundle.patch + dsh.client
├── cordis.patch.yml        # 插入 devin-search-next 行（不带 config）+ web.searchProvider=devin
├── icon.svg  locale/{en,zh}.json
├── docs/{CONTRACT.md,dsh-api-dossier.md}
├── scripts/{check.mjs,port-core.mjs}
├── lib/
│   ├── index.js            # Host 入口：apply（无 name 以外的 Config 导出）
│   ├── session.js          # Devin 会话状态机（自有凭据、PKCE、后台兑换）
│   ├── store.js            # 原子写、0600 的 session.json / settings.json
│   ├── legacy-import.js    # 旧插件 DSH 凭据记录的一次性迁移（legacy-import.json 标记）
│   ├── settings.js         # webSearch / codeSearch + 订阅
│   ├── adapter-commands.js # /devin-login|status|logout|cancel|settings
│   ├── adapter-web.js      # web_search provider（id: "devin"）
│   ├── adapter-tools.js    # code_search 工具 + web_search guard
│   ├── adapter-api.js      # /api/devin/* 浏览器通路（connection.fetch.register）
│   ├── core/               # 纯逻辑（由 scripts/port-core.mjs 从 src/*.ts 生成）
│   └── client.js           # 浏览器半边（__ModuleLoader__ 懒工厂）
└── test/                   # node --test
```

## 稳定性约束（评审时逐条对照）

- Host 进程里 **不允许** 出现 `from '@deepseek-ai/...'`；`scripts/check.mjs` 会拦截裸包导入。
- Client 里 **不允许** 出现 `require('@deepseek-ai/...')`；只允许 `react` / `react/jsx-runtime`。
- 工具定义直接用**原生 JSON Schema**：对象节点必须显式 `additionalProperties`，
  `required` 必须是顶层数组；不要用 `defineTool` 的 author DSL（那需要 import）。
- 工具的 `output`（`schema` + `render`）是注册强制项；`parameters` 注册时不校验但会原样给模型。
- 工具 `execute(args, exec)` 里**没有 `cwd`**：用 `ctx.get('workingDirectory').ensure(agent, signal)`，
  回退 `agent.session.header.cwd`。
- 路由路径必须在 `/api` 之下、方法只能是 `GET/HEAD/POST`（`assertFetchRoute`），
  处理器是 `Request → Response`。
- `ctx.slots.register` 的选项：keyed slot 用 `{ name, key }`，list slot 用 `{ name, id, order, label? }`。
- locale 字典是**扁平点号 key**：`locale.register('devin-search', { en: {...}, zh: {...} })`，
  同一 namespace 重复注册同一语言会抛。

## Host 内部接口

```js
// store.js
createStore({ dir? })                     // 目录默认 $DSH_HOME/devin-search
  readSession() / writeSession(grant) / clearSession()   // session.json，0600
  readSettings() / writeSettings(value)                  // settings.json

// settings.js
readConfig(config)                        // 兼容 plain object 与 Schemastery .get()
createSettings({ store, config }) -> { get, isEnabled, patch, subscribe, notify }

// session.js
new DevinSessions({ store, options? })    // options.oauth 透传 core/oauth
  getStatus() / statusText() / available()
  access(signal) / revoke(token)
  beginLogin(mode) -> { attemptId, mode, url, alreadyPending? }
  loginState(attemptId) / submitCode(attemptId, code) / cancel() / logout()
  reload() / invalidate() / subscribe(fn) / dispose()

// adapter-*.js
mountCommands({ ctx, sessions, settings, log }) -> cleanup
mountWebProvider({ ctx, sessions, log }) -> { provider, dispose }
mountCodeSearch({ ctx, sessions, settings, log, completion }) -> { dispose }
registerHostApi({ ctx, api: { sessions, settings }, log }) -> void
```

## HTTP 接口（Client 唯一的数据通道）

全部 `/api/devin/*`、JSON、`cache-control: no-store`；成功 `{ ok: true, ... }`，
失败 `{ ok: false, error }` + 4xx。

| 方法 | 路径 | 请求体 | 成功响应 |
| --- | --- | --- | --- |
| GET | `/api/devin/state` | – | `{ signedIn, login:{phase,pending,attemptId?,mode?,url?,detail?}, message, expiresAt?, expirySource?, revoked?, settings }` |
| POST | `/api/devin/login` | `{ mode:'code'\|'local' }` | `{ attemptId, mode:'code'\|'loopback', url, alreadyPending? }` |
| GET | `/api/devin/login?attemptId=` | – | `{ attemptId, phase, pending, detail? }` |
| POST | `/api/devin/login/code` | `{ attemptId, code }` | `{ attemptId, phase }` |
| GET/POST | `/api/devin/settings` | `{ webSearch?, codeSearch? }` | `{ settings }` |
| POST | `/api/devin/logout` | – | `{ signedIn:false, settings }` |
| POST | `/api/devin/cancel` | – | `{ cancelled:true }` |

`phase ∈ idle|pending|exchanging|authorized|cancelled|error`。授权码只出现在 POST body，
永不回显、不写日志。

## Client 半边

```js
window.__ModuleLoader__.load({ id: 'dsh-devin-search-next', factory: function (require) { ... } })
```

- `exports.name`、`exports.inject = ['slots']`、`exports.apply`。
- 只 require `react`（`createElement`）；不使用 harness 内部组件。
- 每步 try/catch，失败 `console.warn('[devin-search] …')`。
- 注册的 seat：

| slot | 形式 | key/id | 组件 |
| --- | --- | --- | --- |
| `conversation.chat.commandview` | keyed | `devin-login` | 登录卡（链接 + 授权码输入 + 轮询） |
| `conversation.chat.commandview` | keyed | `devin-status` | 状态卡 |
| `conversation.chat.commandview` | keyed | `devin-logout` / `devin-cancel` | 动作卡 |
| `settings.section` | list | id `devin-search` | 设置页：登录状态 + 两个开关 |
| `settings.general.item` | list | id `devin-search` | 精简开关行 |

- 样式只用 `--dsw-alias-*` token；Switch 自写（`role="switch"`、`aria-checked`、Enter/Space）。

## 验证

```bash
cd packages/dsh-devin-search-next
node scripts/check.mjs       # 清单 / patch / locale / 图标 / 导入图 / 语法
node --test                  # core + host 单测，全离线
node scripts/port-core.mjs --check
```
