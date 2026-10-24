# DSH 0.2.1-rc.3 — exact API dossier for the `dsh-devin-search-next` rewrite

Evidence base: the **running** build, not docs. Installed version `0.2.1-rc.3` (`<PKG>/../../package.json:4`), where `<PKG> = D:\DeepSeek harness\resources\app.asar\dsh\node_modules\@deepseek-ai`. This build ships **no `.d.ts`**; the bundled `lib/index.js` is the authority and keeps its JSDoc. Two cross-checked sources: (1) `read` of the shipped `lib/index.js` — shell/glob/grep/node cannot open the asar, the `read` tool can; quoted code is verbatim with `file:line`; (2) the live Cordis Inspect providers (`platform:"host"` → `Service.listService`), which project the *running* contracts and their type declarations, quoted as `inspect:`. Anything unestablished is marked **UNVERIFIED**.

## 0. Packages that matter

Reference implementations in `<PKG>`: `dsh-web-search-deepseek` (real `WebSearchProvider`, 342 ln) · `dsh-tool-web` (only consumer of `ctx.web`; defines the model-facing `web_search`/`web_fetch`, so it defines what our provider must return, 878 ln) · `dsh-client-locale` (Host half `lib/index.js` 28 ln; browser half `lib/client.js` 1573 ln with `locale.register` and the canonical `window.__ModuleLoader__.load` wrapper) · `dsh-app-boot` (4566 ln: profile/bundle loading, **version gate**, `readPluginMeta`, `isNativeConfigSchema`) · `dsh-client-modules` (1000 ln: `dsh.client` manifest + boot wire) · `cordis-plugin-loader` (vendored, 675 ln) · `dsh-credentials`, `dsh-authorization`, `dsh-web`, `dsh-tools`.

## 1. Tools — `@deepseek-ai/dsh-tools`

**Accepted definition** (`inspect:` exact projection of the running registry):
```ts
interface ToolDefinition extends ToolSchema { readonly output: ToolOutputDefinition; execute(args: unknown, exec: ToolRunContext): Promise<unknown>;
  projectContent?(exec, result): ContentBlock[]|undefined; finalizeContent?(exec, result): ContentBlock[]|undefined; timeoutMs?: number;
  isConcurrencySafe?(args: unknown): boolean; presentCall?(args: unknown): ToolCallView|undefined; presentResult?(args, result: ToolResult): ToolResultView|undefined; }
interface ToolSchema { deferLoading?: true; name: string; description: string; parameters: Record<string, unknown>; }
interface ToolOutputDefinition { readonly schema: JsonSchemaNode; render(args: unknown, value: JsonValue): ContentBlock[]; presentationMeta?(args, value): JsonValue; }
```
`output` is **required**; `execute` and `output.render` are **required**. Registration-time validation (`dsh-tools/lib/index.js:2974`):
```js
register(definition) {
	const name = definition.name;
	const output = definition.output;
	if (output === void 0 || typeof output !== "object" || typeof output.render !== "function" || output.presentationMeta !== void 0 && typeof output.presentationMeta !== "function") throw new TypeError(`tool "${name}" must declare output { schema, render, presentationMeta? }`);
	assertSupportedJsonSchema(output.schema);
	const timeoutMs = definition.timeoutMs;
	if (timeoutMs !== void 0 && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) throw new TypeError(`tool "${name}" timeoutMs must be a positive finite number`);
	if (name === "run_code") throw new Error(`tool name "${RUN_CODE_NAME}" is reserved for the PTC mode presentation transport and cannot be registered or shadowed`);
	return this.layers.effect(this.ctx, (layer) => layer.tools.insert(name, definition), { label: "tools.register()" });
}
```
Consequences: **`parameters` is never validated or normalised by `register`** — only `output.schema` is asserted; whatever you pass reaches the model verbatim (`schemaOf`, `:3135`, projects only `name/description/parameters/deferLoading`). Duplicate names within one layer and the reserved `run_code` fail. Tool bodies are wrapped: arguments are JSON-round-tripped and deep-frozen before `execute` (`createExecution`, `:3259`-`:3264`), and the returned value is schema-checked → `ToolOutputError` code `INVALID_TOOL_OUTPUT` (`:2647`).

