# EvalScope 集成实施状态

> 每个 E Step 完成后更新真实状态、提交与 gate。唯一实施计划见 [PLAN.md](PLAN.md)。

<!-- evalscope-status
current_step: E9
last_completed_step: E8
runtime_enabled: false
offline_runtime_enabled: true
ui_routes_enabled: true
upstream_commit: b2a62f05fd81e89ec2cf4f83b9a79ce0a5535d60
e3_implementation: complete
e3_gate: passed
e4_implementation: complete
e4_gate: passed
e5_implementation: complete
e5_gate: passed
e6_implementation: complete
e6_gate: passed
e7_implementation: complete
e7_gate: passed
e8_implementation: complete
e8_gate: passed
e9_implementation: complete
e9_gate: owner_deferred_target
-->

## 当前检查点

- **当前分支:** `main`（包含 Swift S4 交叉扩展）
- **当前 Step:** E9 安全复核、容量、离线与最终集成 gate
- **已完成:** E0 决策/来源/能力基线；E1 `evalscope-general-qa@1.0.0` projection；E2 Evaluation Run
  控制面；E3 backend-only runtime、安全 gateway 与真实执行闭环；E4 Databench Evaluation UI foundation；
  E5 Tasks、Databench Dataset、task monitor 与安全报告入口；E6 Reports、Details、Predictions 与逐样本内容展示；
  E7 Dashboard、Evaluation Compare、Performance、Benchmarks 与安全 Viewer 完整业务面；E8 deterministic
  `tar.zst`、attempt-scoped upload、immutable result object、归档状态与 retention
- **产品状态:** backend-only image 与 same-origin gateway 仍 disabled-by-default；`/evaluations/*` 原生
  lazy routes 已开放；锁定 React 基线的全部业务页面已按 Databench 风格迁入唯一 SPA，E7 完整复刻 gate 已关闭
- **GE8:** deterministic archive、secret/oversize/wrong digest/expired URL、replay/PG failure/exact cleanup、
  真实 MinIO/Postgres、OSS contract 和 Web 状态 gate 已通过
- **E9 本地实现:** runtime drain/capacity/timeout、七镜像离线 bundle、EvalScope stable config、
  backup/restore、upgrade/rollback、operator 与 upstream upgrade runbook 已完成；`0.7.0`
  `linux/amd64` 七镜像 bundle 已实际生成并通过 inner/outer checksum、gzip/tar 可读性与 image smoke
- **GE9 待验收:** 仍需在真实 Ubuntu 22.04 amd64 目标机断网执行 install → Dataset evaluation →
  native report/compare/performance → callback/archive → restart/reconcile → upgrade → rollback；本机
  Docker 验证不替代该目标 gate。Owner 于 2026-07-29 批准先合并，并由 owner 后续手工执行该验证
- **Swift S4 交叉扩展:** opaque Databench Deployment model source、server-side resolve 与
  Dataset/Artifact/Deployment Evaluation lineage 已完成 non-GPU gate；不改变 E8/E9 状态
- **既有状态:** V15 complete、V16 current；本集成没有改变 V16/V17 或公共云 D3

## Step 状态

| Step | 目标 | 状态 | Gate | 备注 |
|---|---|---|---|---|
| E0 | 决策、来源与 capability parity 基线 | ✅ | GE0 | 183 source files、34 upstream tests、60 capabilities、31 upstream routes |
| E1 | `evalscope-general-qa` projection | ✅ | GE1 | 三种 profile fixed bytes；真实 exact Dataset export |
| E2 | Evaluation run 控制面 | ✅ | GE2 | exact Dataset binding、canonical create digest、REST 状态机 |
| E3 | backend-only EvalScope 与安全 gateway | ✅ | GE3 | prebuilt image `network=none`、真实 eval/stop/report |
| E4 | Evaluation UI foundation | ✅ | GE4 | routes/client/tokens/i18n/primitives；11 个 lazy entries |
| E5 | Tasks 与 Databench Dataset 闭环 | ✅ | GE5 | eval/perf、monitor、exact Dataset、safe viewer |
| E6 | Reports、Details 与 Predictions | ✅ | GE6 | catalogue、overview/details、逐样本与富内容 |
| E7 | Dashboard、Compare、Performance、Benchmarks、Viewer | ✅ | GE7 | 完整 UI 复刻唯一 gate 已通过 |
| E8 | 结果归档与 retention | ✅ | GE8 | deterministic archive、immutable object、exact cleanup |
| E9 | 安全、容量、离线与最终集成 gate | 🔄 owner 后验 | GE9 | 本地实现与 bundle 完成；owner 批准先合并并自行补目标机验证 |

