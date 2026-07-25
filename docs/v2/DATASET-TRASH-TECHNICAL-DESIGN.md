# 数据集回收站技术方案

- **状态:** Accepted——owner 于 2026-07-25 确认采用可恢复回收站
- **规范依赖:** [ADR 0014](../decisions/0014-recoverable-dataset-trash.md)
- **实现基线:** `main` at `258baca`

## 1. 范围

本 Step 交付 Ref 软删除、回收站发现和恢复的完整 Catalog → Workspace → REST/CLI/Web 纵向链路。

不做：snapshot/catalog cascade、object delete、retention、自动过期、legal hold、destructive
redaction 或 prefix delete。

## 2. 数据模型

`refs_v2` additive 增加：

```prisma
deletedAt DateTime? @map("deleted_at") @db.Timestamptz(6)
```

现有 `(namespace_id, name)` 主键与 `version` 外键保持不变，因此回收站中的名称仍被保留，底层
snapshot 仍受 `ON DELETE RESTRICT` 保护。Migration 只增加 nullable column，不改写现有行。

## 3. 状态机

删除输入固定为 `(namespace, name, expected_version)`：

| 当前状态 | 当前版本 | 结果 |
|---|---|---|
| active | expected | 原子设置 `deleted_at`，`deleted` |
| trashed | expected | 不改时间，`already_deleted` |
| active/trashed | other | `409 ref_state_conflict` |
| missing | — | `404 not_found` |

恢复使用相同 CAS 输入：

| 当前状态 | 当前版本 | 结果 |
|---|---|---|
| trashed | expected | 原子清空 `deleted_at`，`restored` |
| active | expected | `already_active` |
| active/trashed | other | `409 ref_state_conflict` |
| missing | — | `404 not_found` |

Catalog mutation 在单个 transaction 内锁定目标行、比较版本并更新。Ref move/create 只允许 active
目标；同名 trashed Ref 返回 conflict，不隐式恢复。

## 4. 契约

```text
GET    /v2/refs                         active Ref page
GET    /v2/deleted-refs                 trashed Ref page
DELETE /v2/refs/{name}                  body { expected_version }
POST   /v2/refs/{name}:restore          body { expected_version }
```

回收站 cursor 使用独立签名 scope，不能拿 active Ref cursor 跨面读取。删除响应包含
`DeletedRefMetadataV2`，恢复响应包含 `RefMetadataV2`。所有响应继续使用 private/no-store、request
ID 与统一 typed error envelope。

CLI：

```text
databench ref trash
databench ref delete <name> --expected-version <version> | --use-current
databench ref restore <name> --expected-version <version> | --use-current
```

Web 数据集页提供“数据集 / 回收站”切换；删除需二次确认，恢复使用回收站行中锁定的 exact
version。成功后同时失效 active 与 trash query，不清 immutable exact-version cache。

## 5. Gate

- Schema strict request/result/error tests；
- 真实 Postgres migration、active/trash pagination、CAS delete/restore/race tests；
- Workspace mapping 与 active resolution isolation tests；
- API OpenAPI/client regeneration 与 HTTP lifecycle；
- CLI catalog/behavior tests；
- Web delete confirmation、trash discovery、restore与 query isolation tests；
- `pnpm lint`、`pnpm build`、`pnpm typecheck`、`pnpm test`、`pnpm openapi:check`、
  `pnpm v2:status:check`、`git diff --check`。
