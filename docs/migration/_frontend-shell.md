# databench-ui 共享组件 / API 层 / i18n / 应用壳迁移清单

本文按 `fe-brief-B.md` 梳理旧前端 `~/Desktop/databench/databench-ui/` 中共享组件、API 层、i18n 与应用壳功能。目标是给 React + Vite SPA + shadcn/ui + Tailwind + TanStack Router/Query/Virtual + openapi-fetch 重写提供逐项验收清单。

已读范围：

- `databench-ui/src/components/{SampleView,ManifestView,TermsEditor,VirtualizedSamples,VirtualizedTerms,TreeNode,LanguageSwitcher,ConnectionPanel,ui}.tsx`
- `databench-ui/src/api/{client,hooks,http,capabilities,version,config,backend,types}.ts(x)` 与 `generated/schema.ts`
- `databench-ui/src/i18n/index.ts`、`locales/en.json`、`locales/zh.json`
- `databench-ui/src/main.tsx`、`src/App.tsx`、`src/styles.css`
- 参考：`docs/decisions/0006-frontend-stack.md`、`docs/migration/inventory-service.md`

## 共享组件

### CMP-01

- **功能ID**：`CMP-01`
- **名称**：样本类型感知预览；**作用**：按 `Sample.kind` 展示训练样本的关键信息，并保留完整 JSON 折叠查看。
- **现位置**：`databench-ui/src/components/SampleView.tsx:SampleView/Messages/KindBody/Field`
- **行为与边界**：支持 `sft`、`preference`、`rl`、`trajectory`；`messages` 必须是数组才渲染；message role 缺省为 `msg`；非字符串 content 用 `JSON.stringify`；`sample.id` 可选，有则用 code 显示；`preference` 使用 `sample.messages ?? sample.prompt`，展示 `chosen/rejected`；`rl` 展示 `reward`，但当前 OpenAPI schema 中 RL 是 `answer/verifier/rollouts`，这属于旧 UI 容错/漂移点；`trajectory` 展示 `steps` 数量，但当前 schema 中 trajectory 是 `messages`，`steps` 也是容错读取；未知 kind 不展示主体；原始 JSON 使用 `<details>` + `JsonBlock`。
- **依赖后端端点/能力**：间接依赖 `GET /v1/datasets/{ref}/samples` → `API-07`；样本 schema 来自 `SCHEMA Sample`。
- **重写目标(新栈落点)**：`apps/web/src/components/samples/SampleView.tsx`；用 shadcn `Badge`、`Collapsible`/原生 details、代码块组件；保留 tolerant reads，但对 schema 漂移加注释或测试。
- **验收点**：四种 kind 的 fixture 都能显示主要字段；缺失 `id`、缺失 `messages`、非字符串 content 不崩；Raw JSON 折叠内容与原样 sample 一致。
- **备注/疑点**：`rl.reward` 与 `trajectory.steps` 不是当前后端契约字段，重写时要么保留为兼容旧数据，要么确认页面测试不再依赖。

### CMP-02

- **功能ID**：`CMP-02`
- **名称**：Manifest 清单展示；**作用**：把 dataset manifest 的核心字段和额外字段分区展示，可选链接到 dataset detail。
- **现位置**：`databench-ui/src/components/ManifestView.tsx:ManifestView`
- **行为与边界**：核心字段固定为 `version/name/num_rows/kinds`；`version` 在 `linkToDetail=true` 时链接 `/datasets/{encodedVersion}`；`name` 为空显示 `common.dash`；`kinds` 过滤掉 null/undefined 值，空时显示 `common.none`；其他 manifest 字段，如 `schema_version/hash_algo/columns/created_at`，统一进 `Other manifest fields` 折叠 JSON。
- **依赖后端端点/能力**：`GET /v1/datasets/{ref}` → `API-06`；多个 mutation 成功结果也返回 `Manifest`：`API-04/05/10/11`，vocab normalize 返回 `CONTRACT-07`。
- **重写目标(新栈落点)**：`apps/web/src/components/datasets/ManifestView.tsx`；用 shadcn `Card`/`Badge`/`Separator`，路由链接改 TanStack Router typed link。
- **验收点**：manifest fixture 中核心字段固定展示；额外字段折叠可展开；带特殊字符 version 时链接 encode 正确。
- **备注/疑点**：`KNOWN_KEYS` 不含 `schema_version/hash_algo/columns/created_at`，旧 UI 故意把这些归为 extra，不要误删。

### CMP-03

- **功能ID**：`CMP-03`
- **名称**：虚拟化样本浏览；**作用**：分页懒加载样本并只渲染视窗内行，避免大 dataset 卡顿。
- **现位置**：`databench-ui/src/components/VirtualizedSamples.tsx:VirtualizedSamples`
- **行为与边界**：props 为 `{refName, pageSize}`；调用 `useInfiniteSamples(refName,pageSize)`；rows 为所有已加载 pages 的 `items` 扁平化；`total` 来自第一页；TanStack Virtual `estimateSize=200`、`overscan=6`、容器 `.virtual-scroll` 高 600px；当最后一个虚拟项 index 到达 `loaded - 1` 且 `hasNextPage` 时触发 `fetchNextPage`；loading/error/empty 分别用 `Spinner/ErrorState/EmptyState`；底部显示 loading more 或 all loaded。
- **依赖后端端点/能力**：`GET /v1/datasets/{ref}/samples?limit&offset` → `API-07`；后端 limit 上限 500。
- **重写目标(新栈落点)**：`apps/web/src/components/samples/VirtualizedSamples.tsx`；用 `@tanstack/react-virtual`，server state 用 TanStack Query infinite query；样式用 Tailwind 固定高度和绝对定位。
- **验收点**：1000+ 样本只渲染可视行；滚到底自动请求下一页；空 dataset 显示空态；请求失败显示 envelope-aware 错误。
- **备注/疑点**：`virtualItems` 数组参与 effect 依赖，重写时要验证不会重复触发过多请求；pageSize 仍需经 API 层 clamp。

### CMP-04

- **功能ID**：`CMP-04`
- **名称**：词表术语编辑器；**作用**：在词表详情整理流和手工新建流中增删改 `Term[]`。
- **现位置**：`databench-ui/src/components/TermsEditor.tsx:TermsEditor`
- **行为与边界**：受控 props `{terms,onChange}`；新增 canonical 会 trim，空值禁用按钮且不提交；aliases 通过 `parseAliases` 逗号拆分、trim、过滤空项；新增 term 形状 `{canonical, aliases, meta:{}}` 并插入数组头部；输入框 Enter 会 `preventDefault` 后新增；修改 canonical/aliases 与删除 term 都按 index 生成新数组；严格不变量不在前端执行，交给 PUT 服务端校验。
- **依赖后端端点/能力**：保存依赖 `PUT /v1/vocabularies/{name}` → `CONTRACT-05`。
- **重写目标(新栈落点)**：`apps/web/src/components/vocabularies/TermsEditor.tsx`；用 shadcn `Input`、`Button`，列表仍用 `VirtualizedTerms`。
- **验收点**：空 canonical 不能新增；逗号 aliases 规范化；编辑/删除不会原地 mutate；PUT 返回 alias conflict validation 时 `InlineError` 能逐条显示。
- **备注/疑点**：D1 已实现；若连接 `vocabularies:false` 的后端，则 route/nav gated。

### CMP-05

