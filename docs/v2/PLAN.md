# Databench v2 实施计划

- **状态:** 已接受——owner 于 2026-07-23 确认；按 V0-V17 逐步实施
- **日期:** 2026-07-23
- **决策者:** owner
- **规范依赖:** [ADR 0009](../decisions/0009-canonical-post-training-record-v2.md)、
  [ADR 0011](../decisions/0011-identity-hashing-versioning-v2.md)、
  [v2 技术方案](TECHNICAL-DESIGN.md)（已接受）
- **当前基线:** v1 `S0.1-S21` 已完成并保留；v2 是加法式新实现，不重写 v1 golden
- **实施授权:** owner 已授权从 V0 开始；一个 Step 一个 PR，过 gate 后再进入下一步

## 1. 计划职责

ADR 0009 定义 canonical record，ADR 0011 定义 identity/version，技术方案定义最终系统结构。
本文只回答：

- 代码按什么顺序落地；
- 每个 Step 可以改哪些 package；
- 每个 PR 必须交付什么；
- 通过什么 gate 才能进入下一步；
- 哪些工作可以并行，哪些必须等待；
- 失败时停在哪里，不能临时放宽什么不变量。

技术方案中的 T1-T20、Q1-Q14、字段、hash domain、对象协议、数据库模型、API wire contract
和 Web 边界均已锁定。实施阶段不得重新选择另一套方案；确需改变时，先回到 ADR/技术方案
review，不在代码 PR 中偷偷漂移。

## 2. 范围与硬约束

### 2.1 v2.0 必须完成

1. `PostTrainingRecord 2.0.0` strict writer、compatible reader与全字段校验；
2. logical ID、record digest、dataset version、artifact digest四层身份；
3. eager `V2Dataset`、`record-json-v1`、manifest与 conditional object commit；
4. v2 namespace、claim、snapshot、layout、run、revision locator、parent edge与 ref catalog；
5. canonical JSONL ingest/export、可复现 transforms与 exact lineage；
6. canonical、TRL SFT/DPO/GRPO-RLVR、ms-swift converters及 fidelity review；
7. `/v2` API、`databench v2` CLI和独立 Web v2 vertical slice；
8. 并发写、崩溃恢复、资源准入、缓存隔离、安全与可观测性；
9. v1 API、CLI、Web、OpenAPI、tables、objects与 golden tests保持可运行。

### 2.2 v2.0 明确不做

- v1→v2 自动 migration、ID 映射、双写或 Python golden parity；
- provider/raw import adapters；首期 ingest只接收已有 canonical ID 的 v2 JSONL；
- Lance、embedding、向量索引、sidecar写入、promoted/nested Parquet layout；
- annotation workflow、异步 job平台、distributed compute；
- retention、GC、legal hold、destructive redaction；
- 多租户 catalog；v2.0 一个 catalog/object namespace是一个 trusted workspace boundary；
- 生产部署与 S22；仍受现有 D3 API托管平台决策门约束。

### 2.3 全程硬约束

- 一个 Step 一个 PR；未过当前 gate，不得进入下一个 Step；
- `apps/api` 与 `apps/cli` 只依赖 Workspace/Schema，不直连数据层；
- `catalog` 只依赖 Prisma，不 import Schema/Hashing；
- record/sample payload永远不进 Postgres；
- 所有 v2 hash只经 `@databench/hashing` 具名 API；
- 对象 artifact/manifest只做 conditional create，禁止普通覆盖 PUT；
- wire类型只写在 `@databench/schema`，OpenAPI与前端类型全部生成；
- v2 capability在 V17 final gate前默认关闭；
- 每个 PR运行该 Step gate，并保持既有 v1 gates全绿。

## 3. 已锁实施边界

### 3.1 Package DAG

```text
L0  hashing
L1  schema      → hashing
L2  engine      → schema, hashing
    io          → schema
    catalog     → Prisma only
L3  ops         → engine, schema
    store       → engine, schema, hashing
L4  workspace   → engine, io, ops, store, catalog, schema, hashing
L5  apps/api    → workspace, schema
    apps/cli    → workspace, schema
L6  web         → generated OpenAPI client only
```

