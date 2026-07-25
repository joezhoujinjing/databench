# Databench v1 持久化退役 Runbook（R4）

> 本流程不可逆。它只适用于 ADR 0013 已完成 R1-R3、所有 v1 应用读写入口均已停止的环境。
> 应用启动和普通请求不会触发本流程。

## 1. 安全边界

R4 只清理：

- Postgres：`datasets`、`runs`、`refs`、`vocabularies`、`vocab_refs`；
- 对象存储：
  - `objects/<vv>/<64hex>.parquet`
  - `objects/<vv>/<64hex>.manifest.json`
  - `vocabularies/<vv>/<64hex>.json`

工具明确排除 `objects/v2/`。对象 key 必须通过上述精确 parser，前缀下无法识别的 key 只报告、
不删除，并阻断“清理完成”验收。

R4 不迁移或映射 v1 数据。需要保留的数据必须在操作前独立导出或备份。

## 2. 前置条件

1. 已部署或准备部署 R3 的 v2-only 应用代码；
2. 停止所有仍可能写入 v1 表或 legacy object key 的旧实例、CLI 和任务；
3. 备份 Postgres 和对象存储，或由 operator 明确接受放弃 v1 数据；
4. 在同一终端配置目标环境的 `DATABASE_URL` 与 `DATABENCH_OBJECT_STORE`：
   - S3/MinIO：`S3_ENDPOINT`、`S3_REGION`、`S3_BUCKET`、credentials、path style；
   - OSS：`OSS_REGION`、`OSS_BUCKET`、credentials 与可选 endpoint；
5. 确认这些变量指向待退役的唯一 trusted workspace，不能对未确认的 bucket/database 执行。

## 3. 只读 preflight

```bash
pnpm install
pnpm v1:retire preflight \
  --output .databench-maintenance/v1-retirement-preflight.json
```

preflight 使用 repeatable-read 扫描并输出：

- 每张 v1 表是否存在、行数、BLAKE3内容digest、供migration锁内重核的内容checksum、外键和估算大小；
- 每个可删除 legacy object 的完整 key、size、ETag、总数和总 bytes；
- 无法识别的 legacy-prefix objects；
- 受保护的 `objects/v2/` 数量；
- 九张 v2 catalog 表的内容 fingerprint；
- `objects/v2/` 精确 key/size/ETag；
- 对全部已登记 v2 dataset 执行真实 manifest/artifact/Parquet/record/version audit；
- database digest、object digest 与 v2 baseline digest。

若任意已登记 v2 dataset 审计失败，preflight 会继续审计其余 dataset，一次性报告全部失败的
dataset version、错误类型、reason 与非敏感 detail；命令失败、不写 manifest，也不允许进入任何
删除步骤。不得通过放宽 v2 schema 或跳过 dataset 来绕过此门。

manifest 权限为 `0600`，默认目录已加入 `.gitignore`。不要把 manifest 提交到 Git 或复制到不受信
位置。若目标文件已存在，工具会拒绝覆盖，避免混用两次扫描。

必须人工检查：

```bash
jq '{
  database_rows: .database.total_rows,
  database_digest: .database.digest,
  object_count: .objects.target_count,
  object_bytes: .objects.target_bytes,
  object_digest: .objects.digest,
  unrecognized: (.objects.unrecognized_legacy_prefix_objects | length),
  protected_v2: .objects.protected_v2_object_count,
  v2_baseline: .v2_baseline.digest
}' .databench-maintenance/v1-retirement-preflight.json
```

若 `unrecognized` 不为 `0`，暂停并调查；不得扩大 parser 或用 `objects/` 递归删除绕过。

## 4. 数据库退役

### 4.1 非空 v1 表

只有在 operator 已备份或明确放弃 manifest 中列出的行后，使用原样复制的 database digest：

```bash
pnpm v1:retire approve-database \
  --manifest .databench-maintenance/v1-retirement-preflight.json \
  --confirm-digest <database-digest>
```

该命令重新扫描数据库。内容或行数发生变化时 digest 不一致，命令会失败且不会删除数据。
确认成功只写入一次性 approval row，不删除表。

随后运行 forward migration：

```bash
pnpm exec prisma migrate deploy
```

`0005_retire_v1_catalog` 会取得五张表的 `ACCESS EXCLUSIVE` 锁，再次核对 approval 中的行数和
内容checksum，然后按外键顺序删除五张 v1 表并删除 approval table。没有approval、行数改变或
等行数内容改变的非空数据库都会fail-closed。

如果有人在未 preflight/approve 的情况下先运行 migration，Prisma 会记录失败 migration。
停止操作，完成上述确认后，按 Prisma 标准流程将该 migration 标记为 rolled back，再重新 deploy；
不要使用 `--applied` 绕过 SQL：

```bash
pnpm exec prisma migrate resolve --rolled-back 0005_retire_v1_catalog
pnpm exec prisma migrate deploy
```

### 4.2 空 v1 表或 fresh install

当五张表总行数为 `0` 时不需要 approval。Migration 只删除空表；fresh install 会保留历史
migration 链，但最终 schema 只包含 v2 tables。

## 5. 对象退役

只有在 operator 确认 manifest 中的完整 key 清单后，使用原样复制的 object digest：

```bash
pnpm v1:retire delete-objects \
  --manifest .databench-maintenance/v1-retirement-preflight.json \
  --confirm-digest <object-digest>
```

删除前工具会：

1. 重新列出 legacy prefixes；
2. 重算完整清单 digest；
3. 验证 provider、bucket、key、size 与 ETag 未漂移；
4. 对每个 key 再运行精确 legacy parser；
5. 在删除前确认 v2 baseline 与 preflight 相同。

删除使用 manifest 中的精确 keys，不接受 prefix delete。删除后再次扫描，要求已识别 v1 keys 为
零，并重新执行全部 v2 audit；任何 v2 baseline 变化都会失败。

如果 object target count 为 `0`，可以跳过本步骤。

## 6. 最终验证

数据库 migration 和对象清理均完成后：

```bash
pnpm v1:retire verify \
  --manifest .databench-maintenance/v1-retirement-preflight.json
```

成功条件：

- 五张 v1 表全部不存在；
- recognized 与 unrecognized legacy-prefix objects 都为零；
- 九张 v2 catalog 表 fingerprint 与 preflight 一致；
- `objects/v2/` 清单与 preflight 一致；
- 全部 v2 registered layouts 仍通过完整 audit。

随后执行 R5 的全仓、真实依赖、浏览器和离线包 gate。

## 7. 恢复

R4 没有应用级 undo。出现误删只能：

1. 停止新写入；
2. 恢复操作前的 Postgres 备份；
3. 恢复对象存储备份或版本化副本；
4. 重新执行 v2 audit 和 R5 gate。

不要通过重建旧 Prisma model、重新开启 `/v1` 或从 v2 猜测 v1 payload 作为恢复手段。
