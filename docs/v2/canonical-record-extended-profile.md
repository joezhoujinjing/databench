# Canonical Post-training Record v2 扩展设计参考

- **状态:** 设计参考，非 normative schema
- **日期:** 2026-07-23
- **基线:** [ADR 0009](../decisions/0009-canonical-post-training-record-v2.md)
- **用途:** 保留完整设计空间，供 v2.0 上线后的实际需求评估；不得据此向 v2.0
  canonical writer 增加字段

## 1. 文档定位

ADR 0009 定义 v2.0 首发必须实现的最小 canonical record。本文件记录评审过程中形成、
但被有意移出首发范围的扩展字段和 part variant。

这里的设计不代表已经承诺实现，也不改变 ADR 0009。任何扩展进入正式 schema 前，必须:

1. 有真实数据或产品流程证明最小结构无法无损表达需求；
2. 明确 canonical 字段与 sidecar、catalog 元数据或物理派生列的边界；
3. 定义 Zod 校验、不变量、哈希/身份影响与 converter 保真行为；
4. 通过新 ADR 或修订 ADR 0009 正式接受；
5. 按 schema 兼容性规则增加，不能重新解释或复用已有字段。

## 2. 完整候选顶层结构

以下结构展示 v2.0 最小字段与候选扩展字段的组合。标记为“候选扩展”的字段不属于
v2.0 writer 契约。

```ts
interface ExtendedPostTrainingRecord {
  // v2.0 核心字段
  schema_version: string
  id: string
  system_instruction: string | null
  contents: Content[]
  candidates: Candidate[]
  preference_relations: PreferenceRelation[]
  tools: Tool[]
  verification: Verification | null
  source: SourceInfo | null
  lang: string | null
  lineage: Lineage | null
  tags: string[]
  extra: JsonObject

  // 候选扩展；不属于 v2.0
  created_at?: string | null
  updated_at?: string | null
  quality?: Record<string, number>
  dedup_key?: string | null
  annotation?: AnnotationState | null
}
```

### 2.1 `created_at` / `updated_at`

原意是记录业务时间与更新时间。首发移除的原因是 canonical record、catalog object、
导入 source 与 append-only evidence 各自可能有不同时间语义；两个泛化时间戳容易被
错误用于身份、排序或审计。

只有在时间语义、生成主体、是否参与哈希、更新规则与时区格式全部明确后，才能加入。
在此之前，signal、preference relation 等事件保留各自的 `created_at`，catalog 管理
对象生命周期时间。

### 2.2 `quality`

原意是保存为了过滤或 mixture 构建而提升到 record 级的聚合指标。首发移除的原因是它
会复制 candidate signal，且如果缺少 metric、版本、方向和聚合策略，数值无法复现。

首发应从具名 signals 通过版本化策略派生质量指标。若查询性能需要，可先把结果作为
可重建的 Parquet 物理列或 sidecar。只有出现跨流程稳定、定义明确的 record-level
指标时，才考虑把带 provenance 的聚合对象纳入逻辑 schema，而不是恢复无类型 number
map。

### 2.3 `dedup_key`

原意是暴露稳定去重键。首发移除的原因是去重可能基于文本、规范化内容、MinHash、模型
embedding 或业务键，不存在一个天然通用的 key；同时它与后续身份/哈希 ADR 高度耦合。

去重签名、bucket 与重复对图首发进入 sidecar 或物理派生列。只有去重算法、版本、输入
范围和碰撞语义明确后，才考虑使用结构化的 `DedupEvidence`，不能只增加裸字符串。

### 2.4 `annotation`

原意是保存标注/审核工作流状态。首发移除的原因是工作流状态属于可变控制面，而
canonical record 应保留已经形成的数据与证据。候选的 `selected`、signals、
preference relations 足以表达首发训练选择及判断结果。

任务领取、分配、草稿、锁定、退回等 UI 状态应存入 catalog 或标注 sidecar。只有某个
最终审核结论必须随数据发布且无法由现有证据表达时，才考虑增加不可变、带来源的 review
event，而不是一个可覆盖的状态对象。

## 3. 候选 Part 扩展

v2.0 writer 仅支持:

```ts
type Part =
  | TextPart
  | FunctionCallPart
  | FunctionResponsePart
  | FileDataPart
```

以下 variant 保留为未来设计方向，不属于 v2.0:

```ts
type ExtendedPart =
  | Part
  | InlineDataPart
  | ExecutableCodePart
  | CodeExecutionResultPart
```

### 3.1 `inline_data`

用于直接携带小型二进制或编码后的多模态数据。首发已有 `file_data`，可以用不可变摘要
引用对象存储中的资源，避免放大 record、Parquet 与 API payload。

只有确有离线单文件交换、低延迟内联或目标 provider 强制内联等需求，并明确 MIME、
编码、大小上限、摘要和 canonical serialization 后，才应加入。

### 3.2 `executable_code`

用于保存模型生成且预期被执行的代码。普通代码文本仍可由 `text` 表达；单独 variant
只有在语言、执行意图、sandbox 配置与调用身份需要成为结构化语义时才有价值。

加入前必须定义它与 `function_call` 的边界、安全模型、语言枚举及 converter 降级规则。

### 3.3 `code_execution_result`

用于保存上述代码执行的结构化结果。首发可将受控执行器建模为 tool call/response；
独立 variant 只有在需要标准化 stdout、stderr、exit code、产物与资源使用信息时才加入。

它必须引用此前的执行请求 ID，并定义输出大小上限、大型产物的 `file_data` 引用方式及
失败/超时语义，不能只是一个开放 JSON payload。

## 4. 不变的核心设计

首发收敛没有撤销以下设计:

- 只有一个 `PostTrainingRecord`，不恢复 `sft | preference | rl | trajectory` 判别联合；
- `system_instruction` 是 record 级 `string | null`；
- canonical role 只有小写 `user | ai`；
- Candidate 保存完整 agentic 响应后缀；
- function call ID 强制存在，response 必须引用先前唯一 call；
- Signal 是带类型、append-only 的原始证据；
- pairwise preference 使用显式 `PreferenceRelation`；
- loss weight 属于 canonical 数据；
- strict writer 与 compatibility reader 分离；
- Zod 是唯一手写逻辑 schema 来源；
- Postgres 控制面与对象存储数据面不变；
- Lance/向量索引不进入 v2 首期。

## 5. 推荐的扩展顺序

若上线后的真实需求要求扩展，建议按以下顺序评估，而不是一次性恢复完整候选结构:

1. 先通过 `extra` 的命名空间试验或 sidecar 验证数据形态，但限制大小并记录生产者；
2. 对稳定字段补齐类型、来源、不变量、生命周期与保真测试；
3. 判断它应进入 canonical、catalog、sidecar 还是可重建物理列；
4. 一次只接受一个闭合的扩展能力，并发布新的 schema minor；
5. 保留 reader 对未知 minor 字段/part 的 round-trip 能力。

该顺序确保 v2.0 保持简单，同时不堵死多模态、代码执行、质量聚合、去重与标注工作流。
