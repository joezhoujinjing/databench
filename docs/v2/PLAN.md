# Databench v2 实施计划

- **状态:** 暂缓评审——须在 v2 技术方案接受后按其重写；当前版本不得用于实施
- **日期:** 2026-07-23
- **决策者:** owner
- **规范依赖:** [ADR 0009](../decisions/0009-canonical-post-training-record-v2.md)、
  [ADR 0011](../decisions/0011-identity-hashing-versioning-v2.md)、
  [v2 技术方案](TECHNICAL-DESIGN.md)（提议中）
- **当前基线:** v1 `S0.1-S21` 已完成并保留；v2 是加法式新实现，不重写 v1 golden

## 1. 目标

本计划把已经接受的 v2 logical record 与 identity/version 协议变成一条可以逐 PR
执行、逐闸门验收的实施路径。完成后，Databench 必须能够:

1. strict-validate、保存、读取与导出 `PostTrainingRecord 2.0.0`;
2. 跨进程、跨输入顺序复现 logical ID、record digest 与 dataset version;
3. 使用不可覆盖的 Parquet artifact + manifest 保存 immutable snapshot;
4. 在 Postgres 中管理 v2 snapshot、layout、run、ref 与 idempotency control metadata，
   但绝不保存 record payload;
5. 通过 `/v2` API、CLI 与 Web 完成 ingest → inspect → transform → export → lineage
   生命周期;
6. 导出 TRL SFT、TRL DPO、TRL GRPO/RLVR 与 ms-swift，并报告机器可读 fidelity;
7. 保持现有 v1 代码、数据库表、对象 key、OpenAPI 与 golden tests 全绿。

本计划被接受只代表实施顺序和下述 plan-level decisions 被锁定，不代表任何 Step 已完成。
实现 agent 必须建立 `docs/v2/STATUS.md`，一个 Step 一个 PR，过当前闸门后才能进入下一步。

## 2. 非目标

v2 首期明确不做:

- v1 sample 自动转换、v1→v2 ID 映射、双写或 v1/v2 parity;
- 修改、迁移或删除既有 v1 Parquet、catalog rows 与 refs;
- Lance、embedding、向量索引、MinHash 或 semantic dedup;
- 把 record/candidate/signal payload 存入 Postgres;
- 分布式执行框架、Ray、Python worker 或新增第三个有状态服务;
- annotation UI、完整 workflow engine、异步任务平台;
- destructive redaction、数据保留、GC 与 legal hold 策略;
- 生产部署；生产部署仍受既有 D3/S22 平台决策门约束。

## 3. Plan-level decisions

以下不是隐藏的实现细节。Owner 接受本计划即表示接受 P1-P10；要改变时必须先修改本计划，
如果改变 ADR 0009/0011 的不变量，则同时修改对应 ADR。

### P1. v2 采用加法式隔离，不原地改写 v1

- 逻辑代码在现有 package 内使用 `src/v2/` 模块，不复制第二套 package DAG;
- API 使用 `/v2`，CLI 使用 `databench v2 ...`，Web 构建期使用 `/v2/...` 页面;
- Prisma 使用独立 v2 tables，object store 使用 `objects/v2/...`;
- v1 routes、tables、objects、refs、fixtures 与 exported APIs 保持可用;
- v2 final gate 通过前，capabilities 中 v2 默认关闭，不把现有 `/datasets` UI 切到 v2;
- 不实现 v1→v2 自动 migration。需要 v2 数据时从原始来源或 canonical v2 JSONL 重新导入。

这样可以在任何 v2 Step 失败时关闭 capability，而不回滚或破坏 v1 数据。

### P2. 沿用现有 package DAG

v2 不新增横向 package，仍遵守:

```text
L0  hashing
L1  schema      → hashing
L2  engine      → schema, hashing
    io          → schema
    catalog     → Prisma only
L3  ops         → engine, schema
    store       → engine, schema
L4  workspace   → engine, io, ops, store, catalog, schema, hashing
L5  apps/api    → workspace, schema
```

