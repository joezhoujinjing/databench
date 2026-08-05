# Databench Model Registry 实施状态

> 唯一实施计划见 [PLAN.md](PLAN.md)。状态符号：⬜ 未开始 / 🔄 进行中 / ✅ 完成 / ⛔ 阻塞。

<!-- model-registry-status
current_step: complete
last_completed_step: MR8
capability_enabled: true
runtime_implemented: true
public_network_activation: false
hosted_secret_backend: undecided-d3
gpu_gate: deferred
-->

## 当前检查点

- **工作分支:** `feat/model-registry-mr8`
- **代码基线:** `feat/model-registry-mr7@577618c`
- **当前 Step:** MR0-MR8 complete——Model Registry 计划关闭
- **Owner 范围:** MR2 candidate Alias；MR3 ModelScope + operator-managed；CLI MR2 read/MR8 write；
  一级导航“数据集 / 训练 / 模型 / 测评”
- **Runtime:** MR7 已完成三来源注册、Model 注册表与六 Tab detail、Version detail、exact lineage、可比 Evaluation
  summary、Model → Version → Deployment selector、capability exclusion、archive/restore 与 archived-but-serving
  产品闭环；legacy Evaluation v1-v4 保持不变
- **Capability:** Model Registry 已在已实现的本地/可信内网范围启用；这不包含 public-network activation、
  hosted secret backend、managed serving、Hugging Face runtime、GPU 或 production readiness
- **网络:** ADR 0012 offline 仍禁止 public-network activation；公共云 D3 未决定
- **GPU/V17:** Model Registry 的实施不自动完成 V16/V17；V16 后续已独立通过 GV16，V17 与 GPU gate
  仍未完成

## Step 状态

| Step | 目标 | 状态 | PR / 提交 | Gate | 备注 |
|---|---|---|---|---|---|
| MR0 | 决策、fixtures 与状态基线 | ✅ | `feat/model-registry-mr0` | GMR0 green | 只含 docs/scripts/package gate |
| MR1 | Model/Version identity 与 Catalog | ✅ | `feat/model-registry-mr1` | GMR1 green | internal only；capability false |
| MR2 | Artifact 注册与基础产品面 | ✅ | `feat/model-registry-mr2` | GMR2 green | candidate Alias + CLI read；capability false |
| MR3 | Repository reference 与 evidence | ✅ | `feat/model-registry-mr3` | GMR3 green | ModelScope + operator-managed |
| MR4 | Endpoint/secret 安全底座 | ✅ | `feat/model-registry-mr4` | GMR4 green | legacy network hardening + offline projection |
| MR5 | Existing Service 与 Deployment v2 | ✅ | `feat/model-registry-mr5` | GMR5 green | internal v1/v2 隔离 |
| MR6 | Evaluation v5/v6 | ✅ | `feat/model-registry-mr6` | GMR6 green | v1-v4 identity/read 保持 |
| MR7 | 完整 Model 产品面 | ✅ | `feat/model-registry-mr7` | GMR7 green | 三来源、六 Tabs、selector 与浏览器 gate |
| MR8 | CLI、离线与 Final Gate | ✅ | `feat/model-registry-mr8` | GMR8 green | 不自动完成 V16/V17 |

## Owner 决策

2026-08-04，owner 在技术方案完成领域、产品、安全三路 review 并列明推荐范围后要求“下一步叭”。按上下文
记录为接受 ADR 0019、技术方案与实施计划，并授权进入 MR0；具体范围为：

1. MR2 交付 `candidate` Alias，`staging/production` 后置；
2. MR3 首批启用 ModelScope + operator-managed，Hugging Face 只保留 schema/profile；
3. MR2 交付 CLI list/show，MR8 补 registration/deployment 写操作；
4. 一级导航固定为“数据集 / 训练 / 模型 / 测评”。

2026-08-04，owner 进一步要求“按照实施计划依次的实现吧”，授权在每个 Gate 全绿并单独提交后继续
MR1-MR8。该授权不包含跳 Step、公共云 D3 选型、hosted secret backend、managed serving、GPU gate 或
production readiness。

## GMR0 完成证据

