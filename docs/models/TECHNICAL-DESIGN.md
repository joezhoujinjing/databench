# Databench Model Registry 技术方案

- **状态：** Accepted——owner 于 2026-08-04 要求按三种来源起草、完成三路 review 修订，并在四项
  推荐范围列明后要求“下一步叭”；随后要求“按照实施计划依次的实现吧”，授权按 Gate 顺序实施
  MR0-MR8
- **日期：** 2026-08-04
- **决策者：** owner
- **决策：** [ADR 0019](../decisions/0019-model-registry.md)
- **实施计划：** [PLAN.md](PLAN.md)
- **依赖：**
  [ADR 0011](../decisions/0011-identity-hashing-versioning-v2.md)、
  [ADR 0013](../decisions/0013-v2-product-cutover-and-v1-retirement.md)、
  [ADR 0017](../decisions/0017-evalscope-native-ui-integration.md)、
  [ADR 0018](../decisions/0018-ms-swift-native-gradio-studio.md)
- **现有实现：**
  [Swift 技术方案](../swift/TECHNICAL-DESIGN.md)、
  [EvalScope 技术方案](../evalscope/TECHNICAL-DESIGN.md)、
  [v2 技术方案](../v2/TECHNICAL-DESIGN.md)

> 本方案扩展 ADR 0018 已接受的 `Artifact-bound + operator_attested +
> openai_compatible + auth_mode=none` Deployment 契约。实施前必须先形成并接受新的 ADR 与分 Step
> 实施计划；本文不得被解释为已经改变当前 runtime、OpenAPI、数据库或发布声明。

## 1. 文档职责

Databench 当前已经拥有：

```text
Dataset Version
→ Swift Studio Session
→ immutable LoRA Model Artifact
→ operator-attested Model Deployment
→ Evaluation Run / Report
```

但当前没有独立的逻辑 `Model` 与不可变 `Model Version`。Artifact detail 暂时承担了模型库入口，
Deployment 又必须绑定一个 Databench verified LoRA Artifact，因此以下对象还无法进入统一模型注册表：

1. 已由 Databench 训练并导入的 Model Artifact；
2. 已经在本地/内网或远端运行的模型服务；
3. Hugging Face、ModelScope 或 operator-managed 本地模型仓库中的精确模型引用。

本文回答：

- Model Registry 的领域对象和不变量；
- 三种来源怎样注册成统一的 Model Version；
- 现有 Artifact、Deployment、Evaluation 怎样兼容演进；
- 本地与远端模型服务的 endpoint、认证和 SSRF/egress 边界；
- REST、Web、CLI、数据库、identity、失败恢复和 gate；
- 哪些工作仍属于 Training Control Plane、managed serving 或公共云后续范围。

本文不安排具体 commit。实施顺序必须由后续 `PLAN.md` 单独接受。

## 2. 产品定义

### 2.1 Model Registry 是什么

Model Registry 是数据、训练、模型产物、部署与评测之间的产品聚合层：

```text
Model（逻辑产品身份）
└─ Model Version（不可变注册版本）
   ├─ Source（Artifact / Repository / Existing Service）
   ├─ Primary Artifact（Artifact 来源时唯一、精确的 serving bytes）
   ├─ Deployments（本地、内网或远端 serving 实例）
   ├─ Evaluations（版本绑定的质量证据或服务观察）
   ├─ Source Evidence（可刷新的来源验证观察）
   └─ Aliases（candidate / staging / production 等 CAS 指针）
```

`Model` 不是权重文件，不是 URL，也不是某次训练任务；`Model Version` 不是 Deployment；
`Deployment` 也不能代替 `Model Version`。

### 2.2 一级产品面

接受并实现后，全局一级导航建议为：

```text
数据集 / 训练 / 模型 / 测评
```

新增无版本 Web 路由：

```text
/models
/models/:modelId
/models/:modelId/versions/:versionId
```

现有 `/training` 继续负责 Studio Session、训练与 Artifact import；`/models` 负责注册、版本、产物、
部署、评测和血缘。不能把完整 Model Registry 再塞回 Artifact detail。

## 3. 目标与非目标

### 3.1 目标

1. 建立 namespace 内稳定的逻辑 Model 与不可变 Model Version；
2. 支持三种来源：Databench Artifact、模型仓库引用、已有本地/远端服务；
3. 复用现有 immutable Artifact、Deployment、Evaluation Run 与 lineage，不复制另一套产物表；
4. 分开表达 source mutability 与 verification level，不把“不可变”和“可信”混成一个枚举；
5. 本地与远端服务统一使用 Deployment，对 endpoint 位置、认证和健康状态做明确边界；
6. Model Version 与 Dataset、Session、未来 Training Run、Artifact、Deployment、Evaluation 可精确追溯；
7. 历史 S3/S4 Artifact、Deployment、Evaluation identity 和读路径保持可用；
8. 所有公共 wire contract 仍由 `@databench/schema` → OpenAPI → generated Web client 产生；
9. API/CLI 仍只经 Workspace + Schema 触达数据；
10. secret、权重、样本、完整训练日志和 endpoint 凭据不进入公开投影。

### 3.2 非目标

- 本方案不实现 S6 Training Run/Attempt/Profile 或接管 Gradio callback；
- 不实现自动启动、停止、扩缩容、排队或调度模型 serving；
- 不直接扫描任意本地绝对路径，不允许浏览器提交宿主机文件路径；
- 不在注册请求中上传数十 GiB 权重；权重导入必须是独立、可恢复、受限的数据面流程；
- 不把 repository reference 伪装成已经下载或验证的 Artifact；
- 不把 existing service 伪装成拥有 Dataset/Training/Artifact lineage；
- 不把可变 provider alias 伪装成可复现的不可变权重版本；
- 不实现多租户 principal/RBAC、计费、公共 marketplace 或公共云平台选择；
- 不实现 retention/GC/legal hold/destructive model deletion；
- 不补做当前 deferred 的真实 NVIDIA Training/Infer/Serving/Evaluation gate；
- 不完成 V16/V17、EvalScope GE9 或公共云 D3。

## 4. 领域对象与硬不变量

### 4.1 `Model`

`Model` 是 namespace 内的逻辑产品身份，例如 `customer-support-assistant`。它包含：

```text
id                UUID，opaque
namespace_id      trusted workspace namespace
key               lowercase ASCII stable key
display_name      用户可见名称
description       bounded text
task_family       bounded registry value，可为空
tags              canonical、去重、有界字符串集合
metadata_revision CAS revision
archived_at       nullable
created_at
updated_at
```

硬规则：

- `(namespace_id, key)` 唯一；
- `key` 创建后不可修改；
- display metadata 可通过 expected `metadata_revision` CAS 更新；
- archive 不删除 Version、Artifact、Deployment、Evaluation，也不自动 disable Deployment；
- 当前系统没有 principal，不能创建假的 `owner_user_id`。未来 RBAC 只能加真实 FK。

### 4.2 `Model Version`

`Model Version` 是某个 Model 下不可变的注册版本：