落点固定为:

| 能力 | 位置 |
|---|---|
| RFC 8785、BLAKE3 domain API | `packages/hashing/src/v2/` |
| `PostTrainingRecord`、manifest、seed、API Zod | `packages/schema/src/v2/` |
| `V2Dataset`、Parquet codec | `packages/engine/src/v2/` |
| canonical JSONL、provider import、trainer export | `packages/io/src/v2/` |
| v2 transforms 与 identity mode registry | `packages/ops/src/v2/` |
| conditional-create object protocol | `packages/store/src/v2/` |
| v2 Prisma control-plane methods | `packages/catalog/src/v2/` |
| 生命周期编排 | `packages/workspace/src/v2/` |
| `/v2` HTTP | `apps/api/src/routes/v2/` |

`apps/api` 继续只能依赖 `workspace + schema`；`catalog` 继续不依赖 domain packages；
前端继续只消费生成的 OpenAPI client。

### P3. v2.0 首个 Parquet layout 使用最小 lossless record JSON

首个 layout 固定命名为:

```text
layout_version = "record-json-v1"
```

Parquet 只有三个 non-null UTF-8 columns:

```text
record_id
record_digest
record_json
```

规则如下:

- `record_json` 是 strict record 的完整 RFC 8785 canonical JSON，不能使用普通
  `JSON.stringify`;
- `record_id` 必须等于 `record_json.id`;
- `record_digest` 必须按 ADR 0011 从 `record_json` 重算通过;
- 每个 snapshot 写盘前按 `record_digest` ASCII 升序排列，物理行号仍不参与 logical
  dataset version;
- profile 与精确 record schema version 存在 manifest，不在每行重复;
- writer library version、compression、statistics、row-group 与其他影响 bytes 的配置必须
  在 V5 固定并进入 layout fixture；任一配置改变必须提升 `layout_version`;
- 首期不增加 promoted query columns。未来增加 lang、candidate count、signal 等列时发布
  新 layout，仍以 `record_json` 为逻辑真相。

这个 layout 优先保证最小、无损、可验证与易迁移。查询性能优化属于后续 layout，不允许
在 v2.0 同时维护一份手写 nested Parquet 逻辑 schema。

### P4. v2 catalog 使用独立控制面表

Prisma 采用 additive migration，至少增加:

```text
identity_namespaces_v2
identity_claims_v2
dataset_snapshots_v2
dataset_layouts_v2
runs_v2
refs_v2
```

职责边界:

- `identity_namespaces_v2`:保存 workspace-local immutable namespace;
- `identity_claims_v2`:保存 server-created entity 的 seed profile、producer/idempotency
  key、entity ID 与 normalized request digest，用于重试与 conflict，不保存 record payload;
- `dataset_snapshots_v2`:dataset version、identity profile、record schema version、
  num records 与 lifecycle time;
- `dataset_layouts_v2`:`(dataset_version, layout_version)`、artifact digest、manifest key
  与 committed time;
- `runs_v2`:cache key、op/version、params、immutable input/output dataset versions;
- `refs_v2`:mutable ref → immutable v2 dataset version。

不建立 record/candidate/signal payload table，也不在 PG 建每行内容索引。精确
`ParentRevisionRef` 通过已知 run input snapshots 解析；暂时没有 parent payload 时保留
unresolved exact ref。若全局 record lookup 后续成为性能瓶颈，增加可重建的 object-store
index sidecar，不把 canonical payload 搬入 PG。

### P5. v2.0 namespace 是 workspace-local immutable UUID

- 每个 catalog 首次启用 v2 时生成一个 128-bit random UUID;
- namespace 保存在 `identity_namespaces_v2`，不使用 workspace name、URL、目录或可变配置;
- workspace 重命名、API 重启、部署迁移与数据库 restore 不改变 namespace;
- 同一原始来源分别导入两个 workspace，默认得到不同 root IDs;
- canonical v2 export/import 始终保留已有 ID，不在目标 workspace 重算;
- 未来引入 organization/multi-tenant identity 时必须单独决策，不静默重解释现有 UUID。