- **功能ID**：`CMP-05`
- **名称**：虚拟化词表术语列表；**作用**：读模式展示 canonical、aliases 和 count，编辑模式展示每行输入控件。
- **现位置**：`databench-ui/src/components/VirtualizedTerms.tsx:VirtualizedTerms`
- **行为与边界**：props 为 `terms`、`editing=false` 与三个可选回调；空 terms 显示 `vocab.noTerms`；TanStack Virtual `estimateSize` 编辑态 92、只读态 64、`overscan=8`；只读态从 `term.meta.count` 读取数值 count；aliases 空显示 `common.none`，否则以 chip 展示；编辑态 canonical 是受控 input，aliases 使用 `AliasInput`，删除按钮有 `aria-label/title`。
- **依赖后端端点/能力**：展示依赖 `GET /v1/vocabularies/{name}` → `CONTRACT-04`；编辑依赖 `CONTRACT-05`。
- **重写目标(新栈落点)**：`apps/web/src/components/vocabularies/VirtualizedTerms.tsx`；用 TanStack Virtual + shadcn `Input/Button/Badge`。
- **验收点**：数百 term 滚动不卡；只读/编辑切换布局稳定；`meta.count` 非 number 不显示；删除按钮可被屏幕阅读器识别。
- **备注/疑点**：D1 已实现；仍需通过详情页和保存流验证。

### CMP-06

- **功能ID**：`CMP-06`
- **名称**：别名输入延迟提交；**作用**：避免用户输入逗号时被即时 parse/join 打断。
- **现位置**：`databench-ui/src/components/VirtualizedTerms.tsx:AliasInput/parseAliases`
- **行为与边界**：`AliasInput` 内部保存 raw text 和 focused 状态；未聚焦时从父级 normalized value 同步，聚焦时不覆盖用户输入；blur 时调用 `onCommit(parseAliases(text))`；`parseAliases` 只按英文逗号拆分。
- **依赖后端端点/能力**：无直接端点；最终提交依赖 `CONTRACT-05`。
- **重写目标(新栈落点)**：`apps/web/src/components/vocabularies/AliasInput.tsx` 或内联在 `VirtualizedTerms`；保留 focused sync 逻辑。
- **验收点**：输入 `a, b,` 时光标和逗号不被吞；blur 后父级收到 `["a","b"]`；虚拟行回收后非聚焦行显示最新父级值。
- **备注/疑点**：只支持英文逗号；是否支持中文顿号/逗号需要产品确认。

### CMP-07

- **功能ID**：`CMP-07`
- **名称**：递归 JSON/血缘树节点；**作用**：把任意嵌套 object/array 以可折叠树渲染。
- **现位置**：`databench-ui/src/components/TreeNode.tsx:TreeNode`
- **行为与边界**：容器判定为非 null object；primitive 显示 `label: value`，null 显示字符串 `null`；数组 preview 为 `[length]`；对象 preview 展示最多前三个 key，超过用省略号；`defaultOpen` 控制当前节点初始展开；空数组/对象展开后显示 `[]` 或 `{}`；子节点递归默认关闭。
- **依赖后端端点/能力**：主要用于 `GET /v1/lineage/{ref}` → `API-14`；也可展示其他开放 JSON。
- **重写目标(新栈落点)**：`apps/web/src/components/common/TreeNode.tsx` 或 lineage 目录；用 shadcn `Button` 的 ghost variant 或原生 button，保留键盘可操作。
- **验收点**：lineage fixture 可展开到 produced_by/inputs；空对象数组不崩；深层递归样式可读。
- **备注/疑点**：旧 UI 没有 `aria-expanded`，重写应补齐。

### CMP-08

- **功能ID**：`CMP-08`
- **名称**：语言切换器；**作用**：在顶栏切换 en/zh 并持久化到 i18next detector 配置的 localStorage。
- **现位置**：`databench-ui/src/components/LanguageSwitcher.tsx:LanguageSwitcher`
- **行为与边界**：从 `SUPPORTED_LANGUAGES=['en','zh']` 生成按钮；当前语言取 `i18n.resolvedLanguage ?? 'en'`；外层 `role="group"` 且 `aria-label=language.label`；按钮 `aria-pressed` 标识选中；点击调用 `i18n.changeLanguage(lng)`。
- **依赖后端端点/能力**：无。
- **重写目标(新栈落点)**：`apps/web/src/components/shell/LanguageSwitcher.tsx`；可用 shadcn `ToggleGroup`，保留 `aria-pressed`/group label。
- **验收点**：切换后文案立即变更；刷新后沿用 `databench.lang`；只显示 EN/中文。
- **备注/疑点**：旧 i18n 不读取浏览器语言，默认中文。

### CMP-09

- **功能ID**：`CMP-09`
- **名称**：后端连接面板；**作用**：显示连接状态、版本信息、feature flags，并允许配置 API origin 与 bearer token。
- **现位置**：`databench-ui/src/components/ConnectionPanel.tsx:ConnectionPanel`
- **行为与边界**：读取 `useBackend()` 的 `base/token/setBase/setToken` 和 `useCapabilities()`；状态：capabilities error 为 disconnected，有 capabilities 为 connected，否则 checking；弹层用本地 draft，同步外部 base/token；Apply 时 base 变更才 `setBase`，token 总是保存，随后关闭；Reset 只重置 base/baseDraft 到 `DEFAULT_API_BASE`，不清 tokenDraft；版本显示 `api {api_version} · svc {service_version}`；连接成功时展示 api/service/schema version 和 `capabilities.features` badge，false feature 加删除线；token input 为 password 且 `autoComplete="off"`。
- **依赖后端端点/能力**：`GET /capabilities` → `API-03`，`GET /version` → `API-02`；Authorization header 由 API 层附加。
- **重写目标(新栈落点)**：`apps/web/src/components/shell/ConnectionPanel.tsx`；用 shadcn `Popover`、`Input`、`Button`、`Badge`。
- **验收点**：后端不可达显示红点和 unreachable；设置 base 后所有 query key 切到新 base；每个 base 使用独立 token；feature flags 与 capabilities 响应一致。
- **备注/疑点**：Reset 不清 token 可能是旧行为，重写时若改为清 token 应明确变更。

### CMP-10

- **功能ID**：`CMP-10`
- **名称**：通用加载、空态、禁用态；**作用**：给异步数据和能力未启用模块提供一致状态 UI。
- **现位置**：`databench-ui/src/components/ui.tsx:Spinner/EmptyState/FeatureDisabled`
- **行为与边界**：`Spinner` label 可传，不传用 `common.loading`；`EmptyState` 直接渲染 children；`FeatureDisabled` children 可覆盖默认 `common.featureDisabled`；样式分别为 `.state-loading/.state-empty/.state-disabled`。
- **依赖后端端点/能力**：间接依赖各 hook loading/error 与 `capabilities.features`。
- **重写目标(新栈落点)**：`apps/web/src/components/common/State.tsx`；可用 shadcn `Alert`/自定义状态块。
- **验收点**：所有 loading/empty/disabled 场景文案来自 i18n；状态块在暗色主题可读。
- **备注/疑点**：旧 `Spinner` 不是视觉 spinner，只是 loading 文本。

### CMP-11