```text
id                    UUID，opaque
namespace_id
model_id
version_label         namespace/model 内唯一的用户可见标签
source_kind           databench_artifact | repository_reference | existing_service
create_profile
create_digest
source_fingerprint    只绑定规范化 source material，不含 model/label
base_model_reference  nullable sanitized reference
base_model_revision   nullable exact/declared revision
source_mutability     immutable | mutable | unknown；从 frozen locator + evidence 派生
verification_level    content_verified | provider_verified |
                      operator_attested | unverified；从 evidence 派生
created_at
```

硬规则：

- Model Version 创建后不可修改 source、label、base binding 或 create identity；
- 同一 Model 内 `(version_label)` 唯一；
- 同一 Model 内 exact source fingerprint 只允许一个 Version；
- display label 不是权重 digest，也不能代替 source fingerprint；
- endpoint、health、credential rotation 不属于 Model Version identity；
- immutable source locator 与当前 classification projection 分离：`source_fingerprint` 属于 Version
  identity；`source_mutability` 与 `verification_level` 是从 frozen locator + append-only evidence 派生的
  正交投影，不进入 Version create identity；
- evidence 可让 `unknown → immutable|mutable` 或 `unverified/operator_attested → provider_verified`；已由
  source shape 判定为 `mutable` 的 tag/alias 不能被 evidence 提升为 immutable；
- 两个投影由 Workspace 计算，浏览器、CLI 和注册请求不得自报；Evaluation 保存提交时 snapshot；
- 外部服务若只能提供可变 alias，必须保存 `source_mutability=mutable` 并在 UI 显著提示不可复现；
- 后续取得 Databench bytes 时创建新的 Artifact-source Version，并记录 derivation evidence；不得原地把
  Repository/Service Version 改写为 Artifact Version。

### 4.3 `Model Artifact`

继续复用现有 `model_artifacts_v2`：

- Artifact 表示 immutable bytes + manifest + digest；
- 当前唯一 kind 仍是 `lora_adapter`；
- merged/full/quantized 等会改变 serving 行为的产物必须创建新的 Model Version，并使用新的 versioned
  kind、format、容量和验证 gate；tokenizer 等配套文件必须作为同一 primary Artifact manifest 的组成部分；
- Model Registry 不改变已有 Artifact ID、archive digest、object locator 或 Session/import lineage；
- 第一版一个 Artifact-source Model Version 必须且只能绑定一个 primary Artifact；Deployment 与
  Evaluation 精确绑定该 Artifact；
- 后续若确实需要一个 Version 下多个可独立 serving 的变体，必须先引入一等 `Model Build/Variant`，
  不能把它们塞进无 identity 的关联数组；
- Artifact 不因所属 Model 被 archive 而删除。

### 4.4 `Model Deployment`

Deployment 是 Model Version 的一个 serving 实例：

```text
Model Version
→ Deployment ID
→ provider + served model + normalized endpoint
→ auth profile + opaque credential reference
→ immutable declared capability profile
→ lifecycle + health observation
```

硬规则：

- 本地、内网与远端模型服务在领域上都是 Deployment，不创建三套 Deployment 类型；
- `connectivity_scope=private_network|public_network` 只选择 policy，不证明网络位置可信；
- 新 `model-version-v1` Deployment 生命周期为 `registered|active|disabled`；注册事务只创建
  `registered`，通过独立 activation admission 后才能进入 `active`；
- `availability=available|unavailable` 是按当前发布 profile、endpoint policy、credential generation 与
  capability observation 派生的读取状态，不是生命周期；`active + unavailable` 不能进入 selector；
- endpoint 或 served model 改变创建新 Deployment ID，禁止原地覆盖；
- declared capability profile（chat completions、embeddings、vision、tools、context limit）改变创建新
  Deployment；运行兼容性检查结果是 observation，不改写 create identity；
- secret value 变化是 credential rotation，不要求新 Model Version；
- health observation 不改变 Model Version identity，也不自动 disable；
- Deployment disable 不删除历史 Version、Artifact、Evaluation Run 或 Report；
- Artifact-source Version 的 Deployment 必须绑定该 Version 唯一 primary Artifact；Repository/Service
  Version 的 Deployment `artifact_id` 必须为空；
- 浏览器和 public projection 不返回 endpoint、credential ref、create digest 或解析后的网络拓扑。

### 4.5 `Model Alias`

Model Alias 是可变指针，不是版本：

```text
candidate
staging
production
```

- `(namespace_id, model_id, alias)` 唯一；
- create/move 必须携带 `expected_version_id`；`null` 表示 alias 必须不存在，非空表示必须精确指向该
  Version，冲突返回 expected/current/new 三个 opaque ID；
- alias move 不改变 Model Version、Deployment 或 Evaluation identity；
- 首期可只交付 `candidate`，但数据模型不得用 Model metadata 字段伪装 alias；
- `source_mutability!=immutable` 的 Version 禁止成为 `candidate/staging/production`；更复杂的质量 promotion
  policy 属于后续产品 Step。

## 5. 三种注册来源

### 5.1 来源 A：Databench Artifact

适用于当前 Swift Studio 导入的 LoRA Artifact，以及未来受验证的 merged/full/quantized Artifact。

流程：

```text
选择现有 Model Artifact
→ Workspace 读取 immutable Artifact row/manifest
→ 校验 namespace、kind、format、digest 与 base binding
→ inspect registration plan
→ 创建/选择 Model
→ 创建 Model Version
→ 绑定 primary Artifact
→ 可选创建 candidate alias
```

身份输入至少包含：

```text
namespace
model_id
source_kind=databench_artifact
artifact_id
artifact_kind / artifact_format
archive_digest / manifest_digest
base_model_reference / nullable revision / binding_status
version_label
```

lineage 规则：

- 只有 Artifact 自身 `dataset_lineage_status=verified` 时，Model Version 才展示 exact Dataset lineage；
- `external_or_unverified` Artifact 仍可注册，但不能升级成 verified training lineage；
- Studio Session 不是 Training Run，Model Version 只能显示 Session/import provenance；
- Version 保存 Artifact 已有的 `base_model_reference + nullable revision + binding_status`；只有创建
  可评测的 Deployment 时才要求满足当前 serving profile 的 exact base binding；
- S6 完成后，新 Training Run 产物可以自动进入同一 Artifact 注册路径。

### 5.2 来源 B：模型仓库引用

适用于：

```text
Hugging Face repository
ModelScope repository
operator-managed local repository alias
```

公共注册字段：

```text
repository_provider  hugging_face | modelscope | operator_managed
repository_id        provider canonical ID；operator_managed 使用 opaque alias
revision             必填
revision_kind        commit | digest | tag | opaque
base_model_reference/revision（可选）
```

硬规则：

- 浏览器和公共 API 不接受 `/srv/models/...`、`file://...`、`~`、Windows path 或 symlink target；
- operator-managed 本地仓库使用部署配置中的 opaque alias 解析到 allowlisted root，路径不进 PG/public wire；
- Registry 注册不自动下载权重；offline profile 不访问公网，connected profile 也只允许受控 metadata
  resolution，不因登记成功声称 runtime available；
- `commit|digest` 只有经 allowlisted provider metadata resolution、签名 metadata 或本地 content digest
  evidence 确认后，mutability 才投影为 `immutable`；仅字符串形状合法时为 `unknown`；
