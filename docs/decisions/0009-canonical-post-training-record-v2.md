# ADR 0009 — 后训练数据统一 Canonical Record v2

- **状态:** 已接受——v2 身份/版本 ADR 0011 与技术方案已接受；实施计划接受前不得开始实现
- **日期:** 2026-07-23
- **决策者:** owner
- **修订:** [ADR 0011](0011-identity-hashing-versioning-v2.md) 固定 logical ID、digest、
  dataset version、artifact identity，并将 lineage parent 修订为精确 revision reference
- **取代:** `docs/architecture.md`、`docs/migration/feature-inventory.md` 与
  `docs/migration/inventory-domain.md` 中的 v1 逻辑样本模型
  (`sft | preference | rl | trajectory`)

## 背景

databench v1 把后训练数据建模为四种任务格式的判别联合:`sft`、`preference`、
`rl` 与 `trajectory`。该模型已经完成与旧实现的 parity，但它把任务格式纳入
样本身份，并把同一个逻辑样本拆散到互不兼容的结构中:

- SFT 保存一段消息序列;
- preference 保存 `prompt/chosen/rejected` 与可选 candidates;
- RL 保存 prompt、verifier 与 rollouts;
- agent trajectory 复用 messages，却仍需要独立的 `kind`;
- candidate 级的生成器、人审、judge、verifier 与安全证据只能被拍平、塞入开放
  字典，或者在格式转换时丢失。

v2 产品不再受 v1 wire、存储、哈希、API 或旧 Python golden 兼容性的约束。
同一个 prompt 可能依次经历清洗、生成、人审、SFT、偏好优化、RLVR、评测与
拒绝采样。每进入一个阶段就把它重新编码成一种任务格式，会天然丢失信息，也让
血缘追责变得困难。

因此，v2 需要一种与模型和训练器无关的统一记录，完整保留已经付出生成与标注成本的
信息。训练器专用格式只存在于导出边界，不进入 canonical 数据模型。

## 决策

### 1. 只使用一种 Canonical Record；任务是派生视图

v2 只使用一个顶层 `PostTrainingRecord`，不设置 `kind` 或 `task` 判别字段。
SFT、DPO、RLVR/GRPO、评测与拒绝采样，全部由记录实际具备的能力派生。

v2.0 首发采用最小逻辑结构:

```ts
type JsonValue =
  | null
  | boolean
  | string
  | number
  | JsonValue[]
  | JsonObject

interface JsonObject {
  [key: string]: JsonValue
}

interface PostTrainingRecord {
  schema_version: '2.0.0'
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
}
```

最小结构只缩小 v2.0 的首发字段面，不改变单一 record、完整 candidate 轨迹、显式
preference relation 与 append-only signal 等核心模型。被移出首发契约的候选扩展字段
及其适用场景保留在
[`docs/v2/canonical-record-extended-profile.md`](../v2/canonical-record-extended-profile.md)，
该文档不属于 v2.0 normative schema。

以上是逻辑契约。身份字段、摘要输入、canonical 序列化与数据集版本规则，由后续 v2
身份/版本 ADR 决定。所有进入 canonical record 的开放载荷都必须是
`JsonValue` 或 `JsonObject`；禁止 `undefined`、`BigInt`、`Date`、函数、循环引用与
非有限数字。

### 2. `Content` 与 `Part` 是对话的基本单元

对话模型沿用 Gemini `Content` / `Part` 模式，但从 canonical 表达中移除无意义
或有歧义的字段。v2 初版的 system instruction 刻意保持为普通字符串:

```ts
interface Content {
  role: 'user' | 'ai'
  parts: Part[]
  loss_weight: number | null
}
```

- Canonical role 的精确值只有 `user` 与 `ai`，并且区分大小写。导入适配器可以
  接受 `assistant`、`model` 或 `AI` 等 provider 别名，但 canonical 输出必须统一
  归一化为 `ai`。
- 不存在 `system` role。系统指令只存放在记录级
  `system_instruction: string | null` 字段。
- 不存在 `tool` role。工具结果是 `user` content 中的 `function_response` part。
- `system_instruction` 不是 `Content`。强类型 canonical schema 不接受一个
  “存在但 role 被忽略”的字段；Gemini/Vertex converter 在边界处把字符串包装成
  目标格式。