- [x] ADR 0019、技术方案与实施计划状态/范围一致；
- [x] 建立独立 `feat/model-registry-mr0` 分支；
- [x] profile fixture index，共预登记 20 项；
- [x] database shape、endpoint policy、credential registry fixture；
- [x] 当前 S4 legacy public/internal/migration/identity baseline；
- [x] Model Registry status checker 与 8 类负向 tests；
- [x] links/fences/trailing whitespace、lint、v2 status 与 diff gate；
- [x] 最终一致性复核后关闭 GMR0。

2026-08-04 实际通过：

- `pnpm models:status:test`；
- `pnpm models:status:check`；
- `pnpm lint`；
- `pnpm v2:status:check`；
- `git diff --check`。

MR0 不修改 `packages/`、`apps/`、`workers/`、`prisma/`、`deploy/` 或 `openapi.json`。fixtures 只描述后续
契约，不能被解释为 runtime capability 已存在。

## GMR1 完成证据

- [x] 10 个独立 Model Registry identity profile、domain separation 与 UUID v8 fixed vectors；
- [x] 三来源 strict Schema、Inspect/Plan/Commit、敏感文本/path/credential 负向边界；
- [x] 8 张 MR1 表、namespace composite FK、deferred source XOR、metadata/Alias CAS；
- [x] durable registration claim、response-loss replay、digest conflict、并发序列化与 rollback；
- [x] evidence append-only、source classification 与 immutable-only Alias enforcement；
- [x] Artifact/Repository Workspace registration；Existing Service commit 留到 MR5 原子交付；
- [x] fresh PostgreSQL migration 与 S4→MR1 forward migration保留旧 row、constraint 与 fixed vector；
- [x] 真实 PostgreSQL + MinIO Workspace registration integration；
- [x] lint、build、typecheck、test、OpenAPI、Model/V2 status、peer、Prisma 与 diff gates。

2026-08-04 实际通过：

- `RUN_MINIO_STORE_TESTS=true pnpm --filter @databench/workspace test`（185 passed）；
- `pnpm models:migration:check`；
- `pnpm lint`、`pnpm typecheck`、`pnpm build`、`pnpm test`；
- `pnpm openapi:check`、`pnpm models:status:test`、`pnpm v2:status:check`；
- `pnpm peers check`、`pnpm exec prisma format`、`pnpm exec prisma validate`；
- `git diff --check`。

`database-shape.json` 在 GMR1 验证的是完整 additive 设计；其中 adoption、Deployment v2 与 Evaluation v5/v6
仍分别属于 MR2、MR5、MR6，不代表对应 runtime 已实现。

## GMR2 完成证据

- [x] Artifact Inspect/Commit 校验 namespace、kind、format、archive/manifest digest、base binding 与 lineage；
- [x] primary Artifact 唯一约束、同 Artifact/同 Model 换 label conflict 与跨逻辑 Model identity 隔离；
- [x] `candidate` Alias、Model metadata/archive、stable cursor/search/archive/source filter；
- [x] legacy Deployment adoption absent→exact、同目标幂等、异目标 conflict、namespace/Artifact mismatch；
- [x] `/v2/models*`、registration/adoption REST、generated OpenAPI client 与 CLI `model list/show`；
- [x] `/models`、Model/Version detail、Artifact 深链注册向导与中英文响应式产品面；
- [x] Swift bridge 关闭时 Artifact list/show 仍只读 Catalog，不错误依赖 Provider runtime；
- [x] fresh/forward PostgreSQL migration、真实 PostgreSQL + MinIO、全仓与浏览器 gates。

2026-08-04 实际通过：

- `pnpm exec prisma format`、`pnpm exec prisma validate`；
- `pnpm lint`、`pnpm build`、`pnpm typecheck`、`pnpm test`；
- `pnpm openapi:check`、`pnpm models:status:test`、`pnpm models:status:check`、
  `pnpm v2:status:check`；
- `pnpm peers check`、`pnpm models:migration:check`；
- `RUN_MINIO_STORE_TESTS=true pnpm --filter @databench/workspace test`（191 passed / 10 skipped）；
- `git diff --check`；
- Playwright 验证 21 条记录分页、search/source filter、direct refresh、Artifact 深链、四步
  Inspect→Commit、keyboard、中文/English、1440×1000 desktop 与 390×844 narrow layout；新页面
  console 为 0 error / 0 warning。

GMR2 保持 `capability_enabled: false`、`public_network_activation: false` 和 `gpu_gate: deferred`。它不实现
Repository runtime、Existing Service、Deployment v2、Evaluation v5/v6，也不自动完成 V16/V17。

