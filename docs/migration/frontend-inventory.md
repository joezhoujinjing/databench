# 前端重写总清单与重写顺序(权威)

> `apps/web` 全新重写(React 19 + Vite SPA + shadcn/ui + Tailwind + TanStack Router/Query/Virtual + openapi-fetch,ADR-0006)的**主计划**:全部功能索引 + 依赖排序的重写阶段 + 勾选框 + 验收闸门。逐功能细节见两份明细:
> - [`_frontend-pages.md`](_frontend-pages.md) — 页面/外壳/跨页流程,**29 条**(`PAGE-00..10`、`CMP-*`、`FLOW-01..11`)
> - [`_frontend-shell.md`](_frontend-shell.md) — 共享组件内部/API 层/i18n/应用壳,**42 条**(`CMP-*`、`FAPI-01..20`、`I18N-01..04`、`SHELL-01..06`)+ 203 个 i18n key 清单
>
> ⚠️ **两份明细各自用独立的 `CMP-xx` 本地编号、指代不同组件**(pages 的 CMP 偏「页面里怎么用」,shell 的 CMP 偏「组件内部行为」)。本主清单按**组件名**统一索引,不要混用两边的 CMP 号。
>
> 后端契约/端点见 [`inventory-service.md`](inventory-service.md)(`API-*`/`CONTRACT-*`);后端不变,前端只经 `/v1` + openapi-fetch 消费。

## ⚠️ 重写前/中要拍的事(前端侧)

