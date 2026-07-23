# Databench v2 实施状态

> 每个 Step 完成后更新：状态（⬜ 未开始 / 🔄 进行中 / ✅ 完成 / ⛔ 阻塞）、PR/提交、
> gate结果与备注。唯一实施计划见 [PLAN.md](PLAN.md)。

<!-- v2-status
current_step: V10
last_completed_step: V9
capability_enabled: false
-->

## 当前检查点

- **当前分支:** `feat/v2-implementation`
- **下一步:** V10 — Transform、Run Cache 与 Lineage
- **Capability:** 保持关闭；GV-final 后仍需 owner 单独确认开启
- **数据边界:** v2 不与旧 Python golden 对拍，不修改 `~/Desktop/databench/`

## Step 状态

| Step | 目标 | 状态 | PR / 提交 | Gate | 备注 |
|---|---|---|---|---|---|
| V0 | 状态、fixtures 与防误报门 | ✅ | 当前分支 | GV0 | ADR/技术方案/计划均已接受；fixture index和 CI check已建立 |
| V1 | RFC 8785、raw JSON与 Hashing API | ✅ | 当前分支 | GV1 | RFC/JCS、具名 domains、raw parser 与 fixtures已过闸门 |
| V2 | Canonical Record与 Ajv | ✅ | 当前分支 | GV2 | strict/compatible schema、Ajv与真实 OpenAPI生成已过闸门 |
| V3 | Identity、Claim与 Opaque Revision | ✅ | 当前分支 | GV3 | 7类 strict identity、随机物化、opaque revision与 fixed vectors已过闸门 |
| V4 | Immutable `V2Dataset` | ✅ | 当前分支 | GV4 | eager set、资源准入、working-set估算与错误映射已过闸门 |
| V5 | `record-json-v1`确定性 Parquet | ✅ | 当前分支 | GV5 | REQUIRED schema、固定 writer与双 ABI raw-byte matrix已通过 |
| V6 | Manifest与 file-backed Store | ✅ | 当前分支 | GV6 | strict manifest、conditional-create provider adapters、受控 temp与流式 file-backed Store已过闸门 |
| V7 | Prisma与 v2 Catalog | ✅ | 当前分支 | GV7 | 九表迁移、并发 claim/lineage、immutable run与 Ref CAS 已过闸门 |
| V8 | Canonical JSONL与共享投影 | ✅ | 当前分支 | GV8 | fixed-byte golden、增量eager admission与资源/取消边界通过 |
| V9 | Workspace publish/read cache/ref | ✅ | 当前分支 | GV9 | 发布顺序、恢复、cache/ref与真实依赖闸门通过 |
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

## V3 Gate 记录

- 7类 strict creation request、allocation draft/RNG单次物化、profile防歧义、digest-only claim
  proposal与 derived revision例外已落地；Catalog/Workspace边界按依赖DAG重新固定；
- `RecordRevisionV2` 使用内部 class private brand，factory执行 defensive clone → strict parse →
  recursive freeze → JCS → digest；compile-time tests拒绝伪造、spread伪造与 snapshot metadata；
- 5组V3 fixtures全部标记为 verified；7类 ID及 claim/request共21个摘要、random direct摘要、
  全字段 record digest/canonical bytes与空 dataset version均经独立 Python `blake3`复算一致；
- hashing 33 tests、schema 139 tests通过；`pnpm v2:status:check`、`git diff --check`、
  `pnpm lint`（288 files）、`pnpm build`（12 tasks）、`pnpm typecheck`（21 tasks）、
  `pnpm test`（21 tasks）与 `pnpm openapi:check`（11 tasks）全部通过。

## V4 Gate 记录

- eager immutable `V2Dataset`只接受 raw canonical records并统一经过 opaque revision factory；
  dataset identity、空集向量、直接 ASCII排序、exact lookup与 defensive pagination已落地；
- 默认100k records / 512 MiB canonical UTF-8 / 16 MiB单条的 inclusive admission已实现，
  count、单条、总量、Unicode、iterator关闭、invalid limits与失败不返回部分 Dataset均有测试；
- working-set estimator使用 safe checked sum，exact budget允许，超预算映射
  `CapacityExceededError`；resource/capacity/integrity已统一映射到 API 413/503/500与 CLI；
- 3条 fixture的 canonical JSON、record digests、UTF-8 bytes与 dataset version已由独立 Python
  `blake3`复算一致；6种 permutation、重复 ID、模拟 digest collision、runtime constructor绕过与
  deep immutability均通过；Engine 28 tests、Schema 140 tests通过；
- Ajv compile budget改按当前 Node worker thread CPU time计量，排除并行调度造成的合法 schema
  假超时，不改变250ms预算及 byte/depth/node/ref限制；
