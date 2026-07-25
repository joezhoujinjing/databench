# ADR 0016 — Canonical Draft Raw Adapter Identity

- **状态:** Accepted——owner 于 2026-07-25 接受 canonical draft、identity 副作用与重放语义
- **日期:** 2026-07-25
- **决策者:** owner
- **依赖:** [ADR 0009](0009-canonical-post-training-record-v2.md)、
  [ADR 0011](0011-identity-hashing-versioning-v2.md)、
  [ADR 0015](0015-internal-agent-mcp-ingest.md)
- **详细方案:** [Databench MCP 最小可用技术方案](../mcp/TECHNICAL-DESIGN.md)
- **修订范围:** 仅为 `canonical-draft-jsonl-v1` 固定 machine-created run/event keys、owner
  skeleton、mapping order 与 fixed vectors；不发布新的通用 identity profile

## 背景

Canonical JSONL 必须携带合法的 `rec_*`、`cand_*`、`sig_*` 与 `pref_*` IDs。Agent 不能自行编造
这些 IDs。普通 Excel/CSV 又通常没有稳定的 provider generation run ID 或 annotation event key，
ADR 0011 对缺少这些 key 的在线创建默认使用 CSPRNG。

Canonical draft adapter 需要满足两个额外目标：相同 exact draft bytes 重放时产生相同 canonical
JSONL/dataset version；materialize 后再 import 必须 replay 同一组 immutable claims。为此，本 ADR
为这一种 adapter 定义由 raw artifact digest 与稳定 row/index 派生的 machine-creation keys。该规则
不得推广到其他 provider/raw adapter。

## 决策

### 1. Draft 是唯一的 canonical-shaped raw wire format

格式名固定为 `canonical-draft-jsonl-v1`，每个非空数据行镜像一个
`PostTrainingRecordV2`，只替换 Databench 管理的实体 IDs 与本地引用：

- record、candidate、signal、preference 没有 `id`；
- signal/preference `supersedes` 使用同数组更早的 `supersedes_index`；
- preference candidate refs 使用 `left_candidate_index` / `right_candidate_index`；
- 其余字段与 canonical schema 同义，不引入 SFT/DPO/RLVR 专用 DSL；
- optional defaults 在任何 identity request 或 canonical validation 前全部物化；
- `draft_schema_version` 只标识 raw wire schema，物化 canonical record 时删除。

它必须能表达 ADR 0009 当前完整 canonical 能力，包括 SFT、DPO、RLVR、tools、trajectory、signals、
preferences、verification、lineage、tags 与 extra。

### 2. Raw digest 与 row index 精确定义

```text
source_artifact_digest = blake3(exact uploaded request bytes)
```

- raw digest 是无 domain prefix 的 64 lowercase hex BLAKE3，与 ADR 0011 artifact byte checksum 语义
  一致；它不是 record/dataset digest；
- bytes 不做 Unicode、换行、空白或 JSON canonicalization；CRLF/LF、尾随换行和空行差异都会改变
  digest；
- UTF-8 BOM 拒绝，不参与一个“去 BOM 后”等价路径；
- parser 使用 1-based physical line 报错；identity 使用 0-based `data_row_index`；
- 空行或只含 JSONL whitespace 的行不产生 record，也不增加 `data_row_index`；
- 每遇到一个非空数据行，`data_row_index` 增加一，不使用 physical line number；
- 同一 dataset 内若物化出重复 record logical ID，继续由现有 Dataset uniqueness gate 拒绝。

### 3. Root identity 与 owner skeleton

每行先物化 draft defaults，并构造不含 managed IDs 的 root owner skeleton：

```text
root_initial_record = fully-defaulted canonical payload
root_initial_record.candidates = []
root_initial_record.preference_relations = []
```

除上述两个数组外，`schema_version`、shared contents、tools、verification、source、lang、lineage、
normalized tags 与 extra 全部使用最终值。Skeleton 必须通过现有
`InitialPostTrainingRecordV2Schema`，其 exact canonical bytes 进入 request digest fixed vector。

