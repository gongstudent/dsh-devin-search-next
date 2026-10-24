# dsh-devin-search-next

[![ci](https://github.com/gongstudent/dsh-devin-search-next/actions/workflows/ci.yml/badge.svg)](https://github.com/gongstudent/dsh-devin-search-next/actions/workflows/ci.yml)

DeepSeek Harness（DSH）插件：一次 Devin 登录，即可在会话里使用由 Devin 提供的
`web_search` 与只读语义 `code_search`。

这是 [`dsh-devin-search`](https://github.com/gongstudent/dsh-devin-search) 的**抗版本漂移重写版**：
功能对齐，但不依赖任何 DSH 包、不锁版本、客户端不碰官方内部组件。目标是「DSH 升级后它还能自己起来」。

---

## 1. 为什么重写（旧版为什么会消失）

旧版 `dsh-devin-search@0.2.9` 在 DSH 升级后**整行插件消失**，不是报错，而是没有任何输出。
根因在 DSH 的 bundle 兼容性闸门（`dsh-app-boot` 的 `loadProfileDirectory`）：
版本声明不满足时，该 bundle 的**整个 patch 层被丢弃**，只记在 `skippedBundles` 里、
不打印任何日志。旧版把一串 `@deepseek-ai/dsh-*` 写成**精确版本白名单**
（最高 `0.2.1-rc.2`），本机已是 `0.2.1-rc.3`，于是被静默摘除。

除版本闸门外，旧版还有三处会随版本漂移的耦合：

| 耦合点 | 后果 |
| --- | --- |
| 运行时 `import { defineTool } from '@deepseek-ai/dsh-tools'`、`credentialKey`、`Schema`（schemastery） | 包改名/改导出即整个插件起不来 |
| Client `import { Switch } from '@deepseek-ai/dsh-client-ui-primitives'` | 官方内部组件，无兼容承诺 |
| Client 依赖 `ctx.configForms` / `ctx.uiConversation` 服务 | 这两个 Client 服务在当前版本已不存在，`inject` 不满足 → 客户端根本不 `apply` |
| 往 `conversation.chat.node` 塞自定义 key | 该 slot 的 key 域是固定枚举，非法 key 被拒绝 |

新版对应的四条硬规则：

1. **零 DSH 运行时 import**：Host 只用 Node 内建模块，Client 只 `require('react')`；
   `dependencies` / `peerDependencies` 全空，**不声明 `engines.dsh`**，因此不会被版本闸门摘除。
2. **不导出 `Config`**：DSH 要求 `Config` 是真正的 Schemastery 实例（身份校验），
   那是运行时依赖；两个开关改存插件自己的设置文件。
3. **能力逐个探测、逐个降级**：服务拿不到就少一个功能，绝不从 `apply` 里抛出。
4. **只依赖语义稳定的扩展点**：`ctx.get(name)` 查服务、`ctx.inject([...])` 等就绪、
   `ctx.slots.inject/register` 占位；不用 `configForms`、`uiConversation`、官方内部组件。

## 2. 安装

**从 GitHub 安装**（推荐）：

```text
插件 → 添加插件 → 输入 github:gongstudent/dsh-devin-search-next
```

或命令行：

```bash
# 指定 profile，直接装 GitHub 仓库
dsh plugin --profile desktop add "github:gongstudent/dsh-devin-search-next"

# 本地开发：装当前目录（link 安装，改代码后重启生效）
dsh plugin --profile desktop add "$(pwd)"
```

也可以在插件页选择「本地目录」并指向本仓库的克隆路径。

装好后重启应用（新版 bundle 需要新进程加载 JS 模块）。确认三件事：

1. 插件页出现 **Devin 搜索**，标题/描述/图标来自 `locale/*.json` 与 `icon.svg`；
2. 设置 → 插件 → Devin 搜索 里能看到登录状态与两个开关；
3. 聊天里输入 `/devin-status` 有返回。

> 本包与旧包 `dsh-devin-search` **不要同时启用**：两者都注册 id 为 `devin` 的搜索 provider，
> 后注册者会被拒绝。先停用旧包再启用本包。

## 3. 使用

### 登录

| 命令 | 作用 |
| --- | --- |
| `/devin-login` | 生成授权链接；在浏览器登录后把一次性授权码**粘贴到聊天里的登录卡片**（不要贴进对话正文） |
| `/devin-login local` | 同一台机器：监听 `127.0.0.1:59653` 自动接收回调 |
| `/devin-status` | 查看登录状态与到期时间（脱敏） |
| `/devin-logout` | 取消在途登录并删除本地会话 |
| `/devin-cancel` | 只取消在途登录 |

凭据保存在 `$DSH_HOME/devin-search/session.json`（POSIX 0600，原子写入），
**不经过** DSH 的 credentials 服务，也不写入任何会话日志或模型上下文。

> 从旧版升级时会**一次性导入**旧插件留在 `$DSH_HOME/.credentials.yaml` 里的
> `devin-search/session` 授权：只读旧文件、只接受未过期且格式正确的记录，并写
> `$DSH_HOME/devin-search/legacy-import.json` 作为一次性标记——所以 `/devin-logout`
> 之后重启**不会**被旧记录重新登录。导入成功通常就不必重新登录；失败则照常走一次 `/devin-login`。

### 两个开关

| 开关 | 关闭后的效果 |
| --- | --- |
| `web_search` | `web_search` 被 guard 拒绝并返回可操作提示；Devin provider 仍在注册表里 |
| `code_search` | `code_search` 工具从注册表移除（模型看不到，省 token） |

改法三选一：设置页开关；`/devin-settings web off`、`/devin-settings code off`；
删除 `$DSH_HOME/devin-search/settings.json` 回落到默认开。

优先级：**设置文件 > 内置默认（均为开）**。设置文件是运行期自己写的，所以重启后保留。

## 4. 结构

```
lib/index.js           apply()：装配下面四块；任何一块失败只告警
lib/session.js         Devin 会话状态机（PKCE 登录、后台兑换、取消/登出/吊销）
lib/store.js           自有凭据与设置存储（原子写、0600）
lib/settings.js        两个开关 + 订阅
lib/legacy-import.js   一次性导入旧插件的 DSH 凭据记录（带 legacy-import.json 标记）
lib/adapter-commands.js  /devin-* 命令
lib/adapter-web.js      web_search provider（结构体 {id, available, search}）
lib/adapter-tools.js    code_search 工具（原生 JSON Schema）+ web_search guard
lib/adapter-api.js      /api/devin/* 浏览器通路（connection.fetch.register）
lib/core/*.js           纯逻辑：oauth/protobuf/protocol/completion/code-search/local/gitignore
lib/client.js           浏览器半边（__ModuleLoader__ 懒工厂，0 个 @deepseek-ai 依赖）
```

`lib/core/*.js` 是从 `dsh-devin-search` 的 TypeScript 实现机械转换来的（`node:module` 的
`stripTypeScriptTypes(..., { mode: 'transform' })`，逻辑逐字一致，已随仓库提交、不需要重新生成）；
唯一的替换是把 npm `ignore` 包换成自带的 `lib/core/gitignore.js`。

## 5. 兼容性

| 项目 | 要求 |
| --- | --- |
| Node | ≥ 20（`AbortSignal.any`、`Response`、`fetch`） |
| DSH | 0.2.x 系；设计上不感知具体版本。服务缺失/改名时按下列顺序降级 |
| 运行时依赖 | 无 |
| 浏览器半边 | `react` + `react/jsx-runtime`（来自 DSH 模块表），其余全自写 |

降级顺序：

| 缺少的东西 | 结果 |
| --- | --- |
| `connection` 服务 | 卡片只显示静态状态；命令、工具、provider 正常 |
| `tools` 服务 | 没有 `code_search` 与 guard，其余正常 |
| `web` 服务 | 不注册 provider，`web_search` 回到内置实现 |
| `commands` 服务 | 只剩工具与界面，无 `/devin-*` |
| 任何 slot key 不存在 | 该卡片不出现，其他卡片不受影响 |

## 6. 数据边界

`code_search` 会把检索问题与经筛选的代码片段发送到 Devin/Windsurf 云端；请确保对相应代码
资产有上传授权。本地只读沙箱规则（照旧）：工作区为绝对根边界、不跟随符号链接、
执行 `.gitignore`、硬性跳过 `.git`/`node_modules`/`.env*`/密钥类文件、拒绝非 UTF-8 与二进制、
单次检索 6 轮命令 / 90 秒 / 输出 192 KiB 上限，且只能执行结构化的只读命令。

## 7. 自检

```bash
# 清单/patch/locale/图标/导入图/语法
node scripts/check.mjs

# 全部单测（离线，43 项：core 移植等价性 + Host 适配 + 浏览器半边）
node --test
```

CI 在 Node 20 / 22 / 24 上跑同样两条命令。

## 8. 排错

| 现象 | 检查 |
| --- | --- |
| 插件页没有这一行 | profile 的 `package.json` bundles 是否包含它；是否被版本闸门摘除（本包无版本声明，正常不会） |
| 设置页没有 Devin 搜索 | 浏览器控制台看 `[devin-search]` 警告；确认 slot `settings.section` 仍存在 |
| 登录卡片不刷新 | `/api/devin/*` 路由没挂上（需要 `connection` 服务）；用 `/devin-status` 兜底 |
| `web_search` 报 `WEB_PROVIDER_AMBIGUOUS` | 补丁里 `web.searchProvider` 未生效（行被改名），在用户 patch 层自行指定 `devin` |
| `code_search` 报路径错误 | `fs.processPathFromHostPath` 缺失时回退恒等映射；确认 `search_folder_absolute_uri` 在工作区内 |

## 9. License

MIT，见 [LICENSE](./LICENSE) 与 [NOTICE](./NOTICE)。
