# Databench v2 实施状态

> 每个 Step 完成后更新：状态（⬜ 未开始 / 🔄 进行中 / ✅ 完成 / ⛔ 阻塞）、PR/提交、
> gate结果与备注。唯一实施计划见 [PLAN.md](PLAN.md)。

<!-- v2-status
current_step: V3
last_completed_step: V2
capability_enabled: false
-->

## 当前检查点

- **当前分支:** `feat/v2-implementation`
- **下一步:** V3 — Identity、Claim 与 Opaque Revision
- **Capability:** 保持关闭；GV-final 后仍需 owner 单独确认开启
- **数据边界:** v2 不与旧 Python golden 对拍，不修改 `~/Desktop/databench/`

## Step 状态

| Step | 目标 | 状态 | PR / 提交 | Gate | 备注 |
|---|---|---|---|---|---|
| V0 | 状态、fixtures 与防误报门 | ✅ | 当前分支 | GV0 | ADR/技术方案/计划均已接受；fixture index和 CI check已建立 |
| V1 | RFC 8785、raw JSON与 Hashing API | ✅ | 当前分支 | GV1 | RFC/JCS、具名 domains、raw parser 与 fixtures已过闸门 |
| V2 | Canonical Record与 Ajv | ✅ | 当前分支 | GV2 | strict/compatible schema、Ajv与真实 OpenAPI生成已过闸门 |
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

## V1 Gate 记录

- RFC 8785 official bytes、UTF-16 property order、Unicode/number boundaries与 Python `blake3`
  独立生成的10组 domain hex fixed vectors通过；v1 hashing golden保持不变；
- hashing 29 tests、schema 38 tests通过，覆盖交错 incremental hasher、duplicate key、BOM、
  malformed UTF-8、lone surrogate、unsafe integer、byte/depth limits与 strict Zod body helper；
- `pnpm v2:status:check`、`git diff --check`、`pnpm lint`（258 files）、`pnpm build`
  （12 tasks）、`pnpm typecheck`（21 tasks）、`pnpm test`（21 tasks）、
  `pnpm openapi:check`（11 tasks）全部通过。

## V2 Gate 记录

- ADR 0009 的 strict schemas、完整 normalizer、compatible reader/`UnknownPart` 与全部
  cross-field invariants已落地；3 组 V2 fixtures均标记为 verified；
- Tool Draft 2020-12 validator覆盖递归 local `$ref`/`$dynamicRef`、external/unresolved ref、
  schema/instance预算、安全正则与有界编译缓存；
- review 后补齐已知 Part compatible校验、RFC 3339 纳秒保真、完整日历校验、BCP-47
  grandfathered/private-use tag、signed URI和开放 JSON credential边界；
- schema 126 tests、API真实 `OpenAPIHono` component生成测试通过；
- `pnpm v2:status:check`、`git diff --check`、`pnpm lint`、`pnpm build`、`pnpm typecheck`、
  `pnpm test` 与 `pnpm openapi:check` 全部通过。
