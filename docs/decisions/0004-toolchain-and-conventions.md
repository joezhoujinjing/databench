# ADR 0004 — 工具链与项目约定

- **状态:** Accepted
- **日期:** 2026-06-29
- **决策人:** owner

## 背景
全 TS monorepo 重写(ADR-0001)开工前,锁定贯穿所有代码的工具链与约定,**防止迁移过程中各包风格漂移**。

## 决策(全部已选定)

| 维度 | 选择 | 备注 |
|---|---|---|
| 包管理 | **pnpm** workspaces | `pnpm-workspace.yaml` 声明 `apps/*`、`packages/*`、`tooling/*` |
| 任务编排 | **Turborepo** | `turbo.json` 定义 build/lint/typecheck/test/openapi:check 管线 + 缓存 |
| 运行时 | **Node 22 LTS** | `.nvmrc` + `engines.node >=22`;对 nodejs-polars / `@duckdb/node-api` 这类 N-API 原生包最稳 |
| 语言/模块 | **TypeScript**,纯 **ESM**(`"type":"module"`) | 见 `conventions.md` 的 tsconfig 基线 |
| 包构建 | **tsup**(esbuild) | 每个 `packages/*` 出 ESM + `.d.ts`;`apps/api` 可直接 tsx/node 运行 |
| 测试 | **Vitest** | 单测 + golden 对拍;CI 必跑 |
| Lint + Format | **Biome** | 单一 `biome.json`,一个工具搞定 lint+format;接 CI 与 pre-commit |
| catalog ORM | **Prisma ORM** | Rust-free TS/WASM 客户端 + driver adapter;递归 lineage CTE 走 **TypedSQL / `$queryRaw`**(Prisma 无原生递归 CTE) |
| CI | **GitHub Actions** | 与 Turborepo 远程缓存集成;跑 lint/typecheck/vitest/golden/openapi `--check` |
| 包命名 scope | **`@databench/*`** | 见 `project-structure.md` |

## Prisma 的已知约束(必须遵守,否则踩坑)
- **驱动适配器是必需的**(去 Rust 后 Prisma 不再自带驱动):Postgres 用 `@prisma/adapter-pg`(Supabase 走标准 PG 连接)。
- **递归 lineage(`WS-07/08`)用 TypedSQL/`$queryRaw`**,不要试图用 query API 表达;注意 TypedSQL 在 PG 递归 CTE 上有一个把主键标成 `string|null` 的 open bug(2026-01),用 `$queryRaw` + 手写行类型可绕开。
- 三种 upsert(`CATALOG-02/04/07`)分别用 `createMany({skipDuplicates})` / `upsert`(DO UPDATE)/ `upsert` —— **逐表复刻,不可统一**(见 inventory-domain `CATALOG`)。

## 默认项(低风险,已采用;如需变更说一声)
zod v4(配 `@hono/zod-openapi`)、`@aws-sdk/client-s3` 访问对象存储(见 ADR-0005)、Conventional Commits、pre-commit 用 lefthook 跑 Biome。

## 后果
- 一套语言/一套 lint/一套 runtime/一种数据库,本地=CI=生产同构,无方言漂移。
- ORM 仅活在 `packages/catalog`,即便日后更换,封装边界让成本可控。
