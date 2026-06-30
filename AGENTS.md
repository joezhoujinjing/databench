# databench-ts — Agent 工作指南

> 给所有 AI 工具(Claude Code / Codex / Cursor …)的操作总纲。**动手前先读相关 docs,别重新决定已经定了的事。** 本文是防漂移闸,细节都在 `docs/`。

## 这是什么 / 现状
**databench** = LLM post-training 数据基础设施(版本化数据集、自动血缘、可复现混合)。本仓库是它的 **全 TS monorepo 全新重写**(后端 + 前端都重写)。

**现状:S0.1-S21 已完成,M5 parity & 切换收尾完成;D1 已由 owner 改为实现 vocabularies,S19 已补齐。** 后端、前端主流程、OpenAPI、S20 新旧端到端 parity 均已落地并过闸门;词表域已按最新旧后端 + 旧 UI 语义迁入。下一步是 **D3 API 托管平台决策**,拍板前不得进入 S22 部署。旧实现在 `~/Desktop/databench/`(Python 后端 + 旧 UI),**只读参考 + golden 源,默认保留,严禁修改**。

## 执行入口
**实现 agent 先读 [`docs/HANDOFF.md`](docs/HANDOFF.md)**(交接:现状/红线/决策门默认/环境 gotcha/DoD/检查点),然后以 [`docs/migration/STATUS.md`](docs/migration/STATUS.md) 的当前进度为准,继续按 [`docs/migration/PLAN.md`](docs/migration/PLAN.md) 推进(M0..M6 / S0..S22 + 决策门)——一个 Step 一个 PR,过闸门再进下一步。不要重跑或重写已完成 Step,除非是修复当前 gate 暴露的问题。

## 先读这些(docs/ 是唯一真源)
- `docs/architecture.md` — 系统形态、引擎下注、部署
- `docs/project-structure.md` — 有哪些包 + **依赖方向规则**
- `docs/directory-layout.md` — **文件级**布局(含 Hono `apps/api`、`apps/web`)
- `docs/conventions.md` — 命名 / ESM / **确定性纪律** / 错误映射 / 测试 / env
- `docs/tech-stack.md` — Python→TS 逐层映射
- `docs/migration/feature-inventory.md` — **后端**迁移主计划(101 功能、13 阶段、golden 闸门)
- `docs/migration/frontend-inventory.md` — **前端**重写主计划(FE-0..FE-5)
- `docs/decisions/*.md` — ADR(已锁决策的依据)

## 已锁决策(不经新/改 ADR 不得变更)
| 维度 | 选择 |
|---|---|
| monorepo | pnpm workspaces + Turborepo;包名 `@databench/*` |
| 运行时 / 测试 | Node 22 LTS + Vitest |
| Lint+Format | Biome |
| 语言/模块 | TypeScript,纯 ESM;构建 tsup |
| HTTP | Hono + `@hono/zod-openapi`(ADR-0002) |
| 校验/契约 | zod(单一来源)→ OpenAPI → openapi-typescript |
| ORM | **Prisma**(Rust-free;递归 lineage 用 TypedSQL/`$queryRaw`) |
| 数据库 | **Supabase** Postgres(catalog 控制面) |
| 对象存储 | **GCS**(S3 兼容 `@aws-sdk/client-s3`;本地 MinIO)= 数据面 |
| 引擎 | **nodejs-polars** 主力 + **DuckDB**(out-of-core / 兜底) |
| 前端 | React 19 + Vite SPA + shadcn/ui + Tailwind + TanStack Router/Query/Virtual + openapi-fetch(ADR-0006) |

**需要的 Python:零**(除非将来点名复用 distilabel/Ray 框架本身,见 ADR-0001)。

## 仓库布局(简表;完整见 project-structure.md)
```
apps/{api,web}  packages/{hashing,schema,engine,io,ops,store,catalog,workspace}
tooling/openapi-export  prisma/  docs/
```
两个有状态服务:**Postgres + 对象存储**;nodejs-polars/DuckDB/Lance 是进程内库,不是要运维的服务。

## 硬规则(防漂移,CI 应校验)
1. **依赖 DAG(无环、只向下)**:`hashing ← schema ← {engine, io, catalog} ← {ops, store} ← workspace ← apps/api`。
   - **`apps/api` 只经 `workspace` + `schema` 触达数据**,禁止直连 store/catalog/engine/ops/io。
   - `catalog` 只依赖 Prisma;`hashing`/`schema` 保持纯(不碰 polars/Prisma/S3)。
   - **禁止深 import**(只能 import 包的 `index`);用 package.json `exports` 封死。
2. **确定性纪律(后端对拍命门)**:参与哈希的序列化**只走** `@databench/hashing` 的 `canonicalJson` —— **任何地方禁用裸 `JSON.stringify` 做哈希输入**;blake3 固定;内容序列化**保留 null**(不丢 undefined);recipe 计数用 `bankersRound`(非 `Math.round`);权重 `weight || 1.0`;空集 version = `hashText("empty")`。每条都对应一个 golden 闸门。
3. **契约优先**:wire 类型只在 `@databench/schema`(zod)定义一次 → `@hono/zod-openapi` 出 `openapi.json` → `openapi-typescript` 生成前端 client。**不手写 API 类型**(除前端 `ApiError`)。改契约 = 同 PR 跑 `openapi:check` + 重生成。
4. **错误**:域层抛**类型化领域错误**(不抛裸串、不抛 HTTP 概念);**只有 `apps/api`** 映射成统一信封 `{error:{code,message,detail?}}`。
5. **存储**:**样本数据绝不进 Postgres** —— Parquet 在对象存储;PG 只存 catalog 元数据。
6. **Golden 对拍**:每个迁移阶段对拍旧 Python `~/Desktop/databench/databench/bench/`(catalog.db + store)后再进下一阶段。

## 工作方式
- **逐阶段**迁移/重写(后端阶段 0..13 见 feature-inventory;前端 FE-0..5 见 frontend-inventory);**一个阶段≈一个 PR**,过该阶段 golden/FG 闸门才合并。
- **Conventional Commits**,scope = 包名(如 `feat(engine): …`);pre-commit 跑 Biome;CI 跑 lint/typecheck/vitest/golden/`openapi:check`。
- 在仓库根目录操作;Node 22(`.nvmrc`)。

## 常用命令
```
docker compose up -d        # 本地 postgres + minio
pnpm install
pnpm dev                    # turbo 拉起 apps/api + apps/web
pnpm test                   # vitest(含 golden)
pnpm openapi:check          # 契约确定性校验
pnpm --filter @databench/<pkg> <script>
```

## 不要做
- 不要重议已锁决策(见 ADR);要变就改 ADR。
- 不要把样本塞进 PG;不要用 `JSON.stringify` 做哈希;不要深 import;不要让 `apps/api` 直连 store/catalog/engine。
- **不要移除或重新禁用 vocabularies(`CONTRACT-03..08`)**,除非 owner 再次拍板并更新 ADR/计划——当前已实现,后端 `capabilities.vocabularies:true`,前端入口按能力位展示。
- 不要擅自换框架/库。
- 不要修改旧参考仓库 `~/Desktop/databench/`。

## 仍待 owner 决策(遇到时**标出来、别假设**)
- **API 托管平台**(长驻容器 + 原生插件;GCP 候选 Cloud Run)。
- **export `fmt`/TRL**:当前采用照搬等价默认;若要实现真正 TRL,必须 owner 拍板并更新 ADR/计划。