### P6. Logical ID 分配后是 opaque identity

ID 创建时必须遵守 ADR 0011 的 seed schema 与 domain function，但 canonical consumer
不要求只凭当前 record 反推 seed。原因是 canonical import 本来就允许保留已有 ID，且
source/provenance 后续可能修正。

Server-created ID 的审计边界:

- seed profile、namespace、producer/idempotency key 与 normalized request digest 进入
  immutable identity claim;
- normalized request digest 覆盖创建请求中除 server-assigned IDs 与 catalog lifecycle
  time 外的全部 strict canonical 字段;
- 相同 claim key + 相同 request digest 返回原 ID;
- 相同 claim key + 不同 request digest 抛 typed conflict;
- 没有 producer key 时生成 CSPRNG seed，系统不承诺重试合并;
- imported canonical ID 只做格式、局部唯一与引用校验，标记为 imported，不伪造
  machine-generated claim。

### P7. v2.0 identity mode 矩阵

所有 transform 必须在 registry 中声明 `preserve | derive`，默认规则固定为:

| 变化 | Record ID | 子实体 ID |
|---|---|---|
| 新增 candidate | preserve | 新 Candidate ID |
| 新增 signal/relation | preserve | 新事件 ID |
| rank/selected、generator/source 描述、tags、extra 修正 | preserve | 保留已有子实体 ID |
| Candidate contents 改变 | preserve | 创建新 Candidate ID，不原地复用旧 ID |
| system instruction、共享 contents 改变 | derive | 根据新 record 重新分配受影响的 child IDs |
| tools、verification 改变 | derive | 根据新 record 重新分配受影响的 child IDs |
| split、merge、prompt rewrite、产生新训练实例 | derive | 新 child IDs |
| schema migration | preserve | 保留 record/candidate/signal/relation IDs |

补充规则:

- `source.name/kind/original_id` 被纠正时 record ID 保留；原始 seed 只在 immutable identity
  claim 中审计，当前 source 不负责重新证明 ID;
- Candidate contents 不允许“原 ID 原地改字”。需要修正时创建新 candidate，旧 candidate
  保留到显式、独立的 redaction policy 出现;
- signal/relation 永远按 supersession append，不覆盖旧事件;
- destructive deletion/redaction 不在 v2.0，不能借 `preserve` 绕过。

### P8. `/v2` 契约独立发布

- `/v1` 行为与生成类型保持不变;
- `/v2` wire schema 仍只来自 `@databench/schema` Zod;
- 同一个 `openapi.json` 可以同时包含 `/v1` 与 `/v2`，前端继续由
  `openapi-typescript` 生成 client;
- capabilities 增加 v2 envelope，至少暴露 API version、record schema versions、
  identity profiles、layout versions 与 converter names;
- v2 dataset records 按 record digest 固定顺序分页；首期复用 offset/limit，不引入 cursor
  协议;
- API 只返回 manifest、record 与 lineage 契约，不暴露 object-store signed URL、
  identity seed 或数据库内部 row ID。

### P9. Converter 先于 Web 完成

交付顺序固定为:

1. canonical v2 JSONL round-trip;
2. TRL SFT;
3. TRL DPO;
4. TRL GRPO/RLVR;
5. ms-swift;
6. OpenAI/Anthropic/Gemini provider adapters。

前五项是 v2 final gate 必需；provider adapters 可以在 final gate 后继续。每个 converter
必须返回 ADR 0009 的 fidelity report，strict 模式默认拒绝未授权 semantic loss。

### P10. v2 不与旧 Python golden 对拍

v2 的正确性来源为:

- ADR 0009/0011 固定 fixtures;
- RFC 8785 官方 vectors 与至少一个独立 JCS/BLAKE3 实现;
- TypeScript golden/property tests;
- Parquet round-trip、独立进程 artifact determinism 与真实 MinIO conditional-write tests;
- 全生命周期重复运行与并发运行得到同一 logical versions。