所有 v2 源码在现有 package的 `src/v2/` 下增加，通过 package `index`导出；禁止深 import。

### 3.2 首期规模与资源默认值

```text
max records                 100,000
max canonical bytes         512 MiB
max record bytes            16 MiB
max JSON nesting depth      128
max request bytes           1 GiB
record page limit           500
Blob download fallback      256 MiB
```

Transform还必须实现 aggregate working-set、最大 input数量和全局并发限制；Store必须实现
prepare/read semaphore、temp disk admission与 cancellation。具体可配置值在实现 PR 中进入
capability，但不能改变 logical identity。

### 3.3 数据库表

最终 additive migration包含：

```text
identity_namespaces_v2
identity_claims_v2
dataset_snapshots_v2
dataset_layouts_v2
runs_v2
run_inputs_v2
record_revision_locations_v2
record_parent_edges_v2
refs_v2
```

Prisma表达不了的 lowercase hex、ID prefix、非负 count/size/position、ref regex、
`run_id='run_'||cache_key` 等不变量必须进入 migration raw SQL `CHECK`。

### 3.4 Object layout

```text
objects/v2/record-json-v1/<vv>/<dataset_version>/<artifact_digest>.parquet
objects/v2/record-json-v1/<vv>/<dataset_version>/manifest.json
```

`objects/v2/sidecars/` 只保留未来前缀，v2.0禁止写入。

## 4. 里程碑与关键路径

```text
M0  V0 状态与 fixtures
     ↓
M1  V1 Hashing/raw JSON → V2 Schema/Ajv → V3 Identity/revision
                                             ↓
M2  V4 Dataset/admission → V5 Parquet spike → V6 Store
                 └──────── V7 Catalog ─────────┘
                         V8 Canonical IO
                                ↓
M3  V9 Workspace publish/read/ref → V10 Transform/cache/lineage
                                ↓
M4  V11 Converters/fidelity → V12 API/OpenAPI → V13 CLI
                                                   ↓
M5  V14 Web foundation/read → V15 Web mutations/export
                                                   ↓
M6  V16 Recovery/security/perf → V17 Final/capability gate
```

| Step | 单 PR 目标 | 主要落点 | 依赖 | Gate |
|---|---|---|---|---|
| V0 | STATUS、fixture index、CI占位门 | `docs/v2`, test fixtures | PLAN accepted | GV0 |
| V1 | RFC 8785、raw parser、具名 hash APIs | `hashing`, `schema` raw parser | V0 | GV1 |
| V2 | Canonical Record strict/compatible schema + Ajv | `schema` | V1 | GV2 |
| V3 | Seed/claim/ID/revision factory与固定 vectors | `hashing`, `schema` | V1,V2 | GV3 |
| V4 | Immutable `V2Dataset`与资源准入 | `engine` | V3 | GV4 |
| V5 | `record-json-v1`确定性 spike与 codec | `engine` | V4 | GV5 |
| V6 | Manifest、keys、file-backed Store | `store` | V5 | GV6 |
| V7 | v2 Prisma migration与 Catalog并发算法 | `prisma`, `catalog` | V3 | GV7 |
| V8 | Canonical JSONL与 summary/eligibility policy | `io`, `schema` | V2,V3 | GV8 |
| V9 | Workspace ingest/read/cache/ref publish | `workspace` | V4,V6,V7,V8 | GV9 |
| V10 | Transform registry、cache/run/record lineage | `ops`, `workspace` | V9 | GV10 |
| V11 | Converter registry、inspect/stream与 fidelity | `io`, `workspace` | V9,V10 | GV11 |
| V12 | `/v2` API、OpenAPI与 generated client | `schema`,`api`,`tooling`,`web/api` | V9-V11 | GV12 |
| V13 | `databench v2` CLI | `cli` | V9-V12 | GV13 |
| V14 | Web capability、refs、dataset与 Record renderer | `web` | V12 | GV14 |
| V15 | Web ingest/transform/lineage/export | `web` | V13,V14 | GV15 |
| V16 | 并发恢复、安全、容量与跨实例 E2E | 全仓 | V13,V15 | GV16 |
| V17 | 全量 final gate、文档与 capability发布准备 | 全仓 | V16 | GV-final |

