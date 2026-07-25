# 具体目录布局（文件级，权威）

> [`project-structure.md`](project-structure.md) 定义包边界与依赖方向；本文记录当前
> v2-only 文件落点。历史 v1 迁移文件表只在 `docs/migration/` 中保留。

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
│  ├─ middleware/
│  │  ├─ cors.ts
│  │  ├─ error.ts              领域错误 → 统一 HTTP error envelope
│  │  ├─ request.ts            请求 metadata / abort
│  │  └─ v2-workspace.ts       惰性注入 Workspace
│  ├─ routes/
│  │  ├─ meta.ts               /health /version /capabilities
│  │  └─ v2/
│  │     ├─ index.ts            v2 route registry
│  │     ├─ datasets.ts         ingest/show/records/audit/export
│  │     ├─ refs.ts             list/show/move 与 lineage
│  │     ├─ registries.ts       converters/transforms
│  │     ├─ openapi.ts          route schema helpers
│  │     └─ transport.ts        streaming/error transport helpers
│  └─ v2/
│     └─ multipart.ts           bounded multipart ingest
├─ test/
│  ├─ app-support.test.ts
│  ├─ errors.test.ts
│  ├─ v2-http.test.ts
│  ├─ v2-http.integration.test.ts
│  ├─ v2-multipart.test.ts
│  ├─ v2-schema-openapi.test.ts
│  └─ v2-transport.test.ts
├─ Dockerfile
├─ package.json
└─ tsconfig.json
```

公开业务路径只有 `/v2/*`。meta routes 不带版本。`apps/api` 只 import
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
│  │  ├─ __root.tsx             单一产品 shell；三项主导航
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
│  ├─ v2/
│  │  ├─ api/                   v2 client/hooks/query keys/stream export
│  │  ├─ components/            gate、冲突恢复、records、fidelity review
│  │  ├─ features/              datasets/ingest/transforms/lineage/export
│  │  └─ routes/                无版本产品 URL 的薄 route wrappers
│  ├─ i18n/
│  ├─ lib/
│  └─ styles.css
├─ scripts/generate-client.mjs
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
```

`/recipe`、`/vocabularies`、`/v2/...` 等旧产品页面不在 route tree。Web 只通过生成的
OpenAPI 类型和 REST client 访问后端。

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
   ├─ store.ts · contracts.ts · keys.ts · runtime.ts
   ├─ oss-adapter.ts
   ├─ s3-adapter.ts
   ├─ temp-store.ts
   ├─ config.ts
   └─ index.ts
```

只管理 `objects/v2/` immutable artifacts/manifests。写入必须 conditional create；
测试用临时落盘也遵守相同 key 和提交语义。

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

只依赖 Prisma/Postgres。v2 snapshots、layouts、identity claims、runs、record
lineage 与 refs 的数据模型在根 `prisma/schema.prisma`。

## `packages/workspace`

```text
src/
├─ index.ts
└─ v2/
   ├─ workspace.ts
   ├─ identity-allocator.ts
   ├─ cache.ts · cursor.ts
   ├─ mappings.ts
   ├─ transform-semaphore.ts
   └─ index.ts
```

这是应用访问数据的唯一可信编排边界，拥有 ingest、persist、transform、CAS ref、
record/dataset lineage、audit、converter inspect/export 与取消语义。

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
   └─ 0005_retire_v1_catalog/
```

R4 maintenance tool和 forward migration必须保留，供尚未执行退役的安装环境使用；它们不是
可达产品代码。标准操作流程见 `docs/v2/V1-RETIREMENT-RUNBOOK.md`。

## Worker 布局（ADR 0010）

P1 foundation 已落地；标为“planned”的目录只在对应 P2-P6 实现后成为 runtime：

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
│  ├─ databench_worker/        server、registry、runtime、adapters
│  └─ databench/worker/v1/     generated Python bindings
└─ tests/

packages/ops/src/v2/batch/     planned：batch definition 与首个 Data-Juicer transform
packages/store/src/v2/worker-staging*.ts  planned：受限 staging 数据面
packages/workspace/src/internal/worker/  已实现 client/generated；dispatcher planned
packages/workspace/src/v2/batch-transform.ts  planned
apps/api/src/routes/v2/transform-jobs.ts       planned
```

Proto/generated code 只在 Workspace internal 与 Worker generated package 出现。`apps/api`、
`apps/cli` 和 `apps/web` 不导入 generated Proto；公共 contract 仍为 Zod → OpenAPI → generated
Web client。完整边界与每个实施切片见 `docs/processing/TECHNICAL_DESIGN.md`。