- **功能ID**：`CMP-11`
- **名称**：统一错误与表单内联错误展示；**作用**：把 `ApiError` 的 envelope code/message 和 validation detail 统一渲染。
- **现位置**：`databench-ui/src/components/ui.tsx:ErrorState/InlineError/messageFor/detailMessages`
- **行为与边界**：`ApiError.status===0` 显示 network message；HTTP error 显示 `${code} — ${message}`；非 `ApiError` 的 `Error` 显示 `.message`；未知错误用 `common.unknownError`；`InlineError` 优先读取统一 envelope `body.error.detail`，兼容 legacy FastAPI `body.detail`；detail 可以是 string 或 array，array 取每项 `msg`；去掉 `Value error,` 前缀；无 detail 时退回顶层 message。
- **依赖后端端点/能力**：所有 API error；统一 envelope 对应 `ERR-01..06`，legacy `{detail}` 为兼容旧 FastAPI。
- **重写目标(新栈落点)**：`apps/web/src/components/common/ErrorState.tsx`；继续依赖 API 层 `ApiError` 或 openapi-fetch middleware 封装出的等价 error。
- **验收点**：404 envelope、422 envelope array、legacy `{detail:"..."}`、network failure 四类 fixture 都显示正确；表单 validation 能逐条列出 alias conflict。
- **备注/疑点**：旧 UI 使用 `—` 分隔 code/message；重写可保留或改视觉，但信息不能丢。

### CMP-12

- **功能ID**：`CMP-12`
- **名称**：Card 与 JSON block 基础组件；**作用**：提供统一 section 容器和 JSON 预览。
- **现位置**：`databench-ui/src/components/ui.tsx:Card/JsonBlock`
- **行为与边界**：`Card` 可选 title，渲染 `<section className="card">`；`JsonBlock` 用 `JSON.stringify(value,null,2)`，不做循环引用保护。
- **依赖后端端点/能力**：无直接端点；展示 manifest、sample、params_schema、lineage 等 JSON。
- **重写目标(新栈落点)**：`apps/web/src/components/common/JsonBlock.tsx`，Card 优先用 shadcn `Card`。
- **验收点**：JSON 缩进 2 空格；大 JSON 有滚动上限；无 title 时不渲染空标题。
- **备注/疑点**：若后端返回循环对象不可能经 JSON transport 发生。

## API 层

### FAPI-01

- **功能ID**：`FAPI-01`
- **名称**：生成类型与 app-only 类型；**作用**：把 pinned OpenAPI schema 暴露为前端域类型，并补充 UI 容错类型。
- **现位置**：`databench-ui/src/api/types.ts`、`src/api/generated/schema.ts`
- **行为与边界**：所有后端 schema 通过 `components['schemas']` alias 导出；`Vocabulary` 分 input/output，output 有 readonly `id`；`Sample` 是四种 sample 联合并额外允许 optional `id` 和 index signature；`HealthInfo=Record<string,string>`；`Lineage=Record<string,unknown>`；`ExportFormat='messages-jsonl'|'trl'`；`IngestKind=SampleKind`；`AliasConflict` 容错读取 `Term.meta.alias_conflicts`。
- **依赖后端端点/能力**：全量 OpenAPI；vocab 类型依赖已实现的 `CONTRACT-03..08`。
- **重写目标(新栈落点)**：`apps/web/src/api/types.ts`；用 `openapi-typescript` + `openapi-fetch` 生成 paths/components，app-only 类型单独维护。
- **验收点**：生成类型包含 `Capabilities/VersionInfo/Manifest/SamplesPage/RefsPage/TransformsPage/Recipe/Vocabulary*`；`Sample.id` 仍 optional，不误认为后端必返。
- **备注/疑点**：旧 UI 使用的 schema 领先 Python 后端，多出 vocabularies。

### FAPI-02

- **功能ID**：`FAPI-02`
- **名称**：分页常量与 limit clamp；**作用**：前端防御性遵守服务端分页上限。
- **现位置**：`databench-ui/src/api/client.ts:MAX_PAGE_LIMIT/DEFAULT_PAGE_LIMIT/clampLimit`
- **行为与边界**：`MAX_PAGE_LIMIT=500`，`DEFAULT_PAGE_LIMIT=20`；`clampLimit(limit)` 取 `Math.floor` 后限制在 `[1,500]`；refs 默认 hook 用 200，transforms/vocab list 默认用 500。
- **依赖后端端点/能力**：分页端点 `API-07/API-09/API-12` 与 `CONTRACT-03`。
- **重写目标(新栈落点)**：`apps/web/src/api/pagination.ts` 或 `client.ts`；在 openapi-fetch wrapper 调用前统一 clamp。
- **验收点**：传 0、负数、小数、999 都生成合法 limit；不向后端发送超过 500 的 limit。
- **备注/疑点**：offset 未 clamp，旧 UI 原样发送。

### FAPI-03

- **功能ID**：`FAPI-03`
- **名称**：HTTP URL、query、body 与鉴权传输层；**作用**：以运行时 base 构建绝对/相对 URL，附加 bearer token，统一发送 JSON、FormData 和 raw streaming 请求。
- **现位置**：`databench-ui/src/api/http.ts:buildUrl/rawRequest/request/authHeaders`
- **行为与边界**：`buildUrl` 接收已带 `/v1` 或 meta path 的路径；base 为空则 same-origin；query 忽略 undefined/null，其他值 String 化；token 存在时加 `Authorization: Bearer ${token}`；JSON body 加 `Content-Type: application/json`；FormData 不手动设置 Content-Type；网络/CORS/DNS fetch 失败抛 `ApiError(0,'unreachable')`；`rawRequest` 返回原始 `Response` 供下载。
- **依赖后端端点/能力**：所有 REST 端点；鉴权 header 由部署环境决定。
- **重写目标(新栈落点)**：`apps/web/src/api/client.ts`；用 `openapi-fetch` `baseUrl`/middleware 或 wrapper 注入 token、query 和 error handling；streaming export 仍需要 raw fetch。
- **验收点**：same-origin 与 `http://127.0.0.1:8000` 两种 base 生成正确 URL；multipart 上传有 boundary；token header 随 base token 变化。
- **备注/疑点**：API base 必须是 origin only，不能包含 `/v1`。

### FAPI-04

- **功能ID**：`FAPI-04`
- **名称**：错误 envelope 解析；**作用**：把统一错误、legacy FastAPI 错误、非 JSON 响应转为 `ApiError`。
- **现位置**：`databench-ui/src/api/http.ts:ApiError/describeError/parseBody/request`
- **行为与边界**：统一 envelope `{error:{code,message,detail?}}` 优先；legacy `{detail:string}` 和 FastAPI validation array 兼容；fallback message 按 HTTP status 使用 i18n：400 bad request、404 not found、422 validation、501 not implemented，否则 generic；2xx 但 content-type 不含 `application/json` 时抛 `not_databench`，避免 SPA fallback HTML 被误当 API。
- **依赖后端端点/能力**：`ERR-01..06`；legacy `{detail}` 兼容旧 FastAPI。
- **重写目标(新栈落点)**：`apps/web/src/api/errors.ts`；openapi-fetch 的 `onResponse`/wrapper 中保留 envelope-aware parsing。
- **验收点**：统一 envelope、legacy detail、HTML 200、网络失败四类都有单元测试；i18n fallback 在中英文下生效。
- **备注/疑点**：`ApiError.detail` 保存原始 body 或 cause，`InlineError` 依赖该字段。

### FAPI-05

