# 具体目录布局（文件级，权威）

> [`project-structure.md`](project-structure.md) 定义包边界与依赖方向；本文记录当前
> v2-only 文件落点。历史 v1 迁移文件表只在 `docs/migration/` 中保留。MCP M0-M3 已完成；
> 通用 runtime 保持 disabled-by-default，ADR 0012 离线包通过独立配置显式启用。EvalScope E0-E7 已
> 完成：backend-only runtime、gateway、Evaluation 路由、Tasks、Databench Dataset、Reports、Predictions、
> Dashboard、Compare、Performance、Benchmarks 与安全 Viewer 已实现，完整 UI 功能迁移 gate 已关闭。
> ms-swift ADR 0018 已接受；S0 已完成，S1 的 Provider、部署镜像、Gateway 与 `/training` 已实现并进入
> deferred GPU gate。S2 exact Dataset 与单 active Session bridge、S3 immutable LoRA Artifact 已完成
> non-GPU gate；S4 Deployment + EvalScope opaque resolve/lineage 已完成 non-GPU contract，GPU gate deferred。

## `third_party/ms-swift`

```text
third_party/ms-swift/
├─ upstream.lock                         固定 tag/commit/tree/archive/license/runtime target
├─ vendor/ms-swift-upstream.tar.gz       锁定 commit 的 deterministic source archive
├─ upstream-manifest.json                UI/build/license source digests
├─ gradio-baseline.json                  component/dependency/callback compatibility fixture
├─ gradio-routes.json                    完整 Gradio HTTP/SSE/WebSocket route fixture
├─ runtime-capabilities.json             surface/install/validation 三态能力清单
├─ runtime-requirements.in               完整原生 UI 的 Python dependency intent
├─ runtime-provided.txt                  base image 提供的 CUDA/PyTorch exact versions
├─ runtime-requirements.lock             Linux/amd64 hash-locked dependency closure
├─ patches/
│  ├─ 0001-databench-session-prefill.patch
│  └─ 0002-python311-attrdict3-metadata.patch
└─ README.md
```

这里只保留第三方集成构建输入，不放 Databench Python 服务或部署定义。Provider 源码归属
`workers/swift-studio/`；Dockerfile、Compose 和部署说明归属 `deploy/swift-studio/`。

## `workers/swift-studio` 与 `deploy/swift-studio`

```text
workers/swift-studio/
├─ .python-version · pyproject.toml · uv.lock
├─ runtime-requirements.in · runtime-requirements.lock
├─ src/databench_swift_studio/
│  ├─ app.py                    health/runtime、Gradio probe 与 Session internal HTTP API
│  ├─ config.py                 fixed root、ports、workspace、export limits 与版本契约
│  ├─ errors.py                 bounded Provider error envelope
│  ├─ sessions.py               exact export、atomic materialization、recovery 与 cleanup
│  ├─ artifacts.py              LoRA discovery、safetensors 验证与 deterministic tar.zst
│  ├─ artifact_imports.py       replayable exact staging upload 状态机
│  └─ launcher.py               Provider + native Gradio PID 1 lifecycle
└─ tests/                       config、runtime、Session/Artifact 与 77 个 Provider cases

deploy/swift-studio/
├─ Dockerfile                   digest/hash locked Linux/amd64 CUDA image
├─ compose.yaml                 explicit swift-gpu local profile
└─ README.md                    deployment-only runbook
```

`deploy/swift-studio/` 不拥有 Provider、upstream、patch、lock、Gateway 或 Web 源码；Docker build 只从其
权威目录复制这些固定输入。

S1 的仓库级 GPU 验收工具不属于 deployment asset，固定落在：

```text
scripts/
├─ run-swift-s1-gpu-gate.mjs              Linux/NVIDIA host + exact image 编排
├─ run-swift-s1-gpu-gate.test.mjs         pnpm CLI 参数分隔符回归
├─ run-swift-s1-gpu-driver.py              容器内原生 Gradio callback 驱动
├─ run-swift-s1-gpu-driver.test.py         process/Gradio State CPU-only 回归
├─ check-swift-s1-gpu-evidence.mjs         结构化证据 fail-closed checker
├─ check-swift-s1-gpu-evidence.test.mjs    checker 负向 tests
└─ fixtures/swift-s1-gpu-sft.jsonl         固定 32 条本地兼容 S1 fixture
```

