# Databench v2 实施状态

> 每个 Step 完成后更新：状态（⬜ 未开始 / 🔄 进行中 / ✅ 完成 / ⛔ 阻塞）、PR/提交、
> gate结果与备注。唯一实施计划见 [PLAN.md](PLAN.md)。

<!-- v2-status
current_step: V16
last_completed_step: V15
capability_enabled: true
capability_owner_decision: owner-approved-2026-07-24
schema_amendment: system-content-2026-07-24
offline_production_release_authorized: true
-->

## 当前检查点

- **当前分支:** `feat/v2-product-cutover`
- **下一步:** 产品切换 R1 已完成并过闸门；按 [CUTOVER-PLAN.md](CUTOVER-PLAN.md) 进入 R2，
  删除 v1 API/CLI 可达面并保持 v2 lifecycle 全绿；V16/V17 仍不开始
- **Capability:** 已按 owner 2026-07-24 明确决定开启；这是对原 V17 顺序的显式发布例外，
  不代表 V16、V17 或 GV-final 已完成
- **离线发布:** owner于2026-07-24明确授权当前`main`直接生成production离线包；V16/V17
  不阻断该离线发布通道，但其未开始状态与gate记录保持真实
- **Schema修订:** owner于2026-07-24确认删除顶层`system_instruction`，改为共享
  `contents[0]`中至多一条、单text且`loss_weight=0`的`system` content；修订前实验数据须迁移重导
- **数据边界:** v2 不与旧 Python golden 对拍，不修改 `~/Desktop/databench/`
- **产品切换:** ADR 0013、产品切换技术方案与第三版视觉稿已于 2026-07-24 接受；
  [CUTOVER-PLAN.md](CUTOVER-PLAN.md) 的 R0、R1 已完成，下一步为 R2

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
| V10 | Transform、run cache与 lineage | ✅ | 当前分支 | GV10 | 五个最小operation、staged identity、run cache race与稳定lineage分页已过闸门 |
| V11 | Converter registry与 fidelity | ✅ | 当前分支 | GV11 | 五种converter、strict inspect/stream、fidelity授权与真实依赖导出已过闸门 |
| V12 | `/v2` API、OpenAPI与 generated client | ✅ | 当前分支 | GV12 | 15个operation、流式multipart、typed errors与真实HTTP lifecycle均已过闸门 |
| V13 | `databench v2` CLI | ✅ | 当前分支 | GV13 | 完整命令面、流式输出、原子文件写入与取消边界已过闸门 |
| V14 | Web foundation、refs与 record read | ✅ | 当前分支 | GV14 | capability gate、session隔离、exact-version读取与完整Unified Record renderer已过闸门 |
| V15 | Web ingest/transform/lineage/export | ✅ | 当前分支 | GV15 | 桌面真实电缆 JSONL 浏览器 E2E 通过 |
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

## V10 Gate 记录

- registry固定`subset`、`sample`、`append-evidence`、`selection-update`与`prompt-rewrite`五个
  operation的name/version、ordered input roles、strict params、identity mode、working-set estimator
  与seed extractor；Mulberry32 uint32、rejection sampling和`2^32`边界均有fixed vectors；
- Workspace在执行前锁定ordered exact inputs、规范化params并派生cache key/run ID；aggregate
  working-set、input count、并发/等待队列和实际output upper-bound均fail closed；cache hit完整验证
  metadata/object，双miss同结果幂等、不同结果触发determinism conflict且不移动Ref；
- preserve/derive身份矩阵、staged claim allocator、exact parent revision、candidate→signal、claim replay、
  失败不污染与record locator/parent edge登记均有回归；mutation payload固定来自第二个immutable dataset，
  不进入params/run row；五个operation及两个mutation output digest/version由golden锁定；
- lineage固定BFS、producing run C-order seek和run input position顺序；proxy-safe cursor只携带root、
  PostgreSQL bigint sequence水位、scope与已发计数。run注册和高水位读取共用transaction advisory lock，
  跨事务未提交run、分页后新增run、cursor tamper/TTL/capacity均通过；`lineage_seq > 0`由数据库约束；
- 独立review修复时间cutoff不等同提交快照、响应数组缺少硬上限、estimator低报、identityMode factory
  漏检、fixture未消费与RNG/operation边界覆盖；最终无剩余P0/P1/P2；capability继续保持关闭；
- Schema 191 tests、Catalog 27 PostgreSQL tests、Ops 15 tests、Workspace普通suite 84 passed /
  2 gated skipped；fresh migration + 真实MinIO/Postgres Workspace suite 86/86通过；
