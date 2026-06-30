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
│  └─ web/              前端(**全新重写**,栈待定;仍按同一 /v1 契约消费,旧 UI 作功能参考)
├─ packages/
│  ├─ hashing/          @databench/hashing    blake3 + canonicalJson + hash*（地基）
│  ├─ schema/           @databench/schema     zod 样本判别联合 + Manifest + 服务契约 + Vocabulary + 常量
│  ├─ engine/           @databench/engine     Dataset 核心 + transform 抽象（nodejs-polars/DuckDB）
│  ├─ io/               @databench/io         JSONL 摄取 + kind 检测 + 导出整形
│  ├─ ops/              @databench/ops        内置 transforms（dedup/filter/sample/enrich）
│  ├─ store/            @databench/store      内容寻址 Parquet + Vocabulary JSON 存储（S3 接口 / GCS·MinIO）
│  ├─ catalog/          @databench/catalog    Postgres 控制面（Prisma，含 vocab refs）
│  └─ workspace/        @databench/workspace  编排：run/materialize/lineage/export + recipe + vocabulary
├─ tooling/
│  ├─ openapi-export/   启动 api 导出确定性 openapi.json（替代 scripts/export_openapi.py）
│  └─ tsconfig/         共享 tsconfig 基线（可选独立包）
├─ prisma/              Prisma schema + migrations（catalog 用）
├─ docker-compose.yml   本地：postgres + minio
├─ turbo.json · biome.json · tsconfig.base.json · pnpm-workspace.yaml · .nvmrc
└─ docs/
```

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
    store             → engine, schema
L4  workspace         → engine, io, ops, store, catalog, schema, hashing
L5  apps/api          → workspace, schema           （只经 workspace 触达数据,不直连 store/catalog/engine）
L6  tooling/openapi-export → apps/api
    apps/web          → （仅消费生成的 OpenAPI client,不 import 任何后端包）
```

**硬规则(CI 应校验,见 conventions「依赖纪律」):**
1. **`apps/api` 不得直接 import `store`/`catalog`/`engine`/`ops`/`io`** —— 一切经 `@databench/workspace`。API 层只做:校验(zod)→ 调 workspace → 整形响应 → 错误映射。
2. **`catalog` 不依赖任何域包**(它只认 version 串、json、时间戳);Prisma 只活在这里。
3. **`hashing`/`schema` 不依赖 nodejs-polars/Prisma/S3** —— 保持纯,便于 golden 对拍与跨环境复用。
4. **禁止深 import**(`@databench/x/src/foo`):只能 import 包的 `index.ts`。用 package.json 的 `exports` 字段封死。
5. **无环**:Turborepo/Biome 跑依赖检查;新增跨包依赖必须仍是 DAG。

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
| `tooling/openapi-export` | `CONTRACT-02` |

## 数据/配置目录约定
- **Prisma**:schema 与 migrations 在根 `prisma/`;`packages/catalog` import 生成的 client。
- **golden fixtures**:现有 Python `bench/`(catalog.db + store/objects)作为对拍金标,复制进各包 `test/golden/fixtures/` 或在 CI 里挂载只读。
- **本地基础设施**:根 `docker-compose.yml` 起 `postgres` + `minio`;`.env.example` 给全量变量(见 conventions「配置」)。