运行证据只写 ignored `output/swift-gpu-gate/`；这些脚本和 fixture 不进入 `deploy/swift-studio/`、Provider
runtime 或第三方构建输入。

## `apps/api`

```text
apps/api/
├─ src/
│  ├─ index.ts                 runtime owner；装配 Workspace 并启动 Hono
│  ├─ app.ts                   OpenAPIHono 工厂；挂 meta 与 /v2 routes
│  ├─ capabilities.ts          当前能力声明
│  ├─ config.ts                DB、Store、CORS、cursor、PORT 配置
│  ├─ context.ts               Hono context 中的 V2Workspace
│  ├─ openapi.ts               OpenAPI 元信息与 server URL
│  ├─ response.ts              REST/MCP 共用 response stream 与附件 header
│  ├─ evalscope/
│  │  ├─ config.ts             disabled-by-default internal origin + route manifest gate
│  │  ├─ routes.ts             method/path/query/response exact allowlist
│  │  └─ gateway.ts            bounded same-origin proxy 与 generated-document enforcement
│  ├─ swift-studio/
│  │  ├─ config.ts             disabled-by-default origin、route manifest 与容量边界
│  │  ├─ gateway.ts            bounded HTTP/Queue/SSE/upload/download proxy
│  │  └─ upgrade.ts            raw HTTP/1 WebSocket tunnel 与连接上限
│  ├─ mcp/
│  │  ├─ register.ts           stateless MCP server 与四个 tools
│  │  ├─ config.ts · origin.ts disabled-by-default config 与 Origin 防护
│  │  ├─ contracts.ts          canonical contract JSON Schema projection
│  │  ├─ file-tokens.ts        process/export 一次性 token registry
│  │  ├─ file-streams.ts       timeout、abort 与 cleanup
│  │  └─ file-routes.ts        /mcp-files/process|export
│  ├─ middleware/
│  │  ├─ cors.ts
│  │  ├─ error.ts              领域错误 → 统一 HTTP error envelope
│  │  ├─ request.ts            请求 metadata / abort
│  │  └─ v2-workspace.ts       惰性注入 Workspace
│  ├─ routes/
│  │  ├─ model-deployment-auth.ts operator/service Bearer 角色分离
│  │  ├─ meta.ts               /health /version /capabilities
│  │  └─ v2/
│  │     ├─ index.ts            v2 route registry
│  │     ├─ datasets.ts         ingest/show/records/audit/export
│  │     ├─ refs.ts             list/show/move 与 lineage
│  │     ├─ registries.ts       converters/transforms
│  │     ├─ transform-jobs.ts    fixed basic-clean submit/list/show/cancel/retry
│  │     ├─ evaluations.ts       exact Dataset evaluation run create/list/show/transition
│  │     ├─ swift-studio-sessions.ts exact Dataset Studio Session create/list/show/close
│  │     ├─ model-artifacts.ts   output/import 与 immutable Artifact list/show/download
│  │     ├─ model-deployments.ts public list/show、operator actions 与 internal resolve
│  │     ├─ openapi.ts          route schema helpers
│  │     └─ transport.ts        streaming/error transport helpers
│  └─ v2/
│     └─ multipart.ts           bounded multipart ingest
├─ test/
│  ├─ app-support.test.ts
│  ├─ model-deployments.test.ts
│  ├─ evalscope-gateway.test.ts
│  ├─ errors.test.ts
│  ├─ mcp-config.test.ts · mcp-file-tokens.test.ts · mcp.test.ts
│  ├─ v2-http.test.ts
│  ├─ v2-http.integration.test.ts
│  ├─ v2-multipart.test.ts
│  ├─ v2-schema-openapi.test.ts
│  ├─ v2-transport.test.ts
│  └─ golden/fixtures/         真实 Excel 派生 draft 与 namespace-independent expected metadata
├─ Dockerfile
├─ package.json
└─ tsconfig.json
```

公开业务路径只有 `/v2/*`。meta routes 不带版本。MCP enabled 时另注册 `/mcp` 与
`/mcp-files/*`，它们不进入 OpenAPI。`apps/api` 只 import
`@databench/workspace` 与 `@databench/schema`，不得直连下层数据包。

## `apps/cli`