- 全仓并行gate暴露并修复Store双实例初始化清理owner candidate时的`readdir → lstat`消失竞态；
  `ENOENT`按已被并发清理安全跳过，Store 77 passed / 8 gated skipped；
- `pnpm v2:status:check`、`git diff --check`、`pnpm lint`、`pnpm build`、`pnpm typecheck`、
  `pnpm test`、`pnpm openapi:check`、`pnpm peers check`全部通过。

## V11 Gate 记录

- converter registry固定`canonical-jsonl`、TRL SFT/DPO/GRPO-RLVR与ms-swift五种`1.0.0`
  descriptor；options由strict Zod生成JSON Schema，构造时捕获parser并检测schema mutation；
  inspect/stream绑定exact immutable analysis、normalized options、media type与稳定revision set；
- trainer输入按`(record_digest, record_id)`排序；analysis binding使用与dataset identity精确等价的
  incremental BLAKE3，避免保留完整revision signature；输出逐行lazy，不预缓存rows或完整bytes；
- TRL保留tool call ID并按当前dataset contract输出结构化arguments object；ms-swift使用官方
  `tool_call`/`tool_response` roles、JSON-string tools与message loss scale；双source all-fields golden
  锁定五种converter的实际bytes、完整plan、fidelity与output count；
- eligibility、selected/preference direction、loss mask、thought、file、call ID等无法表达的语义均
  进入stable fidelity changes；整条不合格record使用root-level semantic drop，未提供精确
  `fidelity_digest`时拒绝export；reason拒绝嵌入entity ID/digest；
- Workspace提供converter list/get、ref或version inspect与exact-version export；未消费stream不pin
  cache，首次读取才重新acquire exact layout；单次消费、abort/return/throw、pending`next()`、无或
  失败`return()`及cleanup secondary error均保证lease安全释放且不覆盖primary；
- Hashing 35 tests、Schema 201 tests、IO 49 tests、Workspace普通suite 95 passed / 3 gated skipped；
  真实MinIO/Postgres Workspace suite 98/98通过，包含fresh Workspace对持久化dataset执行
  inspect→fidelity授权→exact-version stream；双路独立review最终无剩余P0/P1/P2；
- `pnpm v2:status:check`、`git diff --check`、`pnpm lint`、`pnpm build`、`pnpm typecheck`、
  `pnpm test`、`pnpm openapi:check`、`pnpm peers check`全部通过；capability继续保持关闭。

## V12 Gate 记录

- 14条OpenAPI path / 15个operation全部落地，覆盖canonical JSONL ingest、dataset/record read、
  audit、converter/transform registry、transform run、Refs、bounded lineage、stateless inspect与
  exact-version binary export；Hono action runtime使用严格suffix route，OpenAPI保持锁定contract；
- identity-bearing JSON route全部读取有界raw bytes并拒绝duplicate key；multipart使用真流式
  Busboy parser，file-first、trailing options、backpressure、absence/null语义、request/file/field limit
  与取消清理均有回归；pending raw-body read可被AbortSignal立即打断并取消底层stream；
- 所有request/success/typed error、multipart/binary和response headers由Schema单一来源进入OpenAPI；
  每条route只声明可达错误detail，`X-Request-ID`、private/no-store、nosniff、CORS exposed headers、
  safe Content-Disposition和optional Content-Length同步进入generated client；
- production `V2Workspace.open()`组合Catalog、S3/OSS与file-backed Store；cursor secret启动时fail
  closed，capability从registry/limits单一来源生成且保持`enabled=false`；API继续只依赖Workspace+Schema；
- 独立contract与runtime/security双路review修复untyped error message泄漏、transport abort悬挂、
  OpenAPI错误过宽/漏413、page bounds、raw JSON reason和unsafe Content-Length精度；最终均无剩余
  P0/P1/P2；V12 wire fixture已标记verified；
- Schema 208 tests、API普通suite 68 passed / 1 real integration skipped、Workspace真实
  MinIO/Postgres 107/107通过；真实MinIO/Postgres HTTP ingest→read→audit→transform→lineage→
  inspect→export lifecycle所在API suite 69/69通过；
- `pnpm v2:status:check`、`git diff --check`、`pnpm lint`（383 files）、`pnpm build`（12 tasks）、
  `pnpm typecheck`（21 tasks）、`pnpm test`（21 tasks）、`pnpm openapi:check`（11 tasks）与
  `pnpm peers check`全部通过；capability继续保持关闭。

## V13 Gate 记录

- `databench v2`完整命令面已落地，覆盖 dataset ingest/show/records/audit/export、converter
  list/show、transform list/run、ref list/show/move与lineage show；v1命令表及行为保持不变；
