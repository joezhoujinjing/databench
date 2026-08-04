# ADR 0019 — Model Registry、三种注册来源与版本绑定部署

- **状态:** Accepted——owner 于 2026-08-04 在四项推荐范围列明后要求“下一步叭”，接受本 ADR、
  技术方案与实施计划并授权进入 MR0
- **日期:** 2026-08-04
- **决策者:** owner
- **依赖:** [ADR 0011](0011-identity-hashing-versioning-v2.md)、
  [ADR 0012](0012-offline-single-host-deployment.md)、
  [ADR 0013](0013-v2-product-cutover-and-v1-retirement.md)、
  [ADR 0017](0017-evalscope-native-ui-integration.md)、
  [ADR 0018](0018-ms-swift-native-gradio-studio.md)
- **详细方案:** [Model Registry 技术方案](../models/TECHNICAL-DESIGN.md)
- **实施计划:** [Model Registry 实施计划](../models/PLAN.md)

> 本 ADR 只授权按 MR0-MR8 逐 Step 实施；当前仅进入 MR0，不授权提前修改 MR1+ runtime、OpenAPI、
> Prisma、离线发布或产品 capability。

## 背景

Databench 已经拥有 Dataset、Swift Studio Session、immutable LoRA Model Artifact、Artifact-bound Model
Deployment、Evaluation Run 与 Report，但没有独立的逻辑 Model 和 Model Version。当前 Artifact detail
承担了模型库入口，Deployment 又只能绑定 verified-base LoRA Artifact，导致以下来源无法进入统一产品面：

1. Databench 已有 Model Artifact；
2. Hugging Face、ModelScope 或 operator-managed repository reference；
3. 已经运行的本地、内网或远端 OpenAI-compatible service。

如果直接把 URL、仓库名或 Artifact display name 当成 Model，会混淆逻辑产品身份、权重版本、实际
serving 实例和质量证据，也会破坏 ADR 0018 已接受的 Deployment/Evaluation identity。

## 决策

### 1. 增加 `Model` 与不可变 `Model Version` 聚合层

领域层级固定为：

```text
Model
└─ Model Version
   ├─ Source
   ├─ Primary Artifact（仅 Artifact 来源）
   ├─ Source Evidence
   ├─ Deployments
   ├─ Evaluations
   └─ Aliases
```

- `Model` 是 namespace 内稳定逻辑身份，stable key 创建后不可修改；display metadata 使用 revision CAS；
- `Model Version` 冻结 version label、source locator、base binding、source fingerprint 与 create digest；
- endpoint、served model、health、credential rotation 和 lifecycle 属于 Deployment，不属于 Version；
- Model archive 不删除历史对象，也不自动 disable Deployment；
- 当前没有 principal/RBAC，不增加假的 owner/user 字段。

### 2. 支持三种来源，但统一注册成同一种 Version

```text
databench_artifact
repository_reference
existing_service
```

- Artifact 来源绑定现有 immutable Artifact、manifest/digest 与真实 lineage；
- Repository 来源只登记 canonical provider/repository/revision，不自动下载权重；
- Existing Service 来源登记 operator/provider 声明的 external model/version ref，并强制创建首个
  `registered` Deployment；
- 外部来源不得伪造 Dataset、Training Run、Artifact 或 content-verified lineage；
- Repository materialize 成 Databench bytes 后创建新的 Artifact-source Version，并以 evidence 指回原
  Version，不原地改变 source kind。

### 3. Source mutability 与 verification level 分开表达

冻结的 source locator 参与 `source_fingerprint`；以下两项是从 locator 与 append-only evidence 派生的
正交投影：

```text
source_mutability = immutable | mutable | unknown
verification_level = content_verified | provider_verified |
                     operator_attested | unverified
```

- 浏览器和 CLI 不得自报最终分类；Workspace 统一计算；
- evidence 可以让 `unknown → immutable|mutable` 或提升 verification；
- tag/provider alias 等已知 mutable locator 不能靠 operator attestation 变成 immutable；
- mutable/unknown Version 可以注册和评测，但不得进入 `candidate/staging/production` Alias；
- Evaluation 保存创建时的 classification/evidence snapshot；mutable/unknown 结果显示为某时刻服务观察，
  不冒充可复现权重证据。

### 4. 第一版一个 Artifact-source Version 只有一个 serving-effective Artifact

- 一个 Artifact-source Version 必须且只能绑定一个 primary Artifact；
- Deployment 和 Evaluation 精确绑定该 Artifact；
- merged、quantized 或其他会改变 serving 行为的 Artifact 创建新 Version；
- tokenizer 等配套文件属于 primary Artifact manifest；
- 若未来需要同 Version 多个可独立 serving 的变体，必须先引入一等 `Model Build/Variant`。

### 5. Deployment 使用新 profile，旧 S4 契约保持隔离