## E0 交付

- ADR 0017、技术方案和计划状态改为 Accepted；
- `deploy/evalscope/upstream.lock` 固定 commit/tree、npm/Python inputs、Apache-2.0 和 Plotly 证据；
- `upstream-manifest.json` 记录 183 个文件的 SHA-256、目标和状态；
- `ui-capability-manifest.json` 记录 52 个 upstream parity、4 个 security replacement、2 个
  Databench extension 和 2 个 brand-shell exclusion；
- `implemented-capabilities.json` 建立实现侧反向索引，当前为空；
- checker 同时验证 source ↔ capability backlink、target registry、extension inflation、default-deny routes、
  五类 Benchmark fixture 和 lock 一致性；7 个负面测试已通过；
- `api-routes.json` 固定 31 条 upstream method + exact paths，默认拒绝并显式阻断 resume/scan/SPA；
- active HTML、Router/CSS、output layout、Plotly 与 Benchmark 证据见 `evidence/E0-BASELINE.md`；
- Apache-2.0/Plotly notices 已建立，E3 前不分发 Plotly bytes 或 EvalScope image。

## E0 Gate 记录

2026-07-27 通过：

- `git diff --check` 及全部新增文件 no-index whitespace check；
- `pnpm evalscope:parity:check`；
- `pnpm evalscope:parity:test`（7/7）；
- `pnpm lint`（403 files）；
- `pnpm build`（13/13）；
- `pnpm typecheck`；
- `pnpm test`（22/22 workspace tasks；Web 58 tests）；
- `pnpm openapi:check`（11/11）；
- `pnpm v2:status:check`；
- `pnpm peers check`；
- `pnpm offline:check`。

`pnpm evalscope:parity:check:green` 另做负向确认，当前正确拒绝所有 planned capability。E0 没有 runtime、
数据库、对象存储或浏览器 surface 变更，因此不需要真实 EvalScope/Postgres/MinIO/browser lifecycle gate。

## E1 交付

- `V2_CONVERTER_NAMES` 增加 `evalscope-general-qa`，task view 增加 `evaluation-qa`；Hashing approval
  identity、OpenAPI 和 generated Web client 同步扩展；
- strict `target_source` 只接受 `selected-candidate`、`verification-ground-truth` 或 `none`；
- text-only prompt、user-terminated、无 tools 准入和 8 个有界 exclusion reasons 已实现；file、function、
  thought、multipart 不会被静默压成文本；
- selected candidate 一对多输出、string ground truth 和无 reference 三种路径都输出确定性
  `general_qa` JSONL；空文本和 exact Unicode 不 trim、不 normalize；
- `_databench` 固定携带 Dataset version、record ID/digest，selected profile 另带 candidate ID；
- inspect 固定返回 `general_qa`/`databench` 和 eligibility summary；inspect→stream exact binding、semantic
  fidelity approval/mismatch 继续复用既有 Workspace 链路；
- REST、CLI registry/inspect 和 Web fidelity review 已用 generated contract 验证；E1 没有增加 EvalScope
  runtime、run 表或 `/evaluations/*` 路由。

详细 bytes、reason matrix 和锁定 upstream adapter smoke 见
[E1-PROJECTION.md](evidence/E1-PROJECTION.md)。

## E1 Gate 记录

2026-07-27 通过：