Root creation profile 固定为：

- `source.original_id != null`：使用现有 `source-root-v1`，seed 为 namespace +
  `source.name/kind/original_id`；
- `source == null` 或 `source.original_id == null`：使用现有 `artifact-row-v1`，seed 为 namespace +
  `source_artifact_digest + data_row_index`；
- draft adapter 不使用 `direct-root-v1` 或 `derived-record-v1`。

同 namespace 下复用相同 source identity 却提交不同 root skeleton，继续按 ADR 0011 返回
`claim_request_mismatch`，不能静默创建 revision。没有真正稳定且行级唯一的 upstream ID 时，agent
必须把 `source.original_id` 设为 null；例如电缆 fixture 中重复的 `SPU_ID` 只进入 namespaced extra。

### 4. Candidate identity 与 skeleton

取得 real record ID 后，按 candidate array index 顺序创建 candidate。Seed 固定为：

```text
record_id        = allocated root record ID
generation_run_id =
  "canonical-draft-jsonl-v1:<source_artifact_digest>:row:<data_row_index>"
output_index     = zero-based candidate_index
```

Candidate owner skeleton 为 fully-defaulted 最终 candidate payload，但固定 `signals=[]`；contents、
finish reason、rank、selected、generator、token count 与 avg logprobs 全部使用最终值。Skeleton 必须
通过现有 `InitialCandidateV2Schema`，其 canonical bytes 进入 request digest fixed vector。

Candidate array index 在本 adapter 中就是 immutable source output index。调整 candidate 顺序或修改
raw bytes 会产生新的 candidate creation keys，不能事后按 canonical array 位置猜测旧身份。

### 5. Signal 与 preference identity

Event seed 的 producer 复用现有 ADR 0011 约束，必须等于该 signal/preference 最终 payload 的
`source.id`：

```text
producer = initial_signal.source.id | initial_preference.source.id
```

Adapter 只固定下述 `producer_event_key`，不把 adapter 名覆盖到用户提供的 event source。

Signal 按 candidate index、signal index 顺序创建：

```text
owner_id = allocated candidate ID
producer_event_key =
  "canonical-draft-jsonl-v1:<source_artifact_digest>:row:<data_row_index>" +
  ":candidate:<candidate_index>:signal:<signal_index>"
```

Preference 按 preference index 顺序创建：

```text
owner_id = allocated record ID
producer_event_key =
  "canonical-draft-jsonl-v1:<source_artifact_digest>:row:<data_row_index>" +
  ":preference:<preference_index>"
```

创建 signal/preference request 前，先把 candidate indexes 与 earlier supersedes indexes 解析成已分配
的 real IDs；initial payload 使用最终字段。所有 index 必须在同一 record 的正确 owner 数组内，
supersedes 只能指向同数组更早事件，继续满足 ADR 0009 的语义匹配与单后继不变量。

本节只给现有 `candidate-v1`、`signal-event-v1`、`preference-event-v1` requests 提供稳定 key；
`producer` 与 initial event source 的一致性继续由现有 schema 校验。不修改 entity ID domain、claim
profile、request profile 或 seed schemas。

### 6. Claim 顺序与最终 revision

每个 data row 的 machine-creation 顺序固定为：

1. root claim，使用 root owner skeleton；
2. candidate claims，按 candidate index；
3. 每个 candidate 的 signal claims，按 candidate index 后 signal index；
4. preference claims，按 preference index；
5. 组装包含全部 real IDs/references 的完整 `PostTrainingRecordV2`；
6. 运行全部 canonical cross-field invariants并创建最终 opaque revision。

Root/candidate skeleton 是该 adapter 的创建审计 payload，不是额外发布的 record revision。最终
dataset/materialized JSONL 只包含第 5-6 步的完整 canonical record。

