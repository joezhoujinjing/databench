# EvalScope 集成实施状态

> 每个 E Step 完成后更新真实状态、提交与 gate。唯一实施计划见 [PLAN.md](PLAN.md)。

<!-- evalscope-status
current_step: E5
last_completed_step: E4
runtime_enabled: false
ui_routes_enabled: true
upstream_commit: b2a62f05fd81e89ec2cf4f83b9a79ce0a5535d60
e3_implementation: complete
e3_gate: passed
e4_implementation: complete
e4_gate: passed
-->

## 当前检查点

- **当前分支:** `feat/evalscope-integration-design`
- **当前 Step:** E5 Tasks 与 Databench Dataset 闭环；尚未开始实现
- **已完成:** E0 决策/来源/能力基线；E1 `evalscope-general-qa@1.0.0` projection；E2 Evaluation Run
  控制面；E3 backend-only runtime、安全 gateway 与真实执行闭环；E4 Databench Evaluation UI foundation
- **产品状态:** backend-only image 与 same-origin gateway 仍 disabled-by-default；`/evaluations/*` 原生
  lazy routes 已开放，但 E5-E7 业务控件尚未迁移，不计为完整复刻
- **GE7:** `pnpm evalscope:parity:check:green` 按设计保持失败；60 个 capability 中 5 个 green、55 个 planned
- **既有状态:** V15 complete、V16 current；本集成没有改变 V16/V17 或公共云 D3

## Step 状态

| Step | 目标 | 状态 | Gate | 备注 |
|---|---|---|---|---|
| E0 | 决策、来源与 capability parity 基线 | ✅ | GE0 | 183 source files、34 upstream tests、60 capabilities、31 upstream routes |
| E1 | `evalscope-general-qa` projection | ✅ | GE1 | 三种 profile fixed bytes；真实 exact Dataset export |
| E2 | Evaluation run 控制面 | ✅ | GE2 | exact Dataset binding、canonical create digest、REST 状态机 |
| E3 | backend-only EvalScope 与安全 gateway | ✅ | GE3 | prebuilt image `network=none`、真实 eval/stop/report |
| E4 | Evaluation UI foundation | ✅ | GE4 | routes/client/tokens/i18n/primitives；11 个 lazy entries |
| E5 | Tasks 与 Databench Dataset 闭环 | ⬜ 当前 | GE5 | 下一步 |
| E6 | Reports、Details 与 Predictions | ⬜ | GE6 | |
| E7 | Dashboard、Compare、Performance、Benchmarks、Viewer | ⬜ | GE7 | 完整 UI 复刻唯一 gate |
| E8 | 结果归档与 retention | ⬜ | GE8 | |
| E9 | 安全、容量、离线与最终集成 gate | ⬜ | GE9 | |

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