v1 Python parity tests 继续运行，但只证明 v1 没有回归，不作为 v2 identity 的 expected
value 来源。

## 4. 里程碑与 Step 总览

```text
V0 计划门
  ↓
V1 Hashing → V2 Schema → V3 Identity fixtures
                            ↓
                  V4 Logical Dataset
                    ├─ V5 Parquet layout → V6 Store
                    ├─ V7 Canonical IO
                    └─ V8 Catalog
                            ↓
                      V9 Workspace
                    ├─ V10 Ops
                    └─ V11 Converters
                            ↓
                    V12 API → V13 CLI
                            ↓
                    V14 Web → V15 Final
```

| Step | 目标 | 主要落点 | 闸门 | 依赖 | 规模 |
|---|---|---|---|---|---|
| **M0 协议与计划门** ||||||
| V0 | 接受计划、建立 v2 STATUS 与 fixture index | `docs/v2` | GV0 | ADR 0009/0011 | S |
| **M1 纯协议层** ||||||
| V1 | RFC 8785 + v2 domain hash APIs | `hashing` | GV1 | V0 | M |
| V2 | Canonical Record 2.0.0 strict/compatible schema | `schema` | GV2 | V1 | L |
| V3 | Entity seed、identity claim request、record/dataset vectors | `hashing`,`schema` | GV3 | V1,V2 | M |
| **M2 数据面** ||||||
| V4 | `V2Dataset` logical snapshot | `engine` | GV4 | V3 | L |
| V5 | `record-json-v1` Parquet codec 与 determinism spike | `engine` | GV5 | V4 | M |
| V6 | v2 manifest、keys、conditional-create store | `store` | GV6 | V5 | L |
| V7 | canonical JSONL ingest/export | `io` | GV7 | V2,V3 | M |
| V8 | additive v2 Prisma catalog | `prisma`,`catalog` | GV8 | V0 | L |
| **M3 编排与操作** ||||||
| V9 | v2 Workspace persist/get/ref/run/lineage | `workspace` | GV9 | V4,V6,V7,V8 | L |
| V10 | v2 transform registry + identity modes | `ops`,`workspace` | GV10 | V9 | L |
| **M4 导出** ||||||
| V11 | TRL/ms-swift converters + fidelity | `io`,`workspace` | GV11 | V2,V9 | L |
| **M5 产品契约** ||||||
| V12 | `/v2` API + OpenAPI generated client | `schema`,`api`,`tooling`,`web/api` | GV12 | V9,V10,V11 | L |
| V13 | `databench v2` CLI | `cli` | GV13 | V9,V10,V11 | M |
| **M6 Web 与收口** ||||||
| V14 | Unified Record v2 Web flow | `web` | GV14 | V12 | L |
| V15 | v2 E2E、并发、恢复、文档收口 | 全仓 | GV-final | V13,V14 | L |

## 5. 各 Step 的交付与闸门

### V0 — 计划门与 fixtures 目录

交付:

- owner 接受本计划;
- 新建 `docs/v2/STATUS.md`;
- 建立 `packages/*/test/golden/fixtures/v2/` 命名规则与 fixture index;
- 把 ADR 0009/0011 的 normative example 转成待实现 fixture 清单;
- CI 先加入“v2 未实现时不得误报完成”的空 status check。

> **GV0:** ADR 0009、ADR 0011、PLAN 三份文档均 Accepted；没有未标出的 schema/identity/
> layout 决策；全量 v1 gate 仍绿。

### V1 — RFC 8785 与 domain hash APIs

交付:

- `canonicalJsonV2`，拒绝 duplicate keys、lone surrogate 与所有 ADR 0011 非法值;
- UTF-16 property comparator 与 tags normalization helper;
- 具名 domain APIs：entity、record、dataset、transform cache、raw artifact;
- v1 `canonicalJson/hash*` 输出逐字节不变。

