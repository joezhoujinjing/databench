# Tech stack — implemented TypeScript stack and legacy mapping

> Companion to [architecture.md](architecture.md) and
> [decisions/0001](decisions/0001-rebuild-as-ts-monorepo.md). Package status
> originally verified against npm as of 2026-06; see [feasibility/](feasibility/).
> The rewrite is now complete; treat the TypeScript column as the current stack
> and the Python column as legacy/golden context.

## Backend — what to replace

| Layer | Current (Python) | Target (TypeScript) | Notes |
|---|---|---|---|
| Language / runtime | Python ≥3.10 | **TypeScript / Node 22 LTS** | `.nvmrc` is authoritative |
| Package mgr / build | `uv` + `hatchling` | **pnpm workspaces + Turborepo + `tsup`** | monorepo tooling |
| Dataframe engine | **Polars** | **`nodejs-polars`** (primary) | same Rust core; every op maps 1:1 |
| Analytical SQL / out-of-core | *(implicit Polars; roadmap → Ray Data)* | **none active**; future `@duckdb/node-api` only via new design/ADR | current code is `nodejs-polars` only |
| Arrow interchange | **PyArrow** | **`apache-arrow`** (JS) | zero-copy IPC; polars emits Arrow |
| Parquet IO | Polars / PyArrow | **`nodejs-polars`** | avoid stale `parquetjs` for the core |
| Content hashing | **blake3** (blake2b fallback) | **`hash-wasm`** (blake3) | `@hashbuf/blake3` alt; canonical-JSON + `hashUnordered` are trivial TS |
| Schema / validation | **Pydantic v2** | **`zod` v4** | `z.discriminatedUnion('kind', …)` |
| OpenAPI source | FastAPI `app.openapi()` | **`@hono/zod-openapi`** | spec generated from the same zod schemas — one source of truth |
| Catalog DB (control plane) | SQLite (stdlib `sqlite3`, WAL) | **Postgres** + **Prisma ORM** (Rust-free TS/WASM client; driver adapter `@prisma/adapter-pg`/`-neon`) | managed in prod (Neon/RDS), Docker locally; ADR-0003 / ADR-0004 |
| Blob store (data plane) | local Parquet (fs, atomic rename) | **Aliyun OSS** via native `ali-oss` behind a `Store` interface | content-addressed write-once; tests can inject an in-memory store |
| Lineage DAG | recursive Python walk | recursive **SQL CTE** (`WITH RECURSIVE`) via Prisma **TypedSQL** / `$queryRaw` | Prisma's query API has no native recursive CTE — escape to raw SQL for this one query |
| Web framework | **FastAPI** | **Hono** (locked, ADR-0002) | contract-first routes via `@hono/zod-openapi` |
| HTTP server | `uvicorn` | Node http via Hono adapter | — |
| Multipart upload | `python-multipart` | Hono `c.req.parseBody` | built-in |
| NDJSON streaming | Starlette `StreamingResponse` | Web Streams (Hono) | first-class |
| Tests | `pytest` + `httpx` | **`vitest`** | handlers are fetch fns ⇒ easy to test |
| OpenAPI export script | `scripts/export_openapi.py` | `tooling/openapi-export` | deterministic dump (sorted keys) |

## Roadmap items (M2 / M3)

| Capability | Current plan (Python) | Target (TypeScript) | Verdict |
|---|---|---|---|
| M3 vector backend | Lance | future **`@lancedb/lancedb`** integration | TS-native candidate; not active in current code |
| M2 synthesis | distilabel | **Vercel AI SDK / provider SDKs** over `Dataset`/`Workspace` | TS-native (capability, not the framework) |
| M2 annotation | Argilla | external **Argilla server over REST** | stack-agnostic; integrate via HTTP |
| Distributed scaling | Ray Data | **not active**; future single-node out-of-core/job path should be designed before use | Ray only as an *optional* `workers/python-*` sidecar if true cluster execution is ever mandated |

## Frontend — React + Vite SPA (ADR-0006)

`apps/web` is a pure REST client (no SSR) implemented on the stack below. It is
not allowed to import backend packages; it consumes `apps/api` through generated
OpenAPI types and runtime API wrappers.

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

The original `databench-ui` (React 18 + Vite + TS, at
`~/Desktop/databench/databench-ui/`) remains a read-only feature reference and
historical comparison source.

## The only Python that can ever appear

Zero for the product as specified. Python enters **only** if the owner later
mandates reusing **distilabel** or **Ray Data** *the frameworks themselves* —
as an optional sidecar behind the same `/v1` REST contract, never in the core
path. See [architecture.md → Python boundary](architecture.md).