**Use `defineTool`** (`:838`), which is what every first-party tool does:
```js
function defineTool(options) {
	if (options.timeoutMs !== void 0 && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) throw new Error(`defineTool(${options.name}): timeoutMs must be a positive finite number`);
	const parameters = parameterSchemaSpecToJsonSchema(options.parameters);
	const outputSchema = valueSchemaSpecToJsonSchema(options.output.schema);
	const validate = (args) => validateJsonSchemaValue(parameters, args, "");
	const tool = { name: options.name, description: options.description, parameters,
		output: { schema: outputSchema, render(args, value) { return userRender(args, value); }, ... },
		...options.deferLoading === true ? { deferLoading: options.deferLoading } : {},
		...options.timeoutMs !== void 0 ? { timeoutMs: options.timeoutMs } : {},
		async execute(args, exec) { const violations = validate(args); if (violations.length > 0) throw new ToolArgsError(violations); return userExecute(args, exec); } };
}
```
It compiles the *author schema DSL* (`parameterSchemaSpecToJsonSchema`, `:802`):
```js
function parameterSchemaSpecToJsonSchema(spec) {
	const compiled = compilePropertyMap(spec, "parameters");
	const schema = { type: "object", properties: compiled.properties, ...compiled.required === void 0 ? {} : { required: compiled.required } };
	assertSupportedJsonSchema(schema); return schema;
}
```
DSL rules that bite (compiler, `:600`-`:752`): per-property `required: true` is authored on the **property node** and folded into the parent's `required:[…]` (`:603`); an object node **must** declare `additionalProperties` boolean explicitly (`:699`); the parameter **root is open** (no `additionalProperties` emitted, `:804`-`808`); authorisable types are `string|number|integer|boolean|null|array|object|json` or `oneOf` (`:688`,`:751`), any other key is rejected (`assertAuthorKeys`); the raw gate allows only `type,oneOf,properties,required,additionalProperties,items,enum,const` + `description,title,default,examples` (`:34`-`49`); `defineTool.execute` validates args first and throws `ToolArgsError` (`code:'INVALID_ARGS'`, `:813`).

**`execute(args, exec)` receives** (`inspect:` exact):
```ts
interface ToolExecutionInput { readonly callId: ToolCallId; readonly rootCallId?: ToolCallId; readonly name: string; readonly schema?: ToolSchema;
  readonly arguments: unknown; readonly agent?: Agent; readonly parent?: ToolExecutionToken; readonly signal: AbortSignal; }
interface ToolRunContext extends ToolExecution { deferContext(context: UserMessage): void; concludeTurn(): void; }  // ToolExecution = input + rootCallId + token
```
`signal` is the caller-fused cancellation signal — thread it into every fetch (`dispatchToolBody`, `:3390`). `agent` is `{ readonly id: SessionId }` and may be `undefined`. **There is no `cwd` on `exec`**; the first-party precedent (`:2881`-`:2886`) is `this.ctx.get("workingDirectory")?.ensure(exec.agent, exec.signal)`. `exec.arguments` is frozen JSON; `name/callId/rootCallId` are the correlation ids.

**`guard` / `restrict`** (`:3017`, `:2991`):
```js
guard(guard) {  // ToolGuard = (execution: Readonly<ToolExecution>) => string | undefined
	return this.layers.effect(this.ctx, (layer) => layer.guards.append(guard), { label: "tools.guard()", notify: false }); }
restrict(filter) {  // ToolRestriction = { allow?: readonly string[]; deny?: readonly string[] }
	const scope = scopeOf(this.ctx);
	if (scope === void 0) throw new Error("tools.restrict() requires a scoped context (agent.ctx): a context-global restriction would mask every agent — deny the tool for the intended agent instead");
	if (filter.allow === void 0 && filter.deny === void 0) throw new Error("tools.restrict({}) is a no-op: pass `allow` and/or `deny` (an empty filter is almost always a materialized-empty-config bug)");
	// also throws for the reserved "run_code" name and for names that are not visible global tools
```
A guard denies by returning a **string reason**; no guard can force-allow another's denial. Both return the exact disposer. `presentAs(mode)` is scoped-only (`:2911`).

## 2. Commands — `@deepseek-ai/dsh-commands`