```text
apps/cli/
├─ src/
│  ├─ index.ts · main.ts · router.ts · runtime.ts
│  ├─ args.ts · config.ts · output.ts · streaming.ts · exit.ts · types.ts · version.ts
│  └─ commands/
│     ├─ dataset.ts             ingest/show/records/audit/export
│     ├─ converter.ts           list/show
│     ├─ transform.ts           list/run
│     ├─ ref.ts                 list/show/move
│     └─ lineage.ts             show
├─ test/
│  ├─ config.test.ts
│  ├─ v2-router.test.ts
│  └─ v2-cli.integration.test.ts
├─ package.json
└─ tsconfig.json
```

产品命令不带版本前缀，例如 `databench dataset ingest`。`v2` 测试名和内部类型名保留，
用于明确协议语义，不代表存在第二套 CLI。

## `apps/web`

```text
apps/web/
├─ src/
│  ├─ main.tsx
│  ├─ router.tsx                无版本产品 route tree
│  ├─ routes/
│  │  ├─ __root.tsx             单一产品 shell 与主导航
│  │  ├─ index.tsx
│  │  └─ not-found.tsx
│  ├─ api/
│  │  ├─ generated/schema.ts    openapi-typescript 产物
│  │  ├─ client.ts · config.ts
│  │  ├─ backend.tsx            后端连接与 query scope
│  │  ├─ capabilities.tsx · meta.ts · version.ts
│  │  └─ errors.ts · types.ts
│  ├─ components/
│  │  ├─ shell/                 导航、连接设置、语言切换
│  │  ├─ common/                状态、JSON、复制
│  │  └─ ui/                    基础 UI primitives
│  ├─ evaluations/              ADR 0017；E4-E7 complete Evaluation UI
│  │  ├─ api/                   exact-operation Zod client、report schemas、typed errors
│  │  ├─ components/            capability boundary、breadcrumb、source refresh、安全 document frame
│  │  ├─ domain/                route key、report、metric、task state 与 AgentTrace 纯逻辑
│  │  ├─ features/              Tasks、Reports、Predictions、sample 与 rich-content UI
│  │  ├─ i18n/                  lazy evaluations namespace 与完整中英文词典
│  │  ├─ layouts/               Evaluation shell 和二级导航
│  │  ├─ routes/                typed lazy routes、search contracts 与 route states
│  │  ├─ styles/                .evaluation-surface scoped --es-* tokens
│  │  ├─ UPSTREAM.md
│  │  ├─ upstream-manifest.json
│  │  ├─ ui-capability-manifest.json
│  │  ├─ implemented-capabilities.json
│  │  └─ fixtures/benchmarks-five-categories.json
│  ├─ training/                 ADR 0018 S3/S4；不复刻 Gradio 字段
│  │  ├─ api/                   locked Provider runtime + generated Session/Artifact REST hooks
│  │  ├─ components/            Dataset/Session、Artifact library/detail/download 与 Deployment panel
│  │  ├─ domain/                fixed same-origin path 与 iframe boot contract
│  │  └─ routes/studio.tsx      ready Session gate + loading/error/reconnect/fullscreen iframe shell
│  ├─ models/                    共享 Model Artifact 后续领域；不属于 deploy 资产
│  │  ├─ api/deployments.ts      generated OpenAPI Deployment operations
│  │  ├─ api/hooks.ts            Deployment 与 bound Evaluation Run query/mutation
│  │  └─ components/ModelDeploymentPanel.tsx
│  ├─ v2/
│  │  ├─ api/                   v2 client/hooks/query keys/stream export
│  │  ├─ components/            gate、冲突恢复、records、fidelity review
│  │  ├─ features/              datasets/ingest/transforms/lineage/export
│  │  └─ routes/                无版本产品 URL 的薄 route wrappers
│  ├─ i18n/
│  ├─ lib/
│  └─ styles.css
├─ scripts/generate-client.mjs
├─ scripts/check-evaluation-bundle.mjs
├─ vite.config.ts
├─ package.json
└─ tsconfig.json
```

当前 Web routes：

```text
/
/datasets
/datasets/:ref
/datasets/:ref/records/:recordId
/ingest
/transforms
/lineage/:ref
/export/:ref
/training
/evaluations
/evaluations/tasks
/evaluations/reports
/evaluations/reports/:reportKey
/evaluations/compare
/evaluations/performance
/evaluations/performance/:performanceKey
/evaluations/performance/compare
/evaluations/benchmarks
/evaluations/viewer
```

