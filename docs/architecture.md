# databench — Architecture (all-TypeScript monorepo)

> Status: current architecture after the TypeScript rewrite reached parity.
> Initial architecture decided 2026-06-29; update this file when app/package
> boundaries or locked platform choices change.
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
**object storage** (Parquet data plane) — **Aliyun OSS** via the native
`ali-oss` SDK. `nodejs-polars` and Arrow are current in-process libraries, not
infrastructure. DuckDB and Lance are optional future libraries, not active
dependencies. If DuckDB is added later, it must be introduced by an explicit
design/ADR update and can read Parquet from OSS independently of how the app
writes objects. Locally only `postgres` runs in docker-compose — OSS has no local
emulator, so tests use an in-memory store. No SQLite. See
[decisions/0003](decisions/0003-storage-postgres-object-store.md) and
[decisions/0008](decisions/0008-object-store-aliyun-oss.md).

## Monorepo layout

**`~/Desktop/databench-ts/` is the monorepo root**.
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
│  ├─ web/            React 19 + Vite SPA; consumes /v1 via generated
│  │                  openapi-typescript/openapi-fetch client. See ADR-0006.
│  └─ cli/            agent-facing Thick CLI over Workspace. See ADR-0007.
├─ packages/
│  ├─ schema/         zod discriminated union (sft|preference|rl|trajectory),
│  │                  Message/ToolCall/Rollout/Candidate, Manifest, COLUMNS,
│  │                  Vocabulary, service contracts, error classes;
│  │                  single source for runtime validation + OpenAPI + TS types
│  ├─ hashing/        blake3 (hash-wasm), canonical JSON (sorted keys, compact),
│  │                  hashUnordered (sort row digests, join \n, hash)
│  ├─ engine/         nodejs-polars adapter: dedup, filter_by_signal, sample_n,
│  │                  recipe mix, arrow(), parquet IO
│  ├─ store/          content-addressed write-once Parquet store + manifests
│  │                  on OBJECT STORAGE (Aliyun OSS; in-memory in tests), behind a Store
│  │                  interface; objects/<version[:2]>/ keying (PUT is atomic)
│  ├─ catalog/        POSTGRES + Prisma; datasets/runs/refs tables;
│  │                  lineage DAG via WITH RECURSIVE (TypedSQL/$queryRaw)
│  ├─ io/             JSONL ingest + per-line kind auto-detection + export
│  ├─ ops/            transform registry (decorator/object), enrichments
│  └─ workspace/      ties store+catalog; ingest / run / materialize / lineage /
│                     export / vocabulary orchestration
├─ tooling/
│  └─ openapi-export/ boots apps/api, dumps deterministic openapi.json
│                     (sorted keys, fixed indent) — replaces the Python
│                     scripts/export_openapi.py
├─ workers/
│  └─ python-*/       OPTIONAL Python boundary (see "Python boundary"),
│                     never imported by core TS
└─ docs/              this folder
```

`apps/web` consumes the backend purely through the generated client:
`gen:client` runs `openapi-typescript` against `apps/api`'s `openapi.json`.
It must not import backend packages. The original `databench-ui` (at
`~/Desktop/databench/databench-ui/`) remains a read-only feature reference.

`apps/cli` is a second app adapter beside `apps/api`, not a second backend. It
uses `Workspace.open()` directly and depends only on `@databench/workspace` and
`@databench/schema`, so API and CLI behavior stay aligned at the core boundary.

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

DuckDB is **not currently installed or wired**. ADR-0001 originally kept it as a
resident out-of-core / SQL / browser-exploration option, but ADR-0008 re-checked
the implementation and confirmed the active engine is `nodejs-polars` only. Treat
DuckDB as a future fallback that needs a fresh design update before use, not as a
current package boundary or dependency requirement.

## Per-capability stack (all TS-native)

| Capability | Package |
|---|---|
| Schema / discriminated unions / OpenAPI source | `zod` v4 + `@hono/zod-openapi` |
| blake3 + order-independent versioning | `hash-wasm` (or `@hashbuf/blake3`) |
| Content-addressed write-once store | object storage (Aliyun OSS; in-memory in tests) behind a `Store` interface |
| Parquet read/write | `nodejs-polars` |
| Arrow interchange | `apache-arrow` + polars IPC |
| Catalog + lineage | **Postgres** + **Prisma**, lineage via `WITH RECURSIVE` (TypedSQL/`$queryRaw`) |
| JSONL ingest + kind detection | pure TS |
| HTTP service + UI-compatible OpenAPI | `hono` + `@hono/zod-openapi` (ADR-0002) |
| Agent-facing CLI | Thick `Workspace` adapter with Node `parseArgs` (ADR-0007) |
| M3 Lance backend | future `@lancedb/lancedb` integration |

## Python boundary

**There is none for the product as specified (M1 + M2).** No in-process FFI, no
subprocess, no sidecar in the core build.

Python enters **only** if the owner later mandates reusing a specific Python
*framework* — **distilabel** (synthetic) or **Ray Data** (distributed cluster
execution) — rather than the *capability* those provide. The capabilities are
already TS-native: synthetic generation = provider SDKs / Vercel AI SDK over the
existing `Dataset`/`Workspace` contract; larger-than-memory processing should be
handled by a documented future engine/job path rather than Python by default. If
that day comes, the framework runs as an **optional
`workers/python-*` sidecar behind the same `/v1` REST contract** — TS owns
versions, manifests, store paths, refs, cache keys, and lineage; Python returns
only a produced Parquet/JSONL path + status; the UI never talks to Python
directly. Never an in-process dependency, never in the core path.

## Biggest risk + locked mitigation

**Risk: `nodejs-polars` maturity vs Python Polars** — same Rust core but a
thinner, less-exercised binding (release cadence lag, sparser docs, NAPI
prebuilt edge cases, and the weaker Arrow handoff vs Python's `polars →
pyarrow.Table`). It is *capability-complete* for everything databench does, but
it is the dependency most likely to surface a sharp edge.

The risk is **bounded, not existential**: every current op is small and covered by
focused golden/parity tests, so a worst case should be a targeted implementation
fix or a documented engine fallback, not a redesign.

The risk was front-loaded in S1 and remains guarded by golden tests. The locked
regression constraints are:

1. **Parquet round-trip** of the all-`Utf8` canonical layout (write in TS, read
   back, and cross-read against a Python-written file).
2. **Seeded sampling determinism** (`sample(seed)` reproducibility — recipes
   depend on it).
3. **JSONPath signal filtering** (`str.jsonPathMatch` + non-strict float cast).
4. **Version-hash stability** (`hashUnordered` byte-identical to the spec).