## GMR3 完成证据

- [x] 首批 runtime provider 为 ModelScope + operator-managed；Hugging Face 只保留 schema/profile，未启用
  adapter；
- [x] canonical repository locator、revision kind、独立 `model-source-evidence-v1` domain/digest/UUID 与
  BLAKE3 fixed vector；
- [x] offline declared-only 与 connected bounded resolution；ModelScope exact origin、redirect/credential/
  referrer/cache 关闭，以及 media type/body/depth/node/timeout 限制；
- [x] append-only evidence、semantic replay、revision drift、availability/license/cache 投影与
  `:refresh-source-evidence`；
- [x] initial evidence、Model/Version/source/Alias/claim 同事务，durable replay 不访问 provider；
- [x] operator-managed realpath containment、allowlisted-root no-symlink、`O_NOFOLLOW`、regular-file、inode/
  device/size/mtime race 防护，public projection 不泄漏本地路径或 raw response；
- [x] Repository 注册向导、Version detail、materialize boundary、中英文与响应式 Web；
- [x] fresh/forward PostgreSQL migration、真实 PostgreSQL + MinIO、全仓与浏览器 gates。

2026-08-05 实际通过：

- `pnpm exec prisma format`、`pnpm exec prisma validate`；
- `pnpm lint`、`pnpm build`（initial JS 949955 / 950000 bytes）、`pnpm typecheck`、`pnpm test`；
- `pnpm openapi:check`、`pnpm models:status:test`、`pnpm models:status:check`、
  `pnpm v2:status:check`；
- `pnpm peers check`、`pnpm models:migration:check`、`pnpm offline:check`；
- `RUN_MINIO_STORE_TESTS=true pnpm --filter @databench/workspace test`（200 passed / 10 skipped）；
- `git diff --check`；
- 浏览器验证 ModelScope offline declared-only Inspect→Commit、offline direct refresh typed fail-closed、
  operator-managed provider-verified registration 与 evidence replay refresh、中文/English、1440×1000
  desktop 与 390×844 narrow layout；新页面 console 为 0 error / 0 warning。

GMR3 保持 `capability_enabled: false`、`public_network_activation: false` 和 `gpu_gate: deferred`。它不下载
权重、不创建 Artifact，也不实现 Existing Service、Deployment v2、Evaluation v5/v6 或 hosted secret
backend；MR4 必须先完成 endpoint/secret 安全底座与 legacy network hardening。

## GMR4 完成证据

- [x] TypeScript/Python strict `model-endpoint-policy-v1` parser 与同源 allow/deny fixtures；
- [x] private/public 地址分类、全量 A/AAAA、CIDR + hostname、scheme/port、offline public-network fence；
- [x] Node Undici approved-IP connector 保留 Host/SNI/CA/hostname validation，并复核 remote socket address；
- [x] EvalScope child 在 upstream import 前安装 pinned-address socket guard；OpenAI-compatible sync/async client
  显式关闭 redirect 与 ambient proxy；
- [x] legacy Deployment health 移除 raw `fetch`，Workspace 改为注入受控 health client，缺省 deny-all；
- [x] redirect/auth、proxy、header smuggling、slow header/body、compression bomb、JSON depth/node/model count与
  compressed/decompressed response 上限负测；
- [x] `model-credentials-v1` authority、consumer/Deployment ACL、JIT snapshot、集中 redaction、rotation/
  rollback fence 与 anonymous pipe/FD handoff；
- [x] root-owned authority 不挂容器；隔离 projector 生成 API/EvalScope `0444` 最小 projection，同代内容漂移
  与 generation rollback 均拒绝；
- [x] offline install/upgrade/rollback/backup/restore、encrypted policy/authority escrow、projection reload 与
  Compose mount 静态 smoke；
- [x] legacy public/internal schema、identity、migration 和 replay baseline 未漂移；Hugging Face、Existing
  Service、Deployment v2、Evaluation v5/v6 继续未启用。

2026-08-05 实际通过：

- EvalScope upstream patch dry-run、实际 apply 与 patched Python `py_compile`；
- `pnpm lint`、`pnpm build`、`pnpm typecheck`、`pnpm test`；API 164 passed / 4 skipped，其中 endpoint
  transport 35 passed、credential registry 5 passed；