现有 `artifact-bound-v1` 不删除、不重写。新增 `model-version-v1`：

- 生命周期为 `registered|active|disabled`，注册事务只创建 `registered`；
- activation 在事务外完成 endpoint、credential、capability admission；
- `availability` 由当前发布 profile/policy/ref 派生，不改写 lifecycle；
- Artifact-source Deployment 必须绑定 Version primary Artifact；Repository/Service Deployment 的
  `artifact_id` 必须为空；
- endpoint、served model、credential ref 名或 declared capability 改变时创建新 Deployment；secret value
  rotation 不改变 Deployment identity。

兼容边界固定为：

- 顶层 `/v2/model-deployments*` 和 `/internal/v1/model-deployments/{id}:resolve` 只读取
  `artifact-bound-v1`，response schema 与 fixed vectors不变；
- 新 nested routes 使用独立 `ModelVersionDeployment` schema；
- `/internal/v2/model-deployments/{id}:resolve` 返回 version-bound strict union；
- 新 Deployment ID 在旧 show/internal v1 route 返回 404；
- 历史 Deployment adoption 写独立 append-only association，只提供导航，不改旧 row/create digest，也不
  自动进入新 Evaluation selector。

### 6. Registration 使用 inspect/commit 与 durable claim

```text
inspect strict request
→ normalized plan + classification/evidence + warnings
→ registration digest
→ commit(original request + expected digest)
```

- source fingerprint、Version create digest、registration plan digest 和 Deployment digest 使用独立 strict
  profile/domain/fixed vectors；
- source fingerprint 不含 Model ID 或 version label；Version digest绑定二者与 source fingerprint；
- Deployment v2 digest额外绑定 `model_version_id`，避免同一 source 进入两个逻辑 Model 时碰撞；
- Model/Version/source/primary Artifact/optional registered Deployment/optional Alias/registration claim 在同一
  PostgreSQL transaction 提交；
- 网络、DNS、repository download、secret value 和 object-store I/O 不进入 transaction；
- durable claim 保存 strict normalized request envelope 与结果 locator；exact response-loss replay 先读 claim，
  不依赖当前网络、secret 或 provider availability；不同 request 复用 digest 返回 conflict。

### 7. 数据库约束必须实际证明领域不变量

- `model_versions_v2` 提供 `UNIQUE(namespace_id, model_id, id)`，供 Alias/Evaluation composite FK；
- 三张 source 表使用 deferred constraint trigger 保证且只保证一个匹配 source row；
- Artifact source row是 primary binding 唯一真源；
- registration claim、source evidence 和 legacy adoption 使用独立表；
- `model_deployments_v2.artifact_id` 虽为新 profile 放宽为 nullable，但 profile-specific CHECK 保证旧行仍非空；
- migration 显式替换当前 `provider=openai_compatible AND auth_mode=none` 固定 CHECK，旧 profile 不放宽；
- Evaluation v5/v6 使用 composite FK 同时绑定 Model、Version、Deployment digest 与 nullable exact Artifact；
- 历史 Evaluation v1-v4 identity、列和 FK 不改写、不自动 backfill。

### 8. Endpoint 使用共享、可执行的 default-deny transport policy

- Endpoint 只接受无 userinfo/query/fragment 的 HTTP(S)，禁止 redirect、ambient proxy 和任意 header JSON；
- TypeScript API 与 Python EvalScope 解析同一 `model-endpoint-policy-v1` 语义和跨语言 fixtures；
- private policy 要求 exact hostname、CIDR、scheme、port 同时匹配；
- public policy 要求 HTTPS 且全部 A/AAAA globally routable；loopback、RFC1918、CGNAT、link-local、metadata、
  multicast、unspecified、ULA 默认拒绝；
- transport 连接已批准 IP，同时保留原 hostname 的 Host、TLS SNI 和证书校验，禁止 DNS 检查后再用普通
  fetch(hostname)；
- discovery response 有 header/compressed/decompressed/JSON/time 上限；health 不等于 inference capability；
- ADR 0012 offline profile 只允许 private activation；public endpoint 可以登记 metadata，但保持
  `registered + unavailable`。公网 activation 继续受公共云 D3/新 ADR 决策门约束。

### 9. 第一版 bearer credential 使用 offline file-backed registry

- 公共请求只接受 opaque `credential_ref`，不接受 secret value；PostgreSQL 不保存 secret；
- operator 权威文件位于 `/etc/databench/secrets/model-credentials.json`，root-owned、atomic generation；
- 权威文件不挂入容器；部署工具按 consumer/ref allowlist 编译 API 与 EvalScope 的最小只读 projection；
- API 在受控 transport 内注入 Authorization；EvalScope 在 atomic task claim 后 JIT resolve，并通过继承的
  anonymous pipe/FD 给 exact execution process，禁止 argv、env、task config、manifest 或临时文件；