- `pnpm lint`；
- `pnpm build`；
- `pnpm typecheck`；
- `pnpm test`；
- `pnpm openapi:check`；
- `pnpm v2:status:check`；
- `pnpm peers check`；
- `pnpm evalscope:parity:check` 与 `pnpm evalscope:parity:test`；
- `pnpm offline:check`；
- `git diff --check`；
- `RUN_MINIO_STORE_TESTS=true` 的 Workspace、API 和 CLI 真实 Postgres/MinIO suites；
- 锁定 EvalScope `GeneralQAAdapter.record_to_sample` 对三种 committed profile 的 compatibility smoke。

E1 没有 UI capability 实现，GE7 green gate 仍按设计失败；runtime/UI flags 和 V16/V17 状态均未改变。

## E2 交付

- additive `evaluation_runs_v2` migration 固定 namespace/exact Dataset `RESTRICT` FK、provider/task 唯一键、
  provider/status/digest/terminal/archive/artifact 与 bounded JSON raw CHECK；
- `evaluation-run-create-v1` 使用 RFC 8785 + BLAKE3 绑定 provider task、exact Dataset、display Ref、normalized
  converter plan、fidelity、benchmark、model 和 EvalScope commit；fixed digest 为
  `de467c5dd0ce450c5d234cbaefe483bf83ee97c307d578e3928f5150fa6d25b8`；
- Workspace 创建时重新 inspect exact Dataset，只准入 `evaluation-qa` converter，并把 normalized options、
  converter version、fidelity digest 和 `general_qa` benchmark 写入 create identity；Ref 后续移动不改变 run；
- create 同 digest 重放，provider task 不同 digest 返回 409；execution 状态固定为
  `prepared → running → completed|failed|cancelled`，相同 terminal body 重放成功、不同 body 返回 409；
- metrics 只允许 bounded summary，provider report ID 只允许 bounded opaque token；path、URL、credential、
  未知 metric/sample 字段和错误中的 credential 不进入 Postgres；
- 新增 create/get/list/start/complete/fail/cancel REST，分页 cursor 与 Dataset/status filter 绑定；OpenAPI 和
  Web generated client 已同步；
- archive fields 只作为 E8 数据形状保留，run 固定从 `archive_status=not_requested` 开始，E2 未开放归档
  endpoint；native Benchmark/performance run 不写入本表。

详细 migration、状态机、边界与真实依赖证据见
[E2-RUN-CONTROL.md](evidence/E2-RUN-CONTROL.md)。

## E2 Gate 记录

2026-07-27 通过：

- 真实 Postgres 从空 test schema 部署全部 10 个 migration，Catalog 36 tests；
- hashing 26、schema 217、Workspace 150、API 88 个常规 tests；
- `RUN_MINIO_STORE_TESTS=true` 的 Workspace 155、API 92、CLI 14 个真实 Postgres/MinIO tests；
- API lifecycle 覆盖 exact Dataset ingest/inspect、create replay/mismatch、start/complete replay/conflict、
  get/list 和 secret/unknown-field rejection；
- `pnpm lint`、`pnpm build`、`pnpm typecheck`、`pnpm test`、`pnpm openapi:check`、
  `pnpm v2:status:check`、`pnpm peers check`、`pnpm evalscope:parity:check`、
  `pnpm evalscope:parity:test`、`pnpm offline:check` 与 `git diff --check`。

E2 没有启动 EvalScope、增加 `/evaluations/*` Web route 或实现 UI capability；GE7 green gate 仍按设计失败，
runtime/UI flags、V16/V17 与公共云 D3 状态均未改变。

## E3 交付与 Gate 记录

- Databench-owned EvalScope provider source、Python project 和 tests 位于 `workers/evalscope`；它与
  `workers/python` 同级但通过内部 HTTP 而不是 gRPC 调用，`deploy/evalscope` 只保留部署资产；
- pinned EvalScope source/patch、Python lock、base image、Plotly 2.35.2 与 NLTK `punkt_tab` 已进入
  backend-only image；完整 Python package data 保留，upstream `evalscope/web` 整目录删除；