- `pnpm v2:status:check`、`git diff --check`、`pnpm lint`（294 files）、`pnpm build`
  （12 tasks）、`pnpm typecheck`（21 tasks）、`pnpm test`（21 tasks）与
  `pnpm openapi:check`（11 tasks）全部通过。

## V5 Gate 记录

- `nodejs-polars@0.25.1`因 native `rowGroupSize`为 `i16`且无法写出三列 physical
  `REQUIRED` schema被否决；owner接受替换为精确锁定的 `hyparquet-writer@0.16.1`、
  `@bokuweb/zstd-wasm@0.0.27`与 `hyparquet@1.26.1`，`nodejs-polars`继续保留给 v1/计算引擎；
- `record-json-v1`三列固定为 `BYTE_ARRAY + UTF8 + REQUIRED`，PLAIN、ZSTD level 3、
  65,536 rows/row group、1 MiB page、无 statistics/index/dictionary/动态 metadata；writer写完
  fsync后使用同一 file handle第二遍增量 BLAKE3/size，decoder按 row group有界读取并重建全部
  revision/dataset identity，不信任物理 digest列；
- decoder review后补齐 AbortSignal贯穿、fatal UTF-8 typed integrity、footer count分类、
  canonical/physical byte准入、单 inode/file snapshot校验，以及 exact schema/footer/encoding检查；
  最终安全 review再加入无分配 Compact Thrift footer/page预检、严格连续 chunk ranges、三列逐页
  rows/解压累计预算、ZSTD input/output双边界与 handle-based codec API，阻断声明型 OOM及 path ABA；
- 8组 committed raw Parquet golden覆盖 empty、Unicode、低/高 payload vocabulary、1.1 MiB
  record JSON与65,535/65,536/65,537边界；独立 Node worker双写、decode和逐字节比较均通过；
- `darwin-arm64`原生 matrix 8/8通过（68.54s），隔离 Docker `linux-x64-gnu` matrix 8/8通过
  （198.20s，amd64仿真）；CI使用 `ubuntu-latest`与 `macos-15` required matrix并显式核验 ABI，
  非支持/错配平台直接失败而非 skip；
- Engine普通 suite 52 tests、专用 matrix 8 tests通过；`pnpm v2:status:check`登记25组 fixture，
  `git diff --check`、`pnpm lint`（305 files）、`pnpm build`（12 tasks）、`pnpm typecheck`
  （21 tasks）、`pnpm test`（21 tasks）与`pnpm openapi:check`（11 tasks）全部通过。

## V6 Gate 记录

- strict `DatasetManifestV2`、16 KiB canonical manifest边界与layout identity投影已落地；unknown、
  duplicate、malformed、非canonical raw bytes统一按 manifest integrity失败；
- `FileBackedV2Store`实现 artifact-first / manifest-last、opaque prepared handle、可重试cleanup、
  streaming hash/upload/download、同一file handle校验、temp容量预留、stale清理与symlink/inode防护；
- S3/MinIO使用 `If-None-Match: *`且关闭SDK写重试；OSS使用
  `x-oss-forbid-overwrite: true`、关闭写重试，并对曾启用versioning的bucket fail closed；
  created/already-exists/ambiguous/failure四态、fresh probe与最多一次同conditional create重放均有回归；
- 独立review后补齐 OSS `ObjectAlreadyExists`映射、S3本地body error优先级、caller-aborted
  manifest fresh probe，以及双cold-download并行且仅eager decode串行；最终无剩余P0/P1/P2；
- Schema 151 tests、Engine 52 tests、Store普通suite 77 passed / 8 gated skipped、API 23 tests、
  CLI 38 tests通过；真实 MinIO suite 82 passed / 3 OSS-only skipped，覆盖原生 `200/412`、首对象
  不覆盖、两个独立Store并发commit/read与每个V2 PUT均携带条件头；
- `darwin-arm64` Parquet确定性matrix 8/8通过（68.02s）；`pnpm v2:status:check`、
  `git diff --check`、`pnpm lint`、`pnpm build`（12 tasks）、`pnpm typecheck`（21 tasks）、
  `pnpm test`（21 tasks）、`pnpm openapi:check`（11 tasks）与`pnpm peers check`全部通过。

## V7 Gate 记录

- 新增九张独立 v2 表的 additive migration，全部外键显式 `RESTRICT`；digest/ID/profile、
  count/size/position、JSON形状、run ID和 ref name不变量由 raw `CHECK`固定，v1 表与数据未修改；
- namespace/claim使用无 target的 `ON CONFLICT DO NOTHING`并发算法；snapshot/layout、representative
  revision locator、ordered exact parent edges、run及ordered inputs全部write-once，BigInt在Catalog
  边界保持`bigint`；