## 5. 各 Step 交付与闸门

### V0 — 状态、fixtures 与防误报门

交付：

- owner接受本文；
- 新建 `docs/v2/STATUS.md`，记录 current step、PR、gate、blocker与下一步；
- 建立 v2 fixture index，列出 ADR 0009/0011和技术方案要求的所有 fixed vectors；
- 建立 fixture命名与版本规则，expected bytes/hex变更必须关联 profile/schema/layout migration；
- CI加入 v2 status/fixture占位检查，但 capability保持 false。

> **GV0:** ADR 0009、ADR 0011、技术方案与本文均 Accepted；fixture index没有“实现时再定”的
> identity/layout/API项；全量 v1 gate仍绿。

### V1 — RFC 8785、raw JSON与 Hashing API

交付：

- `canonicalJsonV2`、UTF-16 comparator、incremental raw-byte BLAKE3；
- 四个封闭 entity ID API，以及 record/dataset/cache/claim/request/fidelity具名 domain API；
- exact `DatasetIdentityEnvelopeV2`、claim/request profile与 transform cache input types；
- `parseRawJsonV2(bytes, limits)`，在 parse前拒绝 duplicate keys、超深/超大输入；
- v2 identity-bearing JSON route可复用的 raw-body middleware helper；
- v1 `canonicalJson/hash*`输出保持不变。

测试至少覆盖 RFC 8785 official vectors、BMP/astral排序、lone surrogate、`-0`、指数边界、
unsafe integer、NaN/Infinity、duplicate keys、readonly nested values和增量 hash。

> **GV1:** 固定 canonical bytes和 BLAKE3 hex与独立实现一致；domain互不复用；不存在业务包
> 直接调用第三方 BLAKE3；v1 hashing golden无变化。

### V2 — Canonical Record 2.0.0 与 Tool Schema

交付：

- ADR 0009全部 strict Zod schemas与 TypeScript inference；
- `parseCanonicalRecordV2`、字段完整的 normalizer、compatible reader/writer；
- 所有 cross-field invariants：contents、calls/responses、candidate、signal、preference、
  supersession、verification、source、exact parent refs；
- `UnknownPart` value-level round-trip，禁止进入 strict digest/dataset/converter；
- Ajv 2020 strict实例：只允许 self-contained/local `$ref`，有 schema/compile/instance budgets；
- Tool name/call/args对 `input_schema`校验；
- Schema/OpenAPI component只能从同一 Zod源导出。

> **GV2:** ADR 0009每条不变量至少一个正反例；全字段 fixture round-trip；合法递归 local ref
> 通过，external/unresolved ref拒绝；strict writer与 compatible reader边界无混用。

### V3 — Identity、Claim 与 Opaque Revision

交付：

- root/derived/candidate/event strict seed与 creation request union；
- workspace-local UUID namespace schema；
- claim/request hash envelopes与随机 seed时序；
- private branded `RecordRevisionV2` factory：deep clone → strict parse → deep freeze → JCS → digest；
- record digest、dataset version、empty version与 cache key fixed vectors；
- generation run ID和 output index规则；
- compile-time/type tests防止 snapshot metadata误入 dataset hash。

> **GV3:** ADR 0011全部 vectors直接断言 bytes/hex；同 claim+同 request返回同 ID，同 claim+
> 不同 request冲突；输入/返回 nested mutation不能改变 revision；empty version固定为
> `da99cf8da850355f9bae66e9c38a2c61f62e7d59d7aa43a4ff6151bcdae8fefd`。

### V4 — Immutable `V2Dataset`

交付：

- eager immutable `V2Dataset`，不携带 layout；
- `fromRecords`逐条执行单 record/count/canonical byte准入；
- record ID uniqueness、digest collision检测、dataset version重算；
- `(record_digest, record_id)` ASCII稳定排序与 exact lookup；
- aggregate transform working-set估算接口；
- Polars frame materialization保持 codec-private，不从 Dataset公共 API暴露。