- `tag` 必须是 `mutable`；`opaque` 默认为 `unknown`，不能宣传为 content verified；
- 注册支持两种明确模式：connected profile 可执行有界、allowlisted metadata resolution；offline profile
  只登记 declared reference，不访问公网；
- repository availability、local cache、license、adapter version、observed revision、observed time、结果与
  response digest 作为 append-only、bounded evidence 保存，不保存完整 provider response，也不进入
  Version identity；
- `operator_managed` alias 只在配置期解析；必须 realpath containment、no-follow、拒绝 symlink/special
  file，并对读取 snapshot 做 inode/race 校验；路径不进入 PG 或 wire；
- 需要把 repository bytes 变成 Databench Artifact 时，走独立 materialize/import job，创建新的
  Artifact-source Model Version，并以 derivation evidence 指回原 Version，不修改原注册行。

### 5.3 来源 C：已有本地或远端模型服务

适用于已经独立运行的 OpenAI-compatible service，例如本地/内网 vLLM、独立 transformers server，或
经 operator 允许的远端服务。

注册向导对用户提供“本地/内网服务”和“远端服务”两个入口，但后端统一规范化为：

```text
source_kind=existing_service
provider=openai_compatible
external_model_ref
external_version_ref
declared_reference_kind=immutable_version|mutable_alias|opaque
deployment:
  connectivity_scope=private_network|public_network
  endpoint_base_url
  served_model_name
  auth_profile=none|bearer_ref
  credential_ref=null|opaque configured name
```

`external_model_ref` 与 `external_version_ref` 是 operator/provider 声明的身份，不是 Databench 计算出的
权重 digest；Workspace 根据 reference kind 和 evidence 计算 mutability/verification，客户端不能提交最终
可信度：

- 若服务对应精确 repository commit/digest，优先改用来源 B 并为该 Version 创建 Deployment；
- `mutable_alias` 计算为 `source_mutability=mutable`；未经 provider/content evidence 的
  `immutable_version|opaque` 只能是 `unknown + operator_attested`；
- endpoint 不进入 Model Version source fingerprint。相同模型迁移 endpoint 只创建新 Deployment；
- `served_model_name` 只是 Deployment 的 routing name；改变它创建新 Deployment，不创建新 Version；
- 该来源没有 Artifact、Dataset 或 Training lineage，除非未来通过新 evidence/新 Version 明确绑定；
- 注册事务可以创建 Model + Version + 首个 `registered` Deployment，但网络 probe/activation 不放在数据库
  事务内。

### 5.4 三种来源对照

| 来源 | 权重 bytes 在 Databench | primary Artifact | 可创建 Deployment | 默认 mutability / verification |
|---|---:|---:|---:|---|
| Databench Artifact | 是 | 必须且唯一 | 可选 | `immutable / content_verified` |
| Repository reference | 否 | 无；materialize 后创建新 Version | 需另行创建 | `unknown|mutable / operator_attested`，证据充分后可为 `immutable / provider_verified` |
| Existing service | 否 | 无 | 必须有首个 registered Deployment | `unknown|mutable / operator_attested` |

只有存在 active、当前 endpoint/credential policy 仍通过且 capability 满足 workload 的 Deployment，
Model Version 才可以进入在线 Evaluation selector。只有注册而未部署的 repository Version 可以展示、
比较 metadata 和作为训练基础模型，但不能直接发起在线模型调用。

## 6. 注册 inspect 与提交

注册采用与 converter fidelity 类似的两阶段语义：

```text
POST inspect
→ normalized plan + warnings + registration_digest
→ 用户确认
→ POST register(expected_registration_digest)
```

inspect 必须：

- 规范化 Model key、version label、repository ID、revision、endpoint 和 served model；
- 读取并绑定 exact Artifact metadata，或校验 repository/service source shape；
- 由 Workspace 计算 source mutability 与 verification，不接受客户端自报；
- 标出 lineage、capability、offline/public-network 与 mutable/unknown warnings；
- 对允许联网的 service 可执行受策略保护的 `/models` discovery probe，但 observation 不进入
  registration digest，也不能把 discovery healthy 宣传为 inference compatible；
- 检查 credential ref 是否已由 operator 配置，不返回 secret，并记录 policy/secret generation observation；
- 返回有界、可序列化、无绝对路径/secret 的 plan；
- 不创建 Model、Version、Deployment、claim 或 object。

register 必须：

- 重新规范化输入并计算相同 `registration_digest`；
- digest mismatch 在任何 DB 写入前拒绝；
- 首先按 `(namespace_id, registration_digest)` 查 durable committed claim；exact replay 直接读回既有结果，
  但必须先把当前输入规范化并与 claim 保存的 strict normalized request envelope 做 RFC 8785 语义比较；
  不同 request 使用同一 expected digest 返回 conflict，不重新检查当前网络、credential 或 provider availability；
- 新提交重新检查当前 endpoint policy generation 与 credential ref existence；Model、Version、source row、
  Artifact binding、可选首个 `registered` Deployment 和 registration claim 在同一 PG transaction 提交；
- 不在 transaction 内执行 DNS、HTTP、repository download 或 object-store I/O；
- 响应丢失后同一 exact request 可幂等重放；
- label/source/alias 冲突返回 typed conflict，不静默复用另一 Version。

网络与 secret 配置可能在 preflight 后变化，因此注册不直接激活 Deployment。独立 activation action 先读取
generation G0，完成 endpoint/credential/capability admission 后再次读取 G1；只有 G0=G1 才提交 active +
generation snapshot，否则保持 `registered`。配置在提交后再次变化时，由调用前 admission 使 availability
fail closed，不假装存在跨文件系统与 PostgreSQL 的原子 CAS。
已 active Deployment 在调用前仍重新执行当前 policy/ref admission，配置被撤销时 fail closed 并展示
`availability=unavailable`，不删除注册记录或伪造 lifecycle 回退。

## 7. Identity 与 Hashing

所有 identity 继续走 `@databench/hashing` RFC 8785 + BLAKE3 具名 API。禁止裸 `JSON.stringify`
构造 hash 输入。

拟新增 profile：

```text
model-create-v1
model-source-fingerprint-artifact-v1
model-source-fingerprint-repository-v1
model-source-fingerprint-service-v1
model-version-create-artifact-v1
model-version-create-repository-v1
model-version-create-service-v1
model-registration-plan-artifact-v1
model-registration-plan-repository-v1
model-registration-plan-service-v1
model-deployment-create-v2
```

规则：

- `model-create-v1` 绑定 namespace + stable key；初始 metadata 由 registration plan 绑定，后续通过 CAS 更新；
- 三个 source-fingerprint profile 只绑定 source-specific normalized material，不含 `model_id`、
  `version_label`、endpoint 或 observation；
- `source_fingerprint = hash(source-specific normalized material)`；Artifact 绑定最终 Artifact/manifest digest，
  Repository 绑定 provider/canonical repository ID/revision/revision kind，Service 绑定
  provider/external model ref/external version ref/declared reference kind；
- `create_digest = hash(namespace + model_id + version_label + source_fingerprint + immutable base binding)`；
  三个 Version profile 使用 source-specific strict envelope，禁止用 nullable 大对象混成一个歧义公式；
- registration plan profile 绑定 create/select Model target、初始 metadata、Version、Source、classification
  snapshot + evidence digest、optional registered Deployment、optional Alias CAS 和 normalized policy
  identifiers；secret value、health 与瞬时 availability 不参与；