- **功能ID**：`FAPI-05`
- **名称**：运行时 backend base 与 per-base token 存储；**作用**：让用户在 UI 中切换不同后端，并隔离各后端凭据。
- **现位置**：`databench-ui/src/api/config.ts`
- **行为与边界**：`DEFAULT_API_BASE=''` 表示当前 origin；base 存 localStorage key `databench.api_base`，空值删除；`normalizeBase` trim 并去尾 slash；token key 为 `databench.token:${base || '(origin)'}`；token trim 后为空则删除；localStorage 不可用时静默忽略。
- **依赖后端端点/能力**：无直接端点；影响所有请求。
- **重写目标(新栈落点)**：`apps/web/src/api/backend-config.ts`；继续 runtime editable，不使用 build-time env 固化唯一后端。
- **验收点**：`http://a///` 存为 `http://a`；切到 backend B 时不会带 backend A token；隐私模式 localStorage 抛错不崩。
- **备注/疑点**：token 明文存在 localStorage，是旧行为；如改存储策略需安全评审。

### FAPI-06

- **功能ID**：`FAPI-06`
- **名称**：Backend React context 与 query key 前缀；**作用**：把 active backend 放进 React state，使所有 query cache 按后端隔离。
- **现位置**：`databench-ui/src/api/backend.tsx:BackendProvider/useBackend/useBackendKey`
- **行为与边界**：初始化读取 `getApiBase/getToken`；`setBase` normalize、持久化、更新 state，并切换到新 base namespace 下的 token；`setToken` 按当前 base 持久化并 trim；`useBackend` 必须在 provider 内，否则 throw；`useBackendKey` 返回 base 作为 query key 第一段。
- **依赖后端端点/能力**：无直接端点；影响所有 TanStack Query hooks。
- **重写目标(新栈落点)**：`apps/web/src/api/BackendProvider.tsx`；TanStack Query hooks 继续把 base 放入 queryKey。
- **验收点**：同一路径在两个 base 下缓存互不串；切 base 后 ConnectionPanel token draft 更新为对应 token。
- **备注/疑点**：如果未来支持 org/project 等更多连接维度，query key 前缀要扩展。

### FAPI-07

- **功能ID**：`FAPI-07`
- **名称**：meta endpoints 与客户端握手；**作用**：读取健康、版本与运行时能力。
- **现位置**：`databench-ui/src/api/client.ts:api.health/version/capabilities`、`src/api/hooks.ts:useHealth`、`src/api/capabilities.tsx:CapabilitiesProvider`
- **行为与边界**：meta routes 不带 `/v1`；`useHealth` 每 15s refetch 且不 retry；`CapabilitiesProvider` 对 capabilities 每 30s refetch，不 retry；version 单独查询不 retry；context 暴露 `capabilities/version/compatibility/isLoading/isError/error/ready/refetch`；`ready` 只在 compatibility ok 时 true。
- **依赖后端端点/能力**：`GET /health` → `API-01`，`GET /version` → `API-02`，`GET /capabilities` → `API-03`。
- **重写目标(新栈落点)**：`apps/web/src/api/meta.ts`、`apps/web/src/api/capabilities.tsx`；openapi-fetch 对 unversioned meta routes 需要支持。
- **验收点**：后端启动时 connected，停止时 disconnected；capabilities 30s 自动刷新；version 字段在连接面板显示。
- **备注/疑点**：`CapabilitiesProvider.ready` 旧 App Gate 没直接用，但可供新 shell 使用。

### FAPI-08

- **功能ID**：`FAPI-08`
- **名称**：版本兼容性检查；**作用**：在渲染业务路由前拦截不兼容后端。
- **现位置**：`databench-ui/src/api/version.ts:CLIENT_VERSION/SUPPORTED_API_MAJORS/checkCompatibility`
- **行为与边界**：`CLIENT_VERSION='0.1.0'`；支持 API major `[1]`；`majorOf` 支持 `v1`、`1`、`1.4.0`，缺失或非法视为 unsupported；`compareSemver` 逐段数字比较，缺失段按 0；只有后端提供非空 `min_client` 时才执行 client-too-old gate。
- **依赖后端端点/能力**：`GET /capabilities` 的 `api_version/min_client` → `API-03`；`GET /version` 用于展示 → `API-02`。
- **重写目标(新栈落点)**：`apps/web/src/api/version.ts`；保持测试覆盖。
- **验收点**：`v2` 显示 api unsupported；`min_client=0.2.0` 显示 client too old；缺失 min_client 不阻断。
- **备注/疑点**：后端 inventory 中 `min_client` 当前固定 `0.1.0`。

### FAPI-09

- **功能ID**：`FAPI-09`
- **名称**：能力 feature flags；**作用**：区分严格功能启用与导航容错显示。
- **现位置**：`databench-ui/src/api/capabilities.tsx:FEATURES/useFeature/useModuleEnabled`
- **行为与边界**：已知 feature key：`transforms/recipes/lineage/vocabularies/jsonl_ingest/export`；`useFeature` 严格为 `capabilities.features[name] ?? false`；`useModuleEnabled` 在 capabilities 未加载前返回 true，加载后只在 feature 显式为 false 时隐藏，缺失 key 仍显示。
- **依赖后端端点/能力**：`GET /capabilities` → `API-03`。
- **重写目标(新栈落点)**：`apps/web/src/api/capabilities.ts`；导航 gating 逻辑保留或有意收紧。
- **验收点**：`features.transforms=false` 隐藏 transforms nav；capabilities 缺失 `vocabularies` 时旧行为仍显示词表 nav。
- **备注/疑点**：D1 后 TS 后端显式返回 `vocabularies:true`；连接旧后端或无词表能力后端时，前端仍需按能力位隐藏或 disabled。

### FAPI-10

- **功能ID**：`FAPI-10`
- **名称**：Refs API、查询和失效；**作用**：列出和解析 named refs，并在产生新 dataset 后刷新 refs 列表。
- **现位置**：`databench-ui/src/api/client.ts:api.listRefs/getRef`、`src/api/hooks.ts:useRefs/useRefsInvalidation`
- **行为与边界**：`listRefs(limit=20,offset=0)` 调 `/v1/refs` 且 clamp limit；`useRefs(limit=200)` query key `[base,'refs',limit]`；`getRef(name)` encode path；`useRefsInvalidation` invalidate `[base,'refs']`，会匹配所有 refs limit 变体；create/ingest/runTransform/materialize/normalize/validate 成功后刷新 refs。
- **依赖后端端点/能力**：`GET /v1/refs` → `API-12`，`GET /v1/refs/{name}` → `API-13`。
- **重写目标(新栈落点)**：`apps/web/src/api/refs.ts`；openapi-fetch path params encode，Query hooks 用 queryOptions。
- **验收点**：默认请求 200 refs；mutation 成功后 dataset list 更新；ref 名带 `/` 或空格时 encode 正确。
- **备注/疑点**：`getRef` 在旧 API object 有，但当前 brief 范围组件未直接使用。

### FAPI-11

- **功能ID**：`FAPI-11`
- **名称**：Dataset manifest 与样本分页查询；**作用**：读取 manifest，并提供普通分页和无限滚动两种 samples 数据流。
- **现位置**：`databench-ui/src/api/client.ts:api.getDataset/getSamples`、`src/api/hooks.ts:useDataset/useSamples/useInfiniteSamples`
- **行为与边界**：`getDataset(ref)` 与 `getSamples(ref,limit,offset,signal)` 都 encode ref；`getSamples` clamp limit；`useDataset` 和 samples hooks 在 `!!ref` 时启用；`useSamples` 使用 `placeholderData(prev)=>prev` 保持翻页时旧数据；`useInfiniteSamples` `initialPageParam=0`，`getNextPageParam` 用 `last.offset + last.limit < last.total` 判定下一页 offset。
- **依赖后端端点/能力**：`GET /v1/datasets/{ref}` → `API-06`，`GET /v1/datasets/{ref}/samples` → `API-07`。
- **重写目标(新栈落点)**：`apps/web/src/api/datasets.ts`；虚拟化页面使用 `useInfiniteQuery`。
- **验收点**：未知 ref 显示 404 envelope；offset 超 total 时 items 空但不报错；无限滚动不会一次性拉全量。
- **备注/疑点**：Sample response 不保证有 `id`，组件要容错。