- Gunicorn 固定 one process + threaded；32 条 runtime routes 仅包含 reviewed provider routes 与
  operator-only reconcile；resume、scan、SPA root、synthetic route 继续 blocked；
- Hono `/evalscope-api` gateway 使用独立 compiled allowlist + manifest double check，method/path/query/body、
  redirect、media type 和 response bytes 均 fail closed；浏览器 credential/cookie 不转发；
- native `dataset_args` locator deny、model scheme/host/port/DNS/socket guard、task HMAC claim、race/replay、
  stop intent、startup/manual reconcile 与 callback loss 已覆盖；
- report/chart/perf active HTML 只生成短期 opaque document；iframe context、nonce CSP、local Plotly、
  `nosniff`、`no-referrer`、media realpath/MIME/signature 边界已建立；
- 真实 `evalscope-e3-smoke` Dataset 完成 export → general_qa → fake model → BLEU/ROUGE → Databench
  completed callback；慢任务并发 polling/stop 收敛为 cancelled；
- final image ID
  `sha256:5266dc68033c51a46d2992f7f679128b993aba747d940103d42a9961b93d1f1c` 在 Docker network mode
  `none` 下健康启动并读取真实安全报告与固定 Plotly asset；
- Python 51 tests、API 96 regular/100 real-dependency tests、Workspace 155、CLI 14、Web 59、全仓
  lint/build/typecheck/test/openapi/v2-status/peers/offline/parity gates 均通过；GE7 green 仍按设计失败。

完整证据见 [E3-BACKEND-RUNTIME.md](evidence/E3-BACKEND-RUNTIME.md)。

Owner 于 2026-07-28 确认 GE3/GE9 的 offline release boundary 是 digest-pinned prebuilt image：fresh build
可以联网获取锁定输入，不要求 `docker build --network=none`，仓库不提交 wheelhouse/apt mirror；目标机
断网 install/start/eval/report/upgrade/rollback 要求不变并在 E9 验收。基于该明确决策，GE3 已通过，可以
进入 E4。

## E4 交付与 Gate 记录

- 全部 `/evaluations/*` route 使用 Databench TanStack Router lazy boundary、主导航和 Evaluation 二级导航；
- 浏览器 EvalScope adapter 固定 `/evalscope-api/api/v1`，32 条 allowlist operation 均有 exact
  method/path/query/body/response Zod contract，public config 严格无路径；
- report/performance locator 使用 canonical UTF-8 base64url route key，拒绝绝对路径、遍历、URI、控制字符和
  non-canonical key；route/search params、404、loading、error 和 unavailable 均有稳定边界；
- `.evaluation-surface` 独占 `--es-*` tokens；Tabs/Table/Field/Breadcrumb 与既有 Databench primitives 完成映射；
- 锁定 upstream 的 322 项中英文业务词典按 Evaluation route lazy 注册，locale key drift test 通过；
- capability manifest 的 shell/foundation 五项为 green，E5-E7 的 55 项保持 planned；空 route 明确提示
  业务能力尚未迁移，不以占位页冒充 parity；
- Web 28 files / 88 tests；生产构建 11 个 Evaluation lazy entries，initial JS 844,927 bytes，低于
  950,000-byte budget，Dataset initial graph 不静态包含 Evaluation client/layout/route/full dictionary；
- 浏览器覆盖 ready desktop、390px narrow、disabled gateway、全部 direct refresh、nested 404、中英文切换，
  以及 `/evaluations/performance/compare?embedding=0` reload；ready 路径零 console errors/warnings。

完整证据见 [E4-UI-FOUNDATION.md](evidence/E4-UI-FOUNDATION.md)。全仓 lint/build/typecheck/test/openapi/
v2-status/peers/offline/parity 和 `git diff --check` 均通过；`evalscope:parity:check:green` 按设计继续拒绝
55 个 planned capability。E4 没有改变 runtime disabled-by-default、V16/V17 或公共云 D3。

## E5 交付与 Gate 记录

- Evaluation/Performance tabs 使用 typed URL state；完整表单、upstream defaults、条件字段、first-invalid
  focus 和 payload validation 已落地；
