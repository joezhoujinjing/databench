# Databench Model Registry 实施状态

> 唯一实施计划见 [PLAN.md](PLAN.md)。状态符号：⬜ 未开始 / 🔄 进行中 / ✅ 完成 / ⛔ 阻塞。

<!-- model-registry-status
current_step: MR2
last_completed_step: MR1
capability_enabled: false
runtime_implemented: true
public_network_activation: false
hosted_secret_backend: undecided-d3
gpu_gate: deferred
-->

## 当前检查点

- **工作分支:** `feat/model-registry-mr1`
- **代码基线:** `feat/model-registry-mr0@16afe17`
- **当前 Step:** MR2——待在 GMR1 提交后单独进入 Artifact 注册与基础产品面实施
- **Owner 范围:** MR2 candidate Alias；MR3 ModelScope + operator-managed；CLI MR2 read/MR8 write；
  一级导航“数据集 / 训练 / 模型 / 测评”
- **Runtime:** MR1 内部 Model/Version identity、Schema、Catalog 与 Workspace registration 已实现；现有产品面仍是
  ADR 0018 的 Artifact-bound S4
- **Capability:** 未启用；MR1 没有开放 `/models`、新 REST、Web、CLI 或 internal v2
- **网络:** ADR 0012 offline 仍禁止 public-network activation；公共云 D3 未决定
- **GPU/V16/V17:** 状态不变，Model Registry 的实施不自动完成 V16/V17，也不打开 GPU gate

## Step 状态

| Step | 目标 | 状态 | PR / 提交 | Gate | 备注 |
|---|---|---|---|---|---|
| MR0 | 决策、fixtures 与状态基线 | ✅ | `feat/model-registry-mr0` | GMR0 green | 只含 docs/scripts/package gate |
| MR1 | Model/Version identity 与 Catalog | ✅ | `feat/model-registry-mr1` | GMR1 green | internal only；capability false |
| MR2 | Artifact 注册与基础产品面 | ⬜ | | GMR2 | candidate Alias + CLI read |
| MR3 | Repository reference 与 evidence | ⬜ | | GMR3 | ModelScope + operator-managed |
| MR4 | Endpoint/secret 安全底座 | ⬜ | | GMR4 | 包含 legacy network hardening |
| MR5 | Existing Service 与 Deployment v2 | ⬜ | | GMR5 | internal v1/v2 隔离 |
| MR6 | Evaluation v5/v6 | ⬜ | | GMR6 | 不改历史 identity |
| MR7 | 完整 Model 产品面 | ⬜ | | GMR7 | 浏览器与 selector gate |
| MR8 | CLI、离线与 Final Gate | ⬜ | | GMR8 | 不自动完成 V16/V17 |

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
