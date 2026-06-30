# Tech stack — current (Python) → target (TypeScript)

> Companion to [architecture.md](architecture.md) and
> [decisions/0001](decisions/0001-rebuild-as-ts-monorepo.md). Package status
> verified against npm as of 2026-06; see [feasibility/](feasibility/).

## Backend — what to replace

| Layer | Current (Python) | Target (TypeScript) | Notes |
|---|---|---|---|
| Language / runtime | Python ≥3.10 | **TypeScript / Node ≥20** (Bun optional) | web-standard handlers ⇒ edge-capable |
| Package mgr / build | `uv` + `hatchling` | **pnpm workspaces + Turborepo + `tsup`** | monorepo tooling |
| Dataframe engine | **Polars** | **`nodejs-polars`** (primary) | same Rust core; every op maps 1:1 |
| Analytical SQL / out-of-core | *(implicit Polars; roadmap → Ray Data)* | **`@duckdb/node-api`** (DuckDB Neo) | larger-than-memory + SQL fallback + duckdb-wasm in UI |
| Arrow interchange | **PyArrow** | **`apache-arrow`** (JS) | zero-copy IPC; polars emits Arrow |
| Parquet IO | Polars / PyArrow | **`nodejs-polars`** (or DuckDB `COPY`) | avoid stale `parquetjs` for the core |
| Content hashing | **blake3** (blake2b fallback) | **`hash-wasm`** (blake3) | `@hashbuf/blake3` alt; canonical-JSON + `hashUnordered` are trivial TS |
| Schema / validation | **Pydantic v2** | **`zod` v4** | `z.discriminatedUnion('kind', …)` |
| OpenAPI source | FastAPI `app.openapi()` | **`@hono/zod-openapi`** | spec generated from the same zod schemas — one source of truth |
| Catalog DB (control plane) | SQLite (stdlib `sqlite3`, WAL) | **Postgres** + **Prisma ORM** (Rust-free TS/WASM client; driver adapter `@prisma/adapter-pg`/`-neon`) | managed in prod (Neon/RDS), Docker locally; ADR-0003 / ADR-0004 |
| Blob store (data plane) | local Parquet (fs, atomic rename) | **object storage** (S3/R2; **MinIO** locally) behind a `Store` interface | content-addressed write-once; S3 `PUT` is atomic |
| Lineage DAG | recursive Python walk | recursive **SQL CTE** (`WITH RECURSIVE`) via Prisma **TypedSQL** / `$queryRaw` | Prisma's query API has no native recursive CTE — escape to raw SQL for this one query |
| Web framework | **FastAPI** | **Hono** (recommended, ADR-0002) | NestJS / Fastify are alternatives |
| HTTP server | `uvicorn` | Node http via Hono adapter | — |
| Multipart upload | `python-multipart` | Hono `c.req.parseBody` | built-in |
| NDJSON streaming | Starlette `StreamingResponse` | Web Streams (Hono) | first-class |
| Tests | `pytest` + `httpx` | **`vitest`** | handlers are fetch fns ⇒ easy to test |
| OpenAPI export script | `scripts/export_openapi.py` | `tooling/openapi-export` | deterministic dump (sorted keys) |

## Roadmap items (M2 / M3)

| Capability | Current plan (Python) | Target (TypeScript) | Verdict |
|---|---|---|---|
| M3 vector backend | Lance | **`@lancedb/lancedb`** | TS-native |
| M2 synthesis | distilabel | **Vercel AI SDK / provider SDKs** over `Dataset`/`Workspace` | TS-native (capability, not the framework) |
| M2 annotation | Argilla | external **Argilla server over REST** | stack-agnostic; integrate via HTTP |
| Distributed scaling | Ray Data | **DuckDB out-of-core** covers the real need | Ray only as an *optional* `workers/python-*` sidecar if true cluster execution is ever mandated |

## Frontend — greenfield rewrite (React + Vite SPA, ADR-0006)

`apps/web` is a **full rewrite**, **not** a port of the existing UI. Pure REST
client (no SSR). Stack (see [decisions/0006](decisions/0006-frontend-stack.md)):

| 层 | 选择 |
|---|---|
| 框架/构建 | React 19 + **Vite** SPA |
| 路由 | **TanStack Router**(类型安全文件路由) |
| server state / 虚拟化 | **TanStack Query** + **TanStack Virtual** |
| 组件/样式 | **shadcn/ui + Tailwind v4** + lucide-react |
| API 客户端 | **openapi-typescript + openapi-fetch**(消费 `apps/api` 的 openapi.json) |
| 表单 | react-hook-form + zod |
| lineage 可视化 | **React Flow**(`@xyflow/react`) |
| i18n | i18next + react-i18next（en/zh） |
| 测试/规范 | Vitest + Testing Library + Biome |

It consumes the backend only through the generated client (contract-first,
unchanged). The original `databench-ui` (React 18 + Vite + TS, at
`~/Desktop/databench/databench-ui/`) is the **feature reference**, not the
codebase being moved.

## The only Python that can ever appear

Zero for the product as specified. Python enters **only** if the owner later
mandates reusing **distilabel** or **Ray Data** *the frameworks themselves* —
as an optional sidecar behind the same `/v1` REST contract, never in the core
path. See [architecture.md → Python boundary](architecture.md).