> **GV1:** RFC 8785 vectors 全过；跨实现 canonical bytes 与 BLAKE3 hex 一致；v1 hashing
> golden 无变化；业务 package 不直接 import 第三方 BLAKE3。

### V2 — Canonical Record 2.0.0

交付:

- ADR 0009 全部 Zod schemas、TypeScript inference 与 strict writer;
- compatible reader 保留支持 major 下的未知 minor fields/UnknownPart;
- 所有 cross-field validation：trajectory、tool call、signals、relations、supersession、
  loss weights、verification、source 与 exact parent refs;
- JSON Schema/OpenAPI components 从 Zod 生成，不手写第二份 wire types。

> **GV2:** ADR 0009 每条不变量至少一个正/反例；全字段 fixture round-trip；strict writer
> 拒绝 unknown writer fields，compatible reader 保留 future minor fixture。

### V3 — Entity identity 与固定 vectors

交付:

- root/derived record、candidate、signal、preference relation strict seed schemas;
- workspace namespace 与 identity claim request schemas;
- record digest、dataset identity envelope、empty dataset expected value;
- op params、producer event key、schema/profile change vectors。

> **GV3:** ADR 0011 §10 所有 vectors 直接断言 bytes 与 hex；不同 op params 不撞 ID；
> append/reorder 不改变 event ID；`2.0.0` empty version 固定为
> `da99cf8da850355f9bae66e9c38a2c61f62e7d59d7aa43a4ff6151bcdae8fefd`。

### V4 — Logical `V2Dataset`

交付:

- immutable `V2Dataset`，只接受同 profile/同精确 schema version records;
- record ID uniqueness、record digest recompute 与 dataset version;
- fixed record-digest ordering、slice/head/iterate，不把物理行序当 identity;
- v1 `Dataset` 保留，不通过类型联合偷偷混用 v1/v2。

> **GV4:** 所有 row permutations 得到相同 version；内容变化必改 digest/version；同 logical
> ID 两个 revisions 同 snapshot 被拒绝；空集与 schema/profile 变化 vectors 通过。

### V5 — `record-json-v1` Parquet

交付:

- 三列固定 Arrow/Parquet schema;
- canonical row encoder/decoder 与 full validation;
- writer options 与依赖版本固定为 layout contract;
- 在多个独立 Node 进程重复写同一 fixture 的 artifact determinism spike。

如果 `nodejs-polars` 在固定配置下仍产生不稳定 bytes，V5 必须暂停并记录结论，改用能产生
确定性 Parquet 的 TS writer；不得放宽“同 dataset/layout 同 artifact digest”。

> **GV5:** 跨进程重复写 artifact digest 一致；Parquet round-trip 保留 canonical bytes；
> 改一字节触发 integrity error；columns/order/type 不符被拒绝。

### V6 — v2 Store

交付:

- ADR 0011 v2 key builder、canonical manifest 与 read/audit;
- S3/MinIO `If-None-Match: *`、OSS `x-oss-forbid-overwrite: true`;
- artifact-first、manifest-last commit 与 typed conflict/integrity errors;
- crash recovery、orphan isolation、idempotent retry;
- v1 Store API 与 key builder 不变。

> **GV6:** 真实 MinIO 双 writer 用不同 artifact 并发，只能有一个 manifest winner；loser
> 返回 typed conflict；半写状态不对 reader 可见；相同 write 幂等；v1 G6 继续通过。

### V7 — Canonical JSONL

交付:

- UTF-8 canonical v2 JSONL reader/writer;
- raw duplicate-key detection发生在 JSON parse/Zod 之前;
- canonical import 保留合法 IDs，非 canonical provider IDs 进入 source/provenance;
- 1-based line error 与类型化 validation detail;
- 不实现 v1 auto-conversion。

> **GV7:** JSONL read→write→read 保持 record digest；duplicate keys、future unsupported major、
> invalid ID/ref 都给稳定 typed error；大文件使用 streaming，不一次性读入内存。

### V8 — v2 Catalog