`/recipe`、`/vocabularies`、`/v2/...` 等旧产品页面不在 route tree。Web 只通过生成的
OpenAPI 类型和 REST client 访问 Databench 后端。Evaluation provider API 只通过 E4 隔离的 exact Zod client
访问 same-origin gateway；Swift 的非公共 `/swift-studio-runtime/runtime` 也只通过
`training/api/` 内锁定的 exact Zod adapter 访问。这两个 provider 例外都不是通用 HTTP
client。锁定 EvalScope React 基线的全部业务页面已在 E7 完成原生迁移。训练页面只嵌入固定
`/swift-studio/` 的原生 Gradio，不复制其字段、Tabs 或 callback。

## `packages/hashing`

```text
src/
├─ index.ts
├─ blake3.ts
└─ v2/
   ├─ canonical-json.ts         RFC 8785 JCS
   ├─ artifact-hasher.ts        incremental artifact digest
   ├─ domains.ts                identity domain separation
   ├─ contracts.type-test.ts
   ├─ types.ts
   └─ index.ts
```

## `packages/schema`

```text
src/
├─ index.ts
├─ constants.ts · contracts.ts · errors.ts
└─ v2/
   ├─ record/content/candidate/preference/signal/tool schemas
   ├─ revision/provenance/manifest/identity schemas
   ├─ transform/converter/projection contracts
   ├─ evaluation.ts             E2 run、metric、error、pagination 与 transition wire contract
   ├─ swift-studio.ts           S2 exact Dataset Studio Session wire contract
   ├─ model-artifact.ts         S3 output/import/immutable Artifact wire contract
   ├─ model-deployment.ts       S4 public/internal Deployment wire contract
   ├─ mcp.ts                    MCP tool/result contracts
   ├─ reader/raw-json/json-value verification
   ├─ contracts.type-test.ts
   └─ index.ts
```

所有领域/wire Zod schema 与错误 taxonomy 的单一来源。

## `packages/engine`

```text
src/
├─ index.ts
└─ v2/
   ├─ dataset.ts · dataset-invariants.ts
   ├─ artifact-file.ts
   ├─ record-json-codec.ts · record-json-errors.ts
   ├─ compact-thrift-preflight.ts
   ├─ contracts.type-test.ts
   └─ index.ts
```

负责 immutable `V2Dataset`、资源核算和确定性的 `record-json-v1` Parquet
artifact 编解码；`record-json-v1` 是布局格式名，不是退役产品 v1。

## `packages/io`

```text
src/
├─ index.ts
└─ v2/
   ├─ canonical-jsonl.ts
   ├─ converter-registry.ts · converter-projection.ts
   ├─ evalscope-general-qa.ts  E1 strict options、eligibility、fidelity 与确定性 rows
   ├─ adapters.ts
   ├─ deterministic-json.ts
   ├─ errors.ts
   └─ index.ts
```

## `packages/ops`

```text
src/
├─ index.ts
└─ v2/
   ├─ registry.ts
   ├─ operations.ts
   ├─ context.ts · contracts.ts
   └─ index.ts
```

内置操作为 `subset`、`sample`、`append-evidence`、`selection-update`、
`prompt-rewrite`。

## `packages/store`

```text
src/
├─ index.ts
└─ v2/
   ├─ store.ts · contracts.ts · keys.ts · runtime.ts · object-store.ts
   ├─ oss-adapter.ts
   ├─ s3-adapter.ts
   ├─ temp-store.ts             shared bounded temp admission for canonical, draft and Worker spools
   ├─ worker-staging.ts · worker-staging-keys.ts
   ├─ model-artifact-store.ts · model-artifact-keys.ts
   ├─ config.ts
   └─ index.ts
```

管理 `objects/v2/` immutable artifacts/manifests，以及不进入 canonical identity 的
`staging/worker/v1/` 与 `staging/swift-artifact/v1/` exact temporary objects。canonical 写入和 staging
input 均 conditional create；staging 只允许 attempt-scoped exact read/delete，禁止 prefix delete。

## `packages/catalog`

```text
src/
├─ index.ts
├─ client.ts
└─ v2/
   ├─ catalog.ts
   ├─ types.ts · errors.ts
   └─ index.ts
```

