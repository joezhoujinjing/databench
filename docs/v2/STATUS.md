# Databench v2 实施状态

> 每个 Step 完成后更新：状态（⬜ 未开始 / 🔄 进行中 / ✅ 完成 / ⛔ 阻塞）、PR/提交、
> gate结果与备注。唯一实施计划见 [PLAN.md](PLAN.md)。

<!-- v2-status
current_step: V1
last_completed_step: V0
capability_enabled: false
-->

## 当前检查点

- **当前分支:** `feat/v2-implementation`
- **下一步:** V1 — RFC 8785、raw JSON 与 Hashing API
- **Capability:** 保持关闭；GV-final 后仍需 owner 单独确认开启
- **数据边界:** v2 不与旧 Python golden 对拍，不修改 `~/Desktop/databench/`

## Step 状态

| Step | 目标 | 状态 | PR / 提交 | Gate | 备注 |
|---|---|---|---|---|---|
| V0 | 状态、fixtures 与防误报门 | ✅ | 当前分支 | GV0 | ADR/技术方案/计划均已接受；fixture index和 CI check已建立 |
| V1 | RFC 8785、raw JSON与 Hashing API | ⬜ | | GV1 | 下一步 |
| V2 | Canonical Record与 Ajv | ⬜ | | GV2 | |
| V3 | Identity、Claim与 Opaque Revision | ⬜ | | GV3 | |
| V4 | Immutable `V2Dataset` | ⬜ | | GV4 | |
| V5 | `record-json-v1`确定性 Parquet | ⬜ | | GV5 | |
| V6 | Manifest与 file-backed Store | ⬜ | | GV6 | |
| V7 | Prisma与 v2 Catalog | ⬜ | | GV7 | |
| V8 | Canonical JSONL与共享投影 | ⬜ | | GV8 | |
| V9 | Workspace publish/read cache/ref | ⬜ | | GV9 | |
| V10 | Transform、run cache与 lineage | ⬜ | | GV10 | |
| V11 | Converter registry与 fidelity | ⬜ | | GV11 | |
| V12 | `/v2` API、OpenAPI与 generated client | ⬜ | | GV12 | |
| V13 | `databench v2` CLI | ⬜ | | GV13 | |
| V14 | Web foundation、refs与 record read | ⬜ | | GV14 | |
| V15 | Web ingest/transform/lineage/export | ⬜ | | GV15 | |
| V16 | Recovery、安全与容量 | ⬜ | | GV16 | |
| V17 | Final gate与 capability发布准备 | ⬜ | | GV-final | |

## V0 Gate 记录

- `pnpm v2:status:check`
- Markdown links/fences/trailing-whitespace检查
- `git diff --check`
- `pnpm lint`
- `pnpm build`
- `pnpm typecheck`
- `pnpm test`
- `pnpm openapi:check`

结果（2026-07-23）：status check通过并登记25组 fixtures；lint 243 files、build 12 tasks、
typecheck 21 tasks、test 21 tasks、OpenAPI check 11 tasks全部通过。首次 test因本地 Postgres未启动
在 migration前失败；按仓库标准执行 `docker compose up -d --wait postgres minio` 后完整重跑通过。
