# databench-ui 前端「页面 / 流程」功能迁移清单（重写用）

本文穷尽梳理旧 `databench-ui` 的页面与用户流程，供 `apps/web`（React 19 + Vite SPA + TanStack Router/Query/Virtual + shadcn/ui + openapi-fetch，见 ADR-0006）逐页重写、防漏功能。仿后端 `inventory-service.md` 的逐功能条目法。

**已读范围（只读）：**

- `databench-ui/src/App.tsx`（路由/导航/能力 gate）、`src/main.tsx`（Provider 装配）
- `src/pages/*`：DatasetsPage、DatasetDetailPage、IngestPage、TransformsPage、RecipePage、LineagePage、VocabulariesPage、VocabularyDerivePage、VocabularyCreatePage、VocabularyDetailPage
- `src/components/*`：ConnectionPanel、LanguageSwitcher、ManifestView、VirtualizedSamples、SampleView、VirtualizedTerms、TermsEditor、TreeNode、ui（Card/Spinner/EmptyState/FeatureDisabled/ErrorState/InlineError/JsonBlock）
- `src/api/*`：client.ts、hooks.ts、http.ts、capabilities.tsx、backend.tsx、config.ts、version.ts、types.ts
- `src/i18n/*`：index.ts、locales/en.json（空态/错误文案来源）

**后端端点映射来源：** `inventory-service.md`（`API-01..14`、`SVC-*`、`CONTRACT-03..08`）。

**新栈落点来源：** `directory-layout.md` 的 `apps/web/` 结构。

> 状态更新：vocabularies 全家桶（PAGE-07/08/09/10 + FLOW-08）原本是“UI 合同领先后端”的风险；D1 已改为实现，最新旧后端已补 `CONTRACT-03..08`，TS 前后端也应保留该流程并通过 `features.vocabularies:true` 暴露入口。

---

## 路由总览（`App.tsx:111` `AppRoutes`）

| 路由 path | 页面 | 功能ID | 备注 |
|---|---|---|---|
| `/` | → 重定向 `/datasets` | PAGE-00 | `<Navigate replace>`（`App.tsx:115`） |
| `/datasets` | DatasetsPage | PAGE-01 | |
| `/datasets/:ref` | DatasetDetailPage | PAGE-02 | `:ref` 实际多为 version（见 PAGE-01 备注） |
| `/ingest` | IngestPage | PAGE-03 | |
| `/transforms` | TransformsPage | PAGE-04 | nav 受 `transforms` flag |
| `/recipe` | RecipePage | PAGE-05 | nav 受 `recipes` flag |
| `/lineage` | LineagePage | PAGE-06 | nav 受 `lineage` flag；读 `?ref=` query |
| `/vocabularies` | VocabulariesPage | PAGE-07 | nav 受 `vocabularies` flag |
| `/vocabularies/derive` | VocabularyDerivePage | PAGE-08 | 已实现 |
| `/vocabularies/new` | VocabularyCreatePage | PAGE-09 | 已实现 |
| `/vocabularies/:name` | VocabularyDetailPage | PAGE-10 | 已实现 |
| `*` | 404 文案 `notFound` | PAGE-00 | `App.tsx:126` |

> 注意 react-router 注册顺序：`/vocabularies/derive` 和 `/vocabularies/new` 在 `/vocabularies/:name` 之前注册（`App.tsx:123-125`），避免 `derive`/`new` 被当成 `:name`。TanStack Router 文件式路由用静态段优先即可复刻，但要保证 `vocabularies.derive.tsx`/`vocabularies.new.tsx` 不被 `vocabularies.$name.tsx` 吞掉。

---

## 页面清单

### PAGE-00

- **功能ID**：`PAGE-00`
- **名称**：应用外壳（topbar / 导航 / 能力 gate / 路由 / 404）
- **作用**：提供全站布局（品牌、导航、语言切换、连接面板），在能力握手完成前用 gate 拦住主内容，把页面挂到对应路由，未知路由显示 404。
- **现位置**：`databench-ui/src/App.tsx:36`（`App`）、`:54`（`Nav`）、`:78`（`Gate`）、`:111`（`AppRoutes`）、`:19`（`NAV` 常量）；Provider 装配 `src/main.tsx`（`QueryClientProvider`→`BackendProvider`→`CapabilitiesProvider`→`BrowserRouter`→`App`）
- **路由**：所有；`/`→`/datasets` 重定向，`*`→404
- **交互与状态**：
  - **导航**（`Nav` `:54`）：固定项 Datasets、Ingest 永远显示；Transforms/Recipe/Lineage/Vocabularies 经 `useModuleEnabled(FEATURES.x)` 宽松过滤（`App.tsx:68`）。`NavLink` active 高亮（`:30`）。
  - **gate loading**（`:82`）：`Card` + `Spinner`「Contacting the backend…」。
  - **gate error**（`:86`）：`Card`「Cannot connect to backend」+ `ErrorState` + 提示去连接面板。
  - **gate 版本不兼容**（`:95`）：`compatibility.ok===false` 时按 `client_too_old` / `api_unsupported` 两种文案（`gate.clientTooOld` / `gate.apiUnsupported`）。
  - **gate ready**：渲染 `AppRoutes`。
  - **404**（`:126`）：`notFound`「Page not found.」。
  - gate「永不白屏」原则：loading/error/incompatible/ready 四态总有内容。
- **依赖后端端点**：`GET /capabilities` = `API-03`、`GET /version` = `API-02`（经 `CapabilitiesProvider`，见 FLOW-01）；topbar 连接面板见 CMP-01；health 轮询见 FLOW-11。
- **重写目标（新栈落点）**：`apps/web/src/routes/__root.tsx`（根布局：导航 + 连接面板 + 语言切换 + gate）+ `routes/index.tsx`（→`/datasets` 重定向）；gate 可做成 `beforeLoad`/`pendingComponent`/`errorComponent` 或根布局内的条件渲染；shadcn：`Card`、`Skeleton`/`Spinner`、`Alert`、`NavigationMenu`/自定义 `Tabs`、`Button`。404 用 TanStack Router `notFoundComponent`。
- **验收点**：① 后端未启动时打开任意页 → 看到「Cannot connect to backend」而非白屏；② 后端正常 → 顶部导航出现 Datasets/Ingest/Transforms/Recipe/Lineage/Vocabularies，点击各项 URL 与高亮正确；③ 访问 `/` 自动跳 `/datasets`；④ 访问 `/zzz` 显示「Page not found.」。
- **备注/疑点**：nav 用能力位控制；D1 后后端应显式返回 `vocabularies:true`，若未来连接无词表能力的后端，前端仍应隐藏或 disabled。

### PAGE-01

- **功能ID**：`PAGE-01`
- **名称**：Datasets / Refs 列表
- **作用**：列出 catalog 里所有 named ref（每个 ref 指向最新 dataset version），可按名/version 过滤，点进详情或直接看 lineage。
- **现位置**：`databench-ui/src/pages/DatasetsPage.tsx:8`（`useRefs` `:10`、`rows` useMemo `:16`、过滤输入 `:35`、表 `:47`、cappedNote `:82`）
- **路由**：`/datasets`（无参数）
- **交互与状态**：
  - **loading**：`Spinner`（`:30`）。
  - **error**：`ErrorState`（`:31`）。
  - **empty**：两种文案——`items.length===0`→`datasets.emptyNoRefs`「No refs yet. Ingest a dataset to get started.」；过滤无命中→`datasets.emptyNoMatch`（`:42`）。
  - **过滤**：客户端 text 过滤，按 name **或** version，`trim().toLowerCase()`，`includes`（`:18`）。
  - **排序**：客户端按 `name.localeCompare` 升序（`:23`）。
  - **「分页」**：**无真分页**。`useRefs()` 默认 `limit=200`（`hooks.ts:39`，注意非后端默认 20）单次请求；`total > items.length` 时显示 `datasets.cappedNote`「Showing {shown} of {total} refs (page-limited).」（`:82`）。无 prev/next。
  - **跳转**：name 与 version 两列都 `Link` 到 `/datasets/${encodeURIComponent(r.version)}`（`:59`/`:62`，**用 version 不是 name**）；最右列「lineage」按钮 `Link` 到 `/lineage?ref=${version}`，仅当 `lineageEnabled`（`:67`）。