- 结构化或多模态 system instruction 不属于 v2.0。未来如需支持，必须新增字段
  或提升 schema major，不能静默重新解释现有字符串。
- 每个 `Content` 至少包含一个 part。

`Part` 使用显式 `type` 判别字段，确保 Zod、TypeScript 与 OpenAPI 对 exactly-one
主体得出同一个结论:

```ts
interface PartBase {
  thought: boolean
  thought_signature: string | null
  part_metadata: JsonObject
}

type Part =
  | (PartBase & { type: 'text'; text: string })
  | (PartBase & { type: 'function_call'; function_call: FunctionCall })
  | (PartBase & { type: 'function_response'; function_response: FunctionResponse })
  | (PartBase & { type: 'file_data'; file_data: FileData })

interface UnknownPart extends PartBase {
  type: 'unknown'
  original_type: string
  payload: JsonObject
}

type CompatiblePart = Part | UnknownPart

interface FunctionCall {
  id: string
  name: string
  args: JsonObject
}

interface FunctionResponse {
  call_id: string
  response: JsonValue
}

interface FileDigest {
  algorithm: 'blake3'
  value: string
}

interface FileData {
  uri: string
  media_type: string
  digest: FileDigest
  size_bytes: number
}
```

v2.0 canonical writer 只写入 `text`、`function_call`、`function_response` 与
`file_data` 四种 part。内联二进制、可执行代码与代码执行结果暂不进入首发契约；未来
如有真实需求，按兼容性规则新增 variant。`UnknownPart` 只用于 reader 保留未来
variant，不代表 writer 已支持该类型。

Canonical writer 的每个 Part 必须且只能匹配一个已知 `type`，对应的 Zod variant
使用 strict object，拒绝其他 variant 的主体字段。`thought` 与 `thought_signature`
位于主体之外，因此 text part 或 function-call part 都可以携带 thinking 元数据。
`UnknownPart` 只属于 compatibility reader 的返回类型，不能由 canonical writer
产生。Provider converter 负责在 canonical tagged union 与 Gemini oneof 等目标格式
之间转换。

Canonical record 永远不保存渲染后的 prompt、provider 专用 XML、Hermes block
或序列化后的 JSON 参数。具体规则如下:

- `function_call.args` 是结构化 JSON 对象，绝不是 JSON 字符串;
- `function_response.response` 可以是任意合法 `JsonValue`，包括 object、array、string、
  number、boolean 与 `null`;
- function call 的 `id` 与 function response 的 `call_id` 必须非空、稳定;
- call ID 在一条完整 trajectory 内唯一；完整 trajectory 是
  `record.contents + 当前 candidate.contents`，不同 candidate 可以复用相同 call ID;
- function response 必须引用同一完整 trajectory 中已经出现的 call，每个 call 最多
  对应一个 response；允许 trajectory 在尚未产生 response 的 call 后结束;
- function response 不重复保存工具 `name`；converter 在目标格式需要名称时通过
  `call_id` 查询原 call;
- v2.0 不增加通用 `is_error` 或 `error` 字段；工具错误作为 `response` 的结构化值保存;
- `file_data` 是可选的 Part variant；纯文本或纯工具轨迹不需要产生该 variant。一旦
  `type='file_data'`，其四个内部字段全部必填;
- `file_data.uri` 是不含凭证且不会过期的稳定 locator，不能保存 signed URL；具体 URI
  scheme 与对象 key 布局不在本 ADR 决定;
- `file_data.media_type` 使用小写 MIME type；类型未知时使用
  `application/octet-stream`，不把 charset 等参数混入该字段;
- `file_data.digest.algorithm` 固定为 `blake3`，`value` 是 64 位小写十六进制摘要;
- `file_data.size_bytes` 是原始文件的实际字节数，必须是非负整数;
- 文件名、宽高、时长、编码与原始 URL 不进入 v2.0 `FileData`；必要的小型属性可存入
  `part_metadata`，大型媒体元数据进入 sidecar;
- provider 专用渲染只发生在具备版本号的 converter 中。

### 3. Candidate 是完整响应轨迹