- `pnpm test:evalscope:python`、`pnpm evalscope:parity:check`；
- `pnpm openapi:check`、`pnpm models:status:test`、`pnpm models:status:check`、
  `pnpm v2:status:check`；
- `pnpm peers check`、`pnpm offline:check`；
- `RUN_MINIO_STORE_TESTS=true pnpm --filter @databench/workspace test`（200 passed / 10 skipped）；
- `git diff --check`。

GMR4 保持 `capability_enabled: false`、`public_network_activation: false` 和 `gpu_gate: deferred`。它不下载
权重、不创建 Artifact，不实现 Existing Service、Deployment v2 或 Evaluation v5/v6，也不自动完成
V16/V17、GE9、GPU 或 production readiness。

## GMR5 完成证据

- [x] Existing Service external model/version reference、declared reference kind 与首个 registered Deployment
  在 registration transaction 中原子提交，durable claim 保存 Deployment locator 并支持 response-loss replay；
- [x] `model-deployment-create-v2` 独立 domain、UUID v8 与 BLAKE3 fixed vector绑定 Version ID、source
  fingerprint、serving route、endpoint scope、credential ref 名和 declared capabilities；
- [x] additive `0018_model_version_deployments_v2` migration保留 `artifact-bound-v1`，增加
  `model-version-v1`、nullable Artifact、Version/source composite FK、profile CHECK、deferred source binding、
  generation snapshot 和 claim locator；fresh/forward PostgreSQL 均通过且 legacy row未改写；
- [x] Artifact source Deployment强制 exact primary Artifact，Repository/Service强制 Artifact null；同 source
  进入两个 Model、相同 endpoint进入不同 Deployment identity不碰撞；
- [x] registered→active双读 generation fence、受控 `/models` discovery、policy/ref撤销 fail-closed、DB-clock
  health/disable 与 offline public-network `registered + unavailable`；healthy discovery不声明 inference compatible；
- [x] nested create/list/activate/check/disable REST 与 public projection不暴露 endpoint、credential ref 或 digest；
  legacy顶层 public/internal v1只读 `artifact-bound-v1`，新 ID稳定404；
- [x] `/internal/v2/model-deployments/{id}:resolve` 使用 service credential、private response、strict三来源 union，
  不进入 OpenAPI且不返回 secret；EvalScope增加对应 strict parser/client，但 Evaluation execution未提前从
  internal v1切换；
- [x] 真实 PostgreSQL + MinIO、受控 fake OpenAI-compatible endpoint、API/OpenAPI、EvalScope Python、offline、
  full workspace与全仓 gates通过。

2026-08-05 实际通过：

- `pnpm exec prisma format`、`pnpm exec prisma validate`；
- `pnpm lint`、`pnpm build`、`pnpm typecheck`、`pnpm test`；
- `pnpm openapi:check`、`pnpm models:status:test`、`pnpm models:status:check`、
  `pnpm v2:status:check`；
- `pnpm peers check`、`pnpm models:migration:check`、`pnpm offline:check`；
- `RUN_MINIO_STORE_TESTS=true pnpm --filter @databench/workspace test`（200 passed / 10 skipped）；
- `pnpm test:evalscope:python`、`pnpm evalscope:parity:check`；
- `git diff --check`。

GMR5 保持 `capability_enabled: false`、`public_network_activation: false` 和 `gpu_gate: deferred`。它不实现
Evaluation v5/v6、不接线 Model selector、不启用 Hugging Face adapter或 hosted secret backend，也不自动完成
V16/V17、GE9、GPU 或 production readiness。

## GMR6 完成证据

- [x] `evaluation-run-create-v5/v6` 独立 domain/profile、RFC 8785/BLAKE3 fixed vectors，分别绑定 benchmark
  default metrics 与 explicit canonical metrics；
- [x] additive `0019_model_version_evaluations_v2` migration 增加 Model/Version/Deployment digest、nullable
  Artifact、source mutability/verification/evidence snapshot 与 DB observation time；三组新 composite FK、复用
  Artifact↔Deployment exact FK、profile CHECK 和 deferred source-binding trigger 均由 fresh/forward PostgreSQL
  验证；
