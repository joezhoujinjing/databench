# databench — Target Architecture (all-TypeScript monorepo)

> Status: target design for the greenfield rebuild. Decided 2026-06-29.
> Feasibility verdict: **`FEASIBLE-ALL-TS`** (see [decisions/0001](decisions/0001-rebuild-as-ts-monorepo.md)).
> Required Python surface for the product as specified: **zero**.

## What databench is

Infrastructure for managing **LLM post-training data**: versioned datasets,
automatic lineage, reproducible training mixtures. A thin **control plane**
(catalog, Postgres) over a content-addressed **data plane** (immutable Parquet
blobs on object storage), with a pure-function **transform/enrichment** engine
and a hashable **recipe** (mixture) as the bridge to training.

**Deployment:** a hosted, horizontally-scaled service — N stateless Hono API
replicas over exactly **two stateful services**: **Postgres** (catalog) and
**object storage** (Parquet data plane). `nodejs-polars`, DuckDB, Arrow and
Lance are in-process libraries, not infrastructure — DuckDB reads Parquet
directly from object storage via `httpfs`. Local/CI run the same stack via
docker-compose (`postgres` + `minio`). No SQLite. See
[decisions/0003](decisions/0003-storage-postgres-object-store.md).

## Monorepo layout

**`~/Desktop/databench-ts/` is the monorepo root** (a fresh greenfield repo).
The legacy Python backend and the original `databench-ui` stay at
`~/Desktop/databench/` as **reference + golden-test source** (the Python
`bench/` catalog.db + store live at `~/Desktop/databench/databench/bench/`).
Tooling: **pnpm workspaces + Turborepo**, TypeScript project references, `tsup`
for package builds.

```
databench-ts/                      (monorepo root)
├─ apps/
│  ├─ api/            HTTP service → /health, /version, /capabilities, /v1/*
│  │                  emits openapi.json (the UI's contract). See ADR-0002.
│  └─ web/            frontend — GREENFIELD REWRITE (stack TBD); still consumes
│                     the same /v1 contract via openapi-typescript
├─ packages/
│  ├─ schema/         zod discriminated union (sft|preference|rl|trajectory),
│  │                  Message/ToolCall/Rollout/Candidate, Manifest, COLUMNS;
│  │                  single source for runtime validation + OpenAPI + TS types
│  ├─ hashing/        blake3 (hash-wasm), canonical JSON (sorted keys, compact),
│  │                  hashUnordered (sort row digests, join \n, hash)
│  ├─ engine/         nodejs-polars adapter: dedup, filter_by_signal, sample_n,
│  │                  recipe mix, arrow(), parquet IO; DuckDB adapter alongside
│  ├─ store/          content-addressed write-once Parquet store + manifests
│  │                  on OBJECT STORAGE (S3/R2; MinIO local), behind a Store
│  │                  interface; objects/<version[:2]>/ keying (PUT is atomic)
│  ├─ catalog/        POSTGRES + Prisma; datasets/runs/refs tables;
│  │                  lineage DAG via WITH RECURSIVE (TypedSQL/$queryRaw)
│  ├─ io/             JSONL ingest + per-line kind auto-detection + export
│  ├─ ops/            transform registry (decorator/object), enrichments
│  └─ workspace/      ties store+catalog; run / materialize / lineage / export
├─ tooling/
│  └─ openapi-export/ boots apps/api, dumps deterministic openapi.json
│                     (sorted keys, fixed indent) — replaces the Python
│                     scripts/export_openapi.py
├─ workers/
│  └─ python-*/       OPTIONAL Python boundary (see "Python boundary"),
│                     never imported by core TS
└─ docs/              this folder
```

The frontend (`apps/web`) is a **greenfield rewrite** (stack TBD — see open
decisions), **not** a port of `databench-ui`. It still consumes the backend
purely through the generated client: `gen:client` runs `openapi-typescript`
against `apps/api`'s `openapi.json` (contract-first, unchanged). The original
`databench-ui` (at `~/Desktop/databench/databench-ui/`) is the **feature
reference** for the rewrite.

## The engine bet

**`nodejs-polars` is the primary dataframe engine.** Rationale:

- Every operation the current backend performs maps 1:1 to the Node binding —
  verified against the `nodejs-polars@0.25.1` typings: `str.jsonPathMatch`,
  `cast(strict)`, `filter`, `sample({n, seed})`, `unique({subset, keep,
  maintainOrder})`, `select`, `concat`, `height`, parquet read/write,
  `toArrow`, lazy `collect`, `groupBy`.
- It owns **Parquet and Arrow in one dependency**, preserving the
  `Polars + Arrow boundary` design.
- Same Rust core as the Python original → matching numeric/semantic behavior.
- The engine's actual job is small: the current backend is **eager** Polars
  doing `construct → (dedup | json-extract+cast+filter | sample | select+concat)
  → iterate/arrow/parquet`. No lazy query plan, window, or join anywhere.

**`@duckdb/node-api` (DuckDB Neo) stays resident** for three non-speculative
jobs — not a fallback we hope never to use:

1. **Out-of-core `materialize`** of large recipes — the all-TS answer to the
   roadmap's "single-node Polars → Ray Data" scaling line.
2. **`@duckdb/duckdb-wasm`** lets `apps/web` query Parquet slices **in-browser**
   for M3 exploration.
3. A **drop-in replacement for every engine op** (all of them are trivially SQL:
   `DISTINCT ON`, `json_extract`, `CAST`, `WHERE`, `USING SAMPLE n
   REPEATABLE(seed)`, `UNION ALL`), which de-risks the one shaky dependency.

## Per-capability stack (all TS-native)

| Capability | Package |
|---|---|
| Schema / discriminated unions / OpenAPI source | `zod` v4 + `@hono/zod-openapi` |
| blake3 + order-independent versioning | `hash-wasm` (or `@hashbuf/blake3`) |
| Content-addressed write-once store | object storage (S3/R2; MinIO local) behind a `Store` interface |
| Parquet read/write | `nodejs-polars` (or DuckDB `COPY`/`read_parquet`) |
| Arrow interchange | `apache-arrow` + polars IPC |
| Catalog + lineage | **Postgres** + **Prisma**, lineage via `WITH RECURSIVE` (TypedSQL/`$queryRaw`) |
| JSONL ingest + kind detection | pure TS |
| HTTP service + UI-compatible OpenAPI | `hono` + `@hono/zod-openapi` (ADR-0002) |
| M3 Lance backend | `@lancedb/lancedb` |

## Python boundary

**There is none for the product as specified (M1 + M2).** No in-process FFI, no
subprocess, no sidecar in the core build.

Python enters **only** if the owner later mandates reusing a specific Python
*framework* — **distilabel** (synthetic) or **Ray Data** (distributed cluster
execution) — rather than the *capability* those provide. The capabilities are
already TS-native: synthetic generation = provider SDKs / Vercel AI SDK over the
existing `Dataset`/`Workspace` contract; larger-than-memory processing = DuckDB
out-of-core. If that day comes, the framework runs as an **optional
`workers/python-*` sidecar behind the same `/v1` REST contract** — TS owns
versions, manifests, store paths, refs, cache keys, and lineage; Python returns
only a produced Parquet/JSONL path + status; the UI never talks to Python
directly. Never an in-process dependency, never in the core path.

## Biggest risk + first action

**Risk: `nodejs-polars` maturity vs Python Polars** — same Rust core but a
thinner, less-exercised binding (release cadence lag, sparser docs, NAPI
prebuilt edge cases, and the weaker Arrow handoff vs Python's `polars →
pyarrow.Table`). It is *capability-complete* for everything databench does, but
it is the dependency most likely to surface a sharp edge.

The risk is **bounded, not existential**: DuckDB covers every op one-for-one, so
a worst case is an engine *swap*, not a redesign.

**First action — spike the engine before anything else**, with golden tests
locking the four things that actually decide "all-TS works":

1. **Parquet round-trip** of the all-`Utf8` canonical layout (write in TS, read
   back, and cross-read against a Python-written file).
2. **Seeded sampling determinism** (`sample(seed)` reproducibility — recipes
   depend on it).
3. **JSONPath signal filtering** (`str.jsonPathMatch` + non-strict float cast).
4. **Version-hash stability** (`hashUnordered` byte-identical to the spec).