Claim 是 immutable 且逐项写入。后续 claim conflict、capacity error、abort 或 response failure 可能
留下没有被 dataset 引用的已成功 claims；不得删除、覆盖或改配给其他语义。Import 只有全文件校验、
claim plan 与 Workspace publish 全部成功后才返回 dataset；首期不移动 ref。

### 7. Preview、materialize 与 import

- preview 使用仅限内存的 synthetic IDs 完成全部 canonical invariants；不访问 namespace/claim，
  不返回 synthetic IDs，不写 PG/object/dataset/ref；
- materialize 使用 real claims，seal 完整 canonical JSONL 后才开始响应，不发布 dataset/ref/object；
- import 使用同一 identity planner/allocator，成功后发布 immutable dataset，不更新 ref；
- materialize 后用相同 exact bytes import 必须全部 claim replay，并得到与已交付 JSONL 相同 IDs；
- 相同 exact bytes、namespace 与既有 claims 重放必须得到相同 IDs、record digests、canonical output
  与 dataset version；
- 任何 raw byte 或 array-order 变化都视为新的 adapter input；source-root record ID 可能保持不变，
  但 candidate/event keys 仍因 artifact digest/index 改变；普通 claim conflict规则继续适用。

`expected_input_digest` 是可选 transport guard，不进入任何 identity preimage。无论是否 preview，
identity 都使用服务端对本次 exact uploaded bytes 计算的 `source_artifact_digest`。

### 8. Fixed vectors 与变更纪律

M1b2 在写 allocator 前必须提交并锁定以下 fixtures；golden 必须直接断言 canonical bytes 与 expected
hex，不能只断言两次运行相同：

1. `canonical-draft-sft-v1`：source-root 与 artifact-row 两种 root 路径；
2. `canonical-draft-dpo-v1`：两个 candidates、双 candidate skeleton 与 preference relation；
3. `canonical-draft-rlvr-v1`：verification、signals、signal supersession 与 event IDs；
4. raw UTF-8 bytes、BOM reject、LF/CRLF、空行、无尾 LF 与 data-row/physical-line 边界；
5. root/candidate owner skeleton canonical bytes；
6. generation run/event exact strings；
7. 每个 entity ID、claim key digest、request digest、record canonical bytes、record digest、materialized
   canonical JSONL bytes 与 dataset version；
8. exact replay、materialize → import replay、candidate/event reorder、changed initial semantics conflict；
9. TypeScript 实现与独立 RFC 8785/BLAKE3 实现对相同 preimages 得到相同 hex。

Fixture 文件名、输入 bytes 与 expected bytes/hex 一经 M1b2 gate 通过即不可更新来掩盖 drift。任何会
改变本 ADR 中 seed、key、skeleton、default、row/index 或 materialization order 的调整，都必须先
修订 ADR 并解释已分配 identity 的兼容/迁移策略。

## 非目标

- 为其他 provider/raw format 定义通用 deterministic run/event key；
- 改变 `databench-v2-jcs-1`、entity ID formulas、claim/request profiles；
- 让 agent 提供 canonical managed IDs；
- 从语义相同但 bytes 不同的文件推断同一 candidate/event；
- 在 preview 中预占 claim 或承诺 preview 后不会发生并发冲突；
- 删除 materialize-only 或失败流程留下的 immutable claims。

## 后果

- **+** Excel/CSV 经同一 canonical draft 可以覆盖完整 post-training 数据结构；
- **+** exact bytes 重放、materialize 后 import 与响应丢失重试具有确定结果；
- **+** 沿用 ADR 0011 现有 domains/profiles，不创建平行 identity 系统；
- **−** raw whitespace、换行或 array 顺序变化可能产生新的 candidate/event identities；
- **−** materialize-only 不是无写操作，会永久增加 immutable identity claims；
- **−** claim 写入不可回滚，失败流程可能留下安全但未被 dataset 引用的控制面状态。
