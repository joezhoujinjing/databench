# databench-ts 完整迁移计划(总执行清单)

> 唯一的「从头到尾按顺序执行」计划。把后端 [`feature-inventory.md`](feature-inventory.md)(阶段 0..13 + 闸门 G1..G12)与前端 [`frontend-inventory.md`](frontend-inventory.md)(FE-0..FE-5 + FG1..FG7)串成一条线,并插入 3 个 owner 决策门。
>
> **执行纪律**:① 一个 Step ≈ 一个 PR;② 过该 Step 的**闸门**才进下一步;③ 细节查对应 inventory + [`conventions.md`](../conventions.md),本计划只管**顺序与串联**;④ 落代码前先读 [`/AGENTS.md`](../../AGENTS.md)。
> **粒度跟踪**:本文按 **Step/PR** 跟踪;每个功能的勾选框在两份 inventory 里。

## 里程碑总览

```
M0 Bootstrap ─ M1 去风险 spike ─ M2 后端核心(数据/控制面)─ M3 后端 API
                                                                 │(发布 openapi.json)
                                                                 ▼
                                          M4 前端 ─ M5 Parity & 切换 ─ M6 部署
```

| Step | 目标 | 覆盖 inventory | 闸门 | 依赖 | 规模 |
|---|---|---|---|---|---|
| **M0 Bootstrap** ||||||
| S0.1 | monorepo 脚手架 + 工具链 + git init | 阶段0 / FE-0(工具) | G0 | — | M |
| S0.2 | 基础设施:docker-compose(pg+minio)、prisma init、.env.example | ADR-0003/0005 | G0 | S0.1 | S |
| S0.3 | 空包骨架(apps/* packages/* tooling/*)+ CI 绿 | project-structure | G0 | S0.1 | M |
| **M1 去风险** ||||||
| S1 | **采样确定性 spike**(nodejs-polars vs Python 同 seed)+ blake3/canonicalJson 对拍 | G5 前置 | **G-spike** | S0.* | S |
| **M2 后端核心** ||||||
| S2 | `packages/hashing` | 阶段1 | G1 | S1 | S |
| S3 | `packages/schema` | 阶段2 | G2 | S2 | M |
| S4 | `packages/engine`(dataset 核心) | 阶段3 | G3 | S3 | L |
| S5 | `packages/io` | 阶段4 | G4 | S3 | M |
| S6 | `packages/engine`(transform)+ `packages/ops` | 阶段5 | G5 | S4,S1 | M |
| S7 | `packages/store`(对象存储/MinIO) | 阶段6 | G6 | S4 | M |
| S8 | `packages/catalog`(Prisma+Postgres) | 阶段7 | G7 | S0.2 | L |
| S9 | `packages/workspace` + recipe | 阶段8 | G8 | S5,S6,S7,S8 | L |
| ★ | **域层 parity 里程碑**:库级 ingest→transform→recipe→export→lineage 与 bench/ 对拍 | — | — | S9 | S |
| **M3 后端 API** ||||||
| D1 | 🟡 决策门:**vocabularies**(实现/暂缓默认/移除) | — | — | — | — |
| D2 | 🟡 决策门:**export TRL/fmt**(照搬默认/实现) | — | — | — | — |
| S10 | `packages/schema` 服务契约 + `ErrorResponse` | 阶段9(契约) | — | S3 | S |
| S11 | `apps/api` 支撑(工厂/CORS+PNA/context/meta/registry) | 阶段9(SVC) | — | S9,S10 | M |
| S12 | `apps/api` 错误信封 + 映射 | 阶段10 | G10 | S11 | S |
| S13 | `apps/api` 端点 API-01..14 | 阶段11 | G11 | S12 | L |
| S14 | `tooling/openapi-export`(确定性 openapi.json) | 阶段12 | G12 | S13 | S |
| ★ | **后端 feature-complete + 契约发布** | — | — | S14 | — |
| **M4 前端** ||||||
| S15 | FE-1 API 层(openapi-fetch/ApiError/per-base token/query-key) | FE-1 | FG2,FG3,FG6 | S14 | M |
| S16 | FE-2 握手+gate+应用壳 | FE-2 | FG5 | S15 | M |
| S17 | FE-3 共享组件 + i18n locales | FE-3 / 贯穿 | FG4,FG1 | S16 | M |
| S18 | FE-4 核心页面(Datasets/详情/Ingest/Transforms/Recipe/Lineage) | FE-4 | FG7 | S17 | L |
| S19 | FE-5 vocabularies(**仅 D1=实现 时**) | FE-5 | — | S18,D1 | L |
| ★ | **UI 与旧 databench-ui 已实现功能 parity** | — | — | S18 | — |
| **M5 Parity & 切换** ||||||
| S20 | 端到端 parity:新旧并跑同输入,diff manifest/version/lineage/export | — | **G-parity** | S18 | M |
| S21 | 文档/AGENTS 收尾;旧仓库归档(确认后) | — | — | S20 | S |
| **M6 部署** ||||||
| D3 | 🟡 决策门:**API 托管平台**(长驻容器;Cloud Run 候选) | — | — | — | — |
| S22 | Dockerfile + 部署 API + 部署 web(静态)+ 接 Supabase/GCS 生产 secret + CI/CD | ADR-0005 | **G-prod** | S20,D3 | M |

---

## 各 Step 细节

### M0 — Bootstrap

**S0.1 monorepo 脚手架**:`pnpm-workspace.yaml`、`turbo.json`(build/lint/typecheck/test/openapi:check 管线)、`tsconfig.base.json`(strict + `exactOptionalPropertyTypes` 等,见 conventions §2)、`biome.json`、`.nvmrc`=22、根 `package.json`(engines、scripts 走 turbo)、Vitest 配置、`lefthook.yml`(pre-commit Biome)。在 `~/Desktop/databench-ts/` 执行 `git init`。

**S0.2 基础设施**:`docker-compose.yml`(`postgres` + `minio`,带初始化 bucket)、`prisma/` init(空 schema 骨架 + 生成 client 接线)、`.env.example`(`DATABASE_URL`/`S3_*`/`DATABENCH_CORS_ORIGINS`/`PORT`)、`.gitignore`(`.env`、`node_modules`、`dist`)。

**S0.3 空包骨架**:按 [`directory-layout.md`](../directory-layout.md) 建 `apps/{api,web}`、`packages/{hashing,schema,engine,io,ops,store,catalog,workspace}`、`tooling/openapi-export`,每个含 `package.json`(`@databench/*`,`exports` 仅 `.`)+ `src/index.ts` stub + `tsconfig.json`(project refs)。`apps/web` 跑 FE-0(Vite+Tailwind v4+shadcn init+TanStack Router 骨架+主题 tokens)。`.github/workflows/ci.yml`。

> **闸门 G0**:`pnpm install && pnpm -r build && pnpm typecheck && pnpm test` 全绿(空实现);`docker compose up -d` 两服务 healthy;CI 绿;`AGENTS.md` 命令可用。

### M1 — 去风险 spike(最高风险前置)

**S1**:实测 **nodejs-polars `sample(n, seed)` 是否与 Python polars 同 seed 选出同一子集**(用 bench/ 真实数据);顺带验 `blake3` + `canonicalJson`(含中文/浮点/null)与 Python 逐字节一致。
- 若采样一致 → 引擎按 nodejs-polars 推进;
- 若不一致 → 采样改走 **DuckDB `REPEATABLE(seed)`** 或自实现确定性采样;**把结论写成一条 ADR(0007)**。

> **闸门 G-spike**:有书面结论 + 采样引擎路径锁定。这是「全 TS 可行」的最后实证关口。

### M2 — 后端核心(数据面 + 控制面)
逐包按 inventory 阶段 1..8 实现,**每包末过对应 G 闸门、对拍 `~/Desktop/databench/databench/bench/`**(catalog.db + store)。顺序即依赖序:hashing→schema→engine→io→(transform+ops)→store→catalog→workspace。要点逐条见 `feature-inventory.md`,致命易漏点见 `inventory-domain.md` 结尾「可能遗漏」。
- **★ 域层 parity**:不经 HTTP,在库级跑通 `ingest → enrich → dedup → recipe → export → lineage`,version/lineage/导出与 Python demo 一致。

### M3 — 后端 API
- **D1 vocabularies**、**D2 TRL** 两个决策门在此**之前**拍(影响 capabilities/契约/导出);当前 D1 已由 owner 改为实现(`capabilities.vocabularies:true`),D2 继续 TRL 照搬等价。
- S10..S14:服务契约(zod+`ErrorResponse` 进 OpenAPI)→ 应用支撑(CORS+PNA、workspace context、meta、transform registry)→ 错误映射(G10)→ 端点 API-01..14(G11 全生命周期对拍)→ 确定性 openapi 导出(G12)。
- **★ 契约发布**:`apps/api` feature-complete,`openapi.json` 产出并提交 —— 前端从这一刻起可生成 client。

### M4 — 前端
依赖 S14 发布的 `openapi.json`。FE-1..FE-4 顺序见 `frontend-inventory.md`;**FE-5 词表当前已按 D1=实现补齐**,入口由 capabilities 控制。
- **★ UI parity**:对旧 `databench-ui` 已实现功能逐页核对(以前端 inventory 的验收点为准)。

### M5 — Parity & 切换
**S20 端到端 parity**:同一批输入,旧 Python 服务 vs 新 TS 服务,diff:dataset version、lineage 结构、export 行、samples 分页。**G-parity**:golden 集上语义/字节等价。**S21**:更新 AGENTS/docs,旧仓库 `~/Desktop/databench/` 归档(确认稳定后再考虑删,默认保留)。

### M6 — 部署
**D3 API 托管平台**拍板(长驻容器 + 原生插件;GCP 候选 Cloud Run)。**S22**:`apps/api` Dockerfile + 部署;`apps/web` 静态部署;接生产 Supabase + GCS(secret 走平台,不进仓库);CI/CD。**G-prod**:生产冒烟(health/version/capabilities + 一次完整生命周期)。

---

## 并行与关键路径
- **关键路径**:S0 → S1 → (S2→S3→S4→S6→S9 / 旁支 S5,S7,S8)→ S13 → S14 → S15 → S18 → S20 → S22。
- **可并行**:M2 内 `io(S5)`/`store(S7)`/`catalog(S8)` 在各自依赖就绪后可与主链并行;前端 `FE-2 壳/FE-3 组件` 的非数据部分可在 S15 之后与 S16/S17 交错;i18n locales 迁移可早做。
- **阻塞点**:前端页面(S18)硬依赖契约发布(S14);S19 依赖 D1;S22 依赖 D3。

## 待决策(插入点已在表中标 🟡)
| 决策 | 影响的 Step | 默认 | 最迟在 |
|---|---|---|---|
| D1 vocabularies | S19、capabilities | 已改为实现(`true`) | 已拍板 |
| D2 export TRL | S13 导出端点 | 照搬等价 | S13 前 |
| D3 API 托管 | S22 | 未定 | M6 开始前 |