- **依赖后端端点**：`GET /v1/refs?limit&offset` = `API-12`（`useRefs`→`api.listRefs`）。
- **重写目标**：`apps/web/src/routes/datasets.index.tsx`；shadcn：`Table`、`Input`（过滤）、`Button`（lineage）、`Card`、`Badge`；openapi-fetch hook `useRefs`（`GET /v1/refs`）。过滤/排序保持客户端。
- **验收点**：ingest 一个带 name 的 dataset 后打开 `/datasets` → 表里出现该 name 行，version 列是 sha；输入部分 name → 行被过滤；点 name → 跳到 `/datasets/{version}` 详情；点 lineage → 跳 `/lineage?ref={version}`；空库 → 显示 emptyNoRefs。
- **备注/疑点**：① 列表只来自 `/v1/refs`，**只显示 named ref，不显示匿名 version**（与 `API-12` 一致）。② 详情链接用 `version` 而非 `name`，重写要保留（否则 `:ref` 解析路径变）。③ `limit=200` 仍可能被 500 上限/refs 总数截断 → cappedNote；真要全量需做分页/虚拟化（当前没有）。

### PAGE-02

- **功能ID**：`PAGE-02`
- **名称**：Dataset 详情（manifest + 导出 + 虚拟样本表）
- **作用**：按 `:ref` 显示 dataset manifest，导出为 JSONL，分页/虚拟滚动浏览样本。
- **现位置**：`databench-ui/src/pages/DatasetDetailPage.tsx:14`（`useDataset` `:19`、面包屑 `:25`、manifest 卡 `:36`、`ExportButton` `:69`、样本卡 `:47`、page size select `:52`、`VirtualizedSamples` `:63`、`PAGE_SIZES` `:12`）；样本组件 `components/VirtualizedSamples.tsx`、`components/SampleView.tsx`；manifest 组件 `components/ManifestView.tsx`
- **路由**：`/datasets/:ref`（`:ref` = ref 名或 version；详情用 `GET /v1/datasets/{ref}`，ref 或 version 都能解析）
- **交互与状态**：
  - **面包屑**（`:25`）：返回 `/datasets`；显示 `<code>{ref}</code>`；`lineageEnabled` 时「view lineage」`Link`→`/lineage?ref={ref}`。
  - **manifest loading/error**（`:37`/`:38`）：`Spinner` / `ErrorState`。
  - **manifest 展示**（`ManifestView`，见 CMP-03）：version（可点链接到详情）、name（无则「—」）、num_rows、kinds 徽章、其余字段折叠 JSON。
  - **导出按钮**（`ExportButton` `:69`，仅 `exportEnabled`）：本地 `busy`/`error` state；点击调 `downloadExport(ref)`；`busy` 时 disabled 且文案「Exporting…」；失败显示 `InlineError`；旁有 `detail.exportHint`。详见 FLOW-09。
  - **page size 选择**（`:52`）：`PAGE_SIZES = [20,50,100,200,500]`；`detail.pageSizeHint`「server cap {max}/page」。
  - **虚拟样本表**（`VirtualizedSamples`，`key={ref:pageSize}` 强制 remount，`:63`）：见 CMP-04——TanStack Virtual + 无限滚动按页拉取；loading/error/empty(`detail.noSamples`)；toolbar「Loaded {loaded} of {total}」；接近底部自动 `fetchNextPage`；「Loading more…」/「All {total} samples loaded.」。
- **依赖后端端点**：`GET /v1/datasets/{ref}` = `API-06`（`useDataset`）；`GET /v1/datasets/{ref}/samples?limit&offset` = `API-07`（`useInfiniteSamples`）；`GET /v1/datasets/{ref}/export?fmt` = `API-08`（`downloadExport`）。
- **重写目标**：`apps/web/src/routes/datasets.$ref.tsx`；样本表 `components/samples/`（TanStack Virtual）；shadcn：`Card`、`Select`（page size）、`Button`（导出）、`Badge`（kinds）、`Collapsible`（manifest 其余字段 / 样本 raw JSON）、`Breadcrumb`；hooks：`useDataset`、`useInfiniteSamples`、`downloadExport`。
- **验收点**：打开一个有 ≥3 样本的 dataset → manifest 显示正确 num_rows/kinds；切 page size=50 → 表 remount 重新分页；向下滚动 → 自动加载下一页并更新「Loaded X of Y」直至「All N samples loaded.」；点「Export JSONL」→ 浏览器下载 `.jsonl` 文件，按钮短暂禁用；`export` flag 关时不显示导出按钮。
- **备注/疑点**：① 样本 `id` 在合同里是 optional（`API-07` 备注：Pydantic dump 不含），`SampleView` 做 `id != null` 兜底（`SampleView.tsx:38`）。② `estimateSize=200`（`VirtualizedSamples.tsx:31`）是估值，行高由 `measureElement` 实测。③ 导出 `fmt` 当前后端忽略、永远 NDJSON（`API-08`）；UI 只用默认 `messages-jsonl`，不暴露 `trl` 选择。④ 详情可用 version 或 ref 解析（`API-06`），但 PAGE-01 链接传的是 version。

### PAGE-03

- **功能ID**：`PAGE-03`
- **名称**：Ingest（JSONL 文件上传 + JSON 样本创建）
- **作用**：两个并排卡：上传 `.jsonl` 文件入库；或粘贴 JSON 样本数组创建 dataset。
- **现位置**：`databench-ui/src/pages/IngestPage.tsx:22`（`IngestPage`）、`:39`（`JsonlUploadCard`）、`:95`（`JsonSamplesCard`）、`:156`（`ResultManifest`）；`KINDS` `:9`；占位 `SAMPLE_PLACEHOLDER` `:11`
- **路由**：`/ingest`（无参数）
- **交互与状态**：
  - **布局**：`grid-2`（`:25`）。
  - **JSONL 卡 feature gate**：`jsonlEnabled = useModuleEnabled(jsonl_ingest)`；关时显示 `FeatureDisabled`「JSONL ingest is not enabled…」（`:30`）。
  - **JSONL 表单**（`:39`）：file input（`accept=".jsonl,application/x-ndjson,application/jsonl"` `:66`）、name（可选）、kind 下拉（`(infer)` + sft/preference/rl/trajectory，`:74`）、source（可选）。提交：无文件直接 `return`（`:49`）；空字段→`undefined`；submit 在 `!file || isPending` 时 disabled，文案「Uploading…」。
  - **JSONL 结果**：错误 `InlineError`（`:89`）；成功 `ResultManifest`「✓ Ingested」+ `ManifestView linkToDetail`（`:90`）。
  - **JSON 样本卡**（`:95`）：name、commit message、samples textarea（mono，12 行，带占位）。
  - **JSON 客户端校验**（`:103`）：`JSON.parse`→非数组报 `ingest.errExpectArray`「Expected a JSON array of samples.」；parse 失败报 `ingest.errInvalidJson`（带 message）。错误用 `text-error`（`:149`）。
  - submit 在 `!text.trim() || isPending` 时 disabled，文案「Creating…」。
  - **JSON 结果**：错误 `InlineError`；成功「✓ Created」+ `ManifestView linkToDetail`。
  - 两卡成功都 invalidate refs（FLOW-07）。