交付:

- additive Prisma migration 与 P4 六组 tables;
- immutable namespace、identity claim conflict、snapshot/layout first-write-wins;
- run cache conflict、transactional ref update、dataset lineage query;
- 所有 catalog lifecycle time 使用 database time，不进入 logical digest。

> **GV8:** migration 不修改 v1 tables/data；namespace 重启稳定；identity claim 同请求幂等、
> 异请求冲突；layout conflict 不覆盖；ref 只能指向已注册 committed snapshot。

### V9 — v2 Workspace

交付:

- `addRecords/addJsonl/getRecords/getRecord/persist`;
- object manifest commit → catalog register → ref transaction 的固定顺序;
- transform cache、run lineage、exact parent refs 与 unresolved import handling;
- health/doctor 同时检查 v2 migrations 与 conditional-write capability。

> **GV9:** 内存与真实 MinIO/Postgres 各跑一次 ingest→persist→get→ref→lineage；任一步故障
> ref 仍指向旧 version；重复执行得到相同 dataset version。

### V10 — v2 Operations

交付:

- transform registry 强制声明 identity mode、op version 与 strict params;
- 首批 dataset operations：filter、sample、dedup-by-record-ID;
- 首批 record operations：append candidate/signal/relation、selection update、prompt rewrite;
- 所有 derive operation 写 exact parent refs，所有 append evidence 遵守 event ID 与
  supersession。

> **GV10:** P7 矩阵每一行有测试；preserve 操作只改 digest/version，derive 操作产生新
> record ID；同 cache key 只对应一个 output version；不同 params 不复用 derived ID。

### V11 — Trainer converters

交付:

- canonical、TRL SFT、TRL DPO、TRL GRPO/RLVR、ms-swift;
- `ConversionResult` 与每个 `FidelityChange`;
- strict semantic-loss authorization;
- selected、relation、verification、loss weight、tool/thought 降级 vectors。

> **GV11:** 每个 converter 对资格、输出行数、candidate/relation identity、loss mask 与
> fidelity 逐字段 golden；未授权 semantic loss 必须失败，不能静默 drop。

### V12 — `/v2` API 与 OpenAPI

最低端点面:

```text
POST /v2/datasets:ingest-jsonl
GET  /v2/datasets/{ref}
GET  /v2/datasets/{ref}/records
GET  /v2/datasets/{ref}/records/{record_id}
GET  /v2/datasets/{ref}/export
GET  /v2/transforms
POST /v2/transforms/{name}/run
GET  /v2/refs
GET  /v2/refs/{name}
GET  /v2/lineage/{ref}
```

交付:

- Zod route contract、统一 error envelope、capabilities v2 envelope;
- OpenAPI 同时保留 `/v1` 与 `/v2`;
- regenerated frontend client 与 deterministic `openapi:check`;
- API route 不直接 import store/catalog/engine/ops/io。

> **GV12:** v2 HTTP lifecycle、错误 envelope、分页稳定性、converter fidelity response 与
> OpenAPI determinism 全过；所有 v1 API tests 保持不变。

### V13 — CLI

交付:

- `databench v2 dataset ...`;
- `databench v2 transform ...`;
- `databench v2 ref ...`;
- `databench v2 lineage ...`;
- `databench v2 export ...`;
- machine-readable JSON/NDJSON stdout 与诊断 stderr 边界。

> **GV13:** CLI 与 Workspace 对同 fixture 返回相同 versions/manifests；错误码稳定；
> v1 CLI commands 不改变。

### V14 — Web

交付:

- v2 dataset list/detail/record renderer;
- unified contents、candidate、signal、preference、tool、verification 与 lineage 展示;
- task eligibility/SFT-DPO-RLVR 派生视图;
- ingest、transform、export fidelity 与 ref flow;
- capability false 时隐藏 v2 入口，v1 页面继续可用。

> **GV14:** component tests 覆盖 ADR 0009 所有主要 variants；空/大 candidates、tool
> trajectory、supersession、fidelity warnings 与错误状态可读；generated client 无手写
> duplicate API types。

