# ADR 0011 — v2 身份、哈希与版本

- **状态:** 已接受——owner 于 2026-07-23 确认；v2 技术方案与实施计划均已接受
- **日期:** 2026-07-23
- **决策者:** owner
- **依赖:** [ADR 0009](0009-canonical-post-training-record-v2.md)
- **修订范围:** `docs/conventions.md` 中的确定性规则、ADR-0003/0008 的 v2 对象 key
  与不可变写入协议、ADR 0009 的精确 parent revision 表达；v1 golden 与现有对象保持不变

## 背景

ADR 0009 已经确定 v2 使用单一 `PostTrainingRecord`。一条逻辑记录会持续增加 candidate、
signal、preference relation、selection 与 lineage，但发布的数据集版本必须不可变、可复现，
并且能够验证对象存储中的 Parquet 是否损坏。

v1 同时使用了三种相近但不同的值:

- sample `id` 是任务 payload 的内容哈希;
- `row_digest` 额外混入 source、meta 与 signals;
- dataset `version` 是排序后的 row digests 的无序哈希，空集固定为
  `hashText("empty")`。

这套规则为了旧 Python parity 已经正确实现，但不适合 v2。若 v2 继续把 record ID
直接等同于完整内容哈希，那么追加一个 judge signal 就会让 record、candidate sidecar 与
人工审核引用全部换 ID；反过来，如果只保留稳定 ID 而没有内容摘要，就无法证明某个 ID
在特定数据集版本中对应的精确内容。

物理文件身份也不能继续与逻辑 dataset version 混为一谈。同一组逻辑 records 可以使用
不同 Parquet writer、压缩参数或 layout 物化；逻辑数据没有改变，但文件字节会改变。

因此 v2 必须明确拆开四个概念:

```text
logical ID       —— 这是谁，允许跨 revision 稳定
record digest    —— 这个 revision 的精确 canonical 内容是什么
dataset version  —— 这个不可变数据集包含哪些 record revisions
artifact digest  —— 对象存储中的这份 Parquet 精确是哪一串字节
```

## 决策

### 1. Logical ID 与内容摘要分离

`PostTrainingRecord.id`、Candidate ID、Signal ID 与 PreferenceRelation ID 是稳定的
logical ID，不是完整对象的内容哈希。它们分别使用以下 canonical 格式:

```text
rec_<64 lowercase hex>
cand_<64 lowercase hex>
sig_<64 lowercase hex>
pref_<64 lowercase hex>
```

v2 首个 identity profile 固定为:

```text
IDENTITY_PROFILE = "databench-v2-jcs-1"
```

该 profile 同时固定本 ADR 的 canonical JSON、hash domain、seed schema、record digest 与
dataset version 公式。统一派生函数为:

```text
entity_id = prefix + blake3(
  utf8(
    "databench.id." + IDENTITY_PROFILE + "." + entity_kind + ".v1\0" +
    canonicalJsonV2(seed)
  )
)
```

每种 seed 都必须有具备版本号的 strict Zod schema；调用方不能向 seed 临时塞字段或使用
开放 `extra` 影响身份。`entity_kind.v1` 是 seed profile 的版本边界。Seed 是生成身份
所需的稳定输入，不是实体的完整可变内容:

- 所有 root seed 先加入稳定、非秘密的 organization/workspace identity namespace，避免
  不同租户使用相同 source 名称或 idempotency key 时碰撞；canonical v2 ID 被导出后
  原样保留，不能在目标 workspace 重新生成;
- 有稳定 `source.name/kind/original_id` 的根记录，seed 使用 namespace + source identity;
- 没有 original ID 的文件导入，seed 使用 namespace + source artifact digest + 从零
  开始的原始行号;
- 直接创建使用 namespace + 客户端 idempotency key；调用方没有提供时，系统生成
  256-bit CSPRNG seed，ID 一旦分配便永久保存，重试不保证合并为同一实体;