- CLI只依赖Workspace/Schema；JSON/NDJSON/binary严格输出stdout，diagnostics输出stderr；export
  强制inspect-first并锁定exact version，semantic loss必须显式接受精确fidelity digest；
- 文件输出使用同目录`0600`临时文件、fsync与原子rename；失败、取消及cleanup secondary error均有
  稳定诊断与清理，binary TTY拒绝，stdout断管会取消Workspace操作；Ref move要求显式CAS预期；
- API、CLI与Workspace使用同一真实MinIO/Postgres lifecycle fixture，完整version、manifest及export
  plan对拍一致；真实依赖suite 3 files、12/12 tests通过；独立review修复原生异常路径/凭据泄漏、
  cleanup failure和部分manifest/plan比较，最终无剩余P0/P1/P2；V13 fixture已标记verified；
- `pnpm v2:status:check`、`git diff --check`、`pnpm lint`（389 files）、`pnpm build`（12 tasks）、
  `pnpm typecheck`（21 tasks）、`pnpm test`（21 tasks）、`pnpm openapi:check`（11 tasks）与
  `pnpm peers check`全部通过；capability继续保持关闭。

## V14 Gate 记录

- `/v2`独立路由与capability gate已落地，不影响v1；capability状态区分loading、absent、
  disabled、401、403、network与incompatible；连接身份切换会取消并移除旧私有查询，组件本地
  snapshot锁定状态也随`connectionScope`重置；
- refs列表、exact-version数据集详情、虚拟化record摘要与完整record详情已落地；mutable ref首次
  解析后锁定exact version，后台移动只提示，不会把新snapshot混入当前视图；
- Unified Record renderer覆盖所有Part、candidate三态、signal、relation、tools、verification、
  lineage与eligibility；HTML/URI只作纯文本；大JSON走Worker，16 MiB大文本与大型集合采用有界预览、
  渐进挂载及受控下载；tool call coverage按trajectory隔离；integrity error可触发服务端audit并复制
  `X-Request-ID`；
- 独立并行review的问题已集中修复，最终无剩余P0/P1/P2；V14 fixture已标记verified；Web suite
  33 files、74/74 tests通过；
- `pnpm lint`（427 files）、`pnpm build`（12 tasks）、`pnpm typecheck`（21 tasks）、`pnpm test`、
  `pnpm openapi:check`、`pnpm peers check`、`pnpm v2:status:check`与`git diff --check`全部通过；
  capability继续保持关闭。

## V15 Gate 记录

- canonical JSONL上传、可选Ref CAS、五种transform registry与ordered inputs、参数编辑、identity mode、
  Ref 409三种显式恢复、有界lineage及文本等价视图、fidelity inspect/确认和exact-version export均已落地；
- Blob fallback按累计字节限制256 MiB；File System Access流式写入、响应头校验、取消及失败清理均有
  回归；中英文、route focus、表单错误焦点与ARIA名称已覆盖；
- 使用`/Users/hanlu/Desktop/电缆_DEMO_20260723.v2.jsonl`在真实浏览器、本地Postgres与MinIO完成
  ingest→499条records→record detail→sample transform→Ref conflict/recovery→lineage→inspect→export；
  原始数据集版本为`861e37750c029dac5c63eb4222cf43e426c4a720def7183dbedf41f5dde26909`；
- 499条canonical export为1,096,832 bytes，与只读源文件逐字节相同，SHA-256均为
  `2306f60410a478043eaf1263c0e728cda4dd51c6f69a96974e4d9d6105f7d374`；真实浏览器中的
  File System Access写入同样完成1,096,832 bytes并正常close、无abort；11条sample export逐record
  与源文件对应记录完全相同；
- E2E暴露并修复ordered input change handler延迟读取React event导致页面崩溃，以及Vite `/v2`
  proxy吞掉SPA直接刷新；浏览器已验证精确V2 URL刷新返回SPA且API请求仍正确代理；
- 最终Web build通过；Web typecheck通过，suite 39 files、86/86 tests通过；定向Biome检查64 files、
  `pnpm v2:status:check`与`git diff --check`通过；此前V15全仓build、lint、OpenAPI、peers gate均已通过；
- V15代码完成后按owner决定暂停，不进入V16/V17；owner随后于2026-07-24明确要求提前开启
  capability。运行时和Web入口已开启，但V16/V17仍保持未开始，GV16/GV-final不视为通过。

## 2026-07-24 Schema 修订 Gate 记录

- 顶层`system_instruction`已从strict schema、OpenAPI、generated client、转换器、operation投影与
  Web renderer中删除；canonical role扩展为`system | user | ai`，其中`system`至多一条、只能位于
  共享`contents[0]`、必须恰好一个text part且`loss_weight=0`，candidate contents禁止`system`；