- Deployment v2 绑定 namespace、`model_version_id`、Version source fingerprint、provider、normalized
  display/served model、规范化 endpoint、connectivity scope、auth profile 与 credential ref name，不绑定
  secret value；同时绑定 strict declared capability profile；
- secret rotation不改变 Deployment identity；改变 credential ref、endpoint 或 served model 创建新 Deployment；
- registration claim 以 plan profile + digest 为 durable replay key；response-loss replay 先查 claim，再做
  任何 live check；
- 所有 profile 必须有独立 strict schema、domain、fixed vectors、permutation/replay/conflict tests；
- 现有 `model-deployment-create-v1` 与 evaluation-run v1-v4 fixed vectors不得修改。

## 8. 数据库设计

### 8.1 新表

建议新增：

```text
models_v2
model_versions_v2
model_version_artifact_sources_v2
model_version_repository_sources_v2
model_version_service_sources_v2
model_source_evidence_v2
model_aliases_v2
model_registration_claims_v2
model_version_deployment_adoptions_v2
```

来源采用三个 1:1 source table，而不是把互斥字段塞进一个无约束 JSON：

- `model_versions_v2.source_kind` 决定且只允许一个对应 source row；
- 三张 source 表的跨表 XOR 由 deferred constraint trigger 在 transaction commit 前验证：每个 Version
  必须且只能存在一个与 `source_kind` 对应的 row；Prisma application check 不能代替数据库约束；
- Artifact source 使用 composite FK 限制在同 namespace；
- repository/service source 不存 secret、绝对路径或完整 provider response；
- Artifact source row 是唯一 primary Artifact binding 真源，不再增加可能漂移的通用 Artifact binding 表；
- Artifact source row 提供 `UNIQUE(namespace_id, model_version_id, artifact_id)`，供 Deployment 与 adoption
  的 composite FK 使用；
- `model_source_evidence_v2` 是 append-only、有界 observation；保存 evidence kind、adapter/version、
  observed revision/time、result、response digest，不保存 response body；
- Model Version 的当前 mutability/verification 在有界查询中由 frozen source shape 与 evidence 聚合得到；
  可用 Catalog summary/materialized projection 优化读取，但不得成为第二个可独立写入的真源；
- `model_registration_claims_v2` 在注册 transaction 内保存 plan profile/digest 与创建结果 locator；
- `model_version_deployment_adoptions_v2` 只关联历史 `artifact-bound-v1` Deployment，不修改其 create row。

`models_v2` 关键约束：

```text
UNIQUE(namespace_id, key)
CHECK(key = lowercase ASCII model key)
CHECK(metadata_revision >= 0)
```

`model_versions_v2` 关键约束：

```text
UNIQUE(namespace_id, id)
UNIQUE(namespace_id, model_id, id)
UNIQUE(namespace_id, model_id, version_label)
UNIQUE(namespace_id, model_id, source_fingerprint)
FK(namespace_id, model_id) → models_v2
CHECK(create_digest/source_fingerprint = lowercase hex64)
```

`model_aliases_v2` 关键约束：

```text
PRIMARY KEY(namespace_id, model_id, alias)
FK(namespace_id, model_id, version_id) → model_versions_v2
```

`model_registration_claims_v2` 关键约束：

```text
UNIQUE(namespace_id, registration_digest)
CHECK(plan_profile 是已登记 profile，registration_digest = lowercase hex64)
normalized_request 使用 strict bounded schema，禁止 secret/path，并与 replay 输入做 canonical equality
FK(namespace_id, model_id, model_version_id) → model_versions_v2
optional deployment/alias locator 使用同 namespace composite FK
```

`model_version_deployment_adoptions_v2` 关键约束：

```text
PRIMARY KEY(namespace_id, deployment_id)
FK(namespace_id, model_id, model_version_id) → model_versions_v2
FK(namespace_id, deployment_id, artifact_id, deployment_digest)
  → model_deployments_v2(namespace_id, id, artifact_id, create_digest)
FK(namespace_id, model_version_id, artifact_id)
  → model_version_artifact_sources_v2(namespace_id, model_version_id, artifact_id)
```

Adoption 只允许不存在 → exact association；重复相同目标幂等，不同目标 conflict，禁止重新归属。记录
`adoption_profile/digest/adopted_at`，但不改变历史 Deployment 或 Evaluation create digest。它只提供历史
导航，不使 legacy Deployment 自动进入 v5/v6 selector；要创建新 Model-bound Evaluation，operator 必须
另建 `model-version-v1` Deployment。

### 8.2 扩展现有 `model_deployments_v2`

不删除或重写当前表。Additive migration：

```text
deployment_profile   artifact-bound-v1 | model-version-v1；旧 row backfill 后移除默认值
model_version_id     nullable UUID
artifact_id          从 NOT NULL 改为 nullable
connectivity_scope   nullable for legacy, required for model-version-v1
auth_mode             现有 DB 列；public 新契约名为 auth_profile=none|bearer_ref，legacy 只能 none
credential_ref       nullable opaque name，绝不存 secret value
declared_capabilities strict bounded JSON；model-version-v1 必填
policy_generation    nullable；只记录最后成功 activation snapshot
credential_generation nullable；只记录 generation，不记录 secret
```

约束：

```text
artifact-bound-v1:
  artifact_id IS NOT NULL
  model_version_id IS NULL
  status IN (active, disabled)
  继续遵守当前 verified LoRA + auth_mode=none contract

model-version-v1:
  model_version_id IS NOT NULL
  status IN (registered, active, disabled)
  Artifact source Version 必须保存其唯一 primary artifact_id
  Repository/Service source Version 必须 artifact_id IS NULL
```

迁移必须显式 drop 当前 `provider=openai_compatible AND auth_mode=none` 固定 CHECK，并替换为
profile-specific shape CHECK；旧 profile 的约束一字不放宽。保留现有
`(namespace, id, artifact_id, create_digest)` unique/FK，供历史 Evaluation Run 使用；新增：

```text
UNIQUE(namespace_id, model_version_id, id, create_digest)
FK(namespace_id, model_version_id) → model_versions_v2
FK(namespace_id, model_version_id, artifact_id)
  → model_version_artifact_sources_v2(namespace_id, model_version_id, artifact_id)
  （artifact_id 为 null 时按 SQL FK 语义跳过）
```

Prisma relation 将 Artifact 改为 optional，但当前 `artifact-bound-v1` Workspace、顶层公共
`/v2/model-deployments*` 与 `/internal/v1/model-deployments/{id}:resolve` 继续只读取旧 profile，并维持
Artifact 必填的原 response schema。新 nested route 使用独立 strict `ModelVersionDeployment` schema；
`/internal/v2/model-deployments/{id}:resolve` 使用 version-bound discriminated union。新 Deployment ID 在旧
show/internal v1 route 稳定返回 404，不让 nullable row 流入旧 parser。

旧顶层 route 的兼容承诺仅指 `artifact-bound-v1` profile，不称为“当前 v1 API”，避免与已退役产品 v1
混淆。MR5 必须同步升级 EvalScope 的 internal v2 adapter；internal v1 和所有既有 fixed vectors保持不变。