- 确定性派生操作的新 record 使用 op、op version、完整规范化 params、按语义顺序排列的
  parent logical IDs 与 output index；params 必须先通过该 op 具备版本号的 strict schema，
  不能省略“只影响输出、不影响身份”的参数;
- parent revision 不进入 derived record logical ID：相同 op/version/params 对同一组
  logical parents 的后续 revisions 再运行时，产生同一 derived logical record 的新
  revision；精确 parent revisions 由本 ADR 第 8 节的 `parent_refs` 固定并参与 record
  digest。Derived identity claim只审计首次 logical ID分配；后续 parent revision改变时，
  不能因为完整初始 record或 `request_digest` 改变而拒绝该 logical ID的新 revision;
- candidate 使用 record ID、不可变 generation run ID 与该 run 内稳定的 output index；
  generation run 必须固定模型、参数与输出排序，不能使用 candidate 当前所在数组的位置;
- signal/preference relation 使用所属实体 ID 与稳定 producer event key。Producer 有
  原生 event/annotation ID 时必须使用；批处理 run 可以使用不可变 run ID + 稳定 output
  index；在线创建使用客户端 event idempotency key，没有提供时生成 256-bit CSPRNG
  seed。当前 append position 永远不参与事件 ID。

同一 namespace 下，root/direct/candidate/event 等一次性创建重复使用相同 create
idempotency key、却提交不同初始语义内容时必须返回 typed conflict，不能把第二个请求静默
当作已有实体的 revision。`derived-record-v1` 按上一条规则复用 logical ID，不适用该冲突规则。

机器生成的 ID 必须按上述函数产生。Canonical import 可以保留已经符合对应格式的 v2
ID；外部系统自己的 ID 放入 `source.original_id` 或 provenance，不能直接冒充 canonical
ID。Function-call ID、`SignalSource.id` 与 provider/run identifiers 是 opaque reference，
只遵守 ADR 0009 的非空、唯一与引用规则，不采用上述实体 ID 格式。

每个操作必须显式声明 identity mode:

- `preserve`:给同一逻辑 record 增加 candidate、evidence、selection、tags 或修正
  provenance，保留 record ID;
- `derive`:改变共享 prompt/system instruction，拆分、合并或产生新的逻辑训练实例，按
  operation seed 生成新 record ID，并通过 lineage 指向父记录。

同一 record ID 可以在不同 dataset snapshots 中对应不同 record digest，但同一个
dataset version 内最多出现一次。

### 2. v2 Canonical JSON 采用 RFC 8785 JCS

所有 v2 identity 输入必须先通过 strict Zod schema，再使用
`@databench/hashing` 提供的 `canonicalJsonV2`。v1 `canonicalJson` 与 Python golden
在切换完成前保持原样，禁止为了 v2 直接改变其输出。

