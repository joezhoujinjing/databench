# 项目结构与包边界(权威)

> 迁移前钉死的目录与依赖规则。**任何代码都必须落在这里规定的位置、遵守这里的依赖方向**,以防迁移过程中结构漂移。
>
> - 本文 = 「有哪些包 + 依赖方向规则 + 单包模板」。
> - **每个文件放什么** → 见 [`directory-layout.md`](directory-layout.md)(文件级,含 Hono `apps/api` 的完整内部结构)。
> - 命名/编码/测试/配置 → [`conventions.md`](conventions.md);工具链/基础设施 → ADR [0004](decisions/0004-toolchain-and-conventions.md)/[0005](decisions/0005-infrastructure-and-deployment.md)。

## 顶层目录

> **根目录 = `~/Desktop/databench-ts/`**(全新仓库)。旧 Python 后端 + 旧 `databench-ui` 留在 `~/Desktop/databench/` 作参考与 golden 源(golden 在 `~/Desktop/databench/databench/bench/`)。

```
databench-ts/                   ← monorepo 根(pnpm + Turborepo)
├─ apps/
│  ├─ api/              @databench/api    Hono 服务:/health /version /capabilities /v1/*
│  ├─ cli/              @databench/cli    in-process CLI；只经 Workspace/Schema 触达数据
│  └─ web/              React SPA；仅消费 generated OpenAPI client
├─ proto/               databench.processing.v1 内部 gRPC 源契约(Buf;不承载领域模型)
├─ packages/
│  ├─ hashing/          @databench/hashing    blake3 + canonicalJson + hash*（地基）
│  ├─ schema/           @databench/schema     zod 领域/公共契约（含 Vocabulary 与 Processing）+ 常量
│  ├─ engine/           @databench/engine     Dataset 核心 + transform 抽象（nodejs-polars/DuckDB）
│  ├─ io/               @databench/io         JSONL 摄取 + kind 检测 + 导出整形
│  ├─ ops/              @databench/ops        内置 transforms（dedup/filter/sample/enrich）
│  ├─ store/            @databench/store      内容寻址数据 + Vocabulary + Processing 暂存/seal（OSS/S3·MinIO）
│  ├─ catalog/          @databench/catalog    Postgres 控制面（Prisma，含 vocab refs/processing jobs）
│  └─ workspace/        @databench/workspace  编排：既有领域能力 + Processing gRPC client/dispatcher
├─ workers/
│  └─ processing-python/  原生 Python 3.11 + uv 的长驻内部 gRPC worker(Data-Juicer adapter)
├─ tooling/
│  ├─ openapi-export/   启动 api 导出确定性 openapi.json（替代 scripts/export_openapi.py）
│  ├─ v1-retirement/    R4 显式 preflight、digest确认、legacy object清理与v2前后audit
│  ├─ proto/            @databench/proto    Buf/ts-proto/Python 双语言生成与兼容检查
│  └─ tsconfig/         共享 tsconfig 基线（可选独立包）
├─ prisma/              Prisma schema + migrations（catalog 用）
├─ docker-compose.yml   本地：postgres + minio；P2 增 internal-only processing-python
├─ turbo.json · biome.json · tsconfig.base.json · pnpm-workspace.yaml · .nvmrc
└─ docs/
```

`workers/processing-python` 属于同一 monorepo，但**不加入 pnpm workspace**，其 Python
依赖只由原生 `uv`、`.python-version`、`pyproject.toml` 和已提交 `uv.lock` 管理。
`tooling/proto` 属于 pnpm workspace，负责调用 Buf/ts-proto，并经固定 package script
调用 worker 目录的 `uv run --frozen ...`；pnpm 不安装或解析 Python 依赖。

`proto/databench/processing/v1/processing.proto` 是内部传输的唯一源。生成的 TypeScript 只放在
`packages/workspace/src/internal/grpc/generated/`，生成的 Python 只放在
`workers/processing-python/src/databench/processing/v1/`；两者都提交、只生成、
不得手改或从 Workspace 公共 barrel 导出。Python 文件系统路径必须产生可安装的
`databench.processing.v1` 绝对 import并满足 Buf package-directory lint；禁止 import
rewrite 或 `PYTHONPATH` workaround。

> `packages/recipe` 不单独建包:`RECIPE-*` 落在 `workspace`(混合逻辑)+ `engine`/`schema`(frame 操作与 Recipe 模型),见迁移清单。

## 单个 package 的内部布局(统一模板)

```
packages/<name>/
├─ src/
│  ├─ index.ts          ← 唯一公共出口（barrel）。外部只能 import 这里导出的东西
│  ├─ <feature>.ts      ← 实现，按功能分文件（kebab-case）
│  └─ internal/         ← 私有实现，禁止被其它包 import
├─ test/
│  ├─ <feature>.test.ts ← 单测（也可与源码同目录 colocate）
│  └─ golden/           ← 与 Python `bench/` 对拍的 golden 测试 + fixtures
├─ package.json         ← name=@databench/<name>，exports 只暴露 ./（指向 dist/index）
├─ tsconfig.json        ← extends ../../tsconfig.base.json，配 project references
└─ README.md            ← 该包职责一句话 + 公共 API 摘要
```

## 依赖方向（DAG，**只能向下,禁止成环**)

分层,import 只允许指向更低层;**同层不互相依赖**,跨层不得跳过 `workspace` 边界:

```
L0  hashing                              （无依赖）
L1  schema            → hashing
L2  engine            → schema, hashing
    io               → schema
    catalog           → （仅 Prisma，自洽，不依赖域包）
L3  ops               → engine, schema
    store             → engine, schema, hashing
L4  workspace         → engine, io, ops, store, catalog, schema, hashing
L5  apps/api          → workspace, schema           （只经 workspace 触达数据,不直连 store/catalog/engine）
    apps/cli          → workspace, schema           （in-process client；同样不直连数据层包）
L6  tooling/openapi-export → apps/api
    tooling/v1-retirement → workspace, store, hashing, pg（只在显式maintenance命令中运行）
    tooling/proto    → proto（仅构建期生成；不成为 runtime import）
    apps/web          → （仅消费生成的 OpenAPI client,不 import 任何后端包）
```

Python worker 不进入 TypeScript runtime DAG：它只依赖生成的 Proto binding、
adapter-local Python 类型和通过 gRPC 收到的短期签名 URL；它不 import TS package，
也不连接 Postgres。`packages/workspace` 是唯一内部 gRPC client owner；`apps/api`
不得依赖 `@grpc/grpc-js`、generated Proto 或 worker 文件。

**硬规则(CI 应校验,见 conventions「依赖纪律」):**
1. **`apps/api` 不得直接 import `store`/`catalog`/`engine`/`ops`/`io`** —— 一切经 `@databench/workspace`。API 层只做:校验(zod)→ 调 workspace → 整形响应 → 错误映射。
   `apps/cli` 适用相同数据访问边界。
2. **`catalog` 不依赖任何域包**(它只认 version 串、json、时间戳);Prisma 只活在这里。
3. **`hashing`/`schema` 不依赖 nodejs-polars/Prisma/S3** —— 保持纯,便于 golden 对拍与跨环境复用。
4. **禁止深 import**(`@databench/x/src/foo`):只能 import 包的 `index.ts`。用 package.json 的 `exports` 字段封死。
5. **无环**:Turborepo/Biome 跑依赖检查;新增跨包依赖必须仍是 DAG。
6. **Processing generated 隔离**:`apps/api` 不得 import `@grpc/grpc-js`、Proto 产物或
   worker 文件；TS generated 只在 Workspace `internal/grpc` 使用，Python generated
   只在 worker 内使用。Proto/Pydantic 不得复制 Zod-owned 领域/公共参数模型。

## 功能ID → 落点(与迁移清单一致)

| 包 | 承载的功能ID |
|---|---|
| `hashing` | `HASH-01..05` |
| `schema` | `CORE-01..10`、`Manifest(DATASET-02)`、服务契约 `CONTRACT-01`、`Recipe 模型(RECIPE-01/02)`、`CONTRACT-03..08` Vocabulary 模型/不变式 |
| `engine` | `DATASET-01·03..10`、`XFORM-01..03` |
| `io` | `IO-01..06` |
| `ops` | `OPS-01..05` |
| `store` | `STORE-01..05` + Vocabulary JSON blob |
| `catalog` | `CATALOG-01..12` + vocabulary/vocab_ref 控制面 |
| `workspace` | `WS-01..13`、`RECIPE-03..05(mix/fingerprint)`、Vocabulary derive/save/get/list/normalize/validate |
| `apps/api` | `API-01..14`、`SVC-01..05`、`ERR-01..06`、`CONTRACT-03..08` routes |
| `apps/cli` | ADR-0007 thin adapter；复用 Workspace能力，不新增平行业务规则 |
| `tooling/openapi-export` | `CONTRACT-02` |
| `tooling/v1-retirement` | ADR-0013 R4；不进入应用启动、普通请求或runtime package DAG |

### ADR-0010 Processing 新增落点

Processing 尚未分配既有迁移 feature ID，按 ADR-0010 与
[`processing/TECHNICAL_DESIGN.md`](processing/TECHNICAL_DESIGN.md) 管理：

| 层 | Processing 职责 |
|---|---|
| `proto` | 内部 gRPC transport；parameters/领域结果只传 schema reference + JSON bytes |
| `schema` | job、processor、parameters、progress、artifact、公共错误的 Zod/OpenAPI 单一来源 |
| `catalog` | 单表 job queue、claim/lease/fencing/terminal CAS + durable cleanup fence；仍只依赖 Prisma |
| `store` | attempt-scoped upload、实际对象验证、write-once sealed staging artifact、流式读取 |
| `workspace` | Proto 映射、gRPC client、dispatcher、Catalog/Store/领域校验编排 |
| `apps/api` | local/private REST 路由与 HTTP 错误映射；仍只经 Workspace/Schema |
| `workers/processing-python` | gRPC server、allowlisted processor registry、Data-Juicer adapter |
| `tooling/proto` | 双语言确定性生成、Buf lint/breaking/check-generated |

## 数据/配置目录约定
- **Prisma**:schema 与 migrations 在根 `prisma/`;`packages/catalog` import 生成的 client。
- **Proto**:源只在根 `proto/`;双语言生成只经 `tooling/proto`;generated 文件不得成为
  第二份手写契约。
- **Python worker**:`workers/processing-python` 只用原生 ARM64 Python 3.11 + 原生
  `uv`;Apple Silicon codegen/runtime preflight 同时拒绝 `/usr/local` Rosetta `uv` 与
  Python，可经 `DATABENCH_PROCESSING_UV_BIN` 指向受控 native executable；不加入 pnpm
  workspace，也不得引用其他实验项目的工具路径。
- **golden fixtures**:现有 Python `bench/`(catalog.db + store/objects)作为对拍金标,复制进各包 `test/golden/fixtures/` 或在 CI 里挂载只读。
- **本地基础设施**:根 `docker-compose.yml` 起 `postgres` + `minio`;`.env.example` 给全量变量(见 conventions「配置」)。