`inspect:` exact, plus validation at `dsh-commands/lib/index.js:149` (`normalizeDefinition`):
```ts
interface CommandDefinition { readonly definitionId?: CommandDefinitionId; readonly name: string;  // /^[a-z][a-z0-9_-]*$/u  (:78)
  readonly description: string;  // non-empty
  readonly input?: CommandInputDescriptor;  // { hint: string; attachments?: boolean } — hint non-empty
  readonly recordInput?: boolean;
  readonly handler: (invocation: CommandInvocation) => CommandResult | Promise<CommandResult>; }
interface CommandInvocation { readonly commandId: CommandId; readonly agent: Agent; readonly rawInput: string;
  readonly attachments: readonly (ImageBlock|FileBlock)[]; readonly signal: AbortSignal; }
type CommandResult = { readonly kind:'success'; readonly text?: string; readonly sourceEventSeq?: SessionSeq }
                   | { readonly kind:'error';   readonly text: string };   // non-empty
```
Invocation and settlement (`:379`-`:395`):
```js
const invocation = Object.freeze({ commandId, agent, rawInput: parsed.rawInput, attachments, signal });
try { const output = command.definition.handler(invocation);
      result = normalizeResult(parsed.name, await withAbort(Promise.resolve(output), signal)); }
catch (error) { this.settleThrown(agent.session, parsed.name, commandId, error); throw error; }
```
`rawInput` is the whole suffix after `/name`, **not trimmed** (`parseCommand`, `:102`: `/^\/([a-z][a-z0-9_-]*)(?=$|[\t\n\r ])/u`). `normalizeResult` (`:184`) throws `TypeError` for a missing `kind`, a non-string success `text`, a bad `sourceEventSeq`, an empty error `text`, or an unknown kind — only those two kinds exist. A thrown handler is logged as `command/done kind:'error'` **and re-thrown** to the caller. `input.attachments !== true` makes any attachment settle as `{kind:'error', text:'/name does not accept attachments'}` (`:353`). `recordInput:false` only omits `args` from the `command/run` log row (`:337`).

## 3. Web — `@deepseek-ai/dsh-web` (+ how `dsh-tool-web` consumes it)

`inspect:` exact — **no `label`, no `name`, no `description` on providers**:
```ts
interface WebSearchProvider { readonly id: string; available(): boolean; search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult>; }
interface WebSearchRequest { readonly query: string; readonly maxResults?: number; }
interface WebSearchResult { readonly content?: string; readonly sources: readonly WebSearchSource[]; readonly truncated: boolean; }
interface WebSearchSource { readonly url: string; readonly title?: string; readonly snippet?: string; readonly publishedAt?: string; }
interface WebFetchProvider { readonly id: string; available(): boolean; fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult>; }
```
`content` becomes the card's `answer` and the text prefix; `sources` and `truncated` are **required**. Registration (`dsh-web/lib/index.js:69`-`89`): `registerSearchProvider(provider){ return this.registerProvider(this.searchProviders, provider) }`, and `registerProvider` throws `WebError` code `WEB_DUPLICATE_PROVIDER` (`a web provider with id "…" is already registered`) if the id is taken, else registers under a fiber-scoped effect and returns the disposer.
Selection is at call time and never order-dependent (`:123`-`136`); the configured id is `this.config.searchProvider.get() ?? process.env.DSH_WEB_SEARCH_PROVIDER` (`:100`): configured+registered+available → it; configured but missing → `WEB_PROVIDER_CONFIGURED_MISSING`; configured but `available()===false` → `WEB_PROVIDER_CONFIGURED_UNAVAILABLE`; nothing configured with exactly one usable → it; **more than one usable → `WEB_PROVIDER_AMBIGUOUS`**; none usable → `WEB_PROVIDER_UNAVAILABLE`. The seam enforces the cap itself (`capSources`, `:138`: slices `sources` to `maxResults` and sets `truncated:true`).

**How the tool consumes the result** (`dsh-tool-web/lib/index.js`): the tool's model-facing parameter is `queries: string[]`, **not `query`** (`:264`-`269`), and the tool owns `maxResults`:
```js
async execute(args, exec) {
	const result = await runSearchQueries(ctx, parseSearchArgs(args, maxQueries), maxResults, exec.signal);
	return { ...result.content !== void 0 ? { content: result.content } : {}, sources: result.sources.map(projectSource), truncated: result.truncated }; }
```
The output schema (`:270`-`:304`) requires `sources` (array of `{url,title?,snippet?,publishedAt?}`, `additionalProperties:false`) and `truncated`; `content` is optional. `parseSearchArgs` (`:38`) requires 1..`maxQueries` non-blank queries and de-duplicates. `formatSearchOutput` (`:62`) dereferences `result.sources.length` and `result.content.length` unconditionally, so a provider omitting `sources`/`truncated` fails validation or formatting loudly. Reference provider shape: `apply(ctx, config){ ctx.web.registerSearchProvider(new DeepSeekSearchProvider(() => resolveOptions(ctx, {...config.x.get()}))) }` (`dsh-web-search-deepseek/lib/index.js:330`-`339`).