`canonicalJsonV2` 必须逐字节实现
[RFC 8785 JSON Canonicalization Scheme（JCS）](https://www.rfc-editor.org/rfc/rfc8785)，
不能只实现一个“看起来稳定”的 `JSON.stringify` 包装。进入 JCS 前与输出时的完整规则为:

1. 输入只能包含 object、array、string、finite number、boolean 与 `null`；拒绝
   `undefined`、BigInt、Date、函数、symbol、循环引用、NaN 与 Infinity。
2. 原始 JSON reader 在进入 Zod 前拒绝重复 object key，不能接受“最后一个 key 胜出”。
3. 所有字符串必须是合法 Unicode scalar-value sequence；拒绝 unpaired/lone UTF-16
   surrogate。字符串不做 NFC/NFKC、trim 或换行归一化，escaping 严格采用 RFC 8785
   §3.2.2.2。
4. Object property 按 RFC 8785 §3.2.3 的 UTF-16 code-unit 规则递归排序；array 顺序
   原样保留。实现不得替换成 Unicode code point 排序或 locale-sensitive comparator。
5. Number 按 RFC 8785 §3.2.2.3 引用的 ECMAScript/IEEE-754 binary64 算法序列化；
   `-0` 归一为 `0`，`1.0` 归一为 `1`，指数的切换阈值、正号与格式均按该规范。v2
   不保留 v1 的 int/float JSON lexeme 差异。
6. Schema 声明为 integer 的字段必须是 safe integer。开放 JsonValue 需要精确表达超出
   safe range 的整数时必须使用 string。
7. `null` 永远保留；schema 默认值在 hashing 前全部物化，hash 输入中不存在缺字段与
   `undefined` 两种等价表达。
8. `tags` 是唯一由 writer 规范化的集合型数组：先去重，再使用与 JCS property 相同的
   UTF-16 code-unit comparator 排序。contents、parts、candidates、signals、relations、
   tools、parent refs、steps 与开放 JSON 中的所有数组都保留原顺序，因为顺序具有对话、
   事件、生成环境或 provenance 语义。
9. 输出使用 UTF-8、无 BOM、无额外空白或尾随换行。

`databench-v2-jcs-1` 是完整 identity profile，而不只是一个 serializer 标签。任何会
改变以上字节、hash domain 或 preimage envelope 的调整都必须发布新的 identity profile，
不能作为普通实现修复静默上线。原 profile 下已经分配的 logical IDs 永远保留；新 profile
只控制新 ID 的创建与新 revision/version 的摘要。

### 3. Record digest 覆盖完整 Canonical Record

Record digest 的定义为:

```text
record_json   = canonicalJsonV2(strictRecord)
record_digest = blake3(utf8(
  "databench.record." + IDENTITY_PROFILE + "\0" + record_json
))
```

输出是 64 位小写十六进制。`record_digest` 是物理 Parquet/Arrow 投影与内部 API 的派生
字段，不写回 `PostTrainingRecord`，从而避免自引用。

除 `record_digest` 本身不存在于 record 外，不设置排除字段。以下内容全部参与摘要:

- `schema_version` 与 logical `id`;
- system instruction、contents、parts、tools 与 verification;
- candidates、rank、selected、signals 与 preference relations;
- source、lang、lineage、tags、extra;
- event timestamps、rationale、generator 与所有开放 JsonValue。

因此追加 signal、改变 selected、修正 source、调整数组顺序或修改 extra 都会改变
record digest。两个内容完全相同但 logical ID 不同的 records 也有不同 digest；语义
去重是独立能力，不复用 identity digest。

### 4. Dataset version 是 record revisions 的无序集合摘要

一个 v2 dataset snapshot 必须满足:

- 所有 record digests 使用同一个精确 `identity_profile` 计算;
- 所有 records 使用同一个精确 `schema_version`;
- record logical ID 在 dataset 内唯一;
- 每行 strict validation 与重新计算的 record digest 均通过。

Dataset version 定义为:

```text
digests = record_digests 按 ASCII 小写 hex 升序排序
dataset_identity = {
  identity_profile: IDENTITY_PROFILE,
  record_schema_version: exact_record_schema_version,
  record_digests: digests
}
dataset_json = canonicalJsonV2(strictDatasetIdentity)
preimage = utf8(
  "databench.dataset." + IDENTITY_PROFILE + "\0" + dataset_json
)
dataset_version = blake3(preimage)
```

`strictDatasetIdentity` 是具备版本号的 strict Zod schema，字段固定为以上三项。输出同样
是 64 位小写十六进制。Profile 与精确 record schema version 直接参与 preimage，而不是
仅依赖非空 record digests 间接携带，因此不同 schema/profile 的空数据集也不会碰撞。

在 `IDENTITY_PROFILE="databench-v2-jcs-1"`、`record_schema_version="2.0.0"` 时，空
dataset 的 canonical envelope 为:

```json
{"identity_profile":"databench-v2-jcs-1","record_digests":[],"record_schema_version":"2.0.0"}
```

对应固定 version 为
`da99cf8da850355f9bae66e9c38a2c61f62e7d59d7aa43a4ff6151bcdae8fefd`。它刻意不沿用
v1 的 `hashText("empty")`；此项只修订 v2，v1 golden 常量保持不变。任何 schema/profile
组合的 empty version 都必须由同一公式计算，不能再使用一个跨版本全局 empty 常量。

Dataset 是无序集合:Parquet 行顺序、导入遍历顺序、dataset name、catalog timestamps、
ref name、物理 layout 与压缩参数不参与 version。任何依赖稳定顺序的 export 必须按
record digest 排序，或使用显式、具备版本号的 seeded ordering policy，不能依赖物理
Parquet 行号。

不同 logical IDs 的内容重复记录允许存在，它们的 record digests 不同；是否合并由独立
dedup policy 决定。相同 logical ID 的两个 revisions 不能同时进入一个 snapshot。

### 5. Record revision 与 Dataset snapshot 都不可变

任何已发布的 `(record_id, record_digest)` 与 dataset version 都不可原地修改:

1. 读取旧 record，执行显式 operation;
2. 按 identity mode 保留或派生 logical ID;
3. 生成新的 strict canonical record 与 record digest;
4. 物化包含新 revision 的新 dataset version;
5. 成功写入对象与 catalog 后，按需原子移动 mutable ref。

Signal/PreferenceRelation 在 record 内 append-only，不意味着包含 record 的物理行原地
append；它表示新 revision 保留旧事件并追加新事件。旧 dataset snapshot 与旧 Parquet
始终可读取。

Ref 是唯一正常可变的用户级指针。更新 ref 不改变任何 dataset version；catalog 必须在
事务中移动 ref，失败时继续指向旧版本。

### 6. Schema 演进必然产生新的内容摘要

`schema_version` 参与 record digest。即使业务字段看似相同，把 record 从 `2.0.0`
规范化为 `2.1.0` 也会产生新的 record digest 和 dataset version。

Schema migration 必须:

- 保留 logical record/candidate/signal/relation IDs，除非 migration 明确创建新实体;
- 读取旧 fixture，经新 strict writer 物化全部默认字段;
- 重新计算 record digests 与 dataset version;
- 记录 migration operation、版本、输入 dataset version 与输出 dataset version;
- 绝不宣称跨 schema version 的 digest 相等。

Patch 版本不强制改写已有 records；只有被新 writer 重新发布的 record 才携带新 patch 并
得到新 digest。Identity profile 本身改变时必须通过新 ADR 与显式迁移，不能只提升
schema patch/minor。

### 7. Logical dataset version 与 Parquet artifact digest 分离

Parquet artifact digest 定义为:

```text
artifact_digest = blake3(raw_parquet_bytes)
```

它验证精确文件字节，不参与 logical dataset version。v2 manifest 至少包含:

```ts
interface DatasetManifestV2 {
  manifest_version: '2.0.0'
  identity_profile: 'databench-v2-jcs-1'
  dataset_version: string
  record_schema_version: string
  hash_algorithm: 'blake3'
  num_records: number
  layout_version: string
  artifact_digest: string
  columns: string[]
}
```

Manifest 不包含 dataset name、created/updated time、ref 或临时上传信息；这些是 catalog
元数据，不能让同一个 logical snapshot 产生不同 manifest bytes。Manifest 必须通过
strict Zod schema 后使用 `canonicalJsonV2` 序列化；manifest object key、字段插入顺序或
普通 `JSON.stringify` 的空白选择都不能改变其 bytes。

v2 首期仍只有一份被 manifest 引用的 Parquet，但 Parquet blob 使用自己的 artifact
digest 寻址，manifest 是 `(dataset_version, layout_version)` 的唯一提交点:

```text
objects/v2/<layout_version>/<vv>/<dataset_version>/<artifact_digest>.parquet
objects/v2/<layout_version>/<vv>/<dataset_version>/manifest.json
```

其中 `<vv>` 是 dataset version 的前两位。写入协议固定为:

1. writer 先在本地完成 Parquet bytes、`artifact_digest` 与 canonical manifest bytes；
2. 使用 object-store conditional create 写 artifact，禁止普通覆盖式 PUT：
   S3/MinIO 使用 `If-None-Match: *`，Aliyun OSS 使用
   `x-oss-forbid-overwrite: true`；artifact 已存在时只有在确认已有 bytes 的 BLAKE3 与
   key 一致后才可继续，不能仅凭 key 名假定内容正确;
3. artifact 成功存在后，使用同样的 conditional create 写固定 manifest key，manifest
   创建成功是 snapshot/layout 的提交点;
4. manifest 已存在时，writer 读取并 strict-validate；若 canonical bytes 完全相同则是
   幂等成功，若 `dataset_version`、profile、schema、layout 或 `artifact_digest` 任一
   不同则抛 typed conflict，绝不覆盖;
5. 只有 manifest 提交成功后才能注册 catalog layout；只有对象与 catalog 都完成后才能
   移动 ref。

两个并发 writer 即使产生不同 artifact digest，也只会留下至多一个已提交 manifest；
失败 writer 的未引用 artifact 是可回收 orphan，不能被 reader、catalog 或 ref 当成已
发布 layout。同一个 `(dataset_version, layout_version)` 必须最终只提交一个 artifact
digest；Parquet writer、Arrow schema、压缩或任何会改变字节的编码规则变化时提升
`layout_version`，同一 logical dataset 可以并存多个物理 layout。

`exists` 先读取并 strict-validate 小型 manifest，再对其引用的 artifact 做 HEAD；只有
两者存在且 manifest 与请求的 version/layout/profile/schema 一致时才返回 true，不为一次
布尔探测下载整个 Parquet。writer 在首次上传和 crash recovery 时校验 digest；reader 与
显式 audit 在消费 bytes 时重新计算 artifact digest，发现不一致必须抛 typed integrity
error。本节针对 v2 修订 ADR-0008 的旧 `objects/<vv>/<version>` key 与普通覆盖式 PUT；
v1 objects 不迁移、不覆盖。

### 8. Catalog、Run、Ref 与 Sidecar 的身份边界

Postgres 仍只保存控制面元数据，不保存 sample payload。v2 catalog 至少记录 dataset
version、record schema version、identity profile、num records、可用 layout 与 artifact
digest、生命周期时间。name、description 与 created time 不参与 dataset version。

Run/transform cache 使用独立 domain-separated key:

```text
cache_key = blake3(utf8(
  "databench.transform-cache." + IDENTITY_PROFILE + "\0" +
  canonicalJsonV2({
    identity_profile: IDENTITY_PROFILE,
    op,
    op_version,
    input_dataset_versions,
    params
  })
))
```

上述 envelope 与每个 op 的 params 都必须经过具备版本号的 strict Zod schema。Input
dataset version 的数组顺序保留；会把 inputs 当集合的 operation 必须在自己的参数规范中
显式排序。相同 cache key 只能对应一个 output version，冲突是确定性错误。

本 ADR 对 ADR 0009 的 `Lineage.parent_ids` 作规范性修订，改为直接保存精确 parent
revision:

```ts
interface ParentRevisionRef {
  id: string
  record_digest: string
}

interface Lineage {
  parent_refs: ParentRevisionRef[]
  recipe: string | null
  recipe_revision: string | null
  run_id: string | null
  steps: TransformationStep[]
}
```

`parent_refs` 按语义输入顺序保存；每个 `id` 必须是 canonical record ID，每个
`record_digest` 必须是 64 位小写 hex。同一 parent logical ID 不能重复，child 不能引用
自己的 logical ID。父 payload 可用时必须重新计算并验证 digest；暂时不可用时保留为
unresolved exact ref，不能伪造 payload 或解析到另一个 revision。精确 parent identity
不依赖 `run_id` 或当前 workspace catalog，因此 `run_id=null` 的导入/人工操作和脱离原
catalog 的 canonical export 仍能携带不可歧义的父 revision 身份。

`run_id` 在存在时提供 operation 审计入口，catalog run 继续保存不可变 input/output
dataset versions，但它不再代替 record 级 parent revision。Dataset 级 lineage永远使用
不可变 dataset versions，不能只使用 mutable refs。Catalog 必须能通过
`(record_id, record_digest)` 定位已知 revision；导入暂时没有本地 parent payload 时可以
保留 unresolved ref，但不得把另一个 digest 的 revision 当成该 parent。

Revision-specific sidecar 的 join key 至少是 `(dataset_version, record_id)`；candidate
sidecar 再追加 candidate ID。只用稳定 record ID 连接 sidecar 会把不同 revisions 的
证据混在一起，被禁止。

### 9. Hash 输入与凭证、时间、环境隔离

- Canonical records 不包含密钥、signed URL、主机绝对路径或临时 endpoint；ADR 0009
  已定义的 URI、Tool、Verification 与 provenance 规则继续强制。
- Catalog lifecycle timestamps 使用数据库时间，不参与 record digest 或 dataset version。
- Signal/relation `created_at` 是 canonical evidence，已经进入 record，因此参与 digest。
- Hash 结果不得依赖 locale、timezone、Node process env、CPU 架构、Parquet writer 或
  object-store provider。
- 所有 hash 入口只能来自 `@databench/hashing`；业务包禁止直接调用第三方 BLAKE3 或用
  裸 `JSON.stringify` 构造 hash preimage。
- File/Parquet 的 raw-byte digest 是完整性 checksum，不是 logical identity preimage，
  因此不添加 domain prefix；其算法与用途由 `FileDigest` 或 manifest 显式标识。

### 10. 必须提供可跨实现复现的测试向量

实现前必须先提交 fixtures 与固定 expected values，至少覆盖:

1. Entity ID 的四个 prefix、identity profile/domain separation，以及不同 op params
   产生不同 derived record ID;
2. Signal/PreferenceRelation 的 producer event key 幂等，且 append/reorder 不改变事件
   ID;
3. RFC 8785 UTF-16 property 排序，覆盖 BMP/astral 交界、Unicode 字符串不归一化、
   control/U+2028/U+2029 escaping、null 与嵌套 JsonValue;
4. unpaired/lone surrogate、重复 JSON key、undefined、BigInt、Date 与循环引用拒绝;
5. `1`/`1.0`、`-0`、`1e-7`、`1e21`、safe integer 边界与非有限数字拒绝;
6. tags 使用 JCS comparator 去重排序，但 contents/candidates/signals/tools/parent refs
   顺序保留;
7. 全字段 record digest，包括 selected、timestamps、extra、schema version、
   identity profile 与精确 parent revision 的变化;
8. dataset 行顺序不影响 version，record 内容变化必然影响 version;
9. `2.0.0` 空 v2 dataset 使用本 ADR 固定 version，与 v1 empty version 及其他
   schema/profile 的 empty version 不同;
10. 相同 logical ID 的两个 revisions 同 dataset 被拒绝;
11. schema migration 保留 logical IDs、更新 digests/version;
12. detached canonical export 只凭 `parent_refs` 即可确认精确父身份，不依赖原 catalog;
13. Parquet artifact digest 验证、两个不同 artifact 的并发 conditional create、
    manifest commit 胜者与 typed layout conflict;
14. TypeScript 与至少一个独立 JCS/BLAKE3 实现对相同 UTF-8 preimage 得到相同 canonical
    bytes 与 64 位 BLAKE3 hex。

Golden tests 必须直接断言 canonical bytes 与 hex，不只断言“两次运行相等”。Property
tests 覆盖 object key 插入顺序、dataset row permutation 与非法值。任何 hash profile
变更都必须有 migration fixture，不能更新 expected value 来掩盖 drift。

## 不变量

Strict v2 实现至少强制:

1. Record/Candidate/Signal/PreferenceRelation ID 符合各自 prefix + 64 hex 格式。
2. 同一 logical ID 在一个 dataset snapshot 内唯一。
3. 所有 logical identity preimage 显式绑定 `IDENTITY_PROFILE`；Record digest 来自完整
   strict record，64 hex，且不作为 record 字段参与自哈希。
4. Dataset version 由 identity profile、精确 record schema version 与排序后的 record
   digests 共同产生，物理行序无关。
5. 每个 schema/profile 组合的 empty version 使用完整 dataset envelope 公式，不复用 v1
   empty 常量或跨版本全局常量。
6. 已发布 record revision、dataset snapshot 与 layout manifest 都不可覆盖；artifact 与
   manifest 创建必须使用 object-store conditional create。
7. Ref 可变，但只能指向已完成对象写入与 catalog 注册的 dataset version。
8. Schema version 参与 digest；migration 保留 logical ID 但重新计算所有内容地址。
9. Artifact digest 来自原始 Parquet bytes 并进入 artifact key；同 version/layout 只能有
   一个已提交 manifest，不同 digest 是 conflict。
10. Record lineage 使用 `(parent id, parent record digest)`，dataset/run lineage 使用
    immutable dataset versions；Sidecar join 必须包含 dataset version。
11. Hash preimage 不包含 secret、环境状态或 catalog lifecycle time。
12. 所有 digest 与 cache key 都通过 `@databench/hashing` 的具名 domain API 计算。

## 非目标

本 ADR 不决定:

- v2 Arrow/Parquet 的具体嵌套列类型与压缩参数；它们属于 `layout_version`;
- API route、分页、前端 ID 展示或 ref 命名 UI;
- dedup/semantic hash、MinHash、embedding 或近似重复策略;
- 跨组织全局 source registry;
- v1 record/dataset ID 到 v2 logical ID 的自动兼容映射;
- 数据保留、GC、ref protection 与 artifact layout 淘汰策略。

以上实施顺序、package 变更、migration 与验收门由 `docs/v2/PLAN.md` 决定。

## 后果

- **+** 同一逻辑 record 可以追加证据而保持 ID，任何 revision 仍有不可伪装的内容摘要。
- **+** Dataset version 与物理 Parquet 编码解耦，可在不改变逻辑版本的情况下增加 layout。
- **+** Schema migration、sidecar join、lineage 与 ref 更新都有明确的 immutable 边界。
- **+** Logical identity 的 domain separation 与显式 profile、raw artifact checksum 的
  manifest 标识，共同避免 entity、record、dataset、artifact 与 cache key 相互误用。
- **−** v2 identity 不再与 v1 Python golden 对拍，需要新的固定 fixtures。
- **−** 每行增加 record digest，catalog/store 需要理解 schema、identity 与 layout version。
- **−** Stable logical ID 使完全相同内容的不同实体仍有不同 digest；dedup 必须作为独立
  显式操作实现。
- **−** Re-encoding Parquet 必须提升 layout version 或复用已有 artifact，不能静默覆盖。

## 取代与保留

本 ADR 已接受，因此:

- 取代 v2 对 v1 `sampleId`、`rowDigest`、`hashUnordered` dataset version 与
  `hashText("empty")` 的直接复用;
- 修订 ADR-0008 的 v2 object key 与写入协议，v1 `objects/<vv>/<version>` 保持只读兼容;
- 将 ADR 0009 的 `Lineage.parent_ids` 修订为 revision-specific `parent_refs`;
- 保留 BLAKE3、`@databench/hashing` 单一入口、Postgres 控制面 + 对象存储数据面、
  sample 不入 Postgres、write-once objects、refs 与 runs 的架构;
- 保留 ADR 0009 的 strict writer、compatible reader、append-only evidence 与 Zod
  单一逻辑 schema 决策。
