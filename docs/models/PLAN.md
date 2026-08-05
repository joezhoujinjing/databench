# Databench Model Registry 实施计划

- **状态:** Accepted——owner 于 2026-08-04 在四项推荐范围列明后要求“下一步叭”，并授权按 Gate 顺序
  实施 MR0-MR8；2026-08-05 接受 post-MR8 修订，将公共 Model mutation 的用户鉴权延后到统一 RBAC
- **日期:** 2026-08-04
- **决策:** [ADR 0019](../decisions/0019-model-registry.md)
- **技术方案:** [TECHNICAL-DESIGN.md](TECHNICAL-DESIGN.md)
- **实施纪律:** 一个 accepted Step 一个 PR/commit；当前 gate 全绿后再进入下一 Step

> 当前授权覆盖 MR0-MR8 的顺序实施；每个 Gate 全绿并单独提交后，才可进入下一 Step。

## 1. 交付目标

建立 Databench 的一级 Model Registry：

```text
Dataset Version
→ Swift Studio Session / future Training Run
→ Model Artifact / Repository Reference / Existing Service
→ Model Version
→ Model Deployment
→ Evaluation Run / Report
```

最终产品面提供：

```text
/models
  ├─ 注册表、搜索、筛选、分页
  ├─ 三来源 Inspect → Commit 注册
  ├─ Model / Version / Alias
  ├─ Primary Artifact / Source Evidence
  ├─ Deployment lifecycle / availability / health / capability
  ├─ Evaluation summary / compare boundary
  └─ exact lineage
```

完成本计划只表示 Model Registry 自身 gate 关闭，不自动完成 V16/V17、EvalScope GE9、Swift deferred GPU
gate、公共云 D3 或 production readiness。

## 2. Owner 接受的范围

owner 已同时接受 ADR 0019、技术方案、本计划与以下首期范围：

| 决策 | 推荐默认值 | 影响 |
|---|---|---|
| Alias | MR2 交付 `candidate` | `staging/production` 留待 promotion policy |
| Repository providers | ModelScope + operator-managed | Hugging Face 只保留 schema/profile |
| CLI 节奏 | MR2 list/show，MR8 写操作 | Web 先形成主闭环 |
| 一级导航 | 数据集 / 训练 / 模型 / 测评 | 固定产品主链 |

2026-08-05 owner 追加范围修订：当前不保留独立 Model operator token，公共 Model mutation 暂时不做用户
鉴权；internal Deployment resolve 的 service credential 与 endpoint/secret 安全边界不变。统一 RBAC 必须在
公共云 D3、公网开放或不可信多用户部署之前完成。

后续修改产品范围时必须先同步更新 ADR、技术方案与本计划；不得借范围选择放宽 identity、安全、legacy
compatibility 或发布边界。

## 3. 全程硬约束

1. API/CLI 只经 Workspace + Schema；Catalog 只依赖 Prisma；Web 只使用 generated OpenAPI client。
2. Identity 只走 `@databench/hashing` RFC 8785 + BLAKE3 具名 profile/domain；禁止裸 `JSON.stringify`。
3. Model Version 冻结 source locator/create identity；mutability/verification 由 evidence 派生，客户端不自报。
4. 第一版一个 Artifact-source Version 只有一个 primary Artifact；Deployment/Evaluation 精确绑定它。
5. Repository/Service 不伪造 Artifact、Dataset、Training 或 content-verified lineage。
6. 旧 `artifact-bound-v1` public/internal v1/Evaluation v1-v4 契约和 fixed vectors保持不变。
7. 新 Deployment 先 registered 后 activation；当前 availability fail closed，不自动改写 lifecycle。
8. Endpoint 必须经过共享 default-deny policy和 pinned-address transport；禁止 raw fetch/requests 绕过。
9. Secret value 不进 PostgreSQL、OpenAPI、浏览器、argv/env、task config、manifest、日志、report 或 archive。
10. ADR 0012 offline profile 不激活 public-network Deployment；公共云 D3 未决状态保持真实。
11. EvalScope 新任务 atomic claim 在 resolve/policy/secret 之前；terminal replay 不读取当前外部状态。
12. 历史数据只做显式 append-only adoption；禁止名称推断、自动 backfill 或历史 identity 改写。
13. 所有 migration additive、FK `RESTRICT`、普通启动/读取不扫描或删除对象。
14. 每个 Step 同步更新 fixtures、测试、OpenAPI/generated client、状态和 runbook；不把工作推迟到 final gate。

## 4. Step 概览