- [x] Workspace public request 只接受 opaque Deployment ID，并补齐 Artifact、Repository、Service 三来源 exact
  identity；Artifact 强制 immutable/content_verified，Repository/Service 强制 nullable Artifact 与有时间的
  observation；provider_verified 保存 exact evidence digest；
- [x] PostgreSQL 负测拒绝 Model↔Version、Version↔Deployment↔digest、Artifact↔Deployment 和 source snapshot
  任一错配；v1-v4 row、FK、identity 与 read projection 不改写；
- [x] EvalScope live admission 固定为 validate/digest → atomic claim → replay → capacity/drain → internal v2
  resolve once → endpoint policy → credential JIT resolve → provider；claim 后失败写 typed terminal，terminal replay
  不读取当前 Registry、Deployment lifecycle、capacity、endpoint 或 credential；
- [x] bearer secret 只经 anonymous FD 与 `multiprocessing.reduction.DupFd` 进入 spawn child memory；
  `auth_profile=none` 不发送 FD header，argv/environment/task claim/manifest/response/archive 均不含 secret；
- [x] public REST/OpenAPI/generated Web client 发布 v5/v6 response lineage；browser create request不发布 endpoint、
  served model、credential ref 或 secret；internal v2仍不进入OpenAPI；
- [x] disabled 后 exact provider task replay成功，新 admission拒绝；source-less Benchmark + Deployment继续
  expert/untracked，不伪造Databench Run。

本次实际通过：

- `pnpm exec prisma format`、`pnpm exec prisma validate`；
- `pnpm lint`、`pnpm build`（initial JS 949955 bytes）、`pnpm typecheck`、`pnpm test`；
- `pnpm openapi:check`、`pnpm models:status:test`、`pnpm models:status:check`、
  `pnpm v2:status:check`；
- `pnpm peers check`、`pnpm models:migration:check`、`pnpm offline:check`；
- `RUN_MINIO_STORE_TESTS=true pnpm --filter @databench/workspace test`（201 passed / 10 skipped）；
- `pnpm test:evalscope:python`、`pnpm evalscope:parity:check`、upstream patch dry-run；
- `git diff --check`。

GMR6 保持 `capability_enabled: false`、`public_network_activation: false` 和 `gpu_gate: deferred`。它不实现
MR7完整Model详情/lineage/comparable Evaluation summary/selector/browser gate，不启用Hugging Face adapter或
hosted secret backend，也不自动完成V16/V17、GE9、GPU或production readiness。

## GMR7 完成证据

- [x] `/models` 一级导航、stable cursor、搜索与 source/mutability/verification/task/artifact/alias/
  deployment/archive/tags 筛选；Catalog bounded summary 不读取 Artifact object 或 Evaluation report；
- [x] Artifact、ModelScope offline declared-only、operator-managed provider-verified immutable 与 Existing
  Service 三来源注册向导，支持 create Model、add Version、activation handoff、digest mismatch 零写入与 typed
  `model_key_conflict` 恢复；
- [x] Model detail 六 Tabs（概览、版本、产物、测评、部署、血缘）、Version direct refresh、typed `not_found`、
  Artifact→Model、Model→Evaluation 与 historical adoption exact 导航；
- [x] 最近一次可比评测按 Benchmark/Dataset/Metric/output/time/reproducibility 分组；不存在全局“关键分数”，
  mutable/unknown observation 不进入不可比较的聚合或受保护 Alias；
- [x] Evaluation selector 固定 Model → Version → active + available Deployment，并显式排除 disabled、unavailable
  与 context/output budget capability mismatch；registered + unavailable 显示完整 exclusion reason；
- [x] verified、declared、healthy、compatible、evaluated 与 GPU validated 状态语义隔离；归档 Model 继续服务时
  显示告警，Restore Model 使用 CAS/幂等 action 且不改变原 Deployment row、lifecycle、availability 或 health；
- [x] REST/OpenAPI/generated Web client、operator auth、Schema/Catalog/Workspace/API/Web 回归与中英文文案同步；
- [x] 真实 PostgreSQL + MinIO、ModelScope/operator-managed/fake Existing Service/fake EvalScope、桌面与窄屏真实
  浏览器、direct refresh、keyboard/a11y、中文/English 和 console gate 通过。

本次实际通过：