1. **vocabularies**:原风险为词表 4 页 + 词条组件 + 6 个 API 依赖 `CONTRACT-03..08`。当前 owner 已拍板实现,后端 capabilities 为 `vocabularies:true`,FE-5 已补齐词表列表/派生/新建/详情与术语编辑。
2. **lineage 的两处升级**(易在重写中悄悄丢/做歪):① 路由从 `/lineage?ref=`(query)→ `/lineage/$ref`(path),三处生成链接 + 同步逻辑都要改,注意旧深链接;② 视图从折叠树**升级为 React Flow DAG**(`@xyflow/react`)——**保留 tree/JSON 作兜底**。
3. **错误 envelope 不在 OpenAPI 里**:openapi-fetch 生成类型不含 `ErrorResponse` → **手写 `ApiError` 形状**;保留「统一 envelope + legacy `{detail}` + 非 JSON 2xx=not_databench + 网络失败=unreachable」四路解析(后端修正 OpenAPI 后可简化,见 inventory-service 决策 #3)。
4. **几个旧行为决定保留还是改进**(不丢功能前提下):无真分页(refs 200 / 列表 500 单请求 + cappedNote)、无确认弹窗、无乐观更新、i18n 默认 zh 且不读浏览器语言、详情链接用 version 而非 name。**默认保留**;要改需明确记录。

## 重写顺序(依赖排序,逐阶段)

原则:先搭壳与 API 地基(所有页面都依赖),再共享组件,再核心页面,最后 vocab(gated)。每阶段配前端验收闸门(FG-*)。

### FE-0 — 应用脚手架
- [ ] Vite + React 19 + TS;Tailwind v4(`@tailwindcss/vite`)+ shadcn/ui init(`components.json`)
- [ ] TanStack Router 文件式路由骨架;QueryClient(`retry:1`、`refetchOnWindowFocus:false`)
- [ ] Provider 顺序:QueryClient → Backend → Capabilities → Router(`SHELL-01`)
- [ ] 主题/样式 tokens:把旧暗色体系迁成 Tailwind theme + shadcn CSS vars(`SHELL-06`,保留视觉/尺寸语义,不逐字搬 CSS)

### FE-1 — API 层地基(所有数据流的根)
- [x] openapi-typescript 从 `apps/api` 的 `openapi.json` 生成类型 + openapi-fetch client(`FAPI-01`)
- [x] HTTP 传输:base 拼接、Bearer、query 序列化、FormData、raw streaming(`FAPI-03`)
- [x] **错误解析** → `ApiError`(envelope/legacy/非JSON/网络,四路)(`FAPI-04`)
- [x] runtime backend base + **per-base token 隔离**(localStorage)(`FAPI-05`)
- [x] Backend context + **query key 以 base 打头**(缓存按后端隔离)(`FAPI-06`)
- [x] 分页 clamp(≤500)(`FAPI-02`);feature-not-deployed retry 策略(404/501 不重试)(`FAPI-20`)
- **FG2/FG3** 见下。

### FE-2 — 握手 + gate + 应用壳
- [x] meta 握手:health(15s)/capabilities(30s)/version,不 retry(`FAPI-07`)
- [x] 版本兼容:`CLIENT_VERSION`/`SUPPORTED_API_MAJORS`/`checkCompatibility`(`FAPI-08`)
- [x] feature flags:`useFeature`(严格)/`useModuleEnabled`(宽松)(`FAPI-09`)
- [x] 应用壳:顶栏 + 导航 + 能力门控(`SHELL-02/05`)、capability/version gate「永不白屏」四态(`SHELL-03`)、路由装配 + 404 + `/`→`/datasets`(`SHELL-04`)
- [x] ConnectionPanel(连接状态/版本/flags/改 base/per-base token)、LanguageSwitcher
- [x] 流程:`FLOW-01`(握手 gate)、`FLOW-02`(后端切换 + token 隔离)、`FLOW-11`(健康轮询/状态点)
- **FG5** 见下。

### FE-3 — 共享数据组件
- [x] ui 原语 → shadcn(`Card`/`Skeleton`/`Alert`/状态块)+ 统一错误呈现(`InlineError`/`ErrorState`,per-field detail,剥 `Value error,`)(`FLOW-10`)
- [x] ManifestView(核心字段 + 其余折叠 + linkToDetail)
- [x] SampleView(kind-aware,容错读 id/messages;注意 `rl.reward`/`trajectory.steps` 是旧容错/漂移字段)
- [x] VirtualizedSamples(TanStack Virtual + 无限滚动,绝不全量)
- [x] TreeNode(lineage 兜底视图,补 `aria-expanded`)
- **FG4** 见下。

### FE-4 — 核心页面(主流程,不含 vocab)
- [x] `PAGE-01` Datasets 列表(`/datasets`)— refs 200、客户端过滤/排序、cappedNote、链接用 version(`FAPI-10`)
- [x] `PAGE-02` Dataset 详情(`/datasets/$ref`)— manifest + 导出 + 虚拟样本表 + page size(`FAPI-11`)
- [x] `PAGE-03` Ingest(`/ingest`)— JSONL 上传(multipart 字段 `file`)+ JSON 样本创建(两路不同,别合并)(`FAPI-12`)
- [x] `PAGE-04` Transforms(`/transforms`)— 列表 + 运行(inputs/params/ref;无参 transform 必传空 params)(`FAPI-14`)
- [x] `PAGE-05` Recipe(`/recipe`)— 粘 JSON 物化(`FAPI-15`)
- [x] `PAGE-06` Lineage(`/lineage/$ref`)— React Flow DAG(+tree/json 兜底);**未知 ref 不报错返回 `{version:ref}` 语义保留**(`FAPI-16`)
- [x] 流程:`FLOW-05`(ref/version 深链接)、`FLOW-06`(结果 manifest→详情)、`FLOW-07`(mutation→refs 失效)、`FLOW-09`(带鉴权流式导出下载)
- **FG6/FG7** 见下。

### FE-5 — vocabularies(已实现)
- [ ] `PAGE-07..10` 列表/derive/new/详情(整理·晋级·apply normalize/validate·冲突复核)
- [ ] 词条组件:TermsEditor / VirtualizedTerms / AliasInput(**别名失焦才解析**,保留)
- [ ] `FAPI-17..19`(list/get/derive/put/normalize/validate)、`FLOW-08`(全生命周期)
- 依赖 `CONTRACT-03..08`;当前已实现,词表 route/nav 按 capabilities 展示。

### 贯穿 — i18n
- [x] i18next + react-i18next 初始化(默认 zh、localStorage `databench.lang`、不读浏览器语言)(`I18N-01`)
- [x] 迁移 en/zh locales(**203 key,en/zh 同构**;清单见 `_frontend-shell.md` 末节)(`I18N-02/04`)
- [x] 错误 fallback 文案(按状态码)(`I18N-03`)
- **FG1** 见下。

## 前端验收闸门(FG-*)

| 闸门 | 检查 | 来源 |
|---|---|---|
| FG1 | en/zh i18n key set **完全一致**(203 key,CI 比对);动态 key(`health.*`/`vocab.status.*`)有覆盖 | I18N-02 |
| FG2 | 错误解析四路:404 envelope / 422 detail 数组 / legacy `{detail}` / 网络失败(status 0) | FAPI-04, FLOW-10 |
| FG3 | per-base token 隔离 + query key 以 base 打头(切后端不串数据) | FAPI-05/06, FLOW-02 |
| FG4 | 1000+ 样本虚拟滚动 + 无限分页,不全量载入 | CMP/VirtualizedSamples |
| FG5 | 能力/版本 gate:后端挂→不可达屏;`api v2`→unsupported;`min_client` 过高→too old;永不白屏 | FAPI-07/08, SHELL-03 |
| FG6 | **契约优先**:类型全由 `apps/api` 的 openapi.json 生成,除手写 `ApiError` 外无手写 API 类型 | FAPI-01 |
| FG7 | lineage `/lineage/$ref` path 路由 + 旧 `?ref=` 深链接兼容;DAG 渲染 + tree/json 兜底 | PAGE-06, FLOW-05 |

## 重写不漏的关键清单(两份「可能遗漏」汇总)

- **vocab 整块按能力位展示**(列表/派生/新建/详情 + 词条组件 + 6 API),后端当前 `vocabularies:true`;若未来连接旧后端返回 false,入口仍应隐藏或显示 disabled。
- **lineage**:query→path、树→React Flow(留兜底)。
- **error envelope 手写 ApiError**(OpenAPI 不含)。
- **无真分页 / 无确认弹窗 / 无乐观更新 / i18n 默认 zh / 详情链接用 version**:默认保留,改则记录。
- **SampleView 的 `rl.reward`/`trajectory.steps`** 非当前契约字段(容错读,加注释/测试)。
- **ConnectionPanel.reset 不清 token**、**`.status-review` CSS 无对应 i18n/schema**、**health 轮询/状态点已在 FE-2 接入**——逐条在明细备注里。
- **JSON/JSONL 两条 ingest 路径行为不同**(JSON 不做简写归一)。

## 怎么用
按 FE-0→FE-5 逐阶段,勾选框对应明细里的功能ID;每阶段末过对应 FG 闸门。vocab(FE-5)是 gated 独立段。后端契约不变,前端类型从 `apps/api` 的 openapi.json 生成。