> **GV4:** 所有输入 permutation得到同一 version和遍历顺序；同 logical ID两个 revisions拒绝；
> 单条/总量/count边界及 defensive immutability测试通过；超限不留下部分 dataset。

### V5 — `record-json-v1` 确定性 Parquet

交付：

- 三列 non-null UTF-8 schema：`record_id`,`record_digest`,`record_json`；
- lazy `sinkParquet`固定 compression/statistics/row group/data page/双层 maintain order等参数；
- store-owned temp path writer与第二遍流式 digest/size；
- decoder验证 columns、row、record digest、dataset version；
- 跨独立进程及支持 OS/arch的 artifact fixture matrix。

Matrix至少覆盖 empty、Unicode、高/低 cardinality、超长 JSON、
65,535/65,536/65,537 row-group边界。

> **GV5:** 所有 matrix raw bytes和 artifact digest稳定；row order固定；任一 nodejs-polars
> 不可控 metadata造成漂移时立即停止，不得进入 V6。此时回到技术方案明确替代 writer，
> 不能临时放宽 layout invariant。

### V6 — Manifest 与 File-backed Store

交付：

- strict canonical `DatasetManifestV2`，包含 artifact size；
- 唯一 key builder和 path component校验；
- `prepare/commit/discard` opaque handle，temp dir `0700`、file `0600`；
- prepare/read semaphore、temp free-space admission、cancellation和 stale cleanup；
- S3/MinIO与 OSS conditional create adapters；
- created/already-exists/ambiguous/failure四类状态机；
- artifact-first、manifest-last提交，read/audit全量验证；
- cold read先落受控 temp并 hash，再 decode，不整对象进 Buffer。

> **GV6:** 真实 MinIO双 writer、崩溃窗口、ambiguous transport和 corruption测试通过；任何
> 分支都不 fallback普通 PUT；相同 retry幂等，不同 artifact/layout typed conflict；v1 Store
> gates保持通过。

### V7 — Prisma 与 v2 Catalog

交付：

- §3.3九张表的 additive migration和显式 RESTRICT FK；
- raw SQL checks与必要 indexes；
- namespace/claim `INSERT ... ON CONFLICT DO NOTHING`并发算法；
- immutable snapshot/layout/run/run inputs registration；
- `(record_id,record_digest)` representative locator；
- ordered exact parent edges、unresolved parent与 recursive CTE cycle detection；
- 单 SQL Ref CAS：create-only INSERT或 expected-version conditional UPDATE；
- opaque seek pagination primitives；
- Catalog-local primitive DTO，不 import domain packages。

> **GV7:** migration不修改 v1表/data；namespace与claim并发稳定；同 revision并发出现在两个
> snapshots不冲突；跨 snapshot cycle拒绝；run metadata/cache conflict不覆盖；Ref无 lost
> update，响应丢失后安全返回可确认的 conflict。

### V8 — Canonical JSONL 与共享投影

交付：

- streaming UTF-8 JSONL reader/writer；
- 每行复用 duplicate-aware raw parser，1-based line + JSON Pointer errors；
- canonical import保留合法 ID，不生成 artifact-row ID；
- writer按 `(record_digest,record_id)`输出 `record_json + '\n'`；
- `RecordSummaryV2`、preview、task eligibility与 output count共享 policy；
- provider/raw adapters仅留扩展接口，不实现。

> **GV8:** read→write→read保持 record digest和稳定 bytes；duplicate key/BOM/invalid ID/
> unsupported major有 typed error；summary/eligibility逐项对拍 ADR 0009；大 transport流式读取，
> snapshot仍受 eager limits。

### V9 — Workspace Publish、Read Cache 与 Ref

交付：