## 4. Browser route registration — which API, exact shapes

**`ctx.connection.fetch.register` exists, exactly that shape** (`dsh-client-connection/lib/index.js:732`, `:840`):
```js
get fetch() { const owner = this.ctx; return { register: (route) => this.registerFetchRoute(owner, route) }; }
registerFetchRoute(owner, route) {
	assertFetchRoute(route);
	const registered = { methods: new Set(route.methods), requestBody: route.requestBody, fetch: route.fetch };
	return owner.effect(() => {
		if (this.fetchRoutes.has(route.path)) throw new Error(`connection: exact Fetch route ${JSON.stringify(route.path)} is already registered`);
		this.fetchRoutes.set(route.path, registered);
		return () => { this.fetchRoutes.delete(route.path); }; }, `client-connection: ${route.path} Fetch route`); }
function assertFetchRoute(route) {   // :973
	if (endpointFromPath("/api", route.path) === void 0) throw new Error(`connection: invalid exact Fetch route ${JSON.stringify(route.path)}`);
	if (route.methods.length === 0) throw new Error(`connection: exact Fetch route ${JSON.stringify(route.path)} declares no methods`);
	if (new Set(route.methods).size !== route.methods.length) throw new Error(`connection: exact Fetch route ${JSON.stringify(route.path)} repeats a method`); }
```
```ts
interface ConnectionFetchRoute { readonly path: string; readonly methods: readonly ConnectionFetchMethod[];  // 'GET'|'HEAD'|'POST', unique
  readonly requestBody: ConnectionRequestBodyMode;  // 'buffered'|'streaming'
  readonly fetch: (request: Request) => Promise<Response>; }
interface HostConnectionFetch { register(route: ConnectionFetchRoute): () => Promise<void>; }
```
Dispatch (`createSharedFetchHandler`, `:820`-`839`): matched by **exact `url.pathname`**; only `peer.principal.kind === 'owner'` proceeds, everyone else gets a `403` `Response`; unmatched → `404`. So the handler returns a plain `Promise<Response>` — no Node `req`/`res`.

**`requestRejection`** (`:737`):
```js
requestRejection(request) { const admission = this.admit(request); return "rejection" in admission ? admission.rejection : void 0; }
admit(request) {  // :742
	if (!this.isTrusted(request)) return { rejection: 403 };
	if (this.disposed) return { rejection: 401 };
	const secure = this.owner.get("webServer")?.protocol === "https:";
	if (this.browserAuth.isAuthenticated(request, secure)) return { peer: this.browserPeer };
	const id = this.browserAuth.authenticateApi(request, secure);
	const record = id === void 0 ? void 0 : this.peers.get(id);
	return record === void 0 ? { rejection: 401 } : { peer: record.peer }; }
```
`ConnectionTrustRequest = { headers: Headers | Record<string,string|string[]|undefined> }`; `ConnectionRequestRejection = 401 | 403 | undefined` (`undefined` = allowed). A `webServer` route must call it itself and mirror the first-party response (`res.writeHead(rejection); res.end(rejection === 401 ? "unauthorized" : "forbidden")`, `:1050`-`:1053`).

**`ctx.webServer.register`** (`inspect:` exact) is the raw HTTP carrier:
```ts
interface WebRoute { kind: WebRouteKind;  // 'exact' | 'prefix'
  path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>; }
```
Duplicate `(kind,path)` throws (route patterns are a composition-level contract). First-party consumers: `dsh-client-modules` mounts `{kind:'prefix', path:'/plugins', handler:this.serveBundle}` (`dsh-client-modules/lib/index.js:563`-`570`); `client-connection` mounts `{kind:'prefix', path:'/api'}` and `{kind:'exact', path:'/connect'}` (`:1045`-`:1065`).

**Prefer `ctx.connection.fetch.register` under `/api/…`** for an authenticated browser route: it inherits the Host/Origin fence and browser cookie/token authentication, the owner-principal check runs *before* your `fetch`, the body is not wrapped, and the handler is Web-Fetch (`Request → Response`) rather than `writeHead/end`. Use `ctx.webServer.register` only when you need a non-`/api` path or an upgrade/prefix mount, and then you own authentication via `requestRejection`.

## 5. Authorization — `@deepseek-ai/dsh-authorization`

