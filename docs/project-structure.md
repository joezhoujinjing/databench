# 项目结构与包边界（权威）

> 本文描述当前 v2-only 实现的目录与依赖方向。历史迁移布局见 `docs/migration/`，
> v2 协议与身份规则见 `docs/v2/`，产品切换决策见 ADR 0013。MCP M0-M3 已完成；通用
> runtime 仍默认关闭，ADR 0012 离线包通过独立配置在匿名可信内网显式启用。实施状态见
> `docs/mcp/`。EvalScope ADR 0017 已接受，E0-E8 gate 已完成，E9 本地实现已完成：backend-only
> runtime、disabled-by-default
> gateway、Evaluation 原生路由、UI foundation、Tasks、Databench Dataset、Reports、逐样本、Dashboard、
> 比较、Performance、Benchmark、安全 Viewer 和完整结果归档已实现；锁定 React 基线的完整 UI 功能迁移
> gate 与结果归档 gate 已关闭。七张基础镜像加一张默认关闭的 Swift CUDA 镜像已经接入离线
> 生命周期、安全、容量与备份；真实 Ubuntu 22.04 amd64 断网目标机 GE9 仍待验收。
> ms-swift ADR 0018 已接受，S0 已完成；S1 的完整原生 Gradio、`/training`、GPU image、Provider 与
> Gateway 已 code-complete，真实 Linux/NVIDIA LoRA + Infer gate 按 owner 决策后置且 capability 保持
> unvalidated。S2 exact Dataset 与单 active Studio Session bridge、S3 LoRA immutable Model Artifact
> import 均已完成 non-GPU gate；S4 operator-attested Deployment + EvalScope opaque resolve/lineage 已完成
> non-GPU contract，GPU 训练、推理部署与真实模型评测证据继续 deferred。

## 顶层目录

```text
databench-ts/
├─ apps/
│  ├─ api/              @databench/api；Hono meta + /v2 REST
│  ├─ cli/              @databench/cli；无版本产品命令
│  └─ web/              React/Vite SPA；无版本产品路由
├─ packages/
│  ├─ hashing/          RFC 8785、BLAKE3、v2 domain-separated identity
│  ├─ schema/           v2 Zod 领域与 wire 契约、错误分类
│  ├─ engine/           immutable V2Dataset、record-json-v1 Parquet codec
│  ├─ io/               canonical JSONL 与 converter registry
│  ├─ ops/              v2 transform registry 与五个内置操作
│  ├─ store/            v2 immutable objects；OSS/S3/MinIO adapter
│  ├─ catalog/          Prisma/Postgres v2 catalog 与 CAS refs
│  └─ workspace/        v2 ingest/transform/ref/lineage/audit/export 编排
├─ tooling/
│  ├─ openapi-export/   确定性导出/校验 OpenAPI
│  └─ v1-retirement/    ADR 0013 R4 显式维护工具，不进入产品 runtime
├─ workers/
│  ├─ python/           通用 Python capability Worker；内部 gRPC
│  ├─ evalscope/        EvalScope Python provider service；内部 HTTP
│  └─ swift-studio/     ms-swift Provider + native Gradio launcher；内部 HTTP
├─ prisma/              v2-only schema 与 forward migrations
├─ deploy/
│  ├─ ecs/              既有托管部署资产
│  ├─ evalscope/        EvalScope image、upstream patch/vendor 与 gateway manifest
│  ├─ swift-studio/     仅 Swift Dockerfile、Compose 与部署说明
│  └─ offline/          ADR 0012 Ubuntu 单机离线发布
├─ third_party/
│  └─ ms-swift/         锁定 upstream archive、patch 与 Gradio compatibility baseline；非 runtime 代码
├─ scripts/             repo gate、测试 schema、EvalScope parity、Swift GPU gate 与辅助脚本
├─ THIRD_PARTY_NOTICES.md
└─ docs/
   ├─ mcp/               已接受的 MCP 技术方案、实施计划、状态与 agent preflight
   ├─ evalscope/         已接受的设计、E0 evidence、实施计划与状态
   └─ swift/             已接受的原生 Gradio 集成方案、实施计划与状态；S4 non-GPU green/GPU deferred
```

`v2` 仍出现在 REST 路径、数据库表、对象 key、类型和测试名中。它是稳定协议/持久化命名，
不是第二套产品。Web 路由和 CLI 主命令不带版本：

```text
Web: /datasets /ingest /transforms /training /evaluations/*
CLI: databench dataset|converter|transform|ref|lineage ...
REST: /v2/...
```

## Worker 执行边界

ADR 0010 P0-P7 已在当前 v2-only 基线上完成并通过最终 Gate，落地 Worker foundation、控制面、
临时数据面、首个 Data-Juicer adapter、canonical finalizer 与 REST/Web 产品闭环：

```text
proto/                  internal Worker gRPC 唯一 transport source
workers/python/         长期 Python Worker；通用 capability host
```

Worker 不是新的产品层，也不进入 TypeScript package DAG。依赖/调用方向固定为：

```text
apps/api → workspace → internal generated gRPC client → Worker
Worker → allowlisted Python capability adapter
```