### 8.3 Evaluation Run 兼容扩展

历史 `evaluation-run-create-v1/v2/v3/v4`、旧列与 composite FK 保持不变。

新 Deployment-bound Evaluation profile 增加：

```text
model_id
model_version_id
model_deployment_id
model_deployment_digest
model_artifact_id nullable
source_mutability_snapshot
verification_level_snapshot
source_evidence_digest nullable
source_observed_at
```

建议 profile：

```text
evaluation-run-create-v5  Model Version Deployment + benchmark default metrics
evaluation-run-create-v6  Model Version Deployment + explicit canonical metrics
```

- Artifact-source Version 保存其唯一 primary Artifact lineage；Repository/Service source 的 artifact ID
  必须为 null；
- 浏览器仍只提交 opaque Deployment ID，Workspace/internal resolver补齐 Model/Version/source material；
- source-less EvalScope Benchmark + Deployment 仍是 expert/untracked，不自动创建 Databench Run；
- 历史 Run 不回填虚假的 Model Version identity；若 operator 后续把旧 Deployment 归入 Model，UI 必须标记
  `adopted association`，不能改写原 Run create digest。

数据库必须同时保证：

```text
FK(namespace_id, model_id, model_version_id)
  → model_versions_v2(namespace_id, model_id, id)
FK(namespace_id, model_version_id, model_deployment_id, model_deployment_digest)
  → model_deployments_v2(namespace_id, model_version_id, id, create_digest)
若 model_artifact_id 非空：
  FK(namespace_id, model_deployment_id, model_artifact_id, model_deployment_digest)
    → model_deployments_v2(namespace_id, id, artifact_id, create_digest)
profile-specific CHECK 固定 Artifact/source snapshot shape
```

v5/v6 create identity 绑定 Model/Version/Deployment digest、Artifact nullable binding、source mutability、
verification 与 evidence digest；`source_observed_at` 使用数据库时间作展示/审计，不参与 create digest。

mutable/unknown source 的 Run 是带 `source_observed_at` 的“某时刻服务观察”，不能显示为可复现版本证据，
跨时间 compare 默认不把它们当成同一个 exact model。EvalScope admission/replay 顺序固定为：

```text
validate + digest
→ atomic claim
→ terminal/already-running fast path
→ new-task capacity
→ internal resolve once
→ endpoint policy
→ secret resolve
→ launch
```

已有 exact claim 的 terminal replay 不读取当前 Registry、endpoint、secret、容量或 Deployment lifecycle；
只有新 admission 要求 active。resolve/policy/secret 失败写入同一 typed terminal，禁止当前实现中的
`has_claim → resolve → claim` TOCTOU 顺序延续到 v5/v6。

## 9. 现有数据迁移与采用

迁移必须 additive，不自动把 Artifact display name 猜成逻辑 Model：

1. 创建新表和 nullable 扩展列，现有 API/行为不变；
2. 现有 Artifact 在 `/models` 注册向导中显示为“未归入模型的产物”；
3. operator 显式创建/选择 Model 与 version label 后，建立新的 Model Version + Artifact binding；
4. 可通过独立 adoption action 把该 Artifact 的现有 Deployment 写入
   `model_version_deployment_adoptions_v2`；不更新原 Deployment row，不改变其 create digest；
5. 历史 Evaluation 继续按 Artifact/Deployment lineage 展示，并可通过 adopted association 导航到 Model；
6. 新注册的 Version 与 Deployment 使用新 profile；
7. 不自动合并同名 Artifact、served model、repository ID 或 endpoint。

这样避免：

- display name 冲突；
- 一个 Artifact 被错误归入业务 Model；
- 远端 served model alias 被当成 immutable version；
- 历史 Evaluation identity 被回填改写。

## 10. Endpoint、认证与网络安全

### 10.1 Endpoint 规范化

- 只接受 `http`/`https`；
- 禁止 userinfo、query、fragment、Unix socket 与非 HTTP scheme；
- URL 不得包含 credential-like text；
- redirect 默认禁止；
- endpoint 只进入 operator request、Catalog internal row 与 service resolve，不进 public projection；
- 禁止 ambient `HTTP_PROXY/HTTPS_PROXY/NO_PROXY`、自动 redirect 和跨 origin header 转发；
- `/models` discovery 只接受 JSON media type，并限制 header bytes、压缩前/解压后 bytes、JSON
  nodes/depth/model count，以及 connect/header/body/total timeout；建议首期解压后上限收紧为 256 KiB，
  不保存 response body；
- public HTTPS 强制系统 CA、hostname 与 SNI 校验；私有 CA 必须新增 versioned TLS profile，禁止全局
  关闭证书校验。

### 10.2 Private 与 public network policy

`connectivity_scope` 只选择不同的 default-deny policy。权威配置是 versioned
`model-endpoint-policy-v1` JSON；TypeScript API 与 Python EvalScope 分别使用 strict parser，并对同一组
跨语言 fixtures 得出完全一致的 allow/deny 结果：

- `private_network`：精确 hostname 与获准 CIDR 必须同时成立，scheme/port 精确匹配；IP literal 必须落在
  精确 CIDR；不支持 wildcard host；
- `public_network`：仅 HTTPS，精确 hostname/port，全部 A/AAAA 必须 globally routable；无条件拒绝
  loopback、RFC1918、CGNAT、link-local、metadata、multicast、unspecified、ULA 与宿主控制面；
- 两类都拒绝尾点/IDNA 混淆、IPv6 zone ID、IPv4-mapped IPv6 绕过和非规范 IP 表达；
- 每次新连接解析全部 A/AAAA，全部地址通过策略后，由受控 transport 把 socket 连接到已批准 IP，同时
  保留原 hostname 的 Host、TLS SNI 与证书验证；禁止“校验后再普通 fetch(hostname)”的 DNS TOCTOU；
- Node 使用受控 Undici dispatcher/connector；Python 使用等价的 pinned-address transport；API discovery
  与 EvalScope inference 都不得绕回当前 raw fetch/requests 默认连接；
- API health check 与 EvalScope execution 使用同一 policy source/generation；应用 allowlist 与容器 egress
  网络策略同时生效。

容器环境中 `127.0.0.1` 指向当前容器，不代表宿主机。用户注册本地模型时，必须提供 API/EvalScope
容器均可达的 Compose service name、内网 DNS 或精确 IP。

发布 capability 固定为：

| 发布 profile | private_network | public_network |
|---|---|---|
| ADR 0012 offline | 可在 exact allowlist 下 activation/check/evaluation | 只可登记 metadata，保持 `registered + unavailable` |
| future connected/hosted | 由后续 accepted ADR 与 D3 决定 | 由后续 accepted ADR 与 D3 决定 |

因此本方案支持注册远端服务，但不把尚未授权公网 egress 的离线安装伪装成可调用。Model selector 只展示
当前发布 profile 可达且 active 的 Deployment。

### 10.3 Credential reference

第一版新 profile 支持：

```text
auth_profile=none
auth_profile=bearer_ref + credential_ref
```

- create request 不接受 secret value；
- `credential_ref` 使用专用 opaque-ID schema：ASCII `[a-z0-9][a-z0-9._-]{0,127}`，拒绝 path separator、
  `..`、control 和 credential-like 内容；可进入 internal Catalog，但不进入 public projection；