- **依赖后端端点**：`POST /v1/datasets:ingest-jsonl`（multipart 字段 `file`，query name/kind/source）= `API-05`（`useIngestJsonl`）；`POST /v1/datasets`（`{name?,message?,samples}`）= `API-04`（`useCreateDataset`）。
- **重写目标**：`apps/web/src/routes/ingest.tsx`；shadcn：`Card`、`Input`（file/text）、`Select`（kind）、`Textarea`、`Button`、`Alert`/inline error；可选 `react-hook-form + zod` 做 JSON 解析校验；hooks：`useIngestJsonl`、`useCreateDataset`。
- **验收点**：上传一个 `preference.jsonl` 不填 kind → 成功显示「✓ Ingested」manifest，kinds 含 preference，点 version 进详情；粘贴一个非数组 JSON → 显示「Expected a JSON array of samples.」不发请求；粘贴合法 sft 数组 → 「✓ Created」；`jsonl_ingest` flag 关 → 左卡显示 disabled 文案。
- **备注/疑点**：① multipart 字段名必须是 `file`（`client.ts:64`），content-type 由浏览器设置、**不手写**（`http.ts:117`）。② kind 留空=后端逐行 auto-detect（`API-05`）。③ source 留空时后端默认用上传文件名 stem（`API-05`）。④ JSON body 路径**不做** JSONL 简写归一化（`API-04`），与上传路径行为不同——重写别混淆两条路径。

### PAGE-04

- **功能ID**：`PAGE-04`
- **名称**：Transforms（列表 + 运行）
- **作用**：左侧列出已注册 transform，右侧选中后填 inputs/params/output ref 运行。
- **现位置**：`databench-ui/src/pages/TransformsPage.tsx:8`（列表 `:22`、选中 `:26`、`RunTransformCard` `:49`、提交 `:57`、inputs 解析 `:61`、params 解析 `:70`、`params_schema` 折叠 `:93`）
- **路由**：`/transforms`（无参数；选中态是组件内部 state，不进 URL）
- **交互与状态**：
  - **布局**：`grid-2`。
  - **列表 loading/error/empty**：`Spinner` / `ErrorState` / `transforms.emptyList`「No transforms registered.」（`:18`）。
  - **列表项**：`button`，选中 `active` 高亮，显示 name + `v{version}`（`:26`）。
  - **右侧未选**：`transforms.selectPrompt`「Select a transform to run it.」（`:42`）。
  - **`RunTransformCard`**（`key={selected.name}` → 切换重置表单，`:39`）：
    - `params_schema` 存在时折叠 `<details>` + `JsonBlock`（`:93`）。
    - inputs textarea（mono，3 行）：按 `\n` 或 `,` split、trim、filter（`:61`）；空 → `transforms.errNeedInput`「Provide at least one input ref/version.」。
    - params textarea（mono，6 行，默认 `'{}'`）：`JSON.parse`→必须是对象（非 null/数组）否则 `errParamsObject`；parse 失败 `errInvalidParams`。
    - output ref input（可选）。
    - submit `isPending` 时 disabled，文案「Running…」。
    - 错误 `formError`(text-error) + `InlineError`；成功「✓ Output manifest」+ `ManifestView linkToDetail`。
  - 成功 invalidate refs（FLOW-07）。
- **依赖后端端点**：`GET /v1/transforms` = `API-09`（`useTransforms`）；`POST /v1/transforms/{name}/run`（`{inputs,params,ref?}`）= `API-10`（`useRunTransform`）。
- **重写目标**：`apps/web/src/routes/transforms.tsx`；shadcn：列表用 `Card`+`Button`/`ScrollArea`，运行表单 `Textarea`/`Input`/`Button`，`params_schema` 用 `Collapsible`+代码块；hooks：`useTransforms`、`useRunTransform`。
- **验收点**：打开 `/transforms` → 列出 dedup/enrich_length/filter_by_signal/sample_n；选 `filter_by_signal` → 展开 params_schema；inputs 留空点运行 → 显示 errNeedInput；填一个 ref + params `{"key":"word_len","min":3}` 运行 → 「✓ Output manifest」并可点进详情。
- **备注/疑点**：① params 默认 `'{}'`，对无参 transform（dedup/enrich_length）必须保持空对象，否则后端 400（`ERR-06`）。② inputs 多个用换行或逗号分隔。③ `useTransforms` retry 把 404/501 当「未部署」软信号不重试（`hooks.ts:88`），但 transforms flag 后端为 true。

### PAGE-05

- **功能ID**：`PAGE-05`
- **名称**：Recipe 物化
- **作用**：粘贴 recipe JSON，物化成可复现的训练混合 dataset。
- **现位置**：`databench-ui/src/pages/RecipePage.tsx:17`（占位 `:8`、提交 `:24`、解析 `:28`、`materialize.mutate` `:39`）
- **路由**：`/recipe`（无参数）
- **交互与状态**：
  - 单 `Card`；recipe textarea（mono，14 行，带 `PLACEHOLDER`）；output ref input（可选）。
  - 客户端校验（`:28`）：`JSON.parse`→必须是对象（非 null/数组）否则 `recipe.errRecipeObject`；parse 失败 `recipe.errInvalidJson`。
  - submit 在 `!text.trim() || isPending` 时 disabled，文案「Materializing…」。
  - 错误 `text-error` + `InlineError`；成功「✓ Materialized」+ `ManifestView linkToDetail`。
  - 成功 invalidate refs（FLOW-07）。
- **依赖后端端点**：`POST /v1/recipes:materialize`（`{recipe,ref?}`）= `API-11`（`useMaterializeRecipe`）。
- **重写目标**：`apps/web/src/routes/recipes.tsx`；shadcn：`Card`、`Textarea`、`Input`、`Button`、错误 `Alert`；hook：`useMaterializeRecipe`。（可选：未来做 source 行可视化编辑器，当前是裸 JSON。）
- **验收点**：粘贴 `{"name":"m","sources":[{"dataset":"<ref>","weight":1}],"seed":0}` → 「✓ Materialized」返回 manifest，可点进详情；粘贴数组 → errRecipeObject；连续两次相同 recipe → version 一致（`API-11` 可复现性）。
- **备注/疑点**：① recipe 是裸 JSON 文本，无字段级表单校验（结构错误由后端 422 返回）。② `target_format`（含 `trl`）当前只进 fingerprint，不改变行为（`API-11` 备注）。③ `target_size` 因 round/cap 可能不等于实际行数。

### PAGE-06

- **功能ID**：`PAGE-06`
- **名称**：Lineage / Provenance 查看
- **作用**：输入一个 ref/version，递归展示产生它的 transform/recipe DAG，可切树视图/原始 JSON。
- **现位置**：`databench-ui/src/pages/LineagePage.tsx:9`（`useSearchParams` `:12`、URL 同步 `:19`、`useLineage` `:24`、提交 `:26`、gate `:33`、表单 `:43`、空态 `:55`、raw 切换 `:64`、tree `:71`）；树组件 `components/TreeNode.tsx`
- **路由**：`/lineage?ref=<ref|version>`（query 参数 `ref`）
- **交互与状态**：
  - **feature gate**：`!lineageEnabled`→`FeatureDisabled`「Lineage is not enabled…」（`:33`）。
  - **URL 同步**：`input`/`activeRef` 初值取 `?ref=`；`useEffect` 在 `refFromUrl` 变化时重置二者（`:19`）——即从 PAGE-01/02 带 `?ref=` 进来会自动加载。
  - **表单**（`:43`）：input + Load 按钮（空时 disabled）；提交把 `activeRef` 设为 trim 后的 input 并写回 search params（`:26`）。
  - **空态**：`!activeRef`→`lineage.emptyPrompt`「Enter a ref/version to inspect its provenance DAG.」（`:55`）。
  - **加载态**：`activeRef` 存在时 `Spinner` / `ErrorState`（`:59`）。
  - **视图切换**（`:64`）：`raw` state 切「Tree view」/「Raw JSON」；树用 `TreeNode`（root label「lineage」，defaultOpen，`:72`），raw 用 `JsonBlock`。