Candidate 是一等公民，不再是 `chosen/rejected` 两列:

```ts
interface Candidate {
  id: string
  contents: Content[]
  finish_reason: string | null
  rank: number | null
  selected: boolean | null
  signals: Signal[]
  generator: GeneratorInfo | null
  token_count: number | null
  avg_logprobs: number | null
}

interface GeneratorInfo {
  provider: string | null
  model: string
  revision: string | null
  parameters: JsonObject
}
```

`Candidate.contents` 是一个列表，而不是单条 assistant 消息。它可以表示完整的
agentic 后缀:

```text
ai(function_call) → user(function_response) → ai(final answer)
```

Candidate contents 必须以 `ai` 开始。完整会话等于
`record.contents + candidate.contents`；共享上下文不在各 candidate 中重复保存。

`rank` 与 `selected` 是结论字段:

- `rank` 是非负的 listwise 排名，`0` 最优，允许并列;
- `selected=true` 表示该 candidate 被明确批准用于正样本/SFT，`false` 表示已经评审但
  未批准，`null` 表示尚未选择或状态未知;
- 同一记录允许多个 candidate 被 selected；默认 SFT exporter 为每个 selected
  candidate 输出一条训练记录;
- strict 模式不会根据 rank 或 score 隐式选择 candidate，SFT exporter 只消费
  `selected=true`。

模型生成的 candidate 使用 `GeneratorInfo` 保存 provider、模型、精确 revision 与实际
采样参数；人工直接编写或来源确实未知时使用 `generator=null`。`parameters` 不得包含
凭证、endpoint、请求头、完整 trace 或大型日志。`model` 必须非空；provider 与
revision 有值时也必须非空。

### 4. 证据采用带类型的 Append-only 事件

Candidate 级的人类评分、LLM judge 分、verifier reward、安全结果与 logprob 指标，
统一使用 append-only 事件模型:

```ts
type SignalValue =
  | {
      type: 'number'
      value: number
      scale_min: number | null
      scale_max: number | null
      higher_is_better: boolean | null
    }
  | { type: 'boolean'; value: boolean }
  | { type: 'category'; value: string }
  | { type: 'json'; value: JsonValue }

type SignalSourceType = 'human' | 'ai' | 'verifier' | 'heuristic' | 'imported'

interface SignalSource {
  type: SignalSourceType
  id: string
  version: string | null
}

interface Signal {
  id: string
  name: string
  kind: 'rating' | 'reward' | 'verdict' | 'safety' | 'logprob' | 'other'
  value: SignalValue
  source: SignalSource
  rationale: string | null
  created_at: string | null
  supersedes: string | null
}
```

Signal 不允许覆盖。更正已有评价时，追加一个新 signal，并由 `supersedes` 指向
旧事件。聚合是具备版本号的消费策略，不是 schema 的隐式行为。不同 name、标准、
量表、方向、来源或版本的指标不得自动求平均。

`SignalSource.id` 使用非空稳定来源标识；human source 只能使用内部匿名 ID，不能保存
姓名、邮箱等直接个人信息。LLM judge 统一使用 `type='ai'`。数字 signal 的两个 scale
字段必须同时为 `null` 或同时为有限数字；有量表时 `scale_min < scale_max` 且 value
必须落在范围内。不知道方向时 `higher_is_better=null`；category value 必须非空。

Signal 与 PreferenceRelation 的 `created_at` 使用 RFC 3339 UTC，canonical 输出统一为
`Z` 时区；来源没有可靠时间时使用 `null`。事件先后以 append-only 列表位置为准，不能
使用可空或来自外部系统的时间戳推断。

v2.0 不在 record 顶层提供 `quality` 聚合 map；过滤或 mixture 构建必须使用具名、
具备版本号的 signal 聚合策略。candidate signals 始终是原始证据。未来如需把稳定的
聚合结果提升为物理查询列，它仍是可重建的派生数据，不改变 signal 的证据地位。

### 5. Pairwise Preference 使用显式关系

Pairwise preference 是关系型证据，不能从互不相关的 candidate 标量分数中安全恢复。
v2 使用显式结构记录:

```ts
interface PreferenceRelation {
  id: string
  left_candidate_id: string
  right_candidate_id: string
  outcome: 'left' | 'right' | 'tie' | 'abstain'
  status: 'observation' | 'adjudicated'
  criterion: string | null
  source: SignalSource
  rationale: string | null
  created_at: string | null
  supersedes: string | null
}
```

两个 candidate ID 必须存在于同一 record 且不能相同。`observation` 保存单个
标注员、judge 或 verifier 的原始判断；`adjudicated` 保存已经完成聚合或裁决、可供
训练消费的结论。Preference relation 与 signal 一样采用 append-only，更正时使用
`supersedes`。

Strict DPO exporter 只消费未被 supersede、`status='adjudicated'` 且 outcome 为
`left` 或 `right` 的 preference relation；`tie` 与 `abstain` 都没有方向，不能进入
DPO。Exporter 不根据任意 signal 均值、`selected` 或 rank 推断 pair。同一无序
candidate pair + criterion 最多存在一个当前有效的 adjudicated relation，防止同时
导出方向相反的训练 pair。允许通过独立、具名的策略从 observations、listwise rank
或指定指标派生 relation，但策略名称、版本与产出的 relation 都必须进入 provenance。

Supersession 使用列表位置定义顺序:

- Signal 只能 supersede 同一 candidate 的更早 signal；目标必须具有相同
  `name`、`kind` 与 source。来源或版本变化表示一次新的独立评价，不是更正;
- PreferenceRelation 只能 supersede 列表中更早、具有相同无序 candidate pair、
  `criterion` 与 `status` 的 relation；observation 不能 supersede adjudicated，
  adjudicated 也不能覆盖 observation;
- 同一事件最多只有一个直接后继；当前有效事件是没有被任何后续事件引用的事件;
- 向前引用同时保证 supersession 不形成循环。

### 6. Loss Masking 是 Canonical 数据属性

`Content.loss_weight` 必须是大于等于零的有限数字。`null` 使用基于位置的默认值:

- 共享的 `record.contents`: `0.0`;
- candidate `ai` contents: `1.0`;
- candidate `user` contents: `0.0`。

如需训练历史 ai 轮，必须在共享 contents 上显式设置正权重。排除 thinking span 等
per-token mask，由具备版本号的 template/converter 派生，并在导出保真元数据中
明确报告。

如果目标 trainer 无法表达所需 mask 或非二值权重，strict export 必须抛出类型化
保真错误。禁止静默转换成另一种训练目标。

### 7. Tools 与 Verification 是 Record 级输入

原始扩展设计使用开放的 `list[dict]` 表达 tools。v2.0 将其收紧为每个元素对应一个
function declaration 的 provider-neutral 强类型结构:

```ts
interface Tool {
  name: string
  description: string | null
  input_schema: JsonObject
}

interface Verification {
  verifier: string
  verifier_version: string
  ground_truth: JsonValue
  constraint: JsonValue
  config: JsonObject
}
```

- `Tool.name` 必填、非空、区分大小写，并且在一条 record 的 `tools` 中唯一；canonical
  层不做 provider 专用重命名。
- `description` 没有内容时统一为 `null`，不保存空字符串。
- `input_schema` 是自包含的 JSON Schema Draft 2020-12，根类型必须为 object；允许
  `$defs` 与本地 `$ref`，禁止依赖外部网络 schema。无参数工具也必须提供显式 object
  schema。
- Canonical Tool 不保存 Gemini 的 `function_declarations` 包装、OpenAI/TRL 的
  `type/function/parameters` 包装或任何渲染后的工具文本；具备版本号的 converter 在导出
  边界生成目标结构。
- 每个 `function_call.name` 必须区分大小写地匹配 `record.tools` 中唯一的 Tool，且
  `args` 必须通过对应 `input_schema` 校验；`tools=[]` 时整条 record 不得包含
  function call。允许声明未被任何 candidate 调用的可用工具。
- v2.0 没有 `output_schema`，因此 writer 不使用 Tool declaration 校验
  `function_response.response`；response 只执行 call-ID 引用完整性校验。
- v2.0 不包含 `output_schema`、工具版本、provider、endpoint、headers、auth、strict 或
  executor config。执行配置属于控制面，凭证绝不能进入 canonical record；未来确有稳定
  需求时通过兼容 minor 扩展。
