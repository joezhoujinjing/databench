# 项目结构与包边界（权威）

> 本文描述当前 v2-only 实现的目录与依赖方向。历史迁移布局见 `docs/migration/`，
> v2 协议与身份规则见 `docs/v2/`，产品切换决策见 ADR 0013。MCP M0-M3 已完成；通用
> runtime 仍默认关闭，ADR 0012 离线包通过独立配置在匿名可信内网显式启用。实施状态见
> `docs/mcp/`。

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
├─ prisma/              v2-only schema 与 forward migrations
├─ deploy/
│  ├─ ecs/              既有托管部署资产
│  └─ offline/          ADR 0012 Ubuntu 单机离线发布
├─ scripts/             repo gate、测试 schema 与辅助脚本
└─ docs/
   └─ mcp/               已接受的 MCP 技术方案、实施计划、状态与 agent preflight
```

`v2` 仍出现在 REST 路径、数据库表、对象 key、类型和测试名中。它是稳定协议/持久化命名，
不是第二套产品。Web 路由和 CLI 主命令不带版本：

```text
Web: /datasets /ingest /transforms
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

apps/web 仅消费 generated OpenAPI client
tooling/openapi-export 仅装配 apps/api
tooling/v1-retirement 是显式 maintenance 边界
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
5. `apps/web` 的 wire 类型只来自生成的
   `apps/web/src/api/generated/schema.ts`。
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
- 离线 Worker：作为第六张镜像随 bundle 交付，使用 4 GiB tmpfs；备份仍只覆盖 PostgreSQL、
  MinIO、release/config escrow。
- OpenAPI：API Zod route → `openapi/openapi.json` →
  `apps/web/src/api/generated/schema.ts`。
- Node 版本：`.nvmrc`，当前 Node 22 LTS。

## 当前发布边界

产品切换 R0-R5 与 MCP M0-M3 已完成。MCP 和单个 CPU-only Worker 只获授权进入 ADR 0012 的
匿名可信内网离线通道；通用部署保持默认关闭，公网部署未授权。V16/V17 的
recovery/security/capacity 状态不因产品切换或这些 scoped gate 自动完成；公共云 API 托管平台
仍受 D3 owner 决策门约束。