- **依赖后端端点**：`GET /v1/lineage/{ref}` = `API-14`（`useLineage`）。
- **重写目标**：`apps/web/src/routes/lineage.$ref.tsx`（路由从 `?ref=` query 改为 path 段 `$ref`，按 directory-layout）；**ADR-0006 指定 lineage 用 React Flow（`@xyflow/react`）渲染 DAG**——旧 UI 只有折叠树，重写应升级为 DAG 图（保留树/JSON 兜底）；shadcn：`Card`、`Input`、`Button`、`Tabs`（tree/json/graph 切换）；hook：`useLineage`。
- **验收点**：对一个由 dedup←enrich_length←raw 链产生的 ref 查 lineage → 顶层 `produced_by.op === "dedup"`，展开第一个 input 是 enrich_length，再上是 raw；从 PAGE-01 点 lineage 链接进来 → 自动加载该 ref；切「Raw JSON」→ 显示完整对象；未启用 lineage → 显示 disabled 文案。
- **备注/疑点**：① **未知 ref/version 不 404，返回 `{version: ref}`**（`API-14` 关键边界）→ UI 不报错、显示单节点树，重写要保留这个「不报错」语义或同步前端/测试。② lineage 是任意嵌套开放对象（`types.ts:65 Lineage = Record<string,unknown>`）。③ 路由从 query → path 是重写期唯一的 URL 形态变化，注意旧 `?ref=` 深链接兼容（PAGE-01/02 都生成 `?ref=`，要一并改）。

### PAGE-07

- **功能ID**：`PAGE-07`
- **名称**：Vocabularies 列表
- **作用**：列出受控词表（name/dimension/terms/status），可过滤，入口去「New」「Derive」，点进详情。
- **现位置**：`databench-ui/src/pages/VocabulariesPage.tsx:8`（gate `:30`、header 链接 `:42`、过滤 `:57`、空态 `:64`、表 `:69`、cappedNote `:107`）
- **路由**：`/vocabularies`（无参数）
- **交互与状态**：
  - **feature gate**：`!enabled`→`FeatureDisabled`「Vocabularies are not enabled…」（`:30`）。
  - **header**：`New`（→`/vocabularies/new`）、`Derive`（primary，→`/vocabularies/derive`）（`:42`）。
  - **loading/error**：`Spinner` / `ErrorState`（`:52`）。
  - **empty**：`vocab.emptyNone`「No vocabularies yet…」 vs `vocab.emptyNoMatch`（`:64`）。
  - **过滤**：按 name 或 dimension，`includes`（`:18`）。
  - **排序**：按 `name ?? id` localeCompare（`:25`）。
  - **表**：name（link，key=`name ?? id`）、dimension（code）、num_terms、status 徽章（`vocab.status.{draft|curated}`，缺失显示「—」）（`:69`）。
  - **cappedNote**：`total > items.length`（`:107`）。
- **依赖后端端点**：`GET /v1/vocabularies?limit&offset` = `CONTRACT-03`（`useVocabularies`，`hooks.ts:102`，limit=MAX 500）。
- **重写目标**：`apps/web/src/routes/vocabularies.index.tsx`；shadcn：`Table`、`Input`、`Badge`（status）、`Button`（New/Derive）；hook：`useVocabularies`。
- **验收点**：有 ≥1 词表时列表显示 name/dimension/terms/status，过滤生效，点 name 进详情；空库显示 emptyNone；`vocabularies:false` 时入口隐藏或 disabled。
- **备注/疑点**：无真分页，仍是单次 `limit=500` + cappedNote。

### PAGE-08

- **功能ID**：`PAGE-08`
- **名称**：Derive 词表（从 dataset 标签派生 draft）
- **作用**：选一个 dataset + dimension，可选高级 extractor，派生出 draft 词表并跳到详情。
- **现位置**：`databench-ui/src/pages/VocabularyDerivePage.tsx:9`（gate `:24`、提交 `:32`、extractor 组装 `:46`、`derive.mutate` `:55`、dataset 下拉 `:81`、高级折叠 `:104`）
- **路由**：`/vocabularies/derive`（无参数）
- **交互与状态**：
  - **feature gate**：`!enabled`→`FeatureDisabled`（`:24`）。
  - **表单**：name（target name）、dataset（`<select>`，选项来自 `useRefs`，loading→Spinner/error→ErrorState，`:79`）、dimension（自由文本，占位「e.g. brand, unit」）。
  - **高级 extractor 折叠**（`:104`）：`advanced` state 控制 `<details open>`；source 固定 `assistant_json`（disabled input）；raw key、std key。
  - **校验**：name/dataset/dimension 必填→`vocab.errRequired`（`:39`）；extractor「两个 key 必须同填或同空」→`vocab.errExtractorKeys`（`:48`）。
  - **extractor 仅在** advanced 且两 key 都填时发送；否则省略 body → 后端按 dimension preset 回退（`:46`）。
  - submit `isPending`→disabled，文案「Deriving…」；错误 `text-error` + `InlineError`。
  - **成功**：`navigate(/vocabularies/{vocab.name ?? n})`（`:58`）。
  - 成功 invalidate vocabularies 列表（`hooks.ts:135`）。
- **依赖后端端点**：`GET /v1/refs` = `API-12`（dataset 下拉）；`POST /v1/vocabularies/{name}:derive?dataset&dimension`（body `Extractor|null`）= `CONTRACT-06`（`useDeriveVocabulary`）。
- **重写目标**：`apps/web/src/routes/vocabularies.derive.tsx`；shadcn：`Card`、`Input`、`Select`/`Combobox`（dataset，复用 refs）、`Collapsible`（高级）、`Button`；可用 `react-hook-form + zod`；hooks：`useRefs`、`useDeriveVocabulary`。
- **验收点**：选一个带 assistant JSON 标签的 dataset + dimension，留空 extractor → 派生成功跳详情；只填一个 key → errExtractorKeys；缺 name → errRequired。
- **备注/疑点**：extractor `source` 当前写死 `assistant_json`（`:52`，`Extractor` 类型见 `CONTRACT-06`）。preset 列表为 `brand/unit`，冲突统计来自最新 Python `derive_vocabulary`。

### PAGE-09

- **功能ID**：`PAGE-09`
- **名称**：手工创建词表
- **作用**：从零手填 name + dimension + 词条，PUT 提交一个 curated 词表。
- **现位置**：`databench-ui/src/pages/VocabularyCreatePage.tsx:13`（gate `:24`、提交 `:32`、payload `:47`、`put.mutate` `:55`、`TermsEditor` `:81`）；编辑器 `components/TermsEditor.tsx`、`components/VirtualizedTerms.tsx`
- **路由**：`/vocabularies/new`（无参数）
- **交互与状态**：
  - **feature gate**：`!enabled`→`FeatureDisabled`（`:24`）。
  - 面包屑回列表；表单：name、dimension（占位「e.g. brand, unit (open namespace)」）、`TermsEditor`（见 CMP-05）。
  - **校验**：name & dimension 必填→`vocab.errNameDimension`；至少 1 词条→`vocab.errNoTerms`（`:42`）。
  - payload：`status:'curated'`、`meta:{}`、`source:null`（`:47`）。
  - submit `isPending`→disabled「Submitting…」；错误 `text-error` + `InlineError`。
  - **成功**：`navigate(/vocabularies/{n})`（`:57`）。
  - 成功 invalidate 列表 + 该词表 detail（`hooks.ts:146`）。
