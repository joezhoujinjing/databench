# ADR 0001 — Rebuild databench as an all-TypeScript monorepo

- **Status:** Accepted
- **Date:** 2026-06-29
- **Deciders:** owner

## Context

databench shipped as two repos: a **Python** backend (`databench/` — Polars +
PyArrow + Parquet + blake3 + Pydantic + FastAPI) and a **React + Vite + TS**
frontend (`databench-ui/`) that consumes the backend purely through an
OpenAPI-generated typed client. The current code is an early/vibecoded M1 and is
considered disposable.

The owner decided to **rebuild greenfield as a single TypeScript monorepo**,
unifying the stack and tooling. Python is permitted inside the monorepo **only
where TS is genuinely incapable** — a hard capability gap, not preference.

## Decision

Rebuild the whole stack in TypeScript as a pnpm/Turborepo monorepo — **both**
the backend (reimplemented as TS packages) **and** the frontend (greenfield
rewrite, stack TBD; the original `databench-ui` is the feature reference, not the
codebase being moved). See [../architecture.md](../architecture.md).

The new monorepo lives at **`~/Desktop/databench-ts/`**; the legacy Python
backend + original UI remain at `~/Desktop/databench/` as reference and
golden-test source (`~/Desktop/databench/databench/bench/`).

**Engine:** `nodejs-polars` as the primary dataframe engine, with
`@duckdb/node-api` (DuckDB Neo) resident as the out-of-core path, the in-browser
query engine (`duckdb-wasm`, M3), and a drop-in fallback for every op.

## Feasibility verdict: `FEASIBLE-ALL-TS`

Two evaluators (Claude + Codex) assessed the same brief independently, then
cross-reviewed. **Both converged on `FEASIBLE-ALL-TS`** — required Python
surface for the product as specified is **zero**. (Codex initially returned
`FEASIBLE-WITH-PYTHON-BOUNDARY`, then conceded on cross-review; full reports and
both Round-2 reconciliations are in [../feasibility/](../feasibility/).)

Two findings drove the verdict:

1. **Expression parity is empirical, not assumed.** The exact Polars operations
   the backend uses all exist in `nodejs-polars@0.25.1` (confirmed against the
   package's `.d.ts`): `str.jsonPathMatch`, `cast(strict)`, `filter`,
   `sample(seed)`, `unique({maintainOrder})`, `concat`, parquet read/write,
   lazy `collect`, `groupBy`.
2. **The engine's job is small.** The current backend is *eager* Polars with no
   lazy plan, window, or join — `construct → (dedup | json-extract+cast+filter |
   sample | select+concat) → iterate/arrow/parquet`. Low bar to reproduce.

Every M1 capability (schema, hashing, content-addressed versioning, CAS store,
SQLite catalog + lineage, transforms, recipes, JSONL ingest, Arrow/Parquet, the
OpenAPI-emitting service) is TS-native. M2 synthesis/annotation is TS-native or
an external HTTP service. M3 Lance is TS-native (`@lancedb/lancedb`).

## The one nuance both evaluators agreed on

Python is required **only** if the owner later mandates reusing **distilabel** or
**Ray Data** *the frameworks specifically* (not the capability they provide).
That is an **optional sidecar** behind the same `/v1` REST contract, never a core
dependency. The capabilities themselves — synthetic generation (provider SDKs /
Vercel AI SDK) and larger-than-memory processing (DuckDB out-of-core) — are
TS-native.

## Consequences

- **+** One language/toolchain; atomic contract+UI changes; OpenAPI stays the
  single source of truth (zod → OpenAPI → openapi-typescript).
- **+** Web-standard service can later run at the edge / in workers (aligns with
  the duckdb-wasm M3 plan).
- **−** Primary risk is `nodejs-polars` maturity / the Arrow boundary vs Python.
  Bounded because DuckDB can replace every op (swap, not redesign). **Mitigation:
  spike the engine first with golden tests** (Parquet round-trip, seeded-sampling
  determinism, JSONPath filtering, version-hash stability) — see architecture.md.

## Supersedes

The earlier "keep the backend in Python" lean (driven by the Rosetta
`polars[rtcompat]` runtime issue) — no longer the direction.