只依赖 Prisma/Postgres。v2 snapshots、layouts、identity claims、transform/evaluation runs、Swift Studio
Sessions、Model Artifact imports/artifacts、Model Deployments、record lineage 与 refs 的数据模型在根
`prisma/schema.prisma`。

## `packages/workspace`

```text
src/
├─ index.ts
├─ internal/worker/
│  ├─ client.ts · grpc-client.ts · dispatcher.ts · runtime.ts
│  ├─ staging.ts · data-juicer.ts · canonical-finalizer.ts · workspace-access.ts
│  └─ generated/
└─ v2/
   ├─ workspace.ts · batch-transform.ts · evaluation.ts
   ├─ swift-studio.ts · swift-studio-provider.ts
   ├─ model-artifact.ts · model-deployment.ts
   ├─ identity-allocator.ts
   ├─ canonical-draft-identity.ts
   ├─ canonical-draft-materializer.ts
   ├─ cache.ts · cursor.ts
   ├─ mappings.ts
   ├─ transform-semaphore.ts
   └─ index.ts
```

这是应用访问数据的唯一可信编排边界，拥有 ingest、canonical/draft no-write preview、draft
deterministic identity/materialize/import、persist、transform、CAS ref、record/dataset lineage、
audit、converter inspect/export、evaluation run exact binding/状态机与取消语义，以及 Swift Studio Session、
Model Artifact import/finalize/download、Model Deployment registry/health/resolve 与 Deployment-bound
Evaluation lineage 编排。

## Tooling 与根目录

```text
tooling/openapi-export/
├─ src/index.ts
└─ test/openapi-export.test.ts

tooling/v1-retirement/
├─ src/
│  ├─ cli.ts · retirement.ts
│  ├─ database.ts · object-store.ts · legacy-keys.ts
│  ├─ manifest.ts · types.ts · index.ts
└─ test/

prisma/
├─ schema.prisma
└─ migrations/
   ├─ 0001_catalog/
   ├─ 0002_vocabularies/
   ├─ 0003_v2_catalog/
   ├─ 0004_v2_run_lineage_sequence/
   ├─ 0005_retire_v1_catalog/
   ├─ 0006_recoverable_ref_trash/
   ├─ 0007_transform_jobs_v2/
   ├─ 0008_worker_staging_v1/
   ├─ 0009_transform_job_result_ref/
   ├─ 0010_evaluation_runs_v2/
   ├─ 0011_swift_studio_sessions_v2/
   ├─ 0012_model_artifacts_v2/
   └─ 0013_model_deployments_v2/
```

EvalScope E0 另有：

```text
deploy/evalscope/
├─ upstream.lock                commit/tree/dependency/license/Plotly evidence
└─ api-routes.json              default-deny method + exact-path classification

scripts/
├─ generate-evalscope-upstream-manifest.mjs
└─ check-evalscope-parity.mjs

docs/evalscope/evidence/E0-BASELINE.md
docs/evalscope/evidence/E1-PROJECTION.md
docs/evalscope/evidence/E2-RUN-CONTROL.md
THIRD_PARTY_NOTICES.md
```

E3 后的 backend runtime 布局为：

```text
workers/evalscope/
├─ .python-version · pyproject.toml · uv.lock
├─ src/databench_evalscope/
│  ├─ app.py · wsgi.py · config.py
│  ├─ databench.py · storage.py
│  └─ security.py · documents.py · errors.py
└─ tests/                      Python runtime/security tests

deploy/evalscope/
├─ README.md
├─ Dockerfile
├─ api-routes.json
├─ patches/0001-databench-runtime-boundary.patch
└─ vendor/
   ├─ evalscope-upstream.tar.gz
   ├─ plotly-2.35.2.min.js · plotly-LICENSE.txt
   └─ punkt_tab.zip
```

两个 Python 服务同处 `workers/`，但协议和职责不同：`workers/python` 是 Workspace 通过内部 gRPC
调用的通用 capability host；`workers/evalscope` 是 Web 经 API gateway 通过内部 HTTP 调用的评测
provider。`deploy/evalscope` 只保留构建和部署资产。镜像删除 upstream `evalscope/web`，只运行
Gunicorn/Flask backend。`upstream-manifest.json` 是文件来源真源，
`ui-capability-manifest.json` 是业务能力验收真源；前者的 `adapted` 不能替代后者的 green。E1/E2 的
converter/export 与 Workspace/REST/OpenAPI 数据链没有被 Python service 绕开。