- canonical继续使用`ai`，TRL与MS-Swift导出边界统一映射成`assistant`；record preview跳过可选的
  system content，仍优先展示实际用户/AI对话；全部受影响的JSONL、converter、record digest、
  dataset、workspace、Web与8组raw Parquet固定向量已重建；
- 通用迁移脚本`scripts/migrate-v2-system-content.mjs`采用新文件原子落盘，不覆盖输入或既有输出；
  修订前实验性`2.0.0`数据必须迁移重导，record digest与dataset version按新canonical bytes重算；
- 使用`/Users/hanlu/Desktop/电缆_DEMO_20260723.v2.jsonl`迁移并真实HTTP导入499条记录，新文件为
  `/Users/hanlu/Desktop/电缆_DEMO_20260723.v2-system-content.jsonl`，Ref为
  `cable-demo-system-content-20260724`，dataset version为
  `241436cb5a2ee3104ae84c57171cbadceb017cc4ab02846b6e7c472381c715ea`；
- 499条canonical export为1,149,726 bytes，SHA-256为
  `7cb54307a8b2145f1bff42d7103c452f24ea82c68c755479431ee048a5a741bf`；export重新导入后dataset
  version不变，再次export逐字节相同；20条sample Ref为`cable-demo-system-sample-20`，version为
  `fe50d89dc84768d4ab676e3c517b587153c6214acc5eb81bc82dcbf6a1c6cf9e`；
- Schema定向112 tests、Hashing 25 tests、Ops 10 tests、IO 41 tests、Engine 49 tests、
  Workspace定向51 tests、Store 21 tests、API真实HTTP 13 tests与Web renderer 6 tests通过；
  `pnpm typecheck`（21 tasks）、`pnpm openapi:check`（11 tasks）、`pnpm v2:status:check`、
  `pnpm lint`与`git diff --check`通过；V16/V17继续暂停，capability保持开启。

## 2026-07-24 Web 创建体验增补

- Owner 要求 v2 refs 列表像 v1 一样直接显示数据规模；`RefMetadataV2` 增加必填
  `num_records`，Catalog 通过 snapshot 联表一次返回，Web 不为每行追加详情请求；
- v2 导入页增加标准 Record JSON 数组粘贴创建，不提供类型选择；前端保留每个顶层元素的原始
  JSON 切片并转为 JSONL，复用既有 strict multipart ingest，服务端 duplicate-key/schema/identity/
  resource gate不变；
- 本增补不启动 V16/V17，不改变 capability 已开启的 owner 决策，也不增加新的 canonical 格式或
  API 写入端点。
- Gate：Schema 219、Catalog 27、Workspace普通 103 passed / 4 gated skipped、真实
  MinIO/Postgres Workspace 107/107、API 68 passed / 1 gated skipped、Web 91 tests通过；Web production
  build、`pnpm v2:status:check`、`pnpm lint`（455 files）、`pnpm typecheck`（21 tasks）、
  `pnpm test`（21 tasks）、`pnpm openapi:check`（11 tasks）、`pnpm peers check`与
  `git diff --check`全部通过。

## 2026-07-24 产品切换 R1 Gate 记录

- Web 已改为单层产品壳；一级导航仅保留“数据集 / 导入 / 转换”，无版本产品路由直接复用
  已验证的 v2 页面；旧 v1 route、页面、专用 hooks、Recipe 与 Vocabularies 产品入口已删除；
- `/v2` 继续只作为 REST API 与内部协议边界；Vite 不再把 `/v2` HTML 请求回退到 SPA，
  无版本数据集详情、record、lineage 与 export URL 均可直接刷新；
- 第三版视觉稿已落地并完成两轮真实浏览器设计 QA，`design-qa.md` 最终为 `passed`；桌面
  数据加载、11→1 搜索过滤、详情、20条record、record详情、lineage、export、ingest 与 transform
  均通过，`/recipe` 返回产品404，`/v2/datasets` HTML请求返回API JSON 404；
- 390×844 CSS viewport 下 `scrollWidth === clientWidth === 381`，console 无 warning/error；
  对照图与桌面、窄屏证据保存在 `artifacts/design-qa-*.png`；
- Web 52/52 tests、production build与typecheck通过；`pnpm v2:status:check`、
  `pnpm openapi:check`、离线脚本测试、`pnpm typecheck`、`pnpm test`（21/21 tasks）、
  `pnpm lint`（396 files）和`git diff --check`全部通过；仅保留既存的Vite大bundle P3 warning。