| Step | 目标 | 主要交付 | 进入条件 |
|---|---|---|---|
| MR0 | 决策与防误报基线 | Accepted docs、fixtures、gate/status skeleton | owner 接受三份文档与范围 |
| MR1 | Model/Version identity 与 Catalog | profiles、Schema、核心表、source XOR、registration claim | GMR0 green |
| MR2 | Artifact 注册与基础产品面 | Artifact source、Alias candidate、adoption、基础 REST/Web/CLI read | GMR1 green |
| MR3 | Repository reference 与 evidence | provider adapters、evidence/refresh、offline semantics | GMR2 green |
| MR4 | Endpoint 与 secret 安全底座 | shared policy、pinned transport、offline credential registry | GMR3 green |
| MR5 | Existing Service 与 Deployment v2 | registered/activate、nested REST、internal v2、capability | GMR4 green |
| MR6 | Evaluation v5/v6 | exact FK/identity、EvalScope claim/resolve/secret、mutable observation | GMR5 green |
| MR7 | 完整 Model 产品面 | detail/lineage/evaluation summary/selector/browser gate | GMR6 green |
| MR8 | CLI、离线与 final gate | write CLI、backup/upgrade/rollback、全仓收口 | GMR7 green |

## 5. MR0 — 决策、fixtures 与状态基线

### 目标

把 Proposed 文档变成唯一 accepted 实施入口，并在任何 runtime 代码出现前建立防误报 gate。

### 交付

- owner 接受 ADR 0019、技术方案、本计划和四项首期范围；
- 三份文档状态改为 Accepted，记录准确日期和 owner wording；
- 新增 `docs/models/STATUS.md`，初始状态 `current_step: MR0`、`last_completed_step: none`；
- 建立 fixture index，预登记所有 source fingerprint、Version、registration、Deployment、Evaluation profile；
- 建立 Model Registry status checker，拒绝跳 Step、缺 fixture、误报 public-network/GPU/V16/V17；
- 建立数据库 shape fixture：core tables、source XOR、legacy/new Deployment profiles、Evaluation v5/v6；
- 建立 endpoint policy 跨语言 fixture schema 和 secret registry fixture schema，但不接线 runtime；
- 固定 legacy public/internal v1/OpenAPI/fixed-vector baseline digest；
- 文档说明当前 runtime 仍为 Artifact-bound S4。

### Gate GMR0

- owner acceptance 可从 ADR/PLAN/STATUS 一致读出；
- fixture index 双向校验，无 orphan/missing profile；
- legacy baseline 来自当前真实 Schema/OpenAPI/migration/EvalScope adapter；
- status checker 的 skipped-step、false-green、public-network/GPU 误报负测通过；
- links、fences、trailing whitespace、`git diff --check`、`pnpm lint`、`pnpm v2:status:check` 通过；
- MR0 不修改 runtime、Prisma、OpenAPI 或产品 capability。

## 6. MR1 — Model/Version identity、Schema 与 Catalog

### 目标

建立不依赖 Web/endpoint 的 Model、Version、source、evidence、Alias 和 durable registration 控制面。

### 交付

- `model-create-v1`；三种 source-fingerprint、Version create、registration plan profile；
- 独立 strict Zod source/target/plan/commit envelopes、limits、sensitive-text 与 error taxonomy；
- `models_v2`、`model_versions_v2`、三张 source 表、`model_source_evidence_v2`、
  `model_aliases_v2`、`model_registration_claims_v2`；
- `UNIQUE(namespace_id, model_id, id)` 与全部 namespace composite FK；
- deferred constraint trigger 强制 source_kind 与唯一 source row；
- Artifact source row作为唯一 primary binding 真源；
- source classification aggregator，只从 frozen locator + evidence 派生；
- Model metadata CAS、Alias CAS 基础 Catalog API；
- inspect/commit normalization 与 transaction claim/replay，不开放公共 route；
- fresh migration 与从当前 S4 schema 的真实 forward migration。

### Gate GMR1

- 所有 profile strict schemas、domain bytes 与独立 fixed vectors通过；
- source fingerprint 排除 model/label，Version digest包含二者，Deployment profile尚不启用；
- Unicode/order/permutation/replay/conflict/collision negative tests通过；
- deferred XOR 在缺 row、多 row、错 kind、并发 transaction 下 fail closed；
- Alias 三列 FK migration 实际创建成功；
- exact registration response-loss replay、不同 request/digest conflict、transaction rollback通过；
- fresh/forward PostgreSQL migration 保留所有旧 row/constraint/fixed vector；
- Catalog/Schema/Hashing tests与适用全仓 gates通过。