- `addRecords/addJsonl/describeDataset/getRecordPage/getRecordView/audit`；
- 固定 `prepare → conditional commit → verified manifest → catalog register → optional ref CAS`；
- 恢复路径执行 strict manifest + HEAD + stream digest后再注册；
- `V2DatasetCache`：exact layout key、promise coalescing、byte-weighted LRU、pin/evict；
- cold load/read semaphore、capacity errors和 cancellation；
- refs list/get/put与 conflict detail；
- auth/tenant在 API进入 Workspace/cache前检查的调用约束。

> **GV9:** 真实 MinIO/Postgres ingest→persist→read→page→audit→ref通过；每页不重复下载同一
> Parquet；ref冲突不删除已提交 dataset；cache admission失败返回 typed 503而非 OOM；任一步失败
> 旧 ref保持不变。

### V10 — Transform、Run Cache 与 Lineage

交付：

- registry声明 name/version/strict params/identity mode；
- 执行前解析 ordered exact inputs、规范化 params并计算 cache key；
- `run_id='run_'+cache_key`与 deterministic context；
- aggregate working-set/input count/concurrency admission；
- cache hit完整 metadata验证，双 miss race与 determinism conflict；
- preserve/derive identity matrix和 exact parent refs；
- locator/parent edge registration与 dataset/run lineage query；
- 首批最小 operations：filter/subset、sample(seed required)、append evidence、selection update、
  prompt rewrite；不在首期扩展无验收需求的 operation面。

> **GV10:** 同 cache key重试/cache hit/run race得到相同 run ID和 output；不同 output触发
> determinism conflict且不移动 ref；所有 identity mode fixtures通过；wall clock、任意 RNG、
> network不能进入 deterministic context。

### V11 — Converter Registry 与 Fidelity

交付：

- converter descriptor registry与从 Zod导出的 options schema；
- 严格两阶段 `inspect`/`stream`；
- canonical JSONL、TRL SFT、TRL DPO、TRL GRPO/RLVR、ms-swift；
- eligibility、output count、config hints与 stable fidelity changes；
- export plan normalization和 `fidelity_digest`；
- semantic loss必须精确 digest授权，informational/transformed必须报告；
- 所有 converter输入按 record digest排序，禁止依赖 Parquet row/order/time。

> **GV11:** 每个 converter实际 output bytes golden通过；同 dataset不同物理 row序导出完全相同；
> inspect不打开 stream/无副作用；stream不改变 analysis；未授权 semantic loss或 plan drift
> 返回 typed fidelity error。

### V12 — `/v2` API、OpenAPI 与 Generated Client

端点必须与技术方案一致：

```text
POST /v2/datasets:ingest-jsonl
GET  /v2/datasets/{ref_or_version}
GET  /v2/datasets/{ref_or_version}/records
GET  /v2/datasets/{ref_or_version}/records/{record_id}
POST /v2/datasets/{ref_or_version}:audit
GET  /v2/converters
GET  /v2/converters/{name}
POST /v2/datasets/{ref_or_version}:inspect-export
POST /v2/datasets/{dataset_version}:export
GET  /v2/transforms
POST /v2/transforms/{name}/run
GET  /v2/refs
GET  /v2/refs/{name}
PUT  /v2/refs/{name}
GET  /v2/lineage/{ref_or_version}
```

交付：

- 所有 request/success/typed error Zod/OpenAPI components；
- streaming multipart ingest，不使用 `request.formData()`整体 buffer；
- identity-bearing JSON route禁止 `c.req.json()`；
- 无状态 inspect + exact-version binary export；
- refs cursor、records offset、lineage depth/nodes/cursor contract；
- capability envelope及全部 limits；
- `X-Request-ID`、no-store/nosniff与 CORS exposed headers；
- 401/403/429/503和 dependency error mapping；
- regenerated OpenAPI与 Web client。

> **GV12:** HTTP lifecycle、multipart null语义、typed error details、pagination/truncation、
> request cancellation与 binary headers通过；`openapi:check` deterministic；API无数据层 direct
> imports；所有 v1 API tests保持通过。

### V13 — CLI

交付：

```text
databench v2 dataset ingest/show/records/audit/export
databench v2 converter list/show
databench v2 transform list/run
databench v2 ref list/show/move
databench v2 lineage show
```