- `pnpm exec prisma format`、`pnpm exec prisma validate`；
- `pnpm lint`、`pnpm build`（initial JS 927829 bytes，11 lazy route entries）、`pnpm typecheck`、`pnpm test`；
- `pnpm openapi:check`、`pnpm models:status:test`、`pnpm models:status:check`、
  `pnpm v2:status:check`；
- `pnpm peers check`、`pnpm models:migration:check`、`pnpm offline:check`；
- `RUN_MINIO_STORE_TESTS=true pnpm --filter @databench/workspace test`（205 passed / 10 skipped）；
- `pnpm test:evalscope:python`、`pnpm evalscope:parity:check`；
- 浏览器验证三来源 registration、create/add Version、activation、digest mismatch、typed conflict、六 Tabs、
  selector exclusion/context budget、archived-but-serving + Restore Model、1440×1000 desktop、390×844 narrow、
  中文/English、a11y 与 console（0 page error / 0 warning）；
- `git diff --check`。

GMR7 保持 `capability_enabled: false`、`public_network_activation: false` 和 `gpu_gate: deferred`。它不实现
MR8 CLI 写操作、完整离线生命周期或 Final Gate，不启用 Hugging Face adapter、hosted secret backend、
managed serving 或 GPU gate，也不自动完成 V16/V17、GE9 或 production readiness。

## GMR8 完成证据

- [x] CLI `model versions`、registration Inspect/Commit 和 Deployment list/activate/check/disable；
- [x] Model list 全量 filter、两级 verb discovery/help 与稳定 typed error/exit；
- [x] registration JSON 128 KiB/depth/duplicate-key/strict schema 边界，stdin 输入和 `0600` 原子 plan 输出；
- [x] 原 strict request + expected digest Commit、digest mismatch 零写入和 response-loss durable replay；
- [x] 离线 API/CLI 同 request 完整 plan 对拍、Commit replay、locator 对拍与 repository-only 无 Deployment；
- [x] `databenchctl model` 使用 `docker compose exec -T` 保留 stdin，不把 request/secret 放入 argv；
- [x] Model Registry operator guide、ADR 0019、技术方案与状态进入完整 bundle，并由增量 release 保留；
- [x] offline policy/projection/backup/restore/upgrade/rollback 静态与合成 release gates保持；
- [x] package DAG、OpenAPI、legacy Evaluation v1-v4、public/internal v1/v2 和 Model security 边界未漂移；
- [x] final review 未发现 blocker/major；MR8 未修改 Web，MR7 浏览器证据保持适用。

2026-08-05 实际通过：

- `pnpm exec prisma format`、`pnpm exec prisma validate`、`pnpm models:migration:check`；
- `pnpm test:evalscope:python`、`pnpm evalscope:parity:check`；
- `pnpm lint`、`pnpm build`（initial JS 927829 bytes）、`pnpm typecheck`、`pnpm test`；
- `pnpm openapi:check`、`pnpm models:status:test`、`pnpm models:status:check`、
  `pnpm v2:status:check`、`pnpm peers check`、`pnpm offline:check`、`git diff --check`；
- `RUN_MINIO_STORE_TESTS=true pnpm --filter @databench/workspace test`（205 passed / 10 skipped）；
- `RUN_MINIO_STORE_TESTS=true pnpm --filter @databench/cli test`（20 passed）；
- 隔离 PostgreSQL schema + 真实 MinIO + 真实 API + `/api` gateway + 正式 CLI 执行
  `deploy/offline/smoke/model-registry.mjs`，完整 lifecycle proof 通过。

本机没有完整八镜像离线 release，因此没有新增真实 Ubuntu 22.04 amd64 断网 install/upgrade/rollback
证据；该目标机证据继续属于既有 GE9 pending，不伪造为通过，也不阻止 Model Registry 的代码、契约和
可执行 lifecycle final gate 收口。打包 CLI 的 `activate/check` 在未注入 API endpoint security runtime 时
保持 fail closed；离线 operator 使用 Web/API runtime 执行受 policy/credential/generation 保护的动作，
不得绕过安全 transport。

GMR8 后 `capability_enabled: true` 只表示 ADR 0019 的 Model Registry 计划在已实现本地/可信内网范围完成。
`public_network_activation: false`、`hosted_secret_backend: undecided-d3` 和 `gpu_gate: deferred` 保持；不启用
Hugging Face runtime、managed serving 或 Model Registry MCP tools，也不自动完成 V16/V17、GE9 或
production readiness。