### 不包含

- 公共 Model REST/Web；
- repository network access；
- version-bound Deployment；
- Evaluation v5/v6。

## 7. MR2 — Databench Artifact 注册与基础 Models 产品面

### 目标

让现有 immutable Model Artifact 显式进入 Model/Version，并交付最小可用 `/models` 注册表。

### 交付

- Artifact inspect/commit Workspace orchestration，验证 namespace/kind/format/digest/base binding/lineage；
- 一个 Version 一个 primary Artifact 的数据库与 Workspace enforcement；
- `POST /v2/model-registrations:inspect`、create Model/register Version、Model/Version list/show；
- Model metadata update/archive 与 `candidate` Alias CAS（若 owner 接受推荐默认值）；
- `model_version_deployment_adoptions_v2` 和显式 adoption action；
- adoption 只允许 absent→exact，重复同目标幂等、不同目标 conflict；
- 历史 Artifact/Deployment/Evaluation 导航，不改旧 row/digest；
- `/models` list、Model/Version 基础 detail、Artifact detail“注册为模型”；
- stable cursor、search/archive filter、source classification 与未归入 Artifact 列表；
- CLI `model list/show`（若 owner 接受推荐默认值）；
- OpenAPI 与 generated Web client。

### Gate GMR2

- Artifact source verified/external lineage 不越权；nullable base revision + binding status正确；
- 同 Artifact/同 Model 换 label conflict；同 Artifact可显式进入不同逻辑 Model且 identity不碰撞；
- primary Artifact唯一、merged/quantized 不能追加为无 identity variant；
- adoption concurrency、same/different target、跨 namespace与 Artifact mismatch通过；
- legacy top-level Deployment/internal v1/Evaluation responses逐字节保持；
- 注册向导 Inspect→Commit、direct refresh、分页/search/archive、a11y/i18n/console通过；
- 真实 PostgreSQL + MinIO、OpenAPI、浏览器和适用全仓 gates通过。

### 不包含

- repository provider；
- service endpoint/secret；
- 新 Deployment/Evaluation profile。

## 8. MR3 — Repository reference 与 source evidence

### 目标

支持不下载权重的 repository registration，并清楚区分 declared、provider-verified 与 mutable reference。

### 交付

- owner 选择的首批 provider adapters；推荐 ModelScope + operator-managed；
- canonical repository ID/revision/revision kind normalization；
- offline declared-only 与 connected bounded metadata-resolution 两种模式；
- append-only evidence：adapter/version、observed revision/time、result、response digest；
- `:refresh-source-evidence` action 与 current classification projection；
- tag固定 mutable，未验证 commit/digest为 unknown，验证后才投影 immutable/provider-verified；
- operator-managed alias 配置期 realpath containment/no-follow/special-file/inode-race enforcement；
- repository-only Version UI、availability/license/cache observation；
- materialize boundary：只定义 future job handoff，不下载或创建 Artifact。

### Gate GMR3

- offline mode 零公网 DNS/HTTP；不可达 provider仍可 operator-attested declared registration；
- connected adapter 只访问 exact allowlist，response bounded，不保存完整 body；
- provider commit/digest/tag/opaque、revision drift、refresh race、evidence replay通过；
- unknown→immutable projection不改变 frozen source fingerprint/create digest；tag不能被提升 immutable；
- operator-managed traversal/symlink/special file/snapshot race负测通过；
- public projection无本地 path/provider raw response；
- 真实 PostgreSQL、浏览器和适用全仓 gates通过。

## 9. MR4 — Endpoint policy、受控 transport 与 offline secret registry

### 目标

先建立独立、可复用、跨语言一致的 endpoint/secret安全底座，并把当前 S4 health/inference 网络路径切换到
该底座，再允许 Existing Service runtime。

### 交付

- versioned `model-endpoint-policy-v1` config schema与 TS/Python parser；
- private/public地址分类矩阵、hostname+CIDR AND、scheme/port exact规则；
- DNS A/AAAA全量复核、approved-IP socket、Host/SNI/CA/hostname validation；
- Node Undici dispatcher/connector 与 Python pinned-address transport；
- 当前 `artifact-bound-v1` API `/models` health check 切换到 Node 受控 transport；
- 当前 internal v1 Deployment 的 EvalScope inference 切换到 Python 受控 transport；
- 禁止 ambient proxy、redirect、cross-origin auth forwarding；
- header/compressed/decompressed/JSON node/depth/model count与分段 timeout；
- offline public-network activation fence；
- `model-credentials-v1` root-owned authority、atomic generation、consumer/ref allowlist；
- API/EvalScope 最小只读 projection生成、reload、backup escrow与 rollback；
- strict `credential_ref` opaque ID、JIT resolve、Authorization injection、集中 redaction；
- EvalScope anonymous pipe/FD execution handoff的最小安全 adapter与单元测试；不接入正式 Model route。