- **依赖后端端点**：`PUT /v1/vocabularies/{name}`（body `Vocabulary-Input`）= `CONTRACT-05`（`usePutVocabulary`）。
- **重写目标**：`apps/web/src/routes/vocabularies.new.tsx`；shadcn：`Card`、`Input`、`Button`、词条编辑器（TanStack Virtual）；hook：`usePutVocabulary`。
- **验收点**：填 name+dimension+≥1 词条提交 → 跳详情且显示该词表；不加词条 → errNoTerms；缺 name → errNameDimension；后端 invariant 冲突（同 canonical / alias 多归属）→ `InlineError` 列出每条 detail（见 FLOW-10）。
- **备注/疑点**：严格 invariant（canonical 唯一、一 alias 一 canonical、aliases 与 canonicals 不相交）由**服务端**强制（`CONTRACT-05`），前端只做存在性校验。

### PAGE-10

- **功能ID**：`PAGE-10`
- **名称**：词表详情（查看 + 整理/晋级 + 应用到 dataset + 冲突复核）
- **作用**：单页集合最多功能：看元信息/词条、curate 编辑并 save/promote、对 dataset 跑 validate/normalize、复核派生时的 alias 冲突。
- **现位置**：`databench-ui/src/pages/VocabularyDetailPage.tsx:23`（`useVocabulary` `:26`、`VocabularyDetail` `:43`、`startEdit` `:55`、`submit` `:66`、元信息徽章 `:86`、provenance `:98`、`ApplyToDataset` `:106`/`:194`、冲突卡 `:108`、Terms 卡 `:143`、`ValidateResult` `:275`、`collectConflicts` `:317`）
- **路由**：`/vocabularies/:name`（参数 `name`，可为 name 或 content id，见 `CONTRACT-04`）
- **交互与状态**：
  - **顶层 loading/error/data**：`Spinner`/`ErrorState`（`:36`）。
  - **元信息卡**（`:85`）：status 徽章、dimension（code）、term count、`conflicts.length>0` 时「{n} need review」徽章；显示 content `id`；`meta.extractor` 存在时「Derivation provenance」折叠 JSON（`:98`）。
  - **Apply to dataset 卡**（`ApplyToDataset` `:194`）：
    - dataset input（`<datalist>` 来自 `useRefs`，`:236`）、output ref（可选）。
    - 两按钮 Validate / Normalize（primary）；任一 pending 时都 disabled（`:204`）。
    - 校验：dataset 必填→`vocab.applyErrDataset`（`:209`）。
    - 运行前互相 `reset()`（validate 前 reset normalize，反之，`:215`）。
    - **Validate 结果**（`ValidateResult` `:275`）：checked/invalid 徽章（invalid>0 标 review 色）、`vocab_{dimension}_valid` signal 提示、off-vocabulary 值 chips（带计数）、`ManifestView linkToDetail`。
    - **Normalize 结果**：「✓ Normalized dataset created.」+ `ManifestView linkToDetail`。
    - 错误各自 `InlineError`。
    - 成功都 invalidate refs（产生新 dataset，FLOW-07）。
  - **冲突复核卡**（仅 `conflicts.length>0`，`:108`）：列每个 canonical 下的 alias → chosen chip + 「also seen」其他归属 chip（带计数）；数据来自 `term.meta.alias_conflicts`（`collectConflicts` `:317`）。
  - **Terms 卡**（`:143`）：term count；非编辑态「Curate」按钮进编辑；编辑态：Cancel、（status===draft 时）「Promote to curated」、「Save」；`curateHint` 说明 invariant；`put.isError`→InlineError、`isSuccess`→「✓ Saved a new version.」。
    - 非编辑：`VirtualizedTerms`（只读，虚拟化）。
    - 编辑：`TermsEditor`（增/改/删词条，虚拟化，见 CMP-05）。
    - `submit(targetStatus)`：payload 用**路由 name（routeName）**而非 `vocab.name`（内容相同词表可能不同 writer，`:71`）；保留 dimension/meta/source。
- **依赖后端端点**：`GET /v1/vocabularies/{name}` = `CONTRACT-04`（`useVocabulary`）；`PUT /v1/vocabularies/{name}` = `CONTRACT-05`（`usePutVocabulary`，save/promote）；`GET /v1/refs` = `API-12`（dataset datalist）；`POST /v1/vocabularies/{name}:normalize?dataset&ref` = `CONTRACT-07`；`POST /v1/vocabularies/{name}:validate?dataset&ref` = `CONTRACT-08`。
- **重写目标**：`apps/web/src/routes/vocabularies.$name.tsx`；shadcn：`Card`、`Badge`、`Collapsible`（provenance）、`Input`+`Combobox`（apply dataset）、`Button`、`Tabs`（查看/编辑词条）、词条虚拟列表（TanStack Virtual）；hooks：`useVocabulary`、`usePutVocabulary`、`useRefs`、`useNormalizeVocabulary`、`useValidateVocabulary`。
- **验收点**：打开一个 draft 词表 → 看到 status/terms/conflicts；点 Curate 改 alias 后 Save → 「Saved a new version.」；Promote → status 变 curated；在 Apply 选一个 dataset 点 Validate → 显示 checked/invalid + offending chips + 新 manifest，且样本带 `vocab_{dim}_valid` signal；点 Normalize → 生成新 dataset 并出现在 refs。
- **备注/疑点**：① validate/normalize 的 extractor body **不发送**，后端从 vocab `meta.extractor` 或 dimension preset 解析（`hooks.ts:159`、`CONTRACT-07/08`）。② save 用 routeName 而非 vocab.name（内容寻址身份 vs 命名指针）。③ `alias_conflicts`/`offending_values` 都做了空对象/数组兜底（开放 meta 容错读）。④ `ValidateSummary.offending_values` schema 非 required，UI 兜底 `?? {}`（`:277`）。

---

## 共享组件清单（被多页复用，按 ADR 落 `apps/web/src/components/`）

### CMP-01

- **功能ID**：`CMP-01`
- **名称**：ConnectionPanel（连接状态 + 后端配置）
- **作用**：topbar 显示连接状态点 + api/svc 版本；popover 内改 API base、设 per-backend bearer token、显示版本/feature flags、Apply/Reset。
- **现位置**：`databench-ui/src/components/ConnectionPanel.tsx:9`（status `:21`、apply `:25`、reset `:31`、popover `:54`、feature flags 徽章 `:83`）
- **交互与状态**：status `connected/disconnected/checking`（由 `useCapabilities` 派生）；base/token 草稿 state，`useEffect` 跟随 active backend 同步；Apply 改 base/token 并关闭；Reset 回 `DEFAULT_API_BASE`；连接时列出 `caps.features` 每个 flag 徽章（on/off）。
- **依赖后端端点**：间接 `API-02`/`API-03`（经 capabilities/version）。
- **重写目标**：`apps/web/src/routes/__root.tsx` 内嵌或 `components/`；shadcn：`Popover`、`Input`、`Button`、`Badge`、状态点。详见 FLOW-02。
- **验收点**：改 base 到错误地址 → 状态点变红 disconnected；改回 → connected 且显示版本；token 输入按 base 隔离。
- **备注/疑点**：token 走 header 非 cookie（`http.ts:51`）；base 是 origin-only，client 自己拼 `/v1`（`config.ts`）。