- 只调用 Workspace/Schema；
- JSON/NDJSON stdout，diagnostics stderr；
- export先 inspect，semantic loss要求显式 fidelity digest；
- 文件输出使用同目录 temp + flush + atomic rename；
- binary TTY拒绝，pipe断开传播 cancellation。

> **GV13:** CLI与 API/Workspace对同 fixture返回相同 version/manifest/plan；错误码和中断清理
> 稳定；v1 CLI commands不改变。

### V14 — Web Foundation、Refs 与 Record Read

交付：

- `apps/web/src/v2/`独立 vertical slice和 routes；
- capability gate验证 API/schema/identity/layout/fidelity兼容性；
- loading/disabled/401/403/network/incompatible独立状态；
- `connectionScope + base + v2 + exact version` query keys；
- token/base/tenant切换 cancel并清理旧 private cache；
- `/v2/datasets`只列 refs，不伪装 detached snapshots discovery；
- exact-version record pagination和 TanStack Virtual；
- 完整 Unified Record renderer与 server-provided eligibility；
- 纯文本、不可信 URI、大 record/raw JSON安全渲染。

> **GV14:** 同 base切换 token后旧 capability/ref/record不可见；ref在分页间移动不混 snapshot；
> 所有 Part/candidate/signal/relation/tool/verification variants可访问；恶意 HTML/URI不执行；
> v2 gate不阻塞任何 v1 route。

### V15 — Web Ingest、Transform、Lineage 与 Export

交付：

- canonical JSONL上传和可选 ref CAS；
- transform registry、ordered inputs、params editor与 identity-mode提示；
- ref conflict三种显式恢复动作，不自动 overwrite；
- 有界 lineage graph与 truncation/continuation；
- inspect fidelity review、semantic confirmation和 exact-version export；
- File System Access streaming download；
- Blob fallback按累计 bytes执行 256 MiB限制；
- Content-Type与 untrusted Content-Disposition校验、取消/失败 abort。

> **GV15:** browser E2E覆盖 ingest→records→transform→ref conflict→lineage→inspect→export；
> fidelity plan漂移必须重新确认；无/错误 Content-Length仍能限流；中断文件不报告成功；
> a11y/i18n/keyboard/focus gates通过。

### V16 — Recovery、安全与容量

集中验证跨 Step故障，不新增业务功能：

1. artifact前、artifact后/manifest前、manifest后/catalog前、catalog后/ref前崩溃；
2. OSS/MinIO conditional write明确冲突与 ambiguous transport；
3.两个 API实例同 dataset/layout双 writer；
4. namespace/claim/ref/run/revision locator并发；
5. unresolved parent晚到与 lineage cycle；
6. read/prepare/transform semaphore、temp disk/heap admission与 cancellation；
7. duplicate-key、schema bomb、deep JSON、oversized record/request；
8. auth前置、connection cache隔离、日志/telemetry无 record/secret；
9.恶意 filename、MIME、HTML、URI与 export中断；
10. detached canonical export/import保留 IDs和 exact parent refs。

> **GV16:** 所有 fault injection都得到已定义的幂等成功、typed conflict或 typed failure；无覆盖、
> 无 payload进 PG、无 orphan被 reader发现、无跨身份 cache泄露、无 temp资源泄露。

### V17 — Final Gate 与发布准备

交付：

- `docs/v2/STATUS.md`全部 Step/gate/PR记录；
- 用户文档、OpenAPI、generated client、env与 capability说明同步；
- 依赖 DAG、禁止深 import、PG payload红线的 CI检查；
- 全生命周期 E2E和 v1/v2 coexistence报告；
- capability enable作为独立 owner动作准备，但默认仍为 false。

> **GV-final:** `pnpm lint && pnpm typecheck && pnpm test && pnpm openapi:check`全绿；真实
> Postgres + MinIO lifecycle、并发、恢复和浏览器 E2E通过；支持 OS/arch artifact matrix通过；
> v1 objects/tables/refs/routes/goldens无变化；技术方案和实现一致。