`inspect:` exact + `dsh-authorization/lib/index.js:75`, `:196`:
```ts
interface AuthorizationFlow { readonly key: CredentialKey; readonly label: string;
  readonly methods: readonly [AuthorizationMethod, ...AuthorizationMethod[]];  // at least one
  run(session: AuthorizationSession): Promise<void>; }
interface AuthorizationMethod { id: string; label: string; }
interface AuthorizationRequest { key: CredentialKey; method?: string; interaction: AuthorizationInteraction; signal?: AbortSignal; }
interface AuthorizationSession { readonly method: string; readonly signal: AbortSignal; commit(record: CredentialRecord): Promise<void>;
  notify(notice: AuthorizationNotice): void; prompt(prompt: AuthorizationPrompt): Promise<string>; }
interface AuthorizationInteraction { notify(notice: AuthorizationNotice): void; prompt(prompt: AuthorizationPrompt): Promise<string>; }
interface AuthorizationNotice { message: string; url?: string; code?: string; }
type AuthorizationPrompt = { signal?: AbortSignal } & ({ kind:'text'; message:string; placeholder?:string }
  | { kind:'secret'; message:string; placeholder?:string } | { kind:'select'; message:string; options: readonly AuthorizationPromptOption[] });
interface AuthorizationPromptOption { id: string; label: string; description?: string; }
type AuthorizationStatus = 'authorized' | 'cancelled';  interface AuthorizationOutcome { status: AuthorizationStatus; }
```
`registerFlow` throws `AuthorizationError` code `DUPLICATE_FLOW` for a taken key (`:77`). `begin` (`:138`) throws `NO_FLOW`, `UNKNOWN_METHOD`, `ALREADY_IN_FLIGHT`, and post-hoc `NOT_COMMITTED`; one attempt per key. The seam implements `commit` itself (`:213`-`:219`) as `ctx.credentials.modifyRecord(key, () => Promise.resolve(record))` and observes it through `credentials/record-updated` (`:206`), so a flow **must** commit during the attempt or the attempt fails `NOT_COMMITTED`; a human declining a prompt must reject with `AuthorizationDeclinedError` (code `DECLINED`, `:48`) so the attempt settles `cancelled` instead of throwing (`:228`,`:241`). `notify` failures are only logged; `cancel(key)` aborts unless mid-commit.

## 6. Loader, `Config`, and the version gate — `@deepseek-ai/dsh-app-boot`

**`Config` consumption** — `isNativeConfigSchema` (`dsh-app-boot/lib/index.js:2447`):
```js
function isNativeConfigSchema(value) {
	if (value === null || typeof value !== "object" && typeof value !== "function") return false;
	const meta = Reflect.get(value, "meta");
	return Reflect.get(value, Symbol.for("schemastery")) === true && typeof Reflect.get(value, "type") === "string" && meta !== null && typeof meta === "object"; }
```
`export const Config` **must be a Schemastery instance** (`z.object({…})` from `@deepseek-ai/schemastery`, which carries `Symbol.for('schemastery')`, `type`, `meta`). A plain object, a JSON-Schema object or a function fails this identity check. First-party pattern: `dsh-tool-web/lib/index.js:845` `const Config = z.object({ search: z.boolean().default(true), … })`; `dsh-web/lib/index.js:48` `static Config = z.object({…})`. The settings UI schema is projected by `createConfigProjector` / `generateConfigSchema` / `isNativeConfigSchema`.

**Why the old plugin vanished — the bundle gate.** `loadProfileDirectory` (`:1002`-`:1040`), JSDoc first: *"Unreadable bundles, and bundles whose own dsh requirements the profile does not exempt, are skipped without changing the manifest and listed in `skippedBundles`; nothing is printed."*
```js
const exemptions = bundles.length === 0 ? {} : readProfileVersionExemptions(dir);
for (const packageName of bundles) try {
	const packageDir = resolveBundleDir(binName, packageName, installAnchor, dir);
	const bundleManifest = readProfileManifest(binName, packageDir);
	const bundle = bundleManifest.dsh?.bundle;
	if (bundle === void 0) throw new Error(`${binName}: profile bundle ${JSON.stringify(packageName)} declares no dsh.bundle in its package.json`);
	const issue = evaluatePluginCompatibility(bundleManifest, exemptions);
	if (issue !== void 0 && !issue.exempted) throw new Error(pluginCompatibilityWarning(issue));
	const patchPaths = bundlePatchPaths(packageDir, bundle);
	const patches = patchPaths.flatMap((patchPath) => loadOverlayPatches(binName, patchPath));
	layers.push({ packageName, packageDir, patchPaths, patches });
} catch (error) { skippedBundles.push({ packageName, reason: String(error) }); }
```
An unsatisfiable `engines.dsh` / DSH peer range makes `evaluatePluginCompatibility` return a non-exempted `issue`; the `throw` aborts that bundle's iteration, so its **whole patch layer is dropped** and its rows never enter the entry list — recorded only in `skippedBundles`, with nothing printed at this point. A bundle layer silently disappearing is therefore *by design*.