### V15 — Final gate

最终场景至少覆盖:

1. canonical JSONL ingest;
2. append candidates/signals/preferences;
3. preserve 与 derive transforms;
4. immutable snapshot/ref/run lineage;
5. SFT、DPO、RLVR 与 ms-swift export;
6. 两个 API instances 并发物化同一 dataset/layout;
7. writer crash 在 artifact 与 manifest 之间后的恢复;
8. detached export/import 保留 IDs 与 exact parent refs;
9. v1/v2 同时运行且 v1 golden 不变。

> **GV-final:** `pnpm lint && pnpm typecheck && pnpm test && pnpm openapi:check` 全绿；
> 独立进程/并发场景 versions 与 artifacts 可复现；PG 无 sample payload；v1 objects/tables/
> refs 未改变；文档与 `docs/v2/STATUS.md` 完整。

GV-final 通过后只允许把 v2 capability 从 false 改为 true。把 Web 默认入口切到 v2、
停用 v1 或生产部署，仍需独立 owner 决策。

## 6. 并行、关键路径与 PR 纪律

关键路径:

```text
V0 → V1 → V2 → V3 → V4 → V5 → V6 → V9 → V10/V11 → V12 → V14 → V15
```

可并行:

- V7 在 V2/V3 后可与 V4/V5 并行;
- V8 是 catalog-only additive migration，可在 V0 后开发，但只能在 V9 集成;
- V10 与 V11 在 V9 的基础生命周期稳定后可并行;
- V13 可在 V12 契约稳定后与 V14 并行。

纪律:

- 一个 Step 一个 PR，不跨 Step 偷跑;
- 每个 PR 更新 `docs/v2/STATUS.md`;
- 改 Zod wire contract 的 PR 同时重生成 OpenAPI/client;
- v2 fixture expected value 变化必须解释 profile/schema/layout migration，禁止直接 update
  snapshot 掩盖 drift;
- 任何使 v1 test 失败的改动都视为 regression，不以“v1 不再使用”为理由删除测试;
- V15 前不得把 v2 capability 默认打开。

## 7. 风险与固定回退

| 风险 | 首次验证 | 固定回退 |
|---|---|---|
| JCS 边界跨实现不一致 | V1 | 以 RFC 8785 vectors 为准，停止实现，不改 expected |
| nodejs-polars Parquet bytes 不稳定 | V5 | 换确定性 TS writer并定义新 layout，不放宽 artifact invariant |
| OSS conditional create SDK 行为不同 | V6 | 用官方 forbid-overwrite header 封装 adapter，真实 OSS gated test |
| JSON record layout 查询慢 | V10/V14 | 新增可重建 sidecar或未来 promoted layout，不改 canonical record |
| Catalog per-record lookup 慢 | V9 | object-store index sidecar，不把 payload放 PG |
| Converter 无法表达 mask/tool semantics | V11 | strict fidelity error，不静默降级 |
| v2 UI 未完成 | V14 | capability 保持 false，v1 UI 不受影响 |

## 8. 完成定义

只有同时满足以下条件，v2 实现才算完成:

- ADR 0009 的 logical schema 与全部 invariants 有 strict tests;
- ADR 0011 的 ID/digest/version/artifact vectors 与并发写协议全部过闸门;
- `record-json-v1` 有稳定 layout fixture 与跨进程 artifact digest;
- v2 catalog、store、workspace、API、CLI、Web 完整闭环;
- canonical、TRL SFT/DPO/GRPO-RLVR、ms-swift converter 通过 fidelity gates;
- v1 所有现有 tests、objects、tables 与 routes 保持兼容;
- 没有 sample payload 进入 Postgres，没有 Lance/Python/第三状态服务;
- `docs/v2/STATUS.md`、OpenAPI、generated client 与用户文档同步;
- owner 在 GV-final 后单独确认 capability enable/cutover，未确认前仍保持关闭。