GV-final通过不自动打开 capability。Owner必须另行确认 enable；把默认入口切到 v2、停用 v1
或生产部署也都不属于本文授权。

## 6. 并行规则

默认仍是一个 Step一个 PR。只有不存在共享 schema/migration文件冲突且前置 gate已通过时才允许：

- V7 Catalog可在 V3后与 V4-V6数据面并行；
- V8 Canonical IO可在 V3后与 V4-V7并行；
- V13 CLI可在 V12 contract稳定后与 V14 Web read并行；
- V16中的独立 provider/infrastructure fault tests可提前准备 fixture，但不得提前宣称 gate完成。

以下不能并行越过：

- V2不能在 V1 canonical/hash行为未固定前完成；
- V3 identity vectors未固定前不能写 Dataset/Catalog identity；
- V5 determinism spike未过不能实现或发布 V6 layout commit；
- V9 publish sequence未过不能开始 transform/converter；
- V11 fidelity contract未过不能冻结 API export；
- V12 generated contract未过不能完成 Web mutation/export；
- V16未过不能进入 final/capability准备。

## 7. PR 与验收纪律

每个 Step PR必须：

1. 只完成该 Step范围，列出未做项；
2. 更新 `docs/v2/STATUS.md`；
3. 提供该 Gate命令与结果；
4. 增加失败/边界测试，不只 happy path；
5. 若改 wire contract，同 PR重生成 OpenAPI/client并跑 `openapi:check`；
6. 若改 hash/profile/layout expected bytes，先更新 ADR/技术方案与 migration说明；
7. 保持 capability false和 v1 full suite全绿；
8. 使用 Conventional Commit，scope为主要 package；
9. 不修改旧参考仓库 `~/Desktop/databench/`；
10. 不把下一 Step的“顺手实现”混入当前 PR。

Step可以因 gate失败暂停；不能为了赶进度降低确定性、完整性、CAS、fidelity或安全要求。

## 8. 风险与固定回退

| 风险 | 首次阻断 Step | 固定回退 |
|---|---|---|
| RFC 8785/JCS跨实现不一致 | V1 | 以规范 vectors为准，停止实现，不改 expected掩盖 |
| Ajv/schema资源消耗不可控 | V2 | 收紧已公开 budgets，不绕过 Tool validation |
| nodejs-polars artifact bytes不稳定 | V5 | 返回技术方案选定确定性 writer；不放宽 layout identity |
| OSS conditional create结果语义不一致 | V6 | 修 provider adapter与 gated test；不 fallback普通 PUT |
| Catalog lineage recursive query过重 | V7/V12 | 使用已定 depth/node/cursor边界，不删除 exact lineage |
| eager transform超过 heap | V4/V10 | admission拒绝并返回 capacity error；不偷偷改 shards |
| converter无法无损表达目标格式 | V11 |报告 fidelity并拒绝未授权 semantic loss |
| Web大文件下载不可安全完成 | V15 |引导 CLI；不扩大无界 Blob |
| v2任一 final gate未过 | V17 | capability保持 false，v1继续服务 |

## 9. 完成定义

只有同时满足以下条件，v2实现才算完成：

- ADR 0009/0011与技术方案的全部不变量都有实现和固定测试；
- identity/record/dataset/artifact/cache/fidelity domains可跨进程复现；
- `record-json-v1`有跨 OS/arch稳定 artifact matrix；
- object commit、catalog registration、run、ref并发与 crash recovery通过；
- record revision lookup与 exact parent lineage可定位、可检环；
- runtime cache/admission在上限、取消与并发下不泄露资源或数据；
- canonical/TRL/ms-swift converters有实际 bytes golden和 fidelity gates；
- API、CLI、Web完整闭环，所有 wire类型来自 generated contract；
- auth/tenant/cache、untrusted content与下载安全边界通过；
- Postgres无 record payload，v2无 sidecar/Lance/Python/第三状态服务；
- v1现有 tests、objects、tables、routes与UI保持兼容；
- `docs/v2/STATUS.md`、OpenAPI、generated client和用户文档同步；
- GV-final后由 owner另行确认 capability enable/cutover。