- rotation 对新任务读取新 generation，已 claim 任务使用启动 snapshot；
- secret/ref/header 必须从 log、error、report、archive 和 tracing 集中脱敏；
- hosted secret backend 不由本 ADR 决定。

### 10. Evaluation 新 profile 保持精确 lineage 与既有 replay 语义

- v5/v6 绑定 Model、Version、Deployment、Deployment digest、Artifact nullable binding、classification 和
  evidence digest；
- Artifact-source Run 必须携带 exact primary Artifact；Repository/Service Run 的 Artifact 必须为空；
- 浏览器仍只提交 opaque Deployment ID，internal resolver补齐其余材料；
- EvalScope 顺序固定为 `validate/digest → atomic claim → replay fast path → capacity → resolve once →
  endpoint policy → secret resolve → launch`；
- terminal replay 不重新读取 Registry、endpoint、secret、capacity 或 lifecycle；只有新 admission 要求 active；
- source-less Benchmark + Deployment 保持 expert/untracked，不伪造成 Databench Run。

### 11. 增加无版本 Models 产品面

```text
/models
/models/:modelId
/models/:modelId/versions/:versionId
```

- 一级产品链建议为“数据集 / 训练 / 模型 / 测评”；
- 注册向导明确三种来源，使用 Inspect → Commit；
- Model detail 提供概览、版本、产物、测评、部署、血缘；
- “关键评测”只展示带 Benchmark、Dataset exact version、Metric/output、时间与 reproducibility 的最近一次
  可比评测，不计算跨 Benchmark 的全局分数；
- Evaluation selector 使用 `Model → Version → active available Deployment`，并执行 capability admission；
- Web wire type 继续只来自 OpenAPI generated client。

## Owner 接受的首期范围

owner 接受：

1. MR2 交付 `candidate` Alias；`staging/production` 留到后续 promotion gate；
2. Repository runtime 首批启用 ModelScope + operator-managed；Hugging Face 保留 schema/profile，不提前声明
   availability；
3. CLI 分阶段交付：MR2 list/show，MR8 registration/deployment actions；
4. 一级导航固定为“数据集 / 训练 / 模型 / 测评”。

安全、identity 和 legacy compatibility 约束不是可选产品开关。

## 非目标

- 不实现 Training Run/Attempt/Profile 或接管 Gradio callback；
- 不自动启动、停止、扩缩容或调度 serving；
- 不在注册请求上传权重，不扫描浏览器提交的宿主绝对路径；
- 不实现多租户 principal/RBAC、计费、marketplace、retention/GC 或 destructive deletion；
- 不开放公共云 egress，不选择 hosted secret backend；
- 不完成 V16/V17、EvalScope GE9、Swift deferred GPU gate 或 production readiness。

## 被否决的替代方案

### 只用 Artifact 充当 Model

无法表达逻辑产品身份、外部 repository/service、aliases 和跨版本评测，继续让 Artifact detail 承担过多职责。

### 把 endpoint 放进 Model Version

服务迁移、credential rotation 和 health 会污染权重版本 identity，也无法表达同一 Version 的多个部署实例。

### 把三种来源塞进一个 nullable JSON

数据库无法可靠保证 source XOR、namespace binding 和精确 FK，容易产生无法解析的半行。

### 自动按 display name/served model/endpoint 回填历史数据

这些字段都不是可靠身份，会错误合并 Artifact、Deployment 和 Evaluation，并改写用户理解的 lineage。

### 在现有 public/internal Deployment schema 上直接把 Artifact 改成 nullable

会让新 row 进入旧 strict parser，破坏 ADR 0017/0018 的公共与 internal contract。

### 由浏览器直接提交 API key 或任意 headers

会把 secret 扩散到 OpenAPI、浏览器状态、日志、任务 payload 和报告，不满足当前安全边界。

## 后果

- **+** 数据、训练产物、模型版本、部署和评测形成稳定产品链；
- **+** 三种来源共享同一 Model/Version 体验，又保留来源可信度与可复现性差异；
- **+** 旧 S4 Deployment/Evaluation identity 不被新产品面破坏；
- **+** endpoint、credential、health 和 capability 有明确安全与生命周期边界；
- **−** 需要新增多个 identity profile、表、constraint trigger、resolver v2 与 EvalScope adapter；
- **−** offline public endpoint 只能登记、不能激活；
- **−** 第一版一个 Version 一个 primary Artifact，暂不支持同版本多 serving variant；
- **−** 完整交付需要跨 Schema/Catalog/Workspace/API/Web/EvalScope/deploy 的多个严格 Step。

## 实施授权边界

owner 已授权进入 MR0。每个后续 Step 仍必须在前一 Gate 全绿后单独进入；接受本 ADR 不自动接受公共云、
hosted secret backend、managed serving、deferred GPU gate 或 production readiness。