### FAPI-12

- **功能ID**：`FAPI-12`
- **名称**：Dataset 创建与 JSONL 上传；**作用**：支持 JSON body 样本入库和 multipart JSONL 入库。
- **现位置**：`databench-ui/src/api/client.ts:api.createDataset/ingestJsonl`、`src/api/hooks.ts:useCreateDataset/useIngestJsonl`
- **行为与边界**：`createDataset(payload)` POST `/v1/datasets` JSON；`ingestJsonl(file,{name,kind,source})` FormData 字段名必须为 `file`，query 可带 name/kind/source；两个 mutation 成功后 invalidate refs；`kind` 使用 `SampleKind`，即 `sft/preference/rl/trajectory`。
- **依赖后端端点/能力**：`POST /v1/datasets` → `API-04`，`POST /v1/datasets:ingest-jsonl` → `API-05`；JSONL 上传还受 `FEATURES.jsonl_ingest` 影响。
- **重写目标(新栈落点)**：`apps/web/src/api/datasets.ts`；multipart 可能需要 openapi-fetch raw body 或自定义 fetch。
- **验收点**：JSON 数组入库成功刷新 refs；JSONL 上传请求 body 是 multipart 且 query 正确；未启用 `jsonl_ingest` 时页面显示 disabled。
- **备注/疑点**：message 只对 JSON body create 有意义，JSONL API 当前不传 message。

### FAPI-13

- **功能ID**：`FAPI-13`
- **名称**：Dataset 流式导出下载；**作用**：生成 export URL，并通过 fetch 附带 bearer token 下载 NDJSON。
- **现位置**：`databench-ui/src/api/client.ts:api.exportUrl/exportResponse/downloadExport`
- **行为与边界**：`ExportFormat='messages-jsonl'|'trl'`，默认 `messages-jsonl`；`exportUrl` 只生成 URL 供展示；实际下载走 `exportResponse`/`rawRequest` 以附加 Authorization；非 ok 时再调用 JSON `request` 以抛出 envelope-aware error；ok 后 `res.blob()`，创建 object URL，临时 `<a>` 下载；文件名为 sanitized ref + `.${fmt}.jsonl`，不使用服务端 Content-Disposition。
- **依赖后端端点/能力**：`GET /v1/datasets/{ref}/export?fmt=` → `API-08`；受 `FEATURES.export` 影响。
- **重写目标(新栈落点)**：`apps/web/src/api/export.ts`；保持 raw fetch，不完全交给 openapi-fetch JSON parser。
- **验收点**：带 token 的后端能下载；404 时显示统一错误；ref 中空格/斜杠被替换为 `_`；下载后 revoke object URL。
- **备注/疑点**：后端实际忽略 `fmt` 差异；旧前端允许 `trl`。

### FAPI-14

- **功能ID**：`FAPI-14`
- **名称**：Transforms 查询与执行；**作用**：列出可运行 transforms，并提交运行请求产生 manifest。
- **现位置**：`databench-ui/src/api/client.ts:api.listTransforms/runTransform`、`src/api/hooks.ts:useTransforms/useRunTransform`
- **行为与边界**：`listTransforms(limit=500,offset=0)`；`useTransforms` 对 404/501 视为 feature not deployed，不重试；其他错误最多 retry 一次；`runTransform(name,payload)` encode name，POST JSON `{inputs,params?,ref?}`；成功后 invalidate refs。
- **依赖后端端点/能力**：`GET /v1/transforms` → `API-09`，`POST /v1/transforms/{name}/run` → `API-10`；受 `FEATURES.transforms` 影响。
- **重写目标(新栈落点)**：`apps/web/src/api/transforms.ts`。
- **验收点**：列表包含 params_schema；未知 transform 404 显示 envelope；成功运行后 refs 刷新；404/501 部署缺失不进行多次 retry。
- **备注/疑点**：params_schema 是开放 object/null，前端不能假设固定字段。

### FAPI-15

- **功能ID**：`FAPI-15`
- **名称**：Recipe materialize mutation；**作用**：提交 recipe 并生成混合 dataset。
- **现位置**：`databench-ui/src/api/client.ts:api.materializeRecipe`、`src/api/hooks.ts:useMaterializeRecipe`
- **行为与边界**：POST `/v1/recipes:materialize` JSON `{recipe,ref?}`；成功后 invalidate refs；recipe type 包含 `name/sources/target_format/target_size/seed`。
- **依赖后端端点/能力**：`POST /v1/recipes:materialize` → `API-11`；受 `FEATURES.recipes` 影响。
- **重写目标(新栈落点)**：`apps/web/src/api/recipes.ts`。
- **验收点**：合法 recipe 返回 manifest 并刷新 refs；非法 JSON/object validation 能通过 `InlineError` 或页面错误显示。
- **备注/疑点**：`target_format` 当前后端不改变物化/导出行为。

### FAPI-16

- **功能ID**：`FAPI-16`
- **名称**：Lineage 查询；**作用**：按 ref/version 获取开放 JSON provenance DAG。
- **现位置**：`databench-ui/src/api/client.ts:api.getLineage`、`src/api/hooks.ts:useLineage`
- **行为与边界**：`getLineage(ref)` encode ref；hook 在 `!!ref` 时启用；404/501 按 feature not deployed 不重试，其他错误最多 retry 一次；返回类型为开放 `Record<string,unknown>`。
- **依赖后端端点/能力**：`GET /v1/lineage/{ref}` → `API-14`；受 `FEATURES.lineage` 影响。
- **重写目标(新栈落点)**：`apps/web/src/api/lineage.ts`。
- **验收点**：未知 ref 按后端当前行为返回 `{version: ref}` 而不是 UI 404；TreeNode 可渲染任意 DAG。
- **备注/疑点**：lineage route 对未知 ref 的语义与 dataset/ref endpoints 不同。

### FAPI-17

- **功能ID**：`FAPI-17`
- **名称**：Vocabularies 列表与详情；**作用**：列出 named vocabulary latest version，并读取单个 vocabulary。
- **现位置**：`databench-ui/src/api/client.ts:api.listVocabularies/getVocabulary`、`src/api/hooks.ts:useVocabularies/useVocabulary`
- **行为与边界**：`listVocabularies(limit=500,offset=0)`；`useVocabularies` 对 404/501 不重试；`getVocabulary(name)` encode name；`useVocabulary` 在 `!!name` 时启用；响应 `VocabularyInfo` 含 `name/id/dimension/num_terms/status`，详情 `Vocabulary` 含 `id/dimension/status/source/meta/terms`。
- **依赖后端端点/能力**：`GET /v1/vocabularies` → `CONTRACT-03`，`GET /v1/vocabularies/{name}` → `CONTRACT-04`；受 `FEATURES.vocabularies`。
- **重写目标(新栈落点)**：`apps/web/src/api/vocabularies.ts`。
- **验收点**：后端返回 `vocabularies:false` 时隐藏或禁用词表入口；D1 后列表分页、过滤和详情加载正常；404/501 部署缺失不反复 retry。
- **备注/疑点**：D1 已实现，保留能力位降级。

### FAPI-18