- 第一版只实现 ADR 0012 offline backend：operator 权威文件位于
  `/etc/databench/secrets/model-credentials.json`，root-owned、专用 runtime group `0640`，安装/升级以
  atomic rename 更新；权威文件不挂入业务容器，部署工具按 `allowed_consumers` 编译带同一 generation 的
  `/run/secrets/api-model-credentials.json` 与 `/run/secrets/evalscope-model-credentials.json` 两份最小只读
  projection，分别挂入 API/EvalScope；
- registry envelope 固定 `profile=model-credentials-v1 + monotonically increasing generation +
  credentials`；备份只进入现有加密配置 escrow，不进入普通业务备份；hosted backend 继续受 D3 与后续
  ADR 决策门约束；
- unknown ref 在任何 DB 写入前拒绝；
- secret、Authorization header、resolved endpoint 不进入 log、error、report、archive manifest 或 tracing；
- API health checker只在内存中按 exact ref 解析，并由受控 transport 注入单个 Authorization header；
- EvalScope 在 atomic claim、新任务 admission 与 endpoint policy 通过后 JIT 解析；父进程通过继承的匿名
  pipe/FD 向 exact 执行进程传递一次性 secret snapshot，禁止 argv、环境变量、task config、HMAC digest、
  integration manifest 或磁盘临时文件传递；patched model client 只在 outbound transport 构造
  Authorization header；
- 日志、error、report、archive 与 tracing 同时按 exact secret value、credential ref key 和标准 auth
  header 名集中脱敏；错误只返回 stable code/字段 pointer，不回显原值；
- rotation 以 atomic generation 生效：已 claim 任务使用启动时 snapshot，新任务读取新 generation；更新
  ref 背后的 secret value不修改 Model Version 或 Deployment identity；
- secret registry ACL 同时限制 consumer 与 deployment/ref allowlist；projection 生成、reload 和 backup
  必须 fail closed。安全文档必须列出每个容器 projection 中的实际 ref 数量与 compromise blast radius，
  不能泛称“secret 不落库”即完成隔离。

新增自定义 header、mTLS、云 provider credential 等必须增加 versioned auth profile，不允许把任意 header
JSON 放进当前 wire contract。

## 11. REST 与投影

### 11.1 公共 REST 草案

```text
POST /v2/model-registrations:inspect
POST /v2/models:register
GET  /v2/models
GET  /v2/models/{model_id}
POST /v2/models/{model_id}:update                     metadata CAS
POST /v2/models/{model_id}:archive

POST /v2/models/{model_id}/versions:register
GET  /v2/models/{model_id}/versions
GET  /v2/model-versions/{version_id}

POST /v2/model-versions/{version_id}/deployments
GET  /v2/model-versions/{version_id}/deployments
POST /v2/model-versions/{version_id}/deployments/{deployment_id}:activate
POST /v2/model-versions/{version_id}/deployments/{deployment_id}:check
POST /v2/model-versions/{version_id}/deployments/{deployment_id}:disable
POST /v2/model-versions/{version_id}:refresh-source-evidence
POST /v2/model-versions/{version_id}/deployments/{deployment_id}:adopt

GET  /v2/models/{model_id}/aliases
POST /v2/models/{model_id}/aliases/{alias}:move       CAS
```

2026-08-05 owner 修订：统一 RBAC 落地前，上述公共 mutation 不再使用独立临时 operator Bearer。
internal v1/v2 Deployment resolve 仍只接受 service credential；endpoint policy、模型服务 credential 与
secret projection 不变。当前无用户鉴权的 mutation 仅用于单租户、本地/可信内网产品阶段，不能作为公网
开放依据。

现有以下 routes 保持兼容：

```text
/v2/model-artifacts*
/v2/model-deployments*
/v2/evaluation-runs*
```

`POST /v2/models:register` 用于提交 create-Model registration；`versions:register` 用于提交 existing-Model
registration。两者使用同一 normalization/claim implementation，commit request 必须带 inspect 返回的 exact
digest。list/get 必须定义 stable C-order cursor、archive filter、source/deployment filters 和 bounded summary；
所有 action 复用集中 error envelope，不自建第二套错误。

### 11.2 Inspect、Plan 与 Commit 契约

真实契约由 `@databench/schema` 的 strict discriminated union 定义。核心 shape：

```ts
type InspectRegistrationRequest = {
  target:
    | { kind: 'create_model'; key: string; display_name: string; description: string; tags: string[] }
    | { kind: 'existing_model'; model_id: UUID }
  version_label: string
  source: RegistrationSource
  alias?: { alias: string; expected_version_id: UUID | null }
}

type RegistrationSource =
  | { kind: 'databench_artifact'; artifact_id: UUID; deployment?: DeploymentDraft }
  | {
      kind: 'repository_reference'
      provider: 'hugging_face' | 'modelscope' | 'operator_managed'
      repository_id: string
      revision: string
      revision_kind: 'commit' | 'digest' | 'tag' | 'opaque'
      deployment?: DeploymentDraft
    }
  | {
      kind: 'existing_service'
      provider: 'openai_compatible'
      external_model_ref: string
      external_version_ref: string
      declared_reference_kind: 'immutable_version' | 'mutable_alias' | 'opaque'
      deployment: DeploymentDraft
    }

type DeploymentDraft = {
  display_name: string
  served_model_name: string
  connectivity_scope: 'private_network' | 'public_network'
  endpoint_base_url: string
  auth_profile: 'none' | 'bearer_ref'
  credential_ref: string | null
  declared_capabilities: {
    interfaces: ('chat_completions' | 'embeddings' | 'vision' | 'tools')[]
    context_limit: number | null
  }
}

type RegistrationPlan = {
  plan_profile: string
  normalized_request: InspectRegistrationRequest
  computed_source_mutability: 'immutable' | 'mutable' | 'unknown'
  computed_verification_level:
    | 'content_verified'
    | 'provider_verified'
    | 'operator_attested'
    | 'unverified'
  warnings: RegistrationWarning[]
  registration_digest: Hex64
}

type CommitRegistrationRequest = {
  request: InspectRegistrationRequest
  expected_registration_digest: Hex64
}
```

Existing Service 的 `deployment` 必填，其他来源在各自 source variant 内可选；客户端提供
mutability/verification、`bearer_ref` 无 ref 或 `none` 带 ref 都必须拒绝。所有文本使用集中式
bounded/sensitive-text schema；`repository_id/revision/external refs/display metadata/tags/warnings` 不得成为
secret、path 或错误回显通道。TypeScript 仅为示意，Web type 必须来自 generated client。

### 11.3 三个投影

```text
Public Web/OpenAPI
  Model/Version identity、source mutability、当前 verification、Artifact public metadata、
  Deployment opaque ID/served model/lifecycle/availability/health/declared capability；不含 endpoint/credential ref

Mutation / inspect response
  registration source、endpoint、auth profile、credential ref、inspect warnings

Internal EvalScope resolve
  /internal/v1 保持 Artifact-bound exact schema；
  /internal/v2 返回 active version-bound Deployment 的 strict source union、endpoint、served model、
  Model/Version/source fingerprint、primary Artifact nullable、auth profile + credential ref；不进入 OpenAPI
```