- `verification` 是可选的 record 级能力；没有 verifier 时为 `null`。一旦存在，五个
  内部字段全部存在，缺少 ground truth 或 constraint 时对应值为 `null`。
- `verifier` 是已注册的路由名，`verifier_version` 是非空稳定版本；禁止保存任意模块
  路径、URL、shell 命令或可执行代码。
- `config` 只保存小型、可序列化的判分配置，不得包含密钥或连接凭证。运行结果作为
  candidate signal 追加，不能写回或覆盖 Verification。
- 已有 rollout candidates 可以与 `verification` 共存；prompt-only RLVR record
  可以没有 candidates。

### 8. 任务资格必须可确定性判断

Exporter 根据记录能力判断任务资格:

| 视图 | 必需能力 | 默认行为 |
|---|---|---|
| SFT | 一个或多个 `selected=true` candidates | 每个 selected candidate 输出一行 |
| DPO | 一个或多个有效、adjudicated、方向为 left/right 的 preference relations | 每个 relation 输出一个 pair |
| RLVR/GRPO | `verification` | 输出 prompt + verifier 列；candidates 可选 |
| Evaluation | candidates + 具名 verdict/reward signals | policy 指定精确 metric/version |
| Rejection sampling | candidates + 显式选择策略 | policy 写入新 signals/relations/selection provenance |

Canonical record 永远不增加 `task` 字段。`task-view:sft` 等 tag 只能作为描述性
缓存，不能让原本不合格的记录获得任务资格。

### 9. Provenance 与 Sidecar 有明确边界

v2.0 使用以下最小来源与血缘结构:

```ts
interface SourceInfo {
  name: string
  kind: string
  url: string | null
  license: string | null
  original_id: string | null
}

interface TransformationStep {
  name: string
  version: string
  params: JsonObject
}

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

- `SourceInfo.name` 与 `kind` 是非空字符串；kind 保持开放，避免新增来源类别就升级
  schema。`license` 优先使用 SPDX expression，内部许可使用稳定内部标识。`url`
  不得包含凭证或过期 signed URL；完全不知道来源时使用 `source=null`。
- `lang` 有值时必须是有效 BCP-47 language tag；无法可靠判断时使用 `null`。
- `parent_refs` 使用 `(logical record ID, record digest)` 引用精确父 revision；logical
  ID 不能重复或引用自身，输入顺序具有语义且不得自动排序。父 payload 可用时必须重新
  计算并验证 digest；不可用时保留 unresolved exact ref。跨 record 的 lineage 环由
  catalog 层检查。完整身份与解析规则见 ADR 0011。
- `recipe` 与 `recipe_revision` 必须同时为非空字符串或同时为 `null`；每个
  TransformationStep 的 name/version 必须非空，params 不得包含凭证或大型数据。
- `Lineage` 不能是所有字段均为空的占位对象；没有血缘时使用 `lineage=null`。

Canonical record 包含选数时需要或发布后审计时必须在场的信息:

- source name、kind、URL、license 与 original ID;
- language 与稳定 tags;
- recipe revision、run ID、parents 与 transformation steps;
- candidate generator model/revision 与 sampling 参数;
- candidate selection state 与必要的 review 结论;
- 大小受控的 review/judge rationale。

大型、不稳定或特定工作流专用的信息存入 revision-specific sidecar；join key 至少包含
`(dataset_version, record_id)`，candidate sidecar 再追加 candidate ID。只用稳定
record/candidate ID 连接不同 revisions 被禁止，完整规则见 ADR 0011:

- Data-Juicer 全量统计与中间状态;
- 标注 UI 的完整逐标注员 response payload;
- embeddings 与检索索引;
- MinHash buckets、重复对图等图结构;
- 大型 traces、logs 或二进制资源。

`extra` 是逃生舱，不是无人治理的第二套 schema。生产者必须使用命名空间 key、限制
大小，不能仅仅为了逃避定义稳定字段而把数据塞进 `extra`。

### 10. Zod 是唯一手写逻辑 Schema 源

v2 逻辑 schema 在 `@databench/schema` 中使用 Zod 实现，并导出 TypeScript 类型。
JSON Schema 与 OpenAPI components 从这一来源生成。核心路径不引入 Pydantic/Python；
ADR-0001 继续有效。

物理 Arrow/Parquet schema 不是另一份独立逻辑真相源。v2 必须从 Zod 模型生成它们，
或者通过完整的逐字段等价测试证明二者一致。物理布局不在本 ADR 内决定；v2 实现计划
在已接受的 Postgres + 对象存储边界内处理，除非后续 ADR 明确取代 ADR-0003/0008。

Lance、向量索引与 Lance 派生查询物化被明确排除在 v2 首期范围之外。它们不构成
任何 v2 验收闸门，也不进入首期实现计划。未来如果确有需要，必须通过独立决策以
“可从 canonical 数据重建的派生状态”引入；canonical record 不能只存在于 Lance。

### 11. Writer 严格性与 Reader 兼容性分离

- Canonical writer 拒绝未知字段、非法 oneof、未知枚举、非有限数字、悬空 call ID
  与无效 candidate/relation 引用。
- Compatibility reader 保留未知普通字段以支持 round-trip，并拒绝未知 schema major。
- 未知的未来 part variant 由 compatibility reader 转换成显式 `UnknownPart` 保留，
  绝不静默当作 text；canonical writer 拒绝写入 `UnknownPart`。
- Patch 只允许文档与不改变数据能力的校验修正；minor 可以增加对旧数据有默认值的字段，
  或增加 compatibility reader 可保留为 `UnknownPart` 的 Part variant；停用字段只标记
  deprecated，字段名永不复用。
- 改变现有语义、删除或复用字段、改变字段必填性，以及给封闭枚举增加值都属于 major。
  `role`、preference outcome/status、SignalValue type 与 SignalSource type 都是封闭
  枚举；可扩展概念必须使用自由字符串、现有 `other` 或新增字段。
- Compatibility reader 对支持 major 下的未知 minor 字段和 UnknownPart 做原样
  round-trip；旧 canonical writer 不能把未知内容写成自己支持的旧 schema 版本。

CI 必须同时测试两个方向:新 reader 能读取旧 fixture；compatibility reader 对更新
minor fixture 做 round-trip 时必须保留未知字段、未知 Part 与 schema version。

## 不变量

Strict v2 writer 至少强制以下规则:

1. `schema_version` 是支持的 v2 语义化版本，`id` 非空。
2. `system_instruction` 存在时必须是非空字符串。
3. 每个 content 至少有一个 part；canonical part 必须匹配且只匹配一个已知 `type`。
4. 共享 contents 的 role 必须交替；存在 candidates 时必须以 `user` 结束。
5. Candidate contents 非空、以 `ai` 开始且 role 交替。
6. Function-call ID 在一条完整 trajectory 内唯一；response 引用更早出现的 call，且每个
   call 最多对应一个 response。
7. Candidate ID、signal ID 与 preference-relation ID 在 record 内唯一；所有 relation
   candidate 引用均在本地可解析。
8. 同一无序 candidate pair + criterion 最多有一个未被 supersede 的 adjudicated
   relation。
9. Rank 是大于等于零的整数且允许并列；`selected` 三态不从 rank 或 signal 隐式派生。
10. Loss weight、signal number、开放 JSON 中的 number、token count 与 log
   probability 必须有限；count 是
   非负整数。
11. `file_data` 包含稳定 locator、MIME type、BLAKE3 内容摘要与非负整数
    `size_bytes`；不得包含凭证或过期 signed URL。
12. Tool name 在 record 内唯一；`input_schema` 是自包含、根类型为 object 的有效
    JSON Schema Draft 2020-12。每个 function call 必须匹配已声明 Tool，且 args 通过
    对应 schema 校验。
13. Verification 使用已注册 verifier 与非空版本，不携带代码或凭证；结果只追加为
    candidate signal。
14. Signal 数字量表有效，category 非空；事件时间是 RFC 3339 UTC 或 `null`。
15. Supersession 只向前引用语义匹配的同类事件，每个事件最多一个直接后继。
16. Source URL 不含凭证，lang 符合 BCP-47；Lineage parent ref 包含 canonical record
    ID 与 64 位小写 hex record digest，logical parent 不重复、不自指，recipe/revision
    成对存在且 Lineage 不是空占位对象。

## Converter 契约

Converter 是从 canonical v2 record 降级到某个 trainer/provider 契约的具备版本号
的函数。每次导出都返回数据与机器可读的保真元数据:

```ts
interface FidelityChange {
  path: string
  action: 'transformed' | 'dropped'
  impact: 'none' | 'informational' | 'semantic'
  reason: string
}