- **功能ID**：`FAPI-18`
- **名称**：Vocabulary derive 与 save；**作用**：从 dataset 标签派生 draft vocabulary，并保存手工整理或新建的 vocabulary。
- **现位置**：`databench-ui/src/api/client.ts:api.deriveVocabulary/putVocabulary`、`src/api/hooks.ts:useDeriveVocabulary/usePutVocabulary`
- **行为与边界**：derive path 为 `/v1/vocabularies/{name}:derive`，query 必填 `dataset/dimension`，optional extractor 作为 JSON body；extractor 不传时 `json` 为 undefined，body 整体省略；PUT body 是 `VocabularyInput`；derive 成功 invalidate vocabularies list；PUT 成功 invalidate vocabularies list 和 `[base,'vocabulary',name]` detail。
- **依赖后端端点/能力**：`POST /v1/vocabularies/{name}:derive` → `CONTRACT-06`，`PUT /v1/vocabularies/{name}` → `CONTRACT-05`；derive 还读取 dataset → `API-06`。
- **重写目标(新栈落点)**：`apps/web/src/api/vocabularies.ts`。
- **验收点**：extractor 留空不发送 JSON `null`；保存后详情页刷新到新版本；服务端 invariant violation 逐条显示。
- **备注/疑点**：D1 已实现；`Extractor.source` 当前固定 `assistant_json`。

### FAPI-19

- **功能ID**：`FAPI-19`
- **名称**：Vocabulary normalize 与 validate；**作用**：把词表应用到 dataset，产生新 dataset manifest 或 validate summary。
- **现位置**：`databench-ui/src/api/client.ts:api.normalizeVocabulary/validateVocabulary`、`src/api/hooks.ts:useNormalizeVocabulary/useValidateVocabulary`
- **行为与边界**：两者 path 分别为 `:normalize`、`:validate`；query 必填 `dataset`，可选 `ref`；旧客户端不发送 extractor body，服务端应从 vocab `meta.extractor` 或 dimension preset 解析；normalize 返回 `Manifest`，validate 返回 `{dataset: Manifest, summary}`；成功后 invalidate refs。
- **依赖后端端点/能力**：`POST /v1/vocabularies/{name}:normalize` → `CONTRACT-07`，`POST /v1/vocabularies/{name}:validate` → `CONTRACT-08`；产生 dataset 并记录 vocabulary lineage。
- **重写目标(新栈落点)**：`apps/web/src/api/vocabularies.ts`。
- **验收点**：validate 显示 checked/invalid/offending_values 与新 dataset manifest；normalize 显示新 manifest；输出 ref 成功刷新 refs。
- **备注/疑点**：D1 已实现；lineage op 为 `vocabulary:normalize` / `vocabulary:validate`。

### FAPI-20

- **功能ID**：`FAPI-20`
- **名称**：feature-not-deployed retry 策略；**作用**：对可选模块的 404/501 降级，避免不可用模块持续重试。
- **现位置**：`databench-ui/src/api/hooks.ts:isNotDeployed` 与 `useTransforms/useLineage/useVocabularies`
- **行为与边界**：`ApiError.status` 为 404 或 501 时返回 true；可选模块 query 的 retry 函数为 `!isNotDeployed(error) && count < 1`；因此最多一次重试，部署缺失不重试。
- **依赖后端端点/能力**：`API-09/API-14`、`CONTRACT-03` 及其他可选模块。
- **重写目标(新栈落点)**：`apps/web/src/api/query-policies.ts`。
- **验收点**：vocab route 404 时 Query 不持续打后端；临时 500 仍可重试一次。
- **备注/疑点**：如果 TS 后端用 capabilities 严格 gating，可减少 404 降级需求，但仍建议保留。

## i18n

### I18N-01

- **功能ID**：`I18N-01`
- **名称**：i18next 初始化；**作用**：加载中英文资源并提供 React i18n。
- **现位置**：`databench-ui/src/i18n/index.ts`
- **行为与边界**：`SUPPORTED_LANGUAGES=['en','zh']`；使用 `LanguageDetector` 和 `initReactI18next`；`fallbackLng='zh'`；`load='languageOnly'`；`nonExplicitSupportedLngs=true`；`interpolation.escapeValue=false`；检测顺序只有 `localStorage`，key 为 `databench.lang`，缓存也写 localStorage；不读取浏览器语言，因此无持久化选择时默认中文。
- **依赖后端端点/能力**：无。
- **重写目标(新栈落点)**：`apps/web/src/i18n/index.ts`；沿用 i18next/react-i18next。
- **验收点**：首次打开中文；切换英文后 localStorage 记录并刷新保持；`zh-CN`/`en-US` 归并为 `zh/en`。
- **备注/疑点**：如果新产品希望跟随浏览器语言，这是行为变更。

### I18N-02

- **功能ID**：`I18N-02`
- **名称**：双语资源对齐；**作用**：保证 en/zh key 完全同构。
- **现位置**：`databench-ui/src/i18n/locales/en.json`、`zh.json`
- **行为与边界**：两个文件均有 203 个 flattened leaf key；命名空间覆盖 `brand/nav/common/language/health/connection/gate/datasets/detail/ingest/transforms/recipe/lineage/vocab/manifest/sample/errors/notFound`；`vocab.status` 当前只有 `draft/curated`，没有 `review`，但 CSS 有 `.status-review`。
- **依赖后端端点/能力**：无直接端点；vocab 文案依赖 `CONTRACT-03..08`。
- **重写目标(新栈落点)**：`apps/web/src/i18n/locales/{en,zh}.json`；可加测试比较 key set。
- **验收点**：CI 中 flatten key set 完全一致；页面使用 key 不 missing；动态 key 如 `health.${status}`、`language.${lng}`、`vocab.status.${status}` 有覆盖。
- **备注/疑点**：若 vocabulary status 增加 `review`，需要补 key。

### I18N-03

- **功能ID**：`I18N-03`
- **名称**：错误 fallback 文案；**作用**：API 层在缺少后端 message 时仍可按状态码显示本地化错误。
- **现位置**：`databench-ui/src/api/http.ts:describeError`、`src/i18n/locales/*.json:errors`
- **行为与边界**：错误 key 包含 `unreachable/notDatabench/badRequest/notFound/validation/notImplemented/generic`；`generic` 插值 `status`；network failure 使用 `errors.unreachable`；2xx 非 JSON 使用 `errors.notDatabench`。
- **依赖后端端点/能力**：所有端点错误；`ERR-*`。
- **重写目标(新栈落点)**：`apps/web/src/api/errors.ts` 与 locale resources。
- **验收点**：切换语言后 API fallback 错误同步改变；插值 status 正确。
- **备注/疑点**：后端如果返回已本地化 message，前端直接显示，不二次翻译。

### I18N-04

- **功能ID**：`I18N-04`
- **名称**：跨模块业务文案覆盖；**作用**：为旧页面、共享组件和应用壳提供完整文案。
- **现位置**：`databench-ui/src/i18n/locales/*.json`
- **行为与边界**：`common` 覆盖通用动作和状态；`connection/gate/health` 覆盖应用壳；`manifest/sample` 覆盖共享数据展示；`vocab` 覆盖词表全流程；各页面 namespace 覆盖列表、表单、错误提示。
- **依赖后端端点/能力**：与对应页面和组件的 API 依赖一致。
- **重写目标(新栈落点)**：保留 namespace 结构，重写页面时按功能逐步删改，不应一次性丢弃旧 key。
- **验收点**：静态扫描 `t('...')` 与动态 key 前缀都有对应 key；无 unused key 可后续清理，但迁移初期宁可保留。
- **备注/疑点**：本任务只覆盖共享/API/i18n/壳，页面级 key 仍列入 key 清单，方便后续页面清单引用。