- text+multimodal Benchmark autocomplete 保留手工输入、多值、最多八项、方向键、Enter、Escape 和
  outside-click；native `dataset_args` 保留 raw JSON，服务端 locator admission error 可回到嵌套字段；
- Databench Dataset source 完成 Ref → exact version → inspect eligibility/fidelity → reference target →
  provider re-inspect/export → callback 的闭环；Dataset detail 可直接进入已预选的 Evaluation task；
- task runner 使用 Web Crypto UUID（`randomUUID()` 可用时优先，否则由 `getRandomValues()` 生成同格式
  UUID v4，以兼容受控内网 HTTP）、重复提交保护、invoke/polling AbortController、增量 log、degraded
  state、stop、terminal report 和刷新恢复；服务重启后 persisted terminal 重放，失联任务确定性收敛为
  `provider_interrupted`；
- 报告新标签页只进入 Databench opaque viewer；iframe 固定 `sandbox="allow-scripts"`，Plotly 使用本地固定
  asset、nonce CSP 和 `displaylogo=false`；
- Databench-owned Python provider 已迁到 `workers/evalscope`，与内部 gRPC 的 `workers/python` 同级；
  `deploy/evalscope` 只保留镜像与部署资产；
- 真实 Databench Dataset evaluation、native GSM8K、Performance、cancel、provider interrupt、same-ID
  replay/conflict 均完成；任务 ID、DB 状态与桌面浏览器证据见
  [E5-TASKS-DATASET.md](evidence/E5-TASKS-DATASET.md)；手机版竖屏按 owner 决策不属于 GE5。

最终 `databench-evalscope:e5` image ID 为
`sha256:2081e7e002a833f23d6b72f2f1d892d21702e36be5c1ddf1559648fd4afba5bf`。Gate 通过：

- Python lock check 与 54 tests；Web 30 files / 99 tests；全仓 22/22 test tasks；
- `pnpm lint`（494 files）、`pnpm build`（13/13）、`pnpm typecheck`、`pnpm openapi:check`（11/11）、
  `pnpm v2:status:check`、`pnpm peers check`、`pnpm evalscope:parity:check`、
  `pnpm evalscope:parity:test`（7/7）、`pnpm offline:check` 与 `git diff --check`；
- Web production build 保持 11 个 Evaluation lazy route entries，initial JS 850,200 bytes，低于
  950,000-byte budget。

E5 将 9 个 target capability 置为 green；连同 E4 和两个 brand-shell exclusion，目前为 14 green / 46
planned。E6/E7、runtime disabled-by-default、V16/V17 与公共云 D3 均未改变。

## E6 交付与 Gate 记录

- Reports catalogue 已实现 300ms URL 搜索、筛选、排序、分页、桌面表格/窄 Web 卡片、最多五项选择和
  configured source refresh；refresh 会清除派生筛选与选择并重新读取 provider generation；
- Report detail 已实现 Overview、Details、Predictions，tab/dataset/subset 均由 typed URL state 驱动并支持
  direct refresh；metric 使用原生 scale/precision/direction，只有同质、有界数据才展示 radar；
- Predictions 已实现 Index 跳转、message ID 前缀搜索和高亮、得分预设筛选、上一条/下一条导航，以及
  legacy、structured chat 与 AgentTrace 三种样本形态；
- 富内容支持 Markdown/GFM/KaTeX、按语言加载的代码高亮和复制、媒体、JSON fallback；generated document
  继续只通过 Databench opaque viewer 打开，iframe 精确保持 `sandbox="allow-scripts"`；
- provider schema 采用边界严格、局部宽容的 partial parsing：已知字段维持契约，未知字段和局部异常只降级
  对应区域，不拖垮整份报告；
- 桌面浏览器复用真实 GSM8K 报告验收 catalogue、refresh、三个详情 tab、URL reload、Index/message ID、
  score filters、复制反馈与安全 iframe；页面 console 0 error / 0 warning。手机版竖屏按 owner 决策不属于
  当前 Web gate；完整证据见 [E6-REPORTS-PREDICTIONS.md](evidence/E6-REPORTS-PREDICTIONS.md)。