## 12. Web 产品设计

### 12.1 `/models` 注册表

默认桌面表格列：

```text
模型
候选版本
来源
基础模型
关键评测
Active Deployments / health
更新时间
```

筛选：

```text
source kind
source mutability
verification level
task family
artifact kind
alias/stage
deployment lifecycle/health
archive state
tags
search
```

默认排序固定为 `updated_at DESC, id ASC`，分页使用 namespace/query/filter scoped cursor。主要操作：
`注册模型`。

### 12.2 注册向导

第一步明确三种来源：

```text
从 Databench 产物注册
从模型仓库注册
注册已运行的本地/远端服务
```

已有服务再选择：

```text
本地/内网服务
远端服务
```

四步流程：

1. Model 信息：创建新 Model 或向已有 Model 添加 Version；
2. Source 信息：Artifact、Repository 或 Service；
3. Inspect：规范化结果、mutability、verification、lineage、endpoint/credential/capability/availability
   warnings；
4. Commit：提交 exact registration digest，展示创建的 Model/Version/registered Deployment，并在允许时
   单独执行 activation。

页面不得把以下状态混为“已验证”：

- Artifact bytes verified；
- repository exact reference declared/verified；
- endpoint health healthy；
- workload inference capability compatible；
- 模型质量通过 Evaluation；
- GPU runtime validated。

### 12.3 Model detail

Tabs：

```text
概览
版本
产物
测评
部署
血缘
```

- 概览：Model metadata、aliases、最新 Version、最近一次可比评测与 active Deployment；
- 版本：Version label/source/mutability/verification/base binding/created time 与版本比较；
- 产物：唯一 primary Artifact 的 digest、format、size；Repository/Service 显示“未托管权重”；
- 测评：immutable source 按 exact Model Version 展示可复现证据；mutable/unknown source 按 observation
  time 展示服务观察，不默认跨时间合并比较；
- 部署：served model、scope、lifecycle、health、capability、activate/check/disable；不向普通读取暴露
  endpoint；
- 血缘：Dataset → Session/未来 Training Run → Artifact/Repository/Service → Version → Deployment → Evaluation。

“关键评测”不计算跨 Benchmark/Dataset/Metric 的全局分数。第一版只展示“最近一次可比评测”，summary
必须携带 benchmark、Dataset exact version、metric/output key、run time 和 source reproducibility；若 Model
配置了后续 scorecard 才按该显式定义聚合。列表 API 提供 bounded summary，禁止页面 N+1 读取 report。

### 12.4 训练和测评入口

- Artifact detail 增加“注册为模型 / 添加为新版本”；
- Studio Artifact import 完成后不自动创建逻辑 Model，除非后续 Training Profile 明确绑定 Model；
- Evaluation selector 改为 `Model → Version → active Deployment`，并按 workload capability admission；最终
  browser payload 仍只提交 opaque Deployment ID；
- repository-only Version 显示“尚未部署”，不能发起在线 Evaluation；
- manual endpoint 保留为 Expert Mode，不自动写入 Registry。

Deployment capability 至少包含 operator-attested `chat_completions|embeddings|vision|tools` 与 context limit。
`/models` discovery healthy 只表示 endpoint/model discovery 正常；显式“运行兼容性检查”才可验证具体
workload，且 UI 必须提示它会产生真实调用与可能计费。Model archive 后 Deployment 不自动 disable，页面
必须显示“模型已归档但仍在服务”；list 默认排除 archived，提供显式 filter，restore 只恢复 Model metadata
可见性，不改变 Deployment。

## 13. CLI 与 MCP

建议 CLI：

```text
databench model list
databench model show <model>
databench model registration inspect --input <json> --output <plan.json>
databench model registration commit --input <json> --expected-digest <hex64>
databench model versions <model>
databench model deployment list|activate|check|disable
```

- CLI 仍只调用 Workspace + Schema，不直连 Catalog；
- `inspect` 输出有界 plan 与 digest；`commit` 重新提交原 strict request + expected digest，不把 plan 当作
  无签名、可任意篡改的写入指令；
- 大权重不经 CLI JSON；未来 Artifact import 使用独立 streaming contract；
- 首期 MCP 四个 tools 保持不变。Model Registry MCP tools 必须由后续独立需求和安全 review 决定；
- 不在 MCP 参数中传 endpoint credential 或任意本地路径。

## 14. 失败、一致性与恢复

| 场景 | 结果 |
|---|---|
| inspect 后输入变化 | registration digest mismatch，零写入 |
| 同 exact register 响应丢失 | 幂等返回同 Model/Version/Deployment |
| Model key 已存在但 metadata 不同 | typed conflict，引导选择已有 Model 或 CAS update |
| version label 已指向其他 source | typed conflict，不覆盖 |
| same source 已用另一 label 注册 | typed conflict，返回 existing Version locator |
| Artifact 消失/namespace 不符 | not found/integrity failure，零 Version 写入 |
| repository 暂不可达 | 允许 operator-attested declared reference，明确 unavailable warning |
| endpoint discovery 失败 | Version/Deployment 保持 registered + unhealthy；不激活、不伪造 compatible |
| credential ref 不存在 | 写入前拒绝 |
| inspect 后 policy/ref generation 变化 | 新 commit 重新校验；activation 双读 generation 不一致则保持 registered |
| exact registration 已提交后 policy/ref 被撤销 | replay 直接返回既有资源；后续 activation/inference fail closed |
| active Deployment 的 policy/ref 被撤销 | 保留 lifecycle，投影 availability=unavailable，selector 排除 |
| PG transaction 失败 | Model/Version/source/deployment 全回滚 |
| health update 失败 | 不改变 Deployment lifecycle 或 Model Version |
| archive Model | 不 disable Deployment、不删除历史数据 |
| adoption 重复相同目标 | 幂等返回原 association |
| adoption 指向不同 Version | typed conflict，禁止重新归属 |

不能在普通启动或读取请求中自动扫描、采用、合并或删除 Model/Artifact/Deployment。

## 15. 容量与边界

初始上限建议：

```text
models/version/deployment page max       100
registration request                     64 KiB
display name                             256 UTF-8 bytes
description                              8 KiB
tags                                     64 items / each 128 bytes
repository ID / served model             512 bytes
external version ref                     256 bytes
endpoint URL                             2048 bytes
health response compressed               128 KiB
health response decompressed             256 KiB
health JSON                              depth 16 / nodes 10k / models 1k
credential ref                           128 ASCII bytes
source evidence                          16 KiB / row
```

- 注册接口不接收权重 bytes；
- source/evidence JSON 必须 strict + bounded，不能成为任意 provider response dump；
- Model list 不同步探测所有 Deployment；health 只由显式 check/后续 bounded reconciler更新；
- 不在列表 N+1 读取 Artifact object 或 EvalScope report payload；使用 Catalog summary/有界查询。

## 16. 包边界与代码落点

