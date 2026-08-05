# databench-ts — Agent 工作指南

> 动手前先读相关 docs，不重新决定已经接受的事项。`docs/` 是实现真源，ADR 是决策历史。

## 当前状态

Databench 是 LLM post-training 数据基础设施。本仓库是全 TypeScript monorepo。

- v2 V0-V16 已完成；V17 仍未完成。
- ADR 0013 产品切换 R0-R5 已完成并过最终 gate；V16/V17 状态不因此改变。
- v2 是唯一产品面：Web/CLI 无版本入口，REST/DB/object/internal types 保留稳定 v2 命名。
- v1 runtime、产品 surface、领域实现和本地持久化数据已经退役。
- `tooling/v1-retirement`、forward migration 与 runbook 暂时保留，供尚未执行 R4 的安装环境
  显式退役；它们不是产品 runtime。
- 公共云 API 托管平台仍受 D3 owner 决策门约束。ADR 0012 离线单机通道独立有效。
- 旧仓库 `~/Desktop/databench/` 只读，严禁修改。

## 实施入口

先读：

1. `docs/HANDOFF.md`
2. `docs/v2/STATUS.md`
3. 与任务对应的 accepted ADR/technical design/plan
4. `docs/project-structure.md`
5. `docs/directory-layout.md`
6. `docs/conventions.md`

历史迁移清单、旧 v1 技术方案和 review 可以作为背景，但不代表当前 runtime surface。

## 已锁技术

| 维度 | 当前选择 |
|---|---|
| monorepo | pnpm workspaces + Turborepo |
| runtime/test | Node 22 LTS + Vitest |
| lint/format | Biome |
| module/build | TypeScript、纯 ESM、tsup |
| HTTP | Hono + `@hono/zod-openapi` |
| contract | Zod → OpenAPI → openapi-typescript |
| database | Prisma + Postgres |
| object store | Aliyun OSS；本地/离线 MinIO S3 adapter |
| artifact codec | hyparquet + hyparquet-writer + zstd-wasm |
| frontend | React 19 + Vite + Tailwind + TanStack Router/Query/Virtual + openapi-fetch |

## 依赖 DAG

```text
hashing ← schema
hashing/schema ← engine
schema ← io
Prisma ← catalog
engine/schema ← ops
engine/schema/hashing ← store
engine/io/ops/store/catalog/schema/hashing ← workspace
workspace/schema ← apps/api, apps/cli
generated OpenAPI client ← apps/web
```

硬规则：

1. API/CLI 只经 Workspace + Schema 触达数据。
2. Catalog 只依赖 Prisma；Hashing/Schema 保持纯。
3. 禁止 deep import，只使用 package exports。
4. 样本 payload 不进 Postgres。
5. 对象 artifact/manifest immutable，写入必须 conditional create。

## 确定性

- identity 序列化只走 `@databench/hashing` 的 RFC 8785 v2 路径。
- 禁止用裸 `JSON.stringify` 构造 hash 输入。
- BLAKE3、domain/profile/schema envelope 与 empty formula 以 ADR 0011 为准。
- `record-json-v1` 是当前 Parquet layout 名，不是退役产品 v1，禁止误删或改名。
- 修改 identity/layout/converter fidelity 必须过对应 fixed vectors。

## 产品与契约边界

- Web 只有 `/datasets`、`/ingest`、`/transforms` 及详情子路由。
- CLI 使用 `databench dataset|converter|transform|ref|lineage ...`。
- REST 使用 meta + `/v2/*`；不要把 `/v2` 改成 `/v1` 或无版本 API。
- wire schema 只在 `@databench/schema` 定义；改契约必须重生成 client 并跑
  `pnpm openapi:check`。
- Recipe、Vocabularies 和旧 Processing 产品实现已退役，不得重新接回。

## 工作方式

- 一个 accepted Step 一个 PR/commit，当前 gate 通过后再进入下一步。
- Conventional Commits。
- R5 gate：lint、build、typecheck、test、openapi、v2 status、peer、真实 Postgres/MinIO、
  浏览器和离线 lifecycle smoke。
- V17 未过时不得宣称 production readiness。
- 不修改旧参考仓库，不在普通启动/请求中隐式删除数据。

## 常用命令

```bash
docker compose up -d
pnpm install
pnpm dev
pnpm lint
pnpm build
pnpm typecheck
pnpm test
pnpm openapi:check
pnpm v2:status:check
pnpm offline:check
```

## 不要做

- 不重议 accepted ADR；需要变化先更新 ADR/计划并取得 owner 决策。
- 不恢复 v1 Web/API/CLI/领域实现。
- 不为了清理版本文案而重命名 `/v2`、`*_v2`、`objects/v2/`、`record-json-v1`
  或 identity profile。
- 不让 API/CLI 直连下层包。
- 不用 prefix delete 或模糊对象匹配。
- 不擅自选择 D3 公共云托管平台。