R4 maintenance tool和 forward migration必须保留，供尚未执行退役的安装环境使用；它们不是
可达产品代码。标准操作流程见 `docs/v2/V1-RETIREMENT-RUNBOOK.md`。

## Worker 布局（ADR 0010）

P0-P7 已完成并通过最终 Gate；Worker foundation、job 控制面、临时数据面、Data-Juicer adapter、
canonical finalizer、REST/Web 产品面和生产 runtime 显式启用接线均已落地：

```text
proto/
├─ buf.yaml
├─ buf.gen.yaml
└─ databench/worker/v1/worker.proto

workers/python/
├─ .python-version
├─ pyproject.toml
├─ uv.lock
├─ Dockerfile
├─ src/
│  ├─ databench_worker/
│  │  ├─ grpc_server.py · healthcheck.py · registry.py · runner.py
│  │  ├─ data_juicer_child.py
│  │  ├─ runtime/artifacts.py · subprocess.py
│  │  └─ adapters/data_juicer.py
│  └─ databench/worker/v1/     generated Python bindings
└─ tests/

packages/store/src/v2/worker-staging*.ts  已实现 exact-key staging 数据面
packages/workspace/src/internal/worker/  已实现 client、generated、dispatcher、runtime、staging、
                                         data-juicer、canonical-finalizer、workspace-access
packages/workspace/src/v2/batch-transform.ts  已实现 projection 与 strict retained reader
packages/workspace/src/v2/workspace.ts        已实现共享 publication 与 canonical finalization
apps/api/src/routes/v2/transform-jobs.ts       已实现固定任务 REST 产品面
apps/web/src/v2/features/transforms/           已实现提交、轮询、取消、重试与结果入口
```

Proto/generated code 只在 Workspace internal 与 Worker generated package 出现。`apps/api`、
`apps/cli` 和 `apps/web` 不导入 generated Proto；公共 contract 仍为 Zod → OpenAPI → generated
Web client。完整边界与每个实施切片见 `docs/processing/TECHNICAL_DESIGN.md`。

## MCP 与离线交付

```text
docs/mcp/
├─ TECHNICAL-DESIGN.md   已接受的最终技术边界
├─ PLAN.md               M0-M3 accepted steps 与 gates
├─ STATUS.md             当前真实进度；runtime enabled 状态
└─ AGENT-PREFLIGHT.md    目标 agent/真实 Excel 能力证据
```

```text
deploy/offline/
├─ compose.yml                    API 加载 MCP 配置；私网 Worker → API → Web 生命周期
├─ mcp.env.example                匿名可信内网 MCP 配置示例
├─ MCP-AGENT-GUIDE.zh-CN.md       agent endpoint、三种意图与恢复规则
├─ README.zh-CN.md
├─ DEPLOYMENT-GUIDE.zh-CN.md
├─ TROUBLESHOOTING.zh-CN.md
├─ install.sh · upgrade.sh        显式创建或复用 MCP 配置
├─ rollback.sh                    停服务前校验 current/target 所需 MCP 配置
├─ lib/config.sh                  public base 校验与原子配置
├─ lib/preflight.sh               CPU/RAM、根盘与 Databench 数据盘容量检查
└─ smoke/
   ├─ mcp.mjs                     官方 SDK + companion lifecycle smoke
   ├─ worker.mjs                  basic-clean Dataset/lineage/deterministic reuse smoke
   ├─ upstream-failure.mjs        Caddy 502 runtime-log 脱敏 probe
   └─ mcp-draft.jsonl             最小 canonical draft fixture
```

MCP runtime 与真实 Excel fixture 已按上文实际落点登记。离线配置只在 operator 显式提供稳定、agent
可达的 `http(s)://host[:port]/api` 后启用；不从 Host、网卡或容器名推断，也不引入独立服务、认证
平台或审批状态机。

## ms-swift 设计文档（ADR 0018）

```text
docs/swift/
├─ TECHNICAL-DESIGN.md   完整原生 Gradio、四桥、Session/Artifact 与演进边界
├─ PLAN.md               S0-S4 主计划，S5/S6 后续扩展
└─ STATUS.md             当前真实状态；S4 non-GPU green，S1-S4 GPU deferred
```

计划中的 Web/API/Provider/deploy/DB 文件只有在对应 Step 实现并过 gate 后，才能加入本文的当前文件级
布局。