Gate 通过：

- Web 35 files / 118 tests；全仓 22/22 typecheck tasks 与 22/22 test tasks；
- `pnpm lint`、`pnpm openapi:check`（11/11）、`pnpm v2:status:check`、`pnpm peers check`、
  `pnpm evalscope:parity:check`、`pnpm evalscope:parity:test`（7/7）、`pnpm offline:check` 与
  `git diff --check`；
- Web production build 保持 11 个 Evaluation lazy route entries，initial JS 850,774 bytes，低于
  950,000-byte budget；Reports detail 的富内容依赖不进入 initial graph。

E6 将 16 个 target capability 置为 green；连同 E4/E5 和两个 brand-shell exclusion，目前为 30 green /
30 planned。E7 仍是完整 UI 复刻的唯一 gate；runtime disabled-by-default、V16/V17 与公共云 D3 均未改变。

## E7 交付与 Gate 记录

- Dashboard 已实现 evaluation/performance/去重模型/最近运行四个 KPI、可点击导航、合并 recent feed、
  类型筛选、300ms URL 搜索、分页、刷新以及 partial/welcome/no-data/no-match 状态；
- Evaluation Compare 已实现 URL 恢复的 2–3 slots、Score/Prediction、共同 dataset/subset 交集、metric-native
  图表/表格 fallback、threshold 与每模型 presets、对齐样本分页、Left/Right 键盘导航和单列错误隔离；
- Performance catalogue/detail/runs/requests/compare 已实现搜索排序、最多五项选择、configured refresh、
  provider/protocol、single-run 分支、closed-loop、workload/percentile、50/page request filters、默认
  oldest/newest baseline、URL swap、direction-aware delta、低样本阈值、workload/config diff 和条件图表；
- Benchmark catalogue 已实现 217 条真实配置的五类计数、300ms 搜索、任一标签命中、chips、24/page、
  完整中英文 Markdown 详情、Paper、焦点锁定/Escape/焦点恢复；详情到预选任务作为独立 extension 验收；
- Viewer 继续只读取 opaque generated document，iframe 精确保持 `sandbox="allow-scripts"` 且不含
  `allow-same-origin`；同页和新标签页均不暴露 raw active HTML；
- source manifest 的 183 个文件与 34 个 upstream tests 均闭环到现存 target；capability manifest 的 60 项
  全部 green，58 个非 shell-exclusion ID 全部进入 implemented registry；
- 桌面浏览器使用 1 条真实 evaluation report、3 条 performance report 和 217 个 Benchmark 完成验收；
  Evaluation Compare 因真实 fixture 只有一条报告，浏览器验证不足两条状态，双报告行为由 domain/static
  tests 覆盖且未制造假报告。手机版竖屏按 owner 决策不属于当前 Web gate；完整证据见
  [E7-COMPLETE-UI-PARITY.md](evidence/E7-COMPLETE-UI-PARITY.md)。

Gate 通过：

- Web 42 files / 138 tests，Web typecheck 通过；
- `pnpm lint`、`pnpm build`、`pnpm typecheck`、`pnpm test`、`pnpm openapi:check`、
  `pnpm v2:status:check`、`pnpm peers check`、`pnpm evalscope:parity:check`、
  `pnpm evalscope:parity:check:green`、`pnpm evalscope:parity:test`、`pnpm offline:check` 与
  `git diff --check` 全部通过；
- Web production build 保持 11 个 Evaluation lazy route entries，initial JS 852,543 bytes，低于
  950,000-byte budget；E7 页面与富内容依赖保持 route-level lazy loading；
- 最终桌面浏览器 console 0 error / 0 warning。

E7 只关闭锁定 EvalScope React UI 的完整功能迁移 gate。Runtime 仍 disabled-by-default；结果归档属于 E8，
安全/容量/离线最终集成属于 E9；V16/V17 与公共云 D3 均未改变。

## Swift S4 opaque Deployment 交叉扩展