- lineage registration使用schema-scoped advisory transaction lock和批量 locator/edge/parent compare，
  5000条无parent snapshot按chunk登记；unresolved parent、晚到解析、跨snapshot cycle及并发反向闭环
  均通过；
- Ref create/move使用单写CAS，只允许已提交layout目标；响应丢失重放返回可确认conflict且不改
  timestamp/message；seek分页的查询与索引都固定为C collation；
- 独立review修复完整parent/run-input前缀补写、Prisma model/raw SQL `search_path`分裂，以及JSONB
  `-0`/`0` JCS语义比较；最终review无剩余P0/P1/P2；
- Catalog typecheck、Biome、Prisma validate、`git diff --check`通过；Catalog 20 tests通过，覆盖
  claim双唯一竞态、revision representative、lineage、immutable run、Ref CAS、分页、数据库约束和
  v1 sentinel；
- `pnpm lint`（327 files）、`pnpm build`（12 tasks）、`pnpm typecheck`（21 tasks）、
  `pnpm test`（21 tasks）、`pnpm openapi:check`（11 tasks）、`pnpm peers check`与
  `pnpm v2:status:check`全部通过，capability继续保持关闭。

## V8 Gate 记录

- Canonical JSONL reader按byte-level LF流式分帧，复用duplicate-aware raw parser并严格校验
  `2.0.0` record；合法ID原样保留，writer重算opaque revision后只保留稳定字符串投影，按
  `(record_digest,record_id)` ASCII排序并固定输出尾LF；
- 默认16 MiB单record、depth 128与1 GiB总transport均为inclusive资源门，分别返回带line、
  JSON Pointer和actual的typed 413；合法但非精确`2.0.0`的SemVer返回`unsupported_profile`
  并统一映射API 422 / CLI validation；
- committed input/expected JSONL golden锁定read→write→read digest和输出bytes；覆盖BOM、非法/
  截断UTF-8、duplicate key优先级、CRLF/空行/无尾LF、zero-length/reused chunks、exact/+1、
  iterator关闭以及reader/writer done尾态取消；
- `RecordSummaryV2`与SFT/DPO/RLVR-GRPO eligibility/output count逐项对拍ADR 0009；preview只读
  shared contents，以有界string iterator截取240 Unicode code points，不改写空白；
- `V2Dataset.fromAsyncRecords`提供生产级增量eager admission，JSONL调用方无需先物化完整transport；
  count/canonical/single-record limits、source关闭、取消与同步identity等价均有真实Engine回归；
- 三轮独立review修复双record graph驻留、增量handoff、buffer reuse/chunk放大、资源错误分类、
  done/yield取消竞态与超长preview放大；最终无剩余P0/P1/P2；capability继续保持关闭。
- Schema 160 tests、IO 35 tests、Engine 56 tests、API 23 tests、CLI 38 tests通过；
  `git diff --check`、`pnpm lint`（334 files）、`pnpm build`（12 tasks）、`pnpm typecheck`
  （21 tasks）、`pnpm test`（21 tasks）、`pnpm openapi:check`（11 tasks）、`pnpm peers check`
  与`pnpm v2:status:check`全部通过。

## V9 Gate 记录

- Workspace已实现`addRecords/addJsonl/get/withDataset/describeDataset/getRecordPage/`
  `getRecordView/audit`及refs list/get/put；发布固定为prepare → conditional commit → Catalog
  register → optional Ref CAS，Ref只解析一次并锁定exact version；
- cache使用exact layout key、promise coalescing、lease/pin、byte-weighted LRU、共享cold-load/audit
  semaphore、Store read上限对应的解码前预算及64项bounded pending queue；取消后等待底层操作真正
  settle才释放预算和slot，cache不得跨Workspace复用；
- recovery会严格校验manifest、HEAD、artifact digest、Parquet与dataset identity后补登记；Catalog
  已登记但对象缺失按integrity error处理，cleanup独立于业务signal并重试一次，不掩盖primary error；
- refs cursor使用HMAC-SHA256、namespace scope、canonical base64url、15分钟TTL与长度上限；Ref CAS
  conflict detail明确新dataset已提交且旧Ref保持不变；两个独立Workspace writer真实并发只允许一个
  CAS成功，两个exact version均可读；
- Schema 184 tests、Workspace普通suite 58 passed / 1 real integration skipped；真实MinIO/Postgres
  Workspace suite 59/59通过，每页/view不重复下载Parquet，audit独立cold read、恢复登记与唯一临时
  bucket清理均通过；独立review无剩余P0/P1/P2；
- `pnpm v2:status:check`、`git diff --check`、`pnpm lint`、`pnpm build`、`pnpm typecheck`、
  `pnpm test`、`pnpm openapi:check`、`pnpm peers check`全部通过；capability继续保持关闭。
