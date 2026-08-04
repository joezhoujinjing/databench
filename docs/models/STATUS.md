# Databench Model Registry 实施状态

> 唯一实施计划见 [PLAN.md](PLAN.md)。状态符号：⬜ 未开始 / 🔄 进行中 / ✅ 完成 / ⛔ 阻塞。

<!-- model-registry-status
current_step: MR1
last_completed_step: MR0
capability_enabled: false
runtime_implemented: false
public_network_activation: false
hosted_secret_backend: undecided-d3
gpu_gate: deferred
-->

## 当前检查点

- **工作分支:** `feat/model-registry-mr0`
- **代码基线:** `main@b8167b7`
- **当前 Step:** MR1——尚未开始；需单独进入 Model/Version identity 与 Catalog 实施
- **Owner 范围:** MR2 candidate Alias；MR3 ModelScope + operator-managed；CLI MR2 read/MR8 write；
  一级导航“数据集 / 训练 / 模型 / 测评”
- **Runtime:** 未实现；当前仍是 ADR 0018 的 Artifact-bound S4
- **Capability:** 未启用；不得出现 `/models`、新 REST、Prisma 表或 internal v2 的完成声明
- **网络:** ADR 0012 offline 仍禁止 public-network activation；公共云 D3 未决定
- **GPU/V16/V17:** 状态不变，均不因 MR0 文档与 fixture 完成而转绿

## Step 状态

| Step | 目标 | 状态 | PR / 提交 | Gate | 备注 |
|---|---|---|---|---|---|
| MR0 | 决策、fixtures 与状态基线 | ✅ | `feat/model-registry-mr0` | GMR0 green | 只含 docs/scripts/package gate |
| MR1 | Model/Version identity 与 Catalog | ⬜ | | GMR1 | 不得提前实现 |
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

该授权不包含 MR1+ 提前实施、公共云、hosted secret backend、managed serving、GPU gate 或
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
