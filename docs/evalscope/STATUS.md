# EvalScope 集成实施状态

> 每个 E Step 完成后更新真实状态、提交与 gate。唯一实施计划见 [PLAN.md](PLAN.md)。

<!-- evalscope-status
current_step: E2
last_completed_step: E1
runtime_enabled: false
ui_routes_enabled: false
upstream_commit: b2a62f05fd81e89ec2cf4f83b9a79ce0a5535d60
-->

## 当前检查点

- **当前分支:** `feat/evalscope-integration-design`
- **当前 Step:** E2 Evaluation Run 控制面；尚未开始修改 Prisma/runtime
- **已完成:** E0 决策/来源/能力基线；E1 `evalscope-general-qa@1.0.0` projection
- **产品状态:** 没有 `/evaluations/*` 路由，没有 EvalScope service/image，capability 保持 disabled
- **GE7:** `pnpm evalscope:parity:check:green` 按设计保持失败；60 个 capability 均为 `planned`
- **既有状态:** V15 complete、V16 current；本集成没有改变 V16/V17 或公共云 D3

## Step 状态

| Step | 目标 | 状态 | Gate | 备注 |
|---|---|---|---|---|
| E0 | 决策、来源与 capability parity 基线 | ✅ | GE0 | 183 source files、34 upstream tests、60 capabilities、31 upstream routes |
| E1 | `evalscope-general-qa` projection | ✅ | GE1 | 三种 profile fixed bytes；真实 exact Dataset export |
| E2 | Evaluation run 控制面 | ⬜ 当前 | GE2 | 下一步；run schema、migration、transition |
| E3 | backend-only EvalScope 与安全 gateway | ⬜ | GE3 | |
| E4 | Evaluation UI foundation | ⬜ | GE4 | |
| E5 | Tasks 与 Databench Dataset 闭环 | ⬜ | GE5 | |
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