### CMP-02

- **功能ID**：`CMP-02`
- **名称**：LanguageSwitcher（en/zh 切换）
- **作用**：顶栏切换界面语言，持久化。
- **现位置**：`databench-ui/src/components/LanguageSwitcher.tsx:4`；i18n 配置 `src/i18n/index.ts`
- **交互与状态**：两个按钮 EN/中文，`aria-pressed` 标当前；`i18n.changeLanguage`；持久化 localStorage key `databench.lang`，**默认 zh**（fallbackLng/detection，`i18n/index.ts:18`/`:27`）。
- **重写目标**：`apps/web/src/components/` + `i18n/`（i18next + react-i18next，沿用 en/zh locales）；shadcn：`Button`/`ToggleGroup`。
- **验收点**：切到中文 → 全站文案变中文且刷新后保持；首次访问（无存储）默认中文。详见 FLOW-03。
- **备注/疑点**：刻意不读浏览器 locale（非中文浏览器也默认 zh，`i18n/index.ts:25`）。

### CMP-03

- **功能ID**：`CMP-03`
- **名称**：ManifestView（dataset manifest 展示）
- **作用**：统一渲染 manifest：version（可链接详情）、name、num_rows、kinds 徽章、其余字段折叠 JSON。复用于详情/ingest/transform/recipe/normalize/validate 结果。
- **现位置**：`databench-ui/src/components/ManifestView.tsx:8`（`KNOWN_KEYS` `:6`、kinds `:47`、extra 折叠 `:62`）
- **重写目标**：`apps/web/src/components/ManifestView.tsx`；shadcn：`Badge`、`Collapsible`、描述列表。
- **验收点**：传一个含 source/columns 的 manifest → 主字段显示、其余进「Other manifest fields」折叠；`linkToDetail` 时 version 可点进 `/datasets/{version}`。

### CMP-04

- **功能ID**：`CMP-04`
- **名称**：VirtualizedSamples + SampleView（虚拟化样本浏览）
- **作用**：按页拉取 + 虚拟滚动渲染样本，kind-aware 预览 + raw JSON 折叠。绝不全量载入。
- **现位置**：`databench-ui/src/components/VirtualizedSamples.tsx:12`（虚拟器 `:27`、近底翻页 `:37`、toolbar `:51`）、`components/SampleView.tsx:29`（`KindBody` `:51` 覆盖 sft/preference/rl/trajectory）
- **交互与状态**：`useInfiniteSamples`（每页 `pageSize`）；`useVirtualizer`（estimate 200、overscan 6、measureElement 实测）；滚到末页自动 `fetchNextPage`；loading/error/empty/「Loaded X of Y」/「Loading more…」/「All N loaded」。
- **依赖后端端点**：`GET /v1/datasets/{ref}/samples` = `API-07`。
- **重写目标**：`apps/web/src/components/samples/`（TanStack Virtual + openapi-fetch `useInfiniteQuery`）；shadcn：`Badge`（kind）、`Collapsible`（raw）。
- **验收点**：千行 dataset 滚动流畅、内存不爆、计数随加载更新。

### CMP-05

- **功能ID**：`CMP-05`
- **名称**：VirtualizedTerms + TermsEditor + AliasInput（词条编辑/展示）❗vocab
- **作用**：词表词条的只读虚拟列表 + 编辑器（增/改 canonical/aliases、删），别名输入「聚焦时持原始文本、失焦才解析」避免逗号被吞。
- **现位置**：`databench-ui/src/components/VirtualizedTerms.tsx:12`（编辑行 `:51`、`AliasInput` `:105`、`parseAliases` `:136`、`readCount` `:143`）、`components/TermsEditor.tsx:10`（`addTerm` `:21`、Enter 添加 `:50`）
- **交互与状态**：虚拟化（estimate 编辑 92/只读 64、overscan 8）；空态「This vocabulary has no terms.」；编辑态每行 canonical input + alias input（失焦 commit）+ 删除按钮；新增行 canonical+aliases，Enter 提交。
- **重写目标**：`apps/web/src/components/`（TanStack Virtual）；shadcn：`Input`、`Button`、`Badge`（alias chip）。
- **验收点**：（vocab 实现后）输入「a, b, c」别名失焦 → 解析为 3 个 chip；编辑 388 词条的 brand 词表滚动流畅。
- **备注/疑点**：alias 解析只在 blur（`:128`）——重写必须保留，否则键入逗号即被吞（注释 `:99`）。

### CMP-06

- **功能ID**：`CMP-06`
- **名称**：TreeNode（递归可折叠 JSON/DAG 树）
- **作用**：把任意嵌套对象渲染成可展开树（lineage 用）；容器节点可展开、叶子内联、折叠时显示预览。
- **现位置**：`databench-ui/src/components/TreeNode.tsx:26`（`preview` `:16`）
- **重写目标**：`apps/web/src/components/`（lineage 主视图改 React Flow，TreeNode 作兜底）。
- **验收点**：传嵌套 lineage 对象 → 可逐层展开/折叠。

### CMP-07

- **功能ID**：`CMP-07`
- **名称**：ui 原语（Card / Spinner / EmptyState / FeatureDisabled / ErrorState / InlineError / JsonBlock）
- **作用**：全站状态/容器原语，统一 loading/empty/disabled/error 呈现，并从 `ApiError` envelope 提取 code+message 与 per-field detail。
- **现位置**：`databench-ui/src/components/ui.tsx`（`Spinner` `:6`、`EmptyState` `:11`、`FeatureDisabled` `:16`、`messageFor` `:23`、`detailMessages` `:37`、`ErrorState` `:57`、`InlineError` `:69`、`Card` `:81`、`JsonBlock` `:90`）
- **重写目标**：`apps/web/src/components/ui/`（shadcn 生成 `card`/`skeleton`/`alert` 等）+ 薄封装统一错误呈现；详见 FLOW-10。
- **验收点**：传一个 422 envelope（带 detail 数组）→ `InlineError` 逐条列出 per-field 消息；网络失败（status 0）→ 显示 unreachable 文案。

---

## 跨页流程清单

### FLOW-01

- **功能ID**：`FLOW-01`
- **名称**：能力/版本握手 + gate 启动
- **作用**：连接时拉 `/capabilities`+`/version`，算 compatibility，决定渲染主内容还是 connecting/error/incompatible 屏。
- **现位置**：`src/api/capabilities.tsx:22`（`CapabilitiesProvider`，caps retry:false refetch 30s `:29`）、`src/api/version.ts:37`（`checkCompatibility`）、`App.tsx:78`（`Gate`）
- **依赖后端端点**：`GET /capabilities` = `API-03`、`GET /version` = `API-02`。
- **交互与状态**：compatibility 三态 `ok` / `api_unsupported`（major 不在 `SUPPORTED_API_MAJORS=[1]`）/ `client_too_old`（`CLIENT_VERSION 0.1.0 < min_client`）。
- **重写目标**：`apps/web/src/api/` provider + `routes/__root.tsx` gate；openapi-fetch hooks `useCapabilities`/`useVersion`。
- **验收点**：后端 `api_version="v1"` 且 `min_client<=0.1.0` → 正常进入；伪造 `api_version="v2"` → 显示「does not support API version v2」。
- **备注/疑点**：`CLIENT_VERSION` 与 `SUPPORTED_API_MAJORS` 是前端常量（`version.ts:4`/`:8`），重写沿用。

### FLOW-02