- [x] Evaluation Dataset source 与 Model source 独立；Model 可选 Manual endpoint 或 Databench Deployment
- [x] Deployment 模式浏览器只提交 `databench_deployment_id`；单测与真实浏览器 request body 均确认无
  `model/api_url/api_key`
- [x] EvalScope 使用独立 service credential 调用固定 Databench internal resolver；只对新 task resolve 一次，
  endpoint policy 仍适用
- [x] task integration schema v2 只持久化 Deployment/Artifact/digest/served model，不持久化 endpoint；
  report/log/document response 使用 task-bound endpoint redaction
- [x] terminal replay 在当前磁盘容量耗尽时仍成功；已有 claim 先 replay，不重复 endpoint/Deployment live
  admission
- [x] Deployment disabled 后新的 Deployment-bound Evaluation Run 返回稳定 422 field error；已有 Run/replay
  与 report lineage 保留
- [x] `evaluation-run-create-v2` 保存 exact Dataset、Deployment、Artifact、Deployment digest；Deployment filter
  cursor 与 Artifact detail lineage UI 已接通
- [x] `Benchmark + Deployment` 明确为 source-less expert/untracked，不创建 Databench Evaluation Run
- [x] Python 60/60、Web/API/Catalog/Workspace 常规 suites、真实 Postgres/MinIO lifecycle、OpenAPI 和浏览器
  opaque payload gate 通过
- [ ] 真实 GPU serving、`/chat/completions` 与模型质量 smoke（Swift GPU gate deferred）

该扩展的唯一允许结论是 `S4 non-GPU contract green / GPU deferred`。E8 结果归档、E9 最终离线集成、
V16/V17 和公共云 D3 均未被关闭。

## E8 交付与 Gate 记录

- 新增 prepare/finalize/fail 三条 evaluation result archive REST；execution 与 archive state 保持独立，
  completed run 不等待归档成功；
- EvalScope provider 使用固定 tar metadata、UTF-8 path 排序和固定 zstd 参数生成 deterministic allowlist
  `tar.zst`，拒绝 credential、绝对/遍历 path、symlink、hardlink 和 oversize；
- staging key 固定为 `staging/evaluations/v1/<run>/<attempt>/result.tar.zst`；15 分钟 signed URL 只允许
  exact-key conditional `PUT`，默认和最大归档均为 1 GiB；
- Workspace 验证 content type、size、BLAKE3 后 conditional-create
  `objects/v2/evaluation-result-v1/<prefix>/<digest>.tar.zst`，PG locator 成功后只删除 exact staging key；
- prepare/finalize 可并发重放；PUT/finalize response loss、412 和 PG failure 均可安全 retry，PG 失败时保留
  staging/immutable orphan 供 finalize repair；
- Web 通过 Databench run 查询独立显示 online available/unavailable 与 archive
  processing/available/failed/unavailable；Dataset version 和 run ID 写入 URL，刷新可恢复；
- online volume、immutable archive、PG locator 的 retention/backup owner 固定在
  [RETENTION.md](RETENTION.md)，完整实现与验证见
  [E8-RESULT-ARCHIVE.md](evidence/E8-RESULT-ARCHIVE.md)。

Gate 通过：

- `pnpm lint`（570 files）、`pnpm build`（13/13）、`pnpm typecheck`（22/22 tasks）、
  `pnpm test`（22/22 tasks）、`pnpm openapi:check`、`pnpm v2:status:check`、`pnpm peers check`、
  `pnpm offline:check` 与 `git diff --check`；
- `pnpm evalscope:parity:check`、`pnpm evalscope:parity:check:green` 和
  `pnpm evalscope:parity:test`（7/7）；Python lock 与 62 tests；
- Store 90/90 真实 MinIO；Workspace 156（10 skipped）、API 101/101、CLI 14/14 真实 Postgres/MinIO；
  Catalog 37/37 真实 Postgres；OSS conditional-presign contract；
