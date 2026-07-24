# databench — Target Architecture (all-TypeScript monorepo)

> Status: target design for the greenfield rebuild. Decided 2026-06-29; Python
> processing boundary amended by ADR-0010 on 2026-07-23.
> Feasibility verdict: **`FEASIBLE-ALL-TS`** (see [decisions/0001](decisions/0001-rebuild-as-ts-monorepo.md)).
> Core/domain/public API Python surface: **zero**. The owner has separately
> authorized one optional long-running Python Processing Service behind internal
> gRPC for Data-Juicer and future explicitly allowlisted Python-native adapters.

## What databench is

Infrastructure for managing **LLM post-training data**: versioned datasets,
automatic lineage, reproducible training mixtures. A thin **control plane**
(catalog, Postgres) over a content-addressed **data plane** (immutable Parquet
blobs on object storage), with a pure-function **transform/enrichment** engine
and a hashable **recipe** (mixture) as the bridge to training.

**Deployment:** a hosted, horizontally-scaled service — N stateless Hono API
replicas over exactly **two stateful services**: **Postgres** (catalog) and
**object storage** (Parquet data plane). Production uses RDS + Aliyun OSS; local
development and ADR 0012's isolated offline single-host deployment use Postgres + MinIO via the
S3-compatible adapter. `nodejs-polars`,
DuckDB, Arrow and Lance are in-process libraries, not infrastructure — DuckDB
reads Parquet directly from object storage via `httpfs`. Local runs the same
shape via docker-compose (`postgres` + `minio`). No SQLite. See
[decisions/0003](decisions/0003-storage-postgres-object-store.md).

ADR-0010 adds one stateless Processing worker and one API-process dispatcher for
local/trusted-private execution. It does not add another stateful service:
Postgres remains the job control plane and object storage remains the bulk data
plane. The worker is not part of canonical publication and is disabled unless
explicitly configured.

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
├─ proto/              internal databench.processing.v1 transport source
├─ packages/
│  ├─ schema/         zod discriminated union (sft|preference|rl|trajectory),
│  │                  Message/ToolCall/Rollout/Candidate, Manifest, COLUMNS;
│  │                  single source for runtime validation + OpenAPI + TS types
│  ├─ hashing/        blake3 (hash-wasm); v1 canonical JSON + hashUnordered;
│  │                  v2 RFC 8785 JCS + profile-separated identity (ADR-0011)
│  ├─ engine/         nodejs-polars adapter: dedup, filter_by_signal, sample_n,
│  │                  recipe mix, arrow(), parquet IO; DuckDB adapter alongside
│  ├─ store/          content-addressed write-once Parquet store + manifests
│  │                  on OBJECT STORAGE (S3/R2; MinIO local), behind a Store
│  │                  interface; v1 objects/<version[:2]>/; v2 artifact-digest
│  │                  blobs + conditional manifest commit (ADR-0011)
│  ├─ catalog/        POSTGRES + Prisma; datasets/runs/refs tables;
│  │                  lineage DAG via WITH RECURSIVE (TypedSQL/$queryRaw)
│  ├─ io/             JSONL ingest + per-line kind auto-detection + export
│  ├─ ops/            transform registry (decorator/object), enrichments
│  └─ workspace/      ties store+catalog; run / materialize / lineage / export
├─ tooling/
│  ├─ openapi-export/ boots apps/api, dumps deterministic openapi.json
│                     (sorted keys, fixed indent) — replaces the Python
│                     scripts/export_openapi.py
│  └─ proto/          deterministic TS/Python generation + Buf checks
├─ workers/
│  └─ processing-python/ optional long-running internal gRPC worker,
│                        never imported by core TS
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
| Content-addressed write-once store | object storage (Aliyun OSS hosted production; MinIO local and ADR 0012 offline production via S3 adapter) behind a `Store` interface |
| Parquet read/write | `nodejs-polars` (or DuckDB `COPY`/`read_parquet`) |
| Arrow interchange | `apache-arrow` + polars IPC |
| Catalog + lineage | **Postgres** + **Prisma**, lineage via `WITH RECURSIVE` (TypedSQL/`$queryRaw`) |
| JSONL ingest + kind detection | pure TS |
| HTTP service + UI-compatible OpenAPI | `hono` + `@hono/zod-openapi` (ADR-0002) |
| M3 Lance backend | `@lancedb/lancedb` |
| Optional Python-native processing | internal gRPC + native Python 3.11/`uv`; Postgres jobs + signed OSS/MinIO artifacts (ADR-0010) |

## Python boundary

The core/domain/public API remains all TypeScript: no in-process FFI, no Python
subprocess inside Node, and no Python import in a TS package. ADR-0010 now
authorizes one optional `workers/processing-python` service because the owner
explicitly selected reuse of Data-Juicer as a Python-native framework.

The boundary is strict: `@databench/workspace` is the only internal gRPC client;
Zod remains the domain/public contract source; Proto is internal transport only;
Python has no Postgres or long-lived object-store credentials and receives only
bounded control messages plus short-lived signed artifact targets. TS alone owns
versions, manifests, refs, cache keys, runs, and lineage. V1 produces sealed
staging artifacts and has no canonical finalizer. The UI never talks to Python
directly, and the worker is never an in-process dependency or a core data path.

Additional Python frameworks such as distilabel or Ray remain deferred. They
may be added only as explicitly registered adapters behind this same boundary,
with a separate review of dependencies, resources, and security; ADR-0010 does
not authorize arbitrary modules, YAML, shell execution, runtime installation,
LLM processors, or distributed runtimes.

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