The second gate is per-entry for profile rows (`prepareProfileEntries` → `preflight`, `:2294`-`:2388`) and is loud on stderr:
```js
function prepareProfileEntries(ctx, entries, parentURL, binName = "dsh") {
	return preflight(ctx, entries, parentURL, (row, reason) => {
		const label = typeof row.id === "string" ? `row ${JSON.stringify(row.id)}` : row.name;
		process.stderr.write(`${binName}: disabling profile plugin ${label}: ${reason}\n`);
	}).rows; }
```
with `const issue = evaluatePluginCompatibility(manifest, exemptions); return issue === void 0 || issue.exempted ? void 0 : pluginCompatibilityWarning(issue);` (`:2327`), and denial setting `row.disabled = true` (`:2334`). Exemptions are a real escape hatch: `readProfileVersionExemptions(dir)` (`:1019`), `setProfileVersionExemption`, `PROFILE_COMPATIBILITY_FILENAME`; the live `plugin_manager` tool exposes `list_version_exemptions`/`set_version_exemption` and states "Unmet DSH version requirements (engines.dsh, else DSH peer dependencies) block installation and activation".

## 7. Client module manifest — `@deepseek-ai/dsh-client-modules`

**Validation** (`:62`):
```js
function parseDshClient(pkgName, value) {
	if (value === void 0) return void 0;
	if (typeof value !== "object" || value === null) throw new Error(`client-modules: ${pkgName} has a non-object dsh.client declaration`);
	const decl = value;
	if (typeof decl.platform !== "string") throw new Error(`client-modules: ${pkgName} dsh.client.platform must be a string`);
	const inject = optionalStringArray(pkgName, "dsh.client.inject", decl.inject);
	const external = optionalStringArray(pkgName, "dsh.client.external", decl.external);
	if (decl.immediately !== void 0 && typeof decl.immediately !== "boolean") throw new Error(`client-modules: ${pkgName} dsh.client.immediately must be a boolean`);
	return { platform: decl.platform, ...inject !== void 0 ? { inject } : {}, ...external !== void 0 ? { external } : {}, ...decl.immediately !== void 0 ? { immediately: decl.immediately } : {} }; }
```
Only `platform` is compulsory; `inject`/`external`/`immediately` need only be `string[]`/`boolean`. Real manifest (`<PKG>/dsh-client-locale/package.json:29`): `"dsh":{"client":{"inject":["@deepseek-ai/dsh-client-connection","@deepseek-ai/dsh-client-ui-renderer","@deepseek-ai/dsh-client-ui-settings","@deepseek-ai/dsh-api-remotes"],"platform":"web","immediately":true}}`.

**Consumption** (`resolveMeta`, `:720`): `platform !== "web"` → silently not a client package (negative cached); then `const clientRel = clientExportOf(packageName, pkg.exports); if (clientRel === void 0) throw new Error('client-modules: … declares dsh.client but exports no "./client" bundle')` — `exports["./client"]` (string or `{default:string}`) is mandatory, and a missing bundle file is a loud aggregated `MissingClientBundleError`/`ClientPackageCompositionError` at activation (`:131`-`:157`). The wire row is `{ id, url, rev, inject?, immediately?: true, external? }` (`graphRow`, `:402`). `external` drives ordering only (`orderByModuleGraph`, `:422`-`:443`): each name resolves to the row id or its `/client`-stripped form, and a name with no row is not an edge ("a static-table name that adds no graph edge", so unknown externals are **ignored**, not fatal); a self-reference or cycle throws `client-modules: module graph cycle …`.