## 应用壳

### SHELL-01

- **功能ID**：`SHELL-01`
- **名称**：React root providers；**作用**：装配全局 Query、backend、capabilities、router、i18n 和样式。
- **现位置**：`databench-ui/src/main.tsx`
- **行为与边界**：`QueryClient` 默认 options：queries `retry=1`、`refetchOnWindowFocus=false`；provider 顺序为 `QueryClientProvider > BackendProvider > CapabilitiesProvider > BrowserRouter > App`；React StrictMode 包裹；入口强制 `document.getElementById('root')!`；导入 `./i18n` 初始化和 `./styles.css`。
- **依赖后端端点/能力**：CapabilitiesProvider 启动即访问 `API-02/API-03`。
- **重写目标(新栈落点)**：`apps/web/src/main.tsx`；Router 改 `TanStack Router`，但 provider 顺序中 Backend 必须在 capabilities/query hooks 可读的位置。
- **验收点**：启动后不因 router/provider 顺序报错；默认 query 不在 window focus 时 refetch；capabilities query key 包含 base。
- **备注/疑点**：TanStack Router provider 将替代 BrowserRouter。

### SHELL-02

- **功能ID**：`SHELL-02`
- **名称**：顶栏与全局布局；**作用**：提供品牌、模块导航、语言切换和连接状态入口。
- **现位置**：`databench-ui/src/App.tsx:App/Nav/NavItem`、`src/styles.css:.topbar/.content`
- **行为与边界**：外层 `.app` min-height 100vh；顶栏 sticky top 0，height 56，z-index 10；品牌显示 `databench {brand.suffix}`；导航为 flex，active 使用 NavLink class；右侧固定 `LanguageSwitcher` 与 `ConnectionPanel`；content 最大宽 1100px，居中，padding 24。
- **依赖后端端点/能力**：导航可见性依赖 capabilities `API-03`。
- **重写目标(新栈落点)**：`apps/web/src/components/shell/AppShell.tsx`；TanStack Router active link，Tailwind/shadcn 实现。
- **验收点**：窄屏不发生不可读重叠；active route 可见；连接弹层在顶栏右侧。
- **备注/疑点**：旧样式未做完整移动端导航折叠，重写可改进但模块入口不能丢。

### SHELL-03

- **功能ID**：`SHELL-03`
- **名称**：能力和版本 gate；**作用**：在业务路由前处理连接中、不可达和版本不兼容状态。
- **现位置**：`databench-ui/src/App.tsx:Gate`
- **行为与边界**：capabilities loading 时显示 Card + Spinner；capabilities error 时显示 Card + ErrorState + hint，顶栏仍可操作以修改 base；compatibility 不 ok 时显示 incompatible Card，区分 `client_too_old` 和 `api_unsupported`，并插值 min/current/api；通过后渲染 `AppRoutes`；不使用 `CapabilitiesContext.ready`，直接根据 loading/error/compatibility 分支。
- **依赖后端端点/能力**：`GET /capabilities` → `API-03`，兼容性逻辑见 `FAPI-08`。
- **重写目标(新栈落点)**：`apps/web/src/components/shell/CapabilityGate.tsx`；用 shadcn `Alert/Card`。
- **验收点**：后端不可达时不出现业务页面；api v2 或 min_client 过高显示明确阻断；连接面板仍能打开。
- **备注/疑点**：version query 失败但 capabilities 成功时旧 gate 不阻断。

### SHELL-04

- **功能ID**：`SHELL-04`
- **名称**：路由装配；**作用**：定义旧 SPA 的所有主路由、重定向和 404。
- **现位置**：`databench-ui/src/App.tsx:AppRoutes`
- **行为与边界**：`/` 重定向 `/datasets` replace；路由包括 `/datasets`、`/datasets/:ref`、`/ingest`、`/transforms`、`/recipe`、`/lineage`、`/vocabularies`、`/vocabularies/derive`、`/vocabularies/new`、`/vocabularies/:name`；catch-all 显示 `notFound`。
- **依赖后端端点/能力**：页面各自依赖对应 API；词表 routes 依赖 `CONTRACT-03..08`。
- **重写目标(新栈落点)**：`apps/web/src/routes/*` TanStack Router 文件式路由；保留路径兼容。
- **验收点**：旧 URL 直接访问仍进对应页面；`/` replace 不污染 history；未知路径有 404 文案。
- **备注/疑点**：如果首版禁用 vocabularies，路由可保留 disabled state，不应误导为已实现。

### SHELL-05

- **功能ID**：`SHELL-05`
- **名称**：导航能力门控；**作用**：按 capabilities 动态隐藏未启用模块入口。
- **现位置**：`databench-ui/src/App.tsx:NAV/Nav`
- **行为与边界**：NAV 固定 datasets/ingest 始终显示；transforms/recipe/lineage/vocabularies 分别绑定 `FEATURES.transforms/recipes/lineage/vocabularies`；`Nav` 为每个 feature 调 `useModuleEnabled`，capabilities 未加载或 key 缺失时保持可见，仅显式 false 隐藏。
- **依赖后端端点/能力**：`GET /capabilities` → `API-03`。
- **重写目标(新栈落点)**：`apps/web/src/components/shell/Nav.tsx`。
- **验收点**：`features.lineage=false` 时不显示 lineage；未加载时不闪空导航；`vocabularies:false` 时不显示词表入口。
- **备注/疑点**：D1 后 TS 后端返回 `vocabularies:true`；连接缺失该 key 的旧后端时前端应避免打到 404。

### SHELL-06

- **功能ID**：`SHELL-06`
- **名称**：旧主题与样式体系；**作用**：定义暗色主题、布局、表单、表格、状态、虚拟列表、树和词表样式。
- **现位置**：`databench-ui/src/styles.css`
- **行为与边界**：CSS variables：`--bg/#0f1115`、`--panel/#181b22`、`--panel-2/#1f242d`、`--border/#2a2f3a`、`--text/#e6e8ec`、`--muted/#8a92a3`、`--accent/#4f8cff`、`--ok/#34c759`、`--warn/#ffb020`、`--err/#ff5c5c`、`--radius=8px`；全局 border-box；body dark；cards radius 8；virtual scroll height 600；responsive grid at 860px/600px；kind/status badges 有颜色语义；错误/disabled 状态有 tinted background。
- **依赖后端端点/能力**：无直接端点。
- **重写目标(新栈落点)**：`apps/web/src/styles.css` + Tailwind theme tokens + shadcn CSS variables；保留暗色内部工具风格。
- **验收点**：关键状态颜色可区分；虚拟列表容器固定高度；manifest grid 小屏变单列；JSON block 有 max-height 和 overflow。
- **备注/疑点**：重写使用 shadcn/Tailwind，不应逐字搬 CSS，但这些视觉语义和尺寸约束要保留。

## 可能遗漏 / 存疑

- `SampleView` 读取 `rl.reward` 与 `trajectory.steps`，但当前 generated schema 不含这些字段；可能是旧数据兼容或 schema 漂移。
- `ConnectionPanel.reset()` 只重置 API base，不清当前 token draft；这是旧行为，重写若调整要明示。
- `useModuleEnabled` 对缺失 feature 宽松显示；D1 后 TS 后端显式返回 `vocabularies:true`，无词表能力后端应返回 false 或由前端严格隐藏。
- `Vocabulary` CSS 有 `.status-review`，但 i18n 和 schema status 只覆盖 `draft/curated`。
- API layer 仍有 `api.health` 和 `api.getRef`，本 brief 范围内共享组件不直接使用，但应保留给页面或诊断使用。
- `downloadExport` 文件名使用本地 sanitized ref，不使用服务端 `Content-Disposition`；如重写改用后端文件名，要验证 token 下载和中文文件名。
- `JsonBlock` 不处理循环引用；经 HTTP JSON 不会有循环，本地构造对象需避免。
- 本文未逐页梳理 `src/pages/*` 的页面表单和交互，只在 API/i18n/route 层保留其依赖。页面功能应由其他 frontend inventory 覆盖。