- **功能ID**：`FLOW-02`
- **名称**：后端切换 + per-backend token 隔离 + query 重键
- **作用**：运行时指向不同 API origin，每个 backend 独立 token，切换时所有 query 以 base 为 key 前缀重新取数、不串数据。
- **现位置**：`src/api/backend.tsx:26`（`BackendProvider`、`setBase` 切 token `:30`、`useBackendKey` `:62`）、`src/api/config.ts`（localStorage：base key `databench.api_base`、token key `databench.token:{base}` `:52`）、CMP-01 连接面板
- **交互与状态**：base 存 localStorage（origin-only，去尾斜杠）；token 按 base 命名空间隔离；每个 query key 以 `base` 开头（`hooks.ts` 全部 `[base, ...]`）→ 换 base 即换缓存分区。
- **重写目标**：`apps/web/src/api/config.ts` + backend context；openapi-fetch client `baseURL` 动态 + Bearer header；TanStack Query key 同样以 base 打头。
- **验收点**：连 A（设 tokenA）→ 切 B（无 token）→ 切回 A → token 仍是 tokenA 且看到 A 的 refs；A/B 数据不互窜。
- **备注/疑点**：2xx 但非 JSON content-type 抛 `not_databench`（`http.ts:146`）——防误连 SPA fallback 主机；重写保留。

### FLOW-03

- **功能ID**：`FLOW-03`
- **名称**：i18n 语言切换（en/zh）
- **作用**：全站中英切换，持久化，默认中文。
- **现位置**：`src/i18n/index.ts`、CMP-02；locales `src/i18n/locales/{en,zh}.json`
- **重写目标**：`apps/web/src/i18n/`（i18next + react-i18next，沿用 locales）。
- **验收点**：见 CMP-02。
- **备注/疑点**：所有页面文案都走 `t()`，空态/错误/按钮文案集中在 locales——重写须整体迁移 locales（en.json 是本清单空态文案来源）。

### FLOW-04

- **功能ID**：`FLOW-04`
- **名称**：feature-flag 驱动的可见性（宽松 nav/page vs 严格）
- **作用**：按 `/capabilities.features` 控制导航项与页面级 gate、ingest 的 JSONL 卡、详情的导出按钮、lineage 页。
- **现位置**：`src/api/capabilities.tsx:64`（`FEATURES`）、`:74`（`useFeature` 严格）、`:82`（`useModuleEnabled` 宽松：缺失=enabled）；用处：`App.tsx:68`（nav）、各页 gate、`DatasetDetailPage.tsx:21`（export）、`IngestPage.tsx:24`（jsonl）
- **依赖后端端点**：`API-03`。
- **重写目标**：`apps/web/src/api/` 同名 hooks。
- **验收点**：把 `lineage` flag 设 false → nav 隐藏 Lineage 且 `/lineage` 显示 disabled；`export` false → 详情无导出按钮。
- **备注/疑点**：D1 后 TS 后端显式返回 `vocabularies:true`；连接旧后端或无词表能力后端时，前端仍需按能力位隐藏或 disabled。

### FLOW-05

- **功能ID**：`FLOW-05`
- **名称**：ref/version 跨页深链接（datasets → detail → lineage）
- **作用**：在列表、详情、lineage 间用 ref/version 串联导航。
- **现位置**：`DatasetsPage.tsx:59`/`:70`（→详情 / →`/lineage?ref=`）、`DatasetDetailPage.tsx:30`（→`/lineage?ref=`）、`LineagePage.tsx:12`/`:19`（读 `?ref=` 并同步）
- **重写目标**：TanStack Router 类型安全链接；lineage 路由从 `?ref=` 改 path `lineage.$ref.tsx`（directory-layout）。
- **验收点**：列表点 lineage → lineage 页自动载入该 version；详情点 view lineage 同理。
- **备注/疑点**：❗URL 形态变化点：旧用 `/lineage?ref=`，新用 `/lineage/$ref`——三处生成链接都要改，注意旧深链接兼容。

### FLOW-06

- **功能ID**：`FLOW-06`
- **名称**：结果 manifest → dataset 详情（linkToDetail）
- **作用**：ingest/transform/recipe/normalize/validate 成功后，结果 manifest 的 version 可一键进详情。
- **现位置**：`ManifestView` `linkToDetail`（`ManifestView.tsx:28`）；调用处：`IngestPage.tsx:160`、`TransformsPage.tsx:131`、`RecipePage.tsx:68`、`VocabularyDetailPage.tsx:268`/`:301`
- **重写目标**：复用 `ManifestView`。
- **验收点**：ingest 成功 → 点结果 version → 落到 `/datasets/{version}` 看到同一 dataset。

### FLOW-07

- **功能ID**：`FLOW-07`
- **名称**：mutation → refs 缓存失效/刷新
- **作用**：任何产生新 dataset/ref 的操作成功后，刷新 refs 列表（与词表列表）使 UI 立即可见。
- **现位置**：`src/api/hooks.ts`：`useRefsInvalidation` `:153`；用于 `useCreateDataset` `:180`、`useIngestJsonl` `:188`、`useRunTransform` `:197`、`useMaterializeRecipe` `:206`、`useNormalizeVocabulary` `:162`、`useValidateVocabulary` `:171`；`useVocabulariesInvalidation` `:120`（derive/put）。
- **重写目标**：TanStack Query `invalidateQueries`（key 以 base 打头）。
- **验收点**：ingest 后无需手动刷新，`/datasets` 列表出现新 ref。
- **备注/疑点**：当前是**失效重取**，非乐观更新（无 optimistic UI）——重写可保持简单失效。

### FLOW-08

- **功能ID**：`FLOW-08`
- **名称**：词表全生命周期（derive → detail → curate/promote → apply normalize/validate）
- **作用**：从 dataset 派生 draft → 详情整理词条 → 晋级 curated → 应用到 dataset 做 normalize/validate，并复核 alias 冲突。
- **现位置**：PAGE-08 → PAGE-10（含 ApplyToDataset、conflicts、TermsEditor）→ 产物回流 refs（FLOW-07）
- **依赖后端端点**：`CONTRACT-06`（derive）、`CONTRACT-04`（get）、`CONTRACT-05`（put）、`CONTRACT-07`（normalize）、`CONTRACT-08`（validate）+ `API-12`（refs）。
- **重写目标**：vocabularies.* 路由族。
- **验收点**：见 PAGE-08/PAGE-10。
- **备注/疑点**：D1 已实现；仍需用端到端测试覆盖 derive → curate/promote → normalize/validate。

### FLOW-09

- **功能ID**：`FLOW-09`
- **名称**：带鉴权的流式导出下载
- **作用**：用 bearer token fetch 导出端点，把 NDJSON 流存成文件——`<a download>` 无法带 header，故走 fetch+blob。
- **现位置**：`src/api/client.ts:145`（`downloadExport`，rawRequest `:138`、失败回落 envelope `:150`、blob/a.click `:155`）、`DatasetDetailPage.tsx:69`（`ExportButton`）
- **依赖后端端点**：`GET /v1/datasets/{ref}/export?fmt` = `API-08`（`application/x-ndjson` 流）。
- **重写目标**：`apps/web/src/api/`；openapi-fetch 取 raw `Response` 或裸 fetch（导出不要求 JSON content-type）。
- **验收点**：设了 token 的 backend 点导出 → 下载到 `{ref}.{fmt}.jsonl`，请求头带 `Authorization`；失败时弹与普通请求一致的 envelope 错误。
- **备注/疑点**：① 导出不经 TanStack Query（一次性下载）。② 非 2xx 时 `downloadExport` 再发一次普通 `request` 以复用 envelope 解析（`:152`）。③ `fmt` 后端忽略，UI 固定默认值。