**Bundle format** — verbatim head of `<PKG>/dsh-client-locale/lib/client.js:1` (same shape for every client half):
```js
window.__ModuleLoader__.load({
	id: "@deepseek-ai/dsh-client-locale",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react_jsx_runtime = require("react/jsx-runtime");
		let react = require("react");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		let _deepseek_ai_dsh_client_store = require("@deepseek-ai/dsh-client-store");
		return module.exports;
	}
})
```
The facade is installed before plugin scripts (`bootInjections`, `:461`-`:482`): queue-mode `window.__ModuleLoader__ = { mode:"queue", pendingQueue, load(registration){pendingQueue.push(registration)}, create(options){…} }`, then `<id>/client.js` combos, then `window.__DSH_BOOT__ = graph`. Executing a bundle only **registers** the factory; side effects (incl. CSS) run at materialisation, memoised in `loadCache`, and requiring a registered-but-unmaterialised module materialises it recursively (`:17`-`:32`). Resolution order for `require` (`:26`-`:32`): *seed word → shell instance; memoized record → exports; graph row → register its dependency factories and own factory; registered factory → materialize; anything else → throw (loud)*. Practically resolvable: the shell-seeded singletons (`react`, `react/jsx-runtime`, `@deepseek-ai/dsh-client-ui-primitives`, `@deepseek-ai/dsh-client-store`, …) plus any other plugin's client half registered in the same graph; everything else throws. `<id>/client` and `<id>` normalise to the same exports (`stripClientSuffix`, `:99`).

## 8. Locale — `@deepseek-ai/dsh-client-locale`

**`locale.register(namespace, dictionary)`** (`lib/client.js:1387`):
```js
register(ns, localeOrDicts, dict) {
	const pairs = typeof localeOrDicts === "string" ? [[localeOrDicts, dict]] : Object.entries(localeOrDicts);
	for (const [locale] of pairs) if (!LOCALE_ID_PATTERN.test(locale)) throw new Error(`locale id "${locale}" is not a BCP 47-style tag`);
	let locales = this.dicts.get(ns);
	if (!locales) { locales = new Map(); this.dicts.set(ns, locales); }
	for (const [locale] of pairs) if (locales.has(localeKey(locale))) throw new Error(`locale namespace "${ns}" already has locale "${locale}"`);
	for (const [locale, entries] of pairs) locales.set(localeKey(locale), entries);
	this.publish(this.snapshot.active, false);
	return () => { /* removes exactly the entries it added */ }; }
```
Accepted shapes: `locale.register("devin-search", { en: { title:"Devin", "status.ok":"Signed in" }, zh: { title:"Devin", "status.ok":"已登录" } })`, or the single-locale form `locale.register("devin-search", "en", { … })`. Keys are **flat dotted strings** (lookup is `locales?.get(localeKey(locale))?.[key]`, `:1429`); locale ids must match `LOCALE_ID_PATTERN = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u` (`lib/index.js:9`) and are lower-cased for storage; re-registering a locale for a namespace throws; resolution falls back along the language chain, then `"common"`, then the key itself (`translate`, `:1423`), with `{name}` interpolation from `params`; `bind(ns)` returns `(key, params) => string`. Host-declared languages are `LOCALE_IDS = ["zh","en"]` (`lib/index.js:11`); the browser adds one with `addLanguage({id,label,fallback})` (`client.js:1297`).

**Keys the Host reads from `locale/*.json`** (`dsh-app-boot/lib/index.js:2168`-`2187`, reached from `readPluginMeta` `:2216`):
```js
const language = entry.name.slice(0, -5);            // filename = language id
if (!LANGUAGE_ID.test(language)) throw new Error(`${resource} must use a language id as its filename`);
const meta = parsed.meta === void 0 ? void 0 : objectOf(parsed.meta, `${file}: meta`);
dictionaries.set(id, { title: textOf(meta?.title, `${file}: meta.title`), description: textOf(meta?.description, `${file}: meta.description`) });
```
So plugin display metadata comes from **`<package>/locale/<lang>.json` → `{ "meta": { "title": …, "description": … } }`**, one file per language, `en.json` anchoring the directory; missing fields fall back to `package.json` `name`/`description` (`:2224`-`:2225`), and an `icon` may be a relative `package.json` `icon` path or exported as `<specifier>/icon` (SVG/PNG/JPEG/WebP ≤ 256 KiB, `:2085`-`:2118`). Nothing else in those files is read by the Host.

## 9. Recommended call shapes (paste-ready)