## 依赖 vocabularies(D1 已实现)的组件/功能

- `CMP-04 TermsEditor`：保存/新建词表依赖 `CONTRACT-05`。
- `CMP-05 VirtualizedTerms`：列表/详情展示依赖 `CONTRACT-04`，编辑依赖 `CONTRACT-05`。
- `CMP-06 AliasInput/parseAliases`：最终提交依赖 `CONTRACT-05`。
- `FAPI-17 list/get vocabularies`：依赖 `CONTRACT-03/04`。
- `FAPI-18 derive/put vocabulary`：依赖 `CONTRACT-06/05`。
- `FAPI-19 normalize/validate vocabulary`：依赖 `CONTRACT-07/08`。
- `SHELL-04` 中 `/vocabularies*` routes：依赖完整 vocabularies 模块。
- `SHELL-05` 中 `FEATURES.vocabularies` 门控：D1 后 TS 后端显式返回 true；连接旧后端 false/缺失时仍需优雅隐藏。
- i18n `vocab.*` 全 namespace：为词表列表、详情、derive、apply、create 全流程准备。

## i18n key 覆盖清单

en/zh key set 当前完全一致，覆盖如下 flattened keys：

- `brand.suffix`
- `nav.datasets`, `nav.ingest`, `nav.transforms`, `nav.recipe`, `nav.lineage`, `nav.vocabularies`
- `common.loading`, `common.errorPrefix`, `common.unknownError`, `common.apply`, `common.prev`, `common.next`, `common.load`, `common.rawJson`, `common.none`, `common.dash`, `common.cancel`, `common.featureDisabled`
- `language.label`, `language.en`, `language.zh`
- `health.connected`, `health.disconnected`, `health.checking`, `health.checkingEllipsis`
- `connection.configure`, `connection.apiBaseLabel`, `connection.apiBasePlaceholder`, `connection.apiBaseHint`, `connection.tokenLabel`, `connection.tokenPlaceholder`, `connection.tokenHint`, `connection.apiVersion`, `connection.serviceVersion`, `connection.schemaVersion`, `connection.unreachable`, `connection.reset`
- `gate.connectingTitle`, `gate.connecting`, `gate.cannotConnectTitle`, `gate.cannotConnectHint`, `gate.incompatibleTitle`, `gate.clientTooOld`, `gate.apiUnsupported`, `gate.incompatibleHint`
- `datasets.title`, `datasets.description`, `datasets.filterPlaceholder`, `datasets.colName`, `datasets.colVersion`, `datasets.lineage`, `datasets.emptyNoRefs`, `datasets.emptyNoMatch`, `datasets.cappedNote`
- `detail.backToDatasets`, `detail.viewLineage`, `detail.manifest`, `detail.exportJsonl`, `detail.exporting`, `detail.exportHint`, `detail.samples`, `detail.pageSize`, `detail.pageSizeHint`, `detail.loadedOf`, `detail.loadingMore`, `detail.allLoaded`, `detail.noSamples`, `detail.emptyRange`
- `ingest.uploadTitle`, `ingest.uploadDescription`, `ingest.jsonlDisabled`, `ingest.fileLabel`, `ingest.nameLabel`, `ingest.kindLabel`, `ingest.kindInfer`, `ingest.sourceLabel`, `ingest.uploading`, `ingest.ingestAction`, `ingest.ingested`, `ingest.createTitle`, `ingest.createDescription`, `ingest.messageLabel`, `ingest.samplesLabel`, `ingest.creating`, `ingest.createAction`, `ingest.created`, `ingest.errExpectArray`, `ingest.errInvalidJson`
- `transforms.title`, `transforms.emptyList`, `transforms.runHeading`, `transforms.selectPrompt`, `transforms.runVerb`, `transforms.paramsSchema`, `transforms.inputsLabel`, `transforms.paramsLabel`, `transforms.outputRefLabel`, `transforms.running`, `transforms.runAction`, `transforms.outputManifest`, `transforms.errNeedInput`, `transforms.errParamsObject`, `transforms.errInvalidParams`
- `recipe.title`, `recipe.description`, `recipe.recipeLabel`, `recipe.outputRefLabel`, `recipe.materializing`, `recipe.materializeAction`, `recipe.materialized`, `recipe.errRecipeObject`, `recipe.errInvalidJson`
- `lineage.title`, `lineage.disabled`, `lineage.placeholder`, `lineage.emptyPrompt`, `lineage.treeView`, `lineage.rootLabel`
- `vocab.title`, `vocab.description`, `vocab.disabled`, `vocab.filterPlaceholder`, `vocab.colName`, `vocab.colDimension`, `vocab.colTerms`, `vocab.colStatus`, `vocab.status.draft`, `vocab.status.curated`, `vocab.emptyNone`, `vocab.emptyNoMatch`, `vocab.cappedNote`, `vocab.backToList`, `vocab.termCount`, `vocab.termsTitle`, `vocab.noTerms`, `vocab.provenance`, `vocab.needsReviewBadge`, `vocab.needsReviewTitle`, `vocab.needsReviewHint`, `vocab.alsoSeen`, `vocab.aliasesPlaceholder`, `vocab.curateAction`, `vocab.curateHint`, `vocab.promoteAction`, `vocab.saveAction`, `vocab.submitting`, `vocab.saved`, `vocab.deriveTitle`, `vocab.deriveDescription`, `vocab.deriveAction`, `vocab.deriving`, `vocab.nameLabel`, `vocab.datasetLabel`, `vocab.datasetPlaceholder`, `vocab.dimensionLabel`, `vocab.dimensionPlaceholder`, `vocab.extractorAdvanced`, `vocab.extractorHint`, `vocab.extractorSource`, `vocab.rawKeyLabel`, `vocab.stdKeyLabel`, `vocab.errRequired`, `vocab.errExtractorKeys`, `vocab.applyTitle`, `vocab.applyDescription`, `vocab.applyDatasetLabel`, `vocab.applyDatasetPlaceholder`, `vocab.applyOutputLabel`, `vocab.applyOutputPlaceholder`, `vocab.applyErrDataset`, `vocab.applyRunning`, `vocab.validateAction`, `vocab.normalizeAction`, `vocab.validateDone`, `vocab.normalizeDone`, `vocab.validateChecked`, `vocab.validateInvalid`, `vocab.validateSignal`, `vocab.offendingValues`, `vocab.newAction`, `vocab.createTitle`, `vocab.createDescription`, `vocab.createAction`, `vocab.canonicalPlaceholder`, `vocab.addTerm`, `vocab.removeTerm`, `vocab.errNameDimension`, `vocab.errNoTerms`
- `manifest.version`, `manifest.name`, `manifest.numRows`, `manifest.kinds`, `manifest.otherFields`
- `sample.stepCount`
- `errors.unreachable`, `errors.notDatabench`, `errors.badRequest`, `errors.notFound`, `errors.validation`, `errors.notImplemented`, `errors.generic`
- `notFound`