### Gate GMR4

- TS/Python 对全部 allow/deny fixtures结果一致；
- DNS rebinding、dual-stack、IPv4-mapped IPv6、IDNA/尾点/zone ID、metadata、RFC1918/CGNAT/ULA负测通过；
- socket 确认连接 approved IP，仍正确验证 Host/SNI/certificate；
- proxy env、redirect、header smuggling、compression bomb、slow header/body和 oversize JSON失败关闭；
- unknown/wrong ref、consumer/ref ACL、atomic rotation、generation rollback、projection权限通过；
- secret/ref/header 不进入 argv/env/config/manifest/log/error/report/archive/tracing；
- offline lifecycle/backup/restore 静态 smoke通过；
- 当前 S4 raw health fetch/default Python connection path 已移除，且 public/internal schema、identity 和 replay
  行为逐字节不变。

## 10. MR5 — Existing Service 与 version-bound Deployment

### 目标

交付第三种来源和新 Deployment profile，同时保持 legacy public/internal契约不变。

### 交付

- Existing Service external model/version ref 与 declared reference kind；served model只属于 Deployment；
- `model-deployment-create-v2` 绑定 Model Version ID/source fingerprint/display+served model/endpoint/
  scope/auth ref/declared capability；
- additive migration：deployment profile、nullable Artifact、model_version、scope/credential/capability/generation；
- profile-specific CHECK；显式替换旧 fixed provider/auth CHECK但不放宽 legacy shape；
- lifecycle `registered|active|disabled` 与 derived availability；
- activation generation双读 fence、discovery、credential和declared capability admission；
- nested public create/list/activate/check/disable routes与严格 public projection；
- internal resolver v2 strict Artifact/Repository/Service union；
- new profile 的 discovery/inference 复用 MR4 已接线的受控 transport，不创建旁路；
- workload capability descriptor与显式、可能计费的 compatibility check边界；
- offline public Deployment只登记，保持 registered + unavailable。

### Gate GMR5

- legacy顶层 routes只返回 artifact-bound-v1；新 ID 在旧 show/internal v1稳定404；
- internal v1 schema/fixed vectors不变，internal v2不进入 OpenAPI且不返回 secret；
- 同 source进入两个 Model、相同 endpoint创建 Deployment不发生 digest碰撞；
- Artifact source强制 exact primary Artifact，Repository/Service强制 Artifact null；
- registration response-loss、activation generation变化、policy/ref撤销、disable和health状态通过；
- discovery healthy不等于 inference compatible；selector尚未开放；
- current raw fetch不再存在于 Model Deployment network path；
- 真实 PostgreSQL、fake OpenAI-compatible service、API/OpenAPI、offline profile与适用全仓 gates通过。

## 11. MR6 — Evaluation v5/v6 与 EvalScope 执行边界

### 目标

让 Model Version Deployment 进入 exact Dataset Evaluation，同时保存来源可复现性快照。

### 交付

- evaluation-run-create-v5/v6 strict identity 与 fixed vectors；
- Model/Version/Deployment digest/Artifact nullable/classification/evidence snapshot fields；
- profile-specific CHECK与三组 composite FK；
- Workspace只接受 opaque Deployment ID并补齐全部 exact material；
- EvalScope internal v2 adapter、credential ref JIT resolve与MR4 pinned transport；
- task顺序改为 atomic claim优先，再capacity/resolve/policy/secret/launch；
- resolver/policy/secret failure写同一 typed terminal；
- terminal/already-running replay不读取当前 Registry/secret/lifecycle；
- immutable source显示可复现证据；mutable/unknown显示有时间的service observation；
- source-less Benchmark + Deployment继续 expert/untracked。

### Gate GMR6

- DB拒绝 Model↔Version、Version↔Deployment↔digest、Artifact↔Deployment 任一错配；
- Artifact source Run Artifact必填且精确；Repository/Service Run Artifact必须为空；
- v1-v4 Run identity、FK和read path不变；historical adopted association只导航；
- same task并发只resolve/secret-access一次；claim前无外部解析；
- disabled后新 admission拒绝，terminal replay在 endpoint/ref撤销后仍返回原终态；
- mutable/unknown跨时间 compare默认隔离；source snapshot/evidence digest可审计；
- 浏览器 invoke body只有 opaque Deployment ID，无 endpoint/model/credential；
- 真实 PostgreSQL + MinIO、EvalScope provider、fake model、报告闭环与适用全仓 gates通过。