interface ConversionResult<T> {
  rows: T[]
  config_hints: JsonObject
  fidelity: {
    preserved: string[]
    changes: FidelityChange[]
  }
}
```

`FidelityChange.path` 使用 JSON Pointer。结构重编码但不丢信息，例如把 args object
序列化为 OpenAI JSON string，标记为 `transformed/none`；丢弃不影响训练目标的
generator/source 等 provenance 标记为 `informational`；丢失训练文本、loss mask、
工具调用、偏好方向或 selected candidate 标记为 `semantic`。Strict converter 默认
拒绝调用方没有通过显式 converter option 授权的 semantic loss；informational loss
可以继续导出，但必须报告。

首批必需 converter 为 TRL SFT、TRL DPO、TRL GRPO/RLVR 与 ms-swift。OpenAI、
Anthropic、Gemini/Vertex 以及模型专用 chat template 属于 provider adapter，同样
遵守保真规则。

只做 converter smoke test 不足以验收。Golden/property tests 必须覆盖 part 数量、
call-ID 链接、selected candidate 数、preference pair 身份、loss mask、thought 处理，
以及每个 fidelity change 的 action、impact 与实际输出。

## 非目标

本 ADR 不决定:

- record/candidate ID 的派生方式;
- canonical 哈希输入、摘要字段、数据集版本或 catalog 时间戳生成规则;
- 物理 Parquet/Arrow 列布局;
- Lance 集成、向量索引或 Lance 派生物化;
- 对象 key 布局或 catalog migration;
- API route、OpenAPI 版本或前端呈现;
- v1 sample/dataset 兼容 converter。

Record/candidate ID、canonical hash/version 与对象 key 已由 ADR 0011 解决；物理
Parquet/Arrow 列布局由 `docs/v2/PLAN.md` 安排后续决策，Lance 继续排除在 v2 首期。
最后一项被刻意排除:v1 兼容不是 v2 要求。

## 后果

- **+** 一条 record 可以在完整后训练生命周期内保留 prompt、trajectory、candidate、
  tools、人审、judge 证据、verifier 结果与 provenance。
- **+** SFT、DPO、RLVR 与评测成为确定性投影，不再是彼此独立的存储格式。
- **+** 结构化 part 防止 provider template 与工具编码变成永久存储数据。
- **+** 显式 preference relation 能保留标量 candidate score 无法安全表达的
  pairwise 证据、tie 与 abstain。
- **+** 带类型、append-only 的 signal 让重新评测与审计历史显式可见。
- **−** 每个 trainer/provider 都需要维护具备版本号的 converter。
- **−** 嵌套模型比 v1 扁平任务结构更难直接检查和查询，需要物理投影与 promoted
  columns。
- **−** 协作者必须先理解 canonical 模型及不变量，才能安全编辑数据。
- **−** v2 会主动打破现有 schema、hash、OpenAPI sample contract、前端 sample
  renderer 与旧 Python parity fixtures。

## 取代范围与保留决策

对于 v2，本 ADR 取代现有架构中的逻辑样本部分，以及已经完成的
`CORE-01..10` / `IO-01..04` v1 迁移契约。相关产物继续作为 v1 完成的历史证据，
不再作为 v2 验收标准。

除非后续 ADR 明确修改，下列决策继续有效:

- ADR-0001:全 TypeScript monorepo，核心零 Python;
- ADR-0002:Hono 与 contract-first OpenAPI;
- ADR-0003/0008:Postgres 控制面 + 对象存储数据面;
- ADR-0004:Node 22、pnpm/Turborepo、Vitest、Biome、纯 ESM;
- ADR-0006:React/Vite 前端栈;
- 包依赖 DAG，以及 `apps/api` 只能通过 `@databench/workspace` 与
  `@databench/schema` 触达数据的规则。