### FLOW-10

- **功能ID**：`FLOW-10`
- **名称**：统一错误 envelope 呈现 + per-field detail
- **作用**：把后端 `{error:{code,message,detail?}}`（及 legacy `{detail}`）统一解析为 `ApiError`，并在 `ErrorState`/`InlineError` 中呈现，表单场景逐条列 per-field 校验消息。
- **现位置**：`src/api/http.ts:7`（`ApiError`）、`:57`（`describeError`）、`:137`（`request`，非 JSON 2xx→`not_databench` `:146`、网络失败→status 0 `unreachable` `:129`）；`components/ui.tsx:23`（`messageFor`）、`:37`（`detailMessages`，剥 `Value error,` 前缀 `:53`）
- **依赖后端端点**：所有（错误合同 `ERR-01..06`，是运行时合同非 OpenAPI 合同）。
- **重写目标**：`apps/web/src/api/` 错误类型 + ui 错误组件；TanStack Query error → 同款呈现。
- **验收点**：`PUT` 词表冲突返回 422 envelope（detail 含「alias X maps to both A and B」）→ `InlineError` 逐条显示；后端关闭 → 显示 unreachable；连到非 databench 主机 → 显示 notDatabench 文案。
- **备注/疑点**：❗错误 envelope 是**运行时合同**，OpenAPI 当前未声明 `ErrorResponse`（`inventory-service.md` ERR 专节）——openapi-fetch 生成类型里不会有它，重写需手写 `ApiError` 形状并修正 OpenAPI。前端同时兼容 legacy FastAPI `{detail}`，迁移后端后可简化。

### FLOW-11

- **功能ID**：`FLOW-11`
- **名称**：连接健康轮询 + 状态显示
- **作用**：定期探活，topbar 状态点反映 connected/disconnected/checking。
- **现位置**：`src/api/hooks.ts:29`（`useHealth` `refetchInterval:15000` retry:false）、`capabilities.tsx:29`（caps `refetchInterval:30000`）、CMP-01 状态点
- **依赖后端端点**：`GET /health` = `API-01`；`GET /capabilities` = `API-03`。
- **重写目标**：`apps/web/src/api/hooks.ts`；TanStack Query `refetchInterval`。
- **验收点**：后端中途挂掉 → ≤30s 内状态点转红；恢复后转绿。
- **备注/疑点**：`useHealth` 当前**未在页面直接消费**（状态点由 capabilities 派生，`ConnectionPanel.tsx:21`）；health 轮询存在但 UI 状态实际看 caps。重写可二选一，别丢探活语义。

---

## 可能遗漏 / 存疑

- **vocabularies 全家桶已纳入 D1 实现范围**：PAGE-07/08/09/10 + FLOW-08 + CMP-05 均依赖 `CONTRACT-03..08`，当前应按已实现功能验收；连接无词表能力的旧后端时走 capabilities gate。
- **lineage 路由形态变更**：旧 `/lineage?ref=`（query）→ 新 `/lineage/$ref`（path，directory-layout）。三处生成链接（PAGE-01 两处、PAGE-02）+ 同步逻辑都要改，注意旧深链接兼容。
- **lineage 升级为 React Flow**：旧 UI 仅折叠树（CMP-06），ADR-0006 指定 `@xyflow/react` 渲染 DAG——这是重写的**功能升级点**，别只 1:1 搬树。建议保留 tree/JSON 作兜底视图。
- **详情链接用 version 不用 name**（PAGE-01）：`/datasets/{version}`；重写保持，否则 `:ref` 解析路径变。
- **样本 `id` 是 optional**：`API-07` 不在合同里 dump `id`，UI 容错（`SampleView.tsx:38`）；若 TS API 想显式带 id 要同步 OpenAPI+前端类型。
- **错误 envelope 不在 OpenAPI 里**：openapi-fetch 生成类型不含 `ErrorResponse`，需手写 `ApiError` 形状（FLOW-10）。
- **无真分页**：DatasetsPage（refs 200）与 VocabulariesPage（500）都是单请求 + cappedNote，无 prev/next/虚拟化；数据量超上限会截断。重写若要全量需补分页。
- **无确认弹窗 / 无乐观更新**：全站破坏性操作（如词表 Save 覆盖、normalize 产新 dataset）**均无二次确认**；mutation 成功靠 refs 失效刷新，无 optimistic UI。重写可酌情加确认（尤其词表覆盖）。
- **health 轮询未被 UI 直接消费**（FLOW-11）：状态点看 capabilities，`useHealth` 存在但旁路；重写注意别丢探活或重复。
- **JSON/JSONL 两条 ingest 路径行为不同**（PAGE-03）：JSON body 不做简写归一化、JSONL 才做；UI 两卡分开，重写别合并逻辑。
- **i18n 默认 zh 且不读浏览器 locale**：重写沿用，否则默认语言会变。
- **transforms/recipe/词表创建表单都是裸 JSON 文本框**（PAGE-04/05/09 部分）：无字段级表单，结构错误靠后端 422。ADR 提到 `react-hook-form + zod`，重写可升级为结构化表单（属增强，非丢功能）。
- **本任务未运行旧 UI**：以上交互由源码阅读得出，未在浏览器实跑验证；空态/错误文案以 `en.json` 为准（zh.json 未逐字核对，假定对称）。
- **生成类型来源是 UI pinned `schema/openapi.json`**（领先后端，含 vocabularies）：新栈从 `apps/api` 导出的 `openapi.json` 生成类型 → 若后端不实现词表，生成类型里就没有词表 schema，PAGE-07..10 的 hooks 会缺类型。

---

## 依赖 vocabularies（D1 已实现）的页面 / 功能

> 最新旧后端已补 `databench/service/routers/vocabularies.py` 和词表 domain；以下功能不再是阻塞项，TS 前后端需要保持可用，并在 `vocabularies:false` 后端上优雅隐藏。

| 功能ID | 页面/流程 | 依赖端点 | 当前实现状态 |
|---|---|---|---|
| PAGE-07 | Vocabularies 列表 | `GET /v1/vocabularies` = `CONTRACT-03` | 已实现 |
| PAGE-08 | Derive 词表 | `POST …:derive` = `CONTRACT-06`（+ refs API-12） | 已实现 |
| PAGE-09 | 手工创建词表 | `PUT /v1/vocabularies/{name}` = `CONTRACT-05` | 已实现 |
| PAGE-10 | 词表详情/整理/应用/冲突 | `GET`=`CONTRACT-04`、`PUT`=`CONTRACT-05`、`:normalize`=`CONTRACT-07`、`:validate`=`CONTRACT-08`（+ refs API-12） | 已实现 |
| FLOW-08 | 词表全生命周期 | 上述 6 个 | 已实现 |
| CMP-05 | 词条编辑器/虚拟列表 | （随 PAGE-09/10） | 已实现 |

PAGE-08/PAGE-10 的 dataset 选择器继续使用 `GET /v1/refs` = `API-12`。

---

## 覆盖小结

- **覆盖页面（10/10）**：DatasetsPage、DatasetDetailPage、IngestPage、TransformsPage、RecipePage、LineagePage、VocabulariesPage、VocabularyDerivePage、VocabularyCreatePage、VocabularyDetailPage；外加应用外壳（PAGE-00）。
- **条目总数 29**：页面/外壳 11（PAGE-00..10）+ 共享组件 7（CMP-01..07）+ 跨页流程 11（FLOW-01..11）。
- **vocabularies 覆盖**：PAGE-07、PAGE-08、PAGE-09、PAGE-10、FLOW-08（及 CMP-05）依赖 `CONTRACT-03..08`，D1 后已纳入实现与验收。