```js
// tool — ctx.tools.register(defineTool({...})) as in §1; zero-import variant: pass RAW JSON Schema
// (object nodes need explicit additionalProperties, requiredness is a top-level `required` array)
ctx.tools.register(defineTool({
  name: "devin_search", description: "Search the web through Devin.",
  parameters: { query: { type: "string", required: true, description: "Search query." }, maxResults: { type: "number" } },
  output: { schema: { type: "object", additionalProperties: false, properties: {
      content: { type: "string" },
      sources: { type: "array", required: true, items: { type: "object", additionalProperties: false, properties: {
          url: { type: "string", required: true }, title: { type: "string" }, snippet: { type: "string" }, publishedAt: { type: "string" } } } },
      truncated: { type: "boolean", required: true } } },
    render: (_args, value) => [{ type: "text", text: format(value) }] },
  timeoutMs: 30000, isConcurrencySafe: () => true,
  async execute(args, exec) { return project(await client.search(args, exec.signal)); } }));

// command
ctx.commands.register({ name: "devin",                       // /^[a-z][a-z0-9_-]*$/
  description: "Open the Devin login flow.",
  input: { hint: "subcommand, e.g. `status`" },              // attachments: true only if used
  async handler({ rawInput, signal }) { try { await flow(signal); return { kind: "success", text: `Devin: ${rawInput.trim()}` }; }
    catch (e) { return { kind: "error", text: String(e?.message ?? e) }; } } });

// web search provider — no `label`; must also be SELECTED (web.searchProvider / DSH_WEB_SEARCH_PROVIDER)
ctx.web.registerSearchProvider({ id: "devin", available: () => session.isValid(),
  async search(request, signal) {                             // { query, maxResults? }
    const rows = await client.query(request.query, request.maxResults, signal);
    return { content, sources: rows.map(r => ({ url: r.url, title: r.title, snippet: r.snippet, publishedAt: r.publishedAt })),
             truncated: rows.length >= (request.maxResults ?? Infinity) }; } });  // sources+truncated REQUIRED

// authenticated browser route (preferred)
ctx.connection.fetch.register({ path: "/api/devin-search/status",   // under /api/, unique
  methods: ["GET"], requestBody: "buffered",                        // 'GET'|'HEAD'|'POST', unique
  fetch: async (request) => Response.json({ ok: true }) });         // Request → Response, owner-only

// Node-level route, only if a non-/api path is required — you own authentication:
ctx.webServer.register({ kind: "exact", path: "/devin-search/status", handler: (req, res) => {
  const rejection = ctx.connection.requestRejection(req);           // 401 | 403 | undefined
  if (rejection !== void 0) { res.writeHead(rejection); res.end(rejection === 401 ? "unauthorized" : "forbidden"); return; }
  res.writeHead(200, { "content-type": "application/json" }); res.end('{"ok":true}'); } });
```

## 10. The three most dangerous assumptions

1. **"`ctx.tools.register` accepts the schema DSL."** It never inspects `parameters` (`dsh-tools/lib/index.js:2974`-`2983`); only `defineTool` compiles `required:true`/`json`/implicit-open roots into the enforced schema. A hand-written definition that skips compilation ships malformed `parameters` to the model, and the failure mode is *silent* (the model simply sees wrong JSON Schema).
2. **"Registering a web provider is enough."** Selection is explicit: with the built-in DeepSeek provider also registered and usable, an unconfigured deployment fails `WEB_PROVIDER_AMBIGUOUS` (`dsh-web/lib/index.js:123`-`136`), and a provider that omits `sources` or `truncated` breaks the `web_search` tool's output validation/formatting (`dsh-tool-web/lib/index.js:62`,`:270`). Set `web.searchProvider` and always return both fields.
3. **"A bad version claim is reported."** At bundle level an unmet `engines.dsh`/DSH peer range drops the whole patch layer and records it only in `skippedBundles`, *"nothing is printed"* (`dsh-app-boot/lib/index.js:1007`-`:1040`); the entry-level path prints to stderr only (`:2308`). Declare no `@deepseek-ai/dsh-*` peer/engine range (or obtain a profile version exemption) — matching what `docs/CONTRACT.md` already concluded.

## 11. Not verified — do not present as fact

* Exact wording of `pluginCompatibilityWarning(issue)` and the `engines.dsh`-vs-`peerDependencies` precedence inside `evaluatePluginCompatibility` (consumer code quoted; producer lives elsewhere in the 4566-line `dsh-app-boot` bundle, not located).
* Behaviour when a patch declares `config` but the plugin exports no `Config` (lives in `@deepseek-ai/cordis` `resolveConfig`, not read).
* Browser-side effect of `dsh.client.immediately`, and whether an unknown/uninstalled `inject` name is fatal (the Host carries both verbatim; only `external` is validated by use).
* A slot registration's `locale` option — the client Inspect providers (`Slots.listSubTree`, client `Service`/`Event`) timed out on every attempt, and the slot runtime lives in a browser bundle I did not read.
* `credentialKey(a,b)`'s runtime value: the `CredentialKey` *type* and `ctx.credentials.readRecord/describeRecord/listRecords/modifyRecord/deleteRecord` contracts are confirmed by `inspect: credentials` (they match the catalog), but not the constructor in `dsh-credentials`.