- Web production build 保持 11 个 Evaluation lazy route entries，initial JS 853,184 bytes；真实 completed
  Databench task 的 desktop direct-refresh 与 online/archive 状态通过，console 0 error / 0 warning。

E8 不启用 runtime，也不改变 UI parity、V16/V17 或公共云 D3。下一步 E9 只关闭 ADR 0017 的安全、容量、
离线、升级/回滚和最终集成 gate。

## E9 本地交付与待完成 Gate

- EvalScope 增加 authenticated operator status/drain/resume；drain 拒绝新 invoke，但不阻断已有任务的
  progress、log、stop 和 report，离线维护默认等待 300 秒，超时会恢复 admission 并取消维护；
- evaluation/performance 使用独立并发槽，并增加 task runtime、sample/batch/repeat、performance
  parallel/request/rate、model token 和 request timeout 上限；所有可配置值另受编译期 ceiling 约束；
- ADR 0012 离线包扩为七镜像，EvalScope 使用 pinned backend-only `linux/amd64` image、Compose 私网
  `evalscope:9000`、无宿主机端口、无 GPU、只读根、4 CPU、12 GiB 和 1024 PIDs；通用部署继续
  disabled-by-default，只有可信内网离线 profile 设置 `offline_runtime_enabled: true`；
- install/backup/restore/restart/upgrade/rollback 纳入稳定 `evalscope.env`、HMAC/operator secrets、
  PostgreSQL + MinIO + EvalScope outputs/inputs 一致备份，以及旧五/六镜像 release 回滚兼容；备份拒绝
  symlink、hardlink 和特殊文件，恢复前拒绝 traversal、重复路径、links、错误根与非普通成员；
- exact browser gateway 继续阻断 operator route、EvalScope root/static SPA、resume/scan 和未知 upstream
  endpoint；public config 保持 path-free，Plotly 继续使用本地固定 digest；
- operator、故障处理、容量、断网部署和 upstream source/API/UI compatibility matrix 已形成 runbook。

本地验证结果与目标机缺口见
[E9-SECURITY-CAPACITY-RELEASE.md](evidence/E9-SECURITY-CAPACITY-RELEASE.md)。当前 E9
`implementation=complete`；owner 于 2026-07-29 批准在 GE9 目标机证据未补齐时先合并，并自行执行真实
断网安装验证，因此 gate 记录为 `owner_deferred_target` 而不是 passed。该状态不完成 V16/V17，也不解除
公共云 D3。

## 2026-07-30 Evaluation 链路修复

针对 `Databench Dataset → general_qa → OpenAI-compatible model → report/run` 的实际内网测评，已在
`feat/evalscope-evaluation-fixes` 实现以下修复：

- `reasoning_tokens=null` 在 Web 渲染边界兼容，不再导致整个 Predictions 响应校验失败；
- EvalScope 完成结果的 metric/category/subset leaf 标准化为 `EvaluationMetricV2`，不再以固定空数组
  complete Databench run；
- 普通评测默认关闭 `analysis_report`，避免完成 benchmark 后产生额外模型调用；
- Judge 指标实现前，产品 UI 和 provider admission 都拒绝无参考答案评测；converter/历史 artifact
  兼容能力不删除；
- Predictions 改为每页 50 条的服务端分页，响应携带全量 Above/Below/All 计数，保留跨页导航和
  index/message-ID 定位；Compare 按有界分页读取完整对齐数据；
- Evaluation 默认 `limit` 留空表示全量，inspect 后明确显示 eligible sample count；request timeout
  默认从 60 秒调为 300 秒；
- Databench report 增加独立 `source_ref + exact dataset version + general_qa benchmark` 元数据，列表和
  详情不再把内部 benchmark 名当成业务数据集名；native report 保持原展示。

本轮只执行评测链路定向验证：EvalScope Worker `test_app.py` 17 tests、Databench/storage 19 tests、
Web Evaluation 85 tests、API gateway 7 tests和 Web/API typecheck 通过；downstream patch dry-run 通过。
尚未把这些结果声明为新的 GE9/离线目标机 gate，也未执行新镜像的真实内网模型回归。