Data-Juicer 是第一个已实现的 runtime adapter。Worker 不依赖 TS packages、不访问 Postgres、
不持有对象存储长期凭据，也不拥有 canonical identity/publication。当前已完成通用 server、
Proto/client、health、test-only `fixture.copy@1`、`transform_jobs_v2`、dispatcher 和 API entrypoint
lifecycle，以及 exact staging key/signed URL/bounded reader、固定 projection/retained reader 和
cleanup fence drain，以及固定 `data_juicer.batch@1` allowlist、受控子进程和 TS-owned
`basic-clean-v1` 参数编译器；P5 已实现 exact projector、retained→原 revision 重建、共享 canonical
publication、layout+Run+job 原子完成、读回验证与成功后的 exact staging cleanup；P6/P7 已完成
REST/Web 产品面、生产 runtime 显式启用接线和最终验证。
进度与后续施工边界以 `docs/processing/` 为真源。

ADR 0012 的后续窄修订将一个 CPU-only Worker 纳入 Ubuntu 单机离线包。它只通过 Compose 私网
`worker:50051` 被 API 调用，不发布宿主机端口、不持有长期存储凭据、不增加持久化目录；其他发布
环境仍保持 disabled-by-default。

## 依赖方向

只能向下依赖，不得成环：

```text
hashing
├─ schema ───────────────┐
├─ engine ───────────────┤
├─ io ───────────────────┤
├─ catalog (仅 Prisma) ──┤
├─ ops ──────────────────┤
├─ store ────────────────┤
└─ workspace ────────────┤
   ├─ apps/api           │
   └─ apps/cli           │

apps/web 对 Databench `/v2/*` 仅消费 generated OpenAPI client；锁定 Provider 状态使用隔离 exact adapter
tooling/openapi-export 仅装配 apps/api
tooling/v1-retirement 是显式 maintenance 边界
workers/python 通用 Python Worker（内部 gRPC，不进入 TS package DAG）
workers/evalscope EvalScope provider service（内部 HTTP，不进入 TS package DAG）
workers/swift-studio Swift Provider/launcher（内部 HTTP，不进入 TS package DAG）
```

精确允许关系：

- `schema → hashing`
- `engine → schema, hashing`
- `io → schema`
- `catalog → Prisma/Postgres`，不依赖任何领域包
- `ops → engine, schema`
- `store → engine, schema, hashing`
- `workspace → engine, io, ops, store, catalog, schema, hashing`
- `apps/api`、`apps/cli → workspace, schema`
- `apps/web` 不 import 后端包

EvalScope E0 在 `apps/web/src/evaluations/` 建立来源、能力 manifest 和 pinned fixtures。E1 在既有
`schema → io → workspace → API/CLI/generated Web client` 边界增加
`evalscope-general-qa` converter；E2 沿相同边界增加 exact Dataset-bound evaluation run 控制面和 generated
client。E3 增加独立 Python provider service 与 `apps/api` same-origin exact gateway；Dataset 数据仍由
EvalScope 通过 Databench REST exact inspect/export 获取，API 不直连下层包。E4 在唯一 Databench SPA 中
增加 lazy `/evaluations/*` route tree、Evaluation shell、scoped tokens/i18n/primitives 和隔离的 exact Zod
client。E5 在该边界实现 Tasks 与 exact Dataset 闭环；E6 实现 Reports catalogue、详情、Predictions、
样本形态与富内容展示；E7 完成 Dashboard、Evaluation Compare、Performance 全业务面、Benchmark 与
安全 Viewer。E8 在同一 Workspace 边界加入 attempt-scoped result staging、BLAKE3 immutable archive、PG
locator 和 exact cleanup；EvalScope 不持有长期 object-store credential。UI 对 Databench `/v2/*` 仍只用
generated client；EvalScope client 只能访问
`deploy/evalscope/api-routes.json` 明确允许的方法与精确路径，不能成为通用反向代理。

MCP runtime 内嵌 `apps/api`；依赖关系仍是 `apps/api → workspace, schema`。不得为了
MCP 让 API 直连下层包；transport SDK 只负责协议，不成为数据访问层。

## 硬边界

1. `apps/api` 和 `apps/cli` 只经 `@databench/workspace` + `@databench/schema`
   触达数据，禁止直连 Catalog、Store、Engine、Ops 或 IO。
2. 外部只能通过 package `exports` 导入公共 barrel，禁止 `@databench/x/src/...`
   深 import。
3. `hashing` 和 `schema` 保持纯；不得依赖 Prisma、对象存储或 Parquet runtime。
4. 样本 payload 只存在对象存储的 immutable Parquet artifact；Postgres 只存 catalog
   元数据、身份 claim、lineage、run 与 ref。
5. `apps/web` 对 Databench `/v2/*` REST 的 wire 类型只来自生成的
   `apps/web/src/api/generated/schema.ts`；EvalScope provider API 使用 `apps/web/src/evaluations/`
   内隔离的 pinned Zod adapter，Swift Provider runtime 状态使用
   `apps/web/src/training/api/` 内隔离的 exact Zod adapter。两者都不能混入 Databench
   contract 或成为任意 HTTP client。
6. `tooling/v1-retirement` 不得被应用启动、普通请求或隐式 migration 调用；它只服务
   ADR 0013 的显式数据退役流程。

## 单包模板

```text
packages/<name>/
├─ src/
│  ├─ index.ts          唯一公共出口
│  ├─ v2/               稳定 v2 协议/持久化实现
│  └─ internal/         可选私有实现，禁止跨包导入
├─ test/
│  ├─ *.test.ts
│  └─ golden/           v2 fixed vectors / fixtures
├─ package.json
├─ tsconfig.json
└─ README.md
```

内部目录保留 `v2` 名称是为了避免身份、对象布局或数据库语义被误当作可随产品文案改名的
实现细节。不得为了“无版本 UI”重命名这些协议标识。

## 数据与配置

- Prisma schema/migrations：根 `prisma/`。
- v2 对象 namespace：`objects/v2/`；manifest 与 artifact 均 conditional create。
- 本地依赖：Postgres + MinIO，见 `docker-compose.yml`。
- 托管对象存储：Aliyun OSS；本地及离线单机使用 S3-compatible MinIO adapter。
- 离线 MCP：`/etc/databench/mcp.env` 独立保存匿名模式、agent 可达 `/api` public base 与可选
  origins；旧 release 不读取该文件。
- 离线 Worker：作为第六张镜像随 bundle 交付，使用 4 GiB tmpfs。
- 离线 EvalScope：作为第七张 pinned backend-only 镜像随 bundle 交付，使用私网 HTTP、持久化
  output/input volume、稳定 operator/HMAC 配置、drain 生命周期与 4 CPU / 12 GiB 容量边界。
- 离线 Swift：作为第八张 pinned CUDA 镜像随 bundle 交付，默认关闭；operator 显式启用单 GPU
  profile，模型从 `/srv/databench/swift-models` 只读挂载，Session workspace 独立持久化。
- 离线备份覆盖 PostgreSQL、MinIO、EvalScope volume、启用时的 Swift Session workspace 和四份
  加密配置 escrow；模型 cache/权重不进入每代业务备份。
- OpenAPI：API Zod route → `openapi/openapi.json` →
  `apps/web/src/api/generated/schema.ts`。
- Node 版本：`.nvmrc`，当前 Node 22 LTS。

Swift S1 增加 `apps/api/src/swift-studio` 的完整锁定 Web App Gateway，以及唯一 SPA 内的 lazy
`/training` 外层壳。S2 沿既有 `schema → hashing/catalog/store/workspace → API/OpenAPI/generated Web`
边界增加 exact Dataset-bound Studio Session；Provider 通过 Databench REST 下载并原子落盘，Gradio patch
只通过内部 Session context 动态预填 Train/RLHF/GRPO。Provider/Gradio 不进入 TypeScript package DAG；
Web 不解析 `/config` 或复刻字段；Gateway 和 Provider 端口仍默认关闭且不属于公共 REST/OpenAPI。仓库级
GPU runner、driver、evidence checker 和固定 fixture 归 `scripts/`；`deploy/swift-studio/` 只拥有
Dockerfile、Compose 与部署说明。S3 沿同一边界增加 output discovery、Model Artifact import、exact
staging 与 immutable object publication；Python 只构建/上传候选归档，canonical verify、finalize、Catalog
transaction 与 download 仍由 Workspace/Store 拥有。

S4 沿既有 `schema → hashing/catalog/workspace → API/OpenAPI/generated Web` 边界增加
`model_deployments_v2`、版本化 create identity、operator action 与 public projection。Deployment 源码属于
领域/API/Web 的 `model-deployment`/`models` 目录，不放进 `deploy/`；`deploy/` 只保存部署资产。
EvalScope 通过固定 internal REST + service credential resolve opaque Deployment ID，不直连 Catalog，也不把
endpoint 写进浏览器、OpenAPI public projection 或 task integration manifest。只有 exact Databench Dataset
与 Deployment 的组合进入 `evaluation_runs_v2` 并固定 Artifact/Deployment digest lineage。

## 当前发布边界

产品切换 R0-R5、MCP M0-M3、EvalScope E0-E8 与 Swift S0-S4 non-GPU gate 已完成。Swift S1-S4 的真实
NVIDIA LoRA/Infer/serving/evaluation gate 按 owner 决策后置且尚未关闭；S4 状态固定为
`non-GPU contract green / GPU deferred`。runtime 保持
disabled-by-default，`/training` 在未启用时显示明确 unavailable
boundary。EvalScope E9 本地实现完成、目标机 gate pending；通用部署仍 disabled-by-default，结果归档与
八镜像离线接线已完成。MCP、CPU-only Worker、backend-only EvalScope 和可选 Swift GPU Studio 只获
授权进入 ADR 0012 的
匿名可信内网离线通道；通用部署保持默认关闭，公网部署未授权。V16/V17 的
recovery/security/capacity 状态不因产品切换或这些 scoped gate 自动完成；公共云 API 托管平台
仍受 D3 owner 决策门约束。