## 12. MR7 — 完整 Model detail、lineage 与 Evaluation selector

### 目标

完成 Model Registry 主产品面和跨数据/训练/模型/测评的可解释导航。

### 交付

- 一级 `/models` 导航和响应式 shell；顺序按 owner接受范围；
- list搜索、source/mutability/verification/task/artifact/alias/deployment/archive/tags筛选；
- stable default order、scoped cursor与bounded Catalog summary；
- 注册向导三来源、create Model/add Version、warnings、activation handoff；
- Model detail六 tabs：概览、版本、产物、测评、部署、血缘；
- 最近一次可比评测 summary，携带 benchmark/Dataset/metric/output/time/reproducibility；
- mutable service observation、archived-but-serving、registered+unavailable显式状态；
- `Model → Version → active available Deployment` selector和workload capability admission；
- Artifact→Model、Model→Evaluation、historical adoption导航；
- route direct refresh、error/empty/loading、keyboard/a11y/i18n/narrow behavior。

### Gate GMR7

- 三种来源完整浏览器注册；create/add Version、digest mismatch、typed conflict恢复通过；
- verified/declared/healthy/compatible/evaluated/GPU validated六种状态不混淆；
- Model list无 Artifact object/report N+1；分页/search/filter稳定；
- 全局“关键分数”不存在；不同 Benchmark/Dataset/Metric不错误聚合；
- mutable/unknown不进入candidate/staging/production；Alias CAS冲突可恢复；
- archived Model仍服务时明确告警，restore不改变Deployment；
- selector排除disabled/unavailable/capability mismatch；
- 桌面/窄屏、direct refresh、a11y、i18n、console与真实浏览器E2E通过；
- OpenAPI/generated client与适用全仓 gates通过。

## 13. MR8 — CLI、离线生命周期与 Final Gate

### 目标

补齐 operator CLI、离线安装/升级/回滚/备份证据，并关闭 Model Registry 自身最终 gate。

### 交付

- `databench model list|show|versions`；
- `model registration inspect|commit`，commit使用原 strict request + expected digest；
- `model deployment list|activate|check|disable`；
- CLI typed errors、stable exit、bounded JSON/file handling，不传 secret value/任意本地路径；
- offline config生成、secret projections、policy、permissions、atomic reload；
- incremental/full bundle升级与旧release rollback兼容；
- PostgreSQL、credential authority/projections和相关配置 escrow备份恢复；
- capability/status/runbook与当前真实限制；
- final cross-package、security、browser、provider、offline review。

### Gate GMR8

- CLI与Web对同 request得到同 plan digest/result；response-loss replay、mismatch和exit code通过；
- 大权重不经CLI JSON，secret不进shell history/argv/output；
- fresh install、upgrade、rollback、backup/restore后legacy与new profile均可读；
- public-network在offline profile始终不可activation/evaluation；
- credential rotation generation、running task snapshot与rollback通过；
- 全仓 lint/build/typecheck/test/openapi/status/peer/offline、真实 PostgreSQL+MinIO、浏览器、EvalScope和受控
  fake endpoint gates全部通过；
- final review无未关闭 blocker/major；
- 状态只能声明 `Model Registry complete`，不得自动声明 V16/V17、GE9、GPU或production readiness。

## 14. 每 Step 共同 Gate

按变更范围至少运行：

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

- Catalog/Workspace/API 改动必须运行独立 test schema 的真实 PostgreSQL + MinIO suites；
- Web 改动必须运行真实浏览器、direct refresh、console、desktop/narrow；
- EvalScope 改动必须运行 pinned provider tests和真实 callback/replay flow；
- endpoint tests使用受控 fake network，不依赖公开互联网；
- offline改动同时运行静态 checker和实际 lifecycle smoke；
- identity/profile改动必须有独立 fixed bytes/hex，不能只断言两次相等；
- migration必须同时跑 fresh和当前S4 forward path，不修改public catalog。

## 15. 完成声明

只有 MR0-MR8 全部通过并在 `docs/models/STATUS.md` 登记证据后，才能声明 Model Registry 计划完成。
任何 deferred、skipped 或 owner-exception 必须原样记录，不能用 Models 页面存在、fake endpoint healthy 或
文档完成替代真实 gate。