```text
packages/hashing/src/v2/model-registry.ts
packages/schema/src/v2/model.ts
packages/schema/src/v2/model-version.ts
packages/catalog/src/v2/catalog.ts
packages/workspace/src/v2/model.ts
packages/workspace/src/v2/model-registration.ts
packages/workspace/src/v2/model-repository.ts
packages/workspace/src/v2/model-deployment.ts

apps/api/src/model-endpoint-policy/
apps/api/src/model-credentials/
apps/api/src/routes/v2/models.ts
apps/api/src/routes/v2/model-deployments.ts

workers/evalscope/src/databench_evalscope/model_endpoint_policy.py
workers/evalscope/src/databench_evalscope/model_credentials.py

apps/web/src/models/
  api/
  components/
  features/
  routes/

prisma/migrations/<next>_model_registry_v2/
```

依赖保持：

```text
apps/api → workspace + schema
workspace → catalog/store/io/schema/hashing
catalog → Prisma only
apps/web → generated OpenAPI client
EvalScope → Databench internal resolver
```

- Registry metadata不进入 `deploy/`；`deploy/` 只保存部署资产；
- repository/provider adapter若需要 Python materialization，后续走 Worker capability，不让 Catalog/Schema
  依赖 Python；
- Model Registry 不要求新的持久化服务；offline credential registry 是 operator 配置面，不是业务数据库。

## 17. 测试与 Gate

### 17.1 Schema/Hashing

- 三个 source 与 create/existing target strict union、limits、path/credential/sensitive-text negative cases；
- source fingerprint、Version create、registration plan、Deployment v2 独立 fixed vectors；
- key/revision/repository/endpoint normalization permutation；
- source fingerprint 排除 label/model、Deployment digest绑定 version ID、registration claim 重放与
  label/source conflict；
- 现有 Artifact/Deployment/Evaluation fixed vectors bytes 不变。

### 17.2 Catalog/Workspace

- fresh migration 与已有 S4 schema forward migration；
- deferred source XOR、namespace composite FK、Alias 三列 FK、profile-specific nullable Artifact checks；
- Model metadata CAS、alias CAS、concurrent register；
- durable registration claim、transaction rollback、response loss、policy/ref 变化后 replay；
- explicit append-only adoption CAS，不自动同名合并或重归属；
- legacy top-level/internal v1 只读旧 profile，新 row 不进入旧 parser；
- new v5/v6 Evaluation identity、三组 composite FK、Artifact/source snapshot shape；
- EvalScope `atomic claim → resolve once` 顺序与 terminal replay 不读当前 Registry/secret。

### 17.3 Endpoint/secret/security

- local/private、remote/public fake OpenAI-compatible discovery 与 inference；
- unknown served model、media type、header/compressed/decompressed/JSON limits、分段 timeout、redirect；
- 跨语言 policy fixtures；DNS rebinding、dual-stack、IPv4-mapped IPv6、IDNA/尾点/zone ID、metadata、
  link-local/RFC1918/CGNAT/ULA；socket 必须连接 approved IP 且保留 Host/SNI；
- offline `public_network` 保持 registered + unavailable；禁止 ambient proxy；
- unknown/wrong credential ref、atomic generation rotation、running-task snapshot、FD injection、
  exact secret/ref/header 的 public/log/report/archive/tracing non-leak；
- public mutation 无临时 operator token、internal service credential 隔离与 endpoint/query/header smuggling；
- internal v1/v2 resolver 都只消费 opaque Deployment ID，v2 strict union 不返回 secret value。

### 17.4 Web/CLI

- 三种来源完整注册；
- create Model 与 add Version；
- warnings、mutability/verification、mutable observation、unverified lineage 明确展示；
- Model list/detail/version/artifact/evaluation/deployment/lineage；
- Artifact → Model adoption；
- Model → Version → Deployment evaluation request body 无 endpoint/credential；
- discovery health 与 workload compatibility 不混淆；selector 按 capability admission；
- archived-but-serving、registered + unavailable、stable pagination/search/archive filter；
- direct refresh、keyboard、a11y、i18n、desktop/narrow、console clean；
- CLI streaming/error/exit behavior。

### 17.5 共同 Gate

```bash
pnpm lint
pnpm build
pnpm typecheck
pnpm test
pnpm openapi:check
pnpm v2:status:check
pnpm peers check
pnpm offline:check
git diff --check
```

涉及 Catalog/Workspace/API 必须运行真实 PostgreSQL + MinIO；涉及 Web 必须跑真实浏览器；涉及远端
endpoint 必须使用受控 fake/测试网络，不依赖公开互联网。完成 Model Registry gate 也不自动完成
V16/V17、GE9、Swift deferred GPU gate 或 production readiness。

## 18. 建议实施切片（待独立 PLAN 接受）

```text
MR0  新 ADR、方案、状态、fixtures 与 gate skeleton
MR1  source fingerprint/Version/registration identity、Schema、Catalog、migration 与 durable claim
MR2  Databench Artifact 注册、Alias candidate、legacy adoption association、REST 与 Models 基础页面
MR3  Repository reference、append-only source evidence 与 refresh
MR4  versioned endpoint policy、offline secret backend、跨语言 fixtures、受控 transport 与 legacy network hardening
MR5  Existing Service、version-bound Deployment、activation、public/nested REST 与 internal resolver v2
MR6  Evaluation v5/v6、EvalScope claim/resolve/secret 顺序与精确 lineage
MR7  Model detail、lineage、可比评测 summary、capability selector 与浏览器 gate
MR8  CLI、离线 lifecycle/backup/rollback、全仓 final gate
```

进入条件：

- MR0 必须先接受“Model/Version/Artifact/Deployment 分层”和三种来源；
- MR1 必须先以 fresh/forward migration 证明 source XOR、Alias FK、claim replay；
- MR4 必须先于任何 Existing Service runtime，且只交付本方案固定的 offline secret backend/private
  activation；不绕过 D3 开启 public egress；
- MR5 必须保持 legacy top-level/internal v1 exact contract；
- MR6 不得重写历史 Evaluation identity，并必须修正 atomic claim 前 resolve 的 TOCTOU；
- 一个 accepted Step 一个 PR/commit，当前 gate 通过后再进入下一步。

## 19. Owner 决策

owner 于 2026-08-04 接受以下首期范围：

1. MR2 交付 `candidate` Alias；`staging/production` 留到后续 promotion gate；
2. MR3 首批启用 `modelscope + operator_managed`；Hugging Face 保留 schema/profile，不提前声明 runtime
   availability；
3. MR2 同期交付 CLI list/show，registration/deployment actions 在 MR8 补齐；
4. 一级导航固定为“数据集 / 训练 / 模型 / 测评”。

以下内容是已接受的硬约束，不是实现时可选开关：mutability 与 verification 必须拆分；mutable/unknown
source 不得进入 promotion Alias；旧数据只允许显式 append-only adoption；第一版 offline secret backend、
public-network 禁用和 internal v1/v2 隔离按本方案执行。Hosted secret backend 与公网 egress 仍必须等待
D3/新 ADR，不能由 Model Registry 方案越权决定。

owner 已授权按 `PLAN.md` 的 Gate 顺序实施 MR0-MR8；一个 Step 全绿并单独提交后才可进入下一 Step。
该授权不包含跳 Step、公共云 D3 选型、hosted secret backend、managed serving、GPU gate 或 production
readiness。实施状态以 `STATUS.md` 为准，且必须继续保持 S4
`non-GPU contract green / GPU deferred`、V16/V17 未完成等真实发布边界。
