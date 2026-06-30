# Feasibility brief: `databench` as an all-TypeScript monorepo

Grounded in the actual code under `databench/databench/` (read, not skimmed). The
only question answered: **can TS/Node implement each core capability?** Porting
cost and Python ecosystem maturity are out of scope by instruction.

---

## 1. What the engine actually does (concrete operation inventory)

The "Polars lazy engine" is, in practice, a thin columnar container plus a
handful of operations. Every dataframe touch in the codebase:

**Polars expressions / DataFrame methods actually used**

| Operation | Call site | Where |
|---|---|---|
| Construct all-`Utf8` frame from dict | `pl.DataFrame({...}, schema={c: pl.Utf8})` | `dataset.py:_build` |
| Empty frame w/ explicit schema | `pl.DataFrame(schema={c: pl.Utf8})` | `recipe.py:mix` |
| Dedup, keep-first, stable | `frame.unique(subset=["id"], keep="first", maintain_order=True)` | `ops.py:dedup` |
| JSON path extraction | `pl.col("signals").str.json_path_match("$." + key)` | `ops.py:filter_by_signal` |
| String→float cast, non-strict | `.cast(pl.Float64, strict=False)` | `ops.py:filter_by_signal` |
| Predicate building | `pl.lit(True)` + `&` + `>=` + `<=` | `ops.py:filter_by_signal` |
| Row filter | `frame.filter(cond)` | `ops.py:filter_by_signal` |
| Seeded random subsample | `frame.sample(n=n, seed=seed)` | `ops.py:sample_n`, `recipe.py:mix` |
| Row count | `frame.height` | `ops.py`, `recipe.py` |
| Column projection | `frame.select(COLUMNS)` | `recipe.py:mix` |
| Vertical concat | `pl.concat(parts)` | `recipe.py:mix` |
| Defensive copy | `frame.clone()` | `dataset.py:polars` |
| Row iteration → dicts | `frame.iter_rows(named=True)` | `dataset.py:to_samples`, `from_frame` |
| Arrow export | `frame.to_arrow()` → `pa.Table` | `dataset.py:arrow` |
| Column-name list | `frame.columns` | `dataset.py:from_frame` |
| Parquet write | `frame.write_parquet(path)` | `store.py:write` |
| Parquet read | `pl.read_parquet(path)` | `store.py:read` |

**PyArrow** is used for *exactly one thing*: `Dataset.arrow()` returns a
`pa.Table`. It is the declared interchange boundary, nothing more — no PyArrow
compute, no Arrow-native filtering.

**Hashing (`hashing.py`)** — blake3 hexdigest of bytes (blake2b fallback);
`canonical_json` = `json.dumps(sort_keys=True, separators=(",",":"),
ensure_ascii=False, default=str)`; `hash_text`/`hash_obj`; and the order-
independent dataset version `hash_unordered` = *sort the row-digest hexes, join
with `\n`, hash*.

**Store (`store.py`)** — content-addressed Parquet + sibling
`manifest.json`, sharded by `version[:2]`, written to `*.tmp` then
`os.replace`'d (atomic), idempotent `exists()` short-circuit.

**Catalog (`catalog.py`)** — stdlib `sqlite3`, `PRAGMA journal_mode=WAL`,
`busy_timeout=5000`, one short-lived connection per op, 3 tables
(`datasets`, `runs` = lineage+cache, `refs`), `INSERT OR IGNORE` / `INSERT OR
REPLACE` / `ON CONFLICT DO UPDATE`, index on `runs.output_version`. Lineage is a
recursive Python walk over `runs_producing`.

**Schema (`schema.py`)** — Pydantic discriminated union on `kind` over
`sft`/`preference`/`rl`/`trajectory`, nested `Message`/`ToolCall`/`Rollout`/
`Candidate`, identity = `hash_obj(model_dump(exclude={source,meta,signals}))`,
`model_json_schema()` exported for transform params.

**Service (`service/`)** — FastAPI `app.openapi()` (the contract), CORS incl.
`allow_private_network`, multipart upload (`UploadFile`), streaming NDJSON
(`StreamingResponse`), pagination caps, unified error envelope, `response_model`
straight off the Pydantic types.

**IO (`io.py`)** — streaming JSONL parse; per-line `detect_kind`
(`chosen`+`rejected`→preference, `rollouts`→rl, `messages`→trajectory if any
tool_calls/`role==tool`/tool_call_id else sft); shorthand normalization
(bare string → `{role, content}`).

**Net:** the columnar engine is doing trivial work. This is the single most
important fact for the verdict — there is no exotic Polars query plan, window
function, or lazy multi-stage optimization anywhere. It's construct → (dedup |
json-extract+cast+filter | sample | select+concat) → iterate/arrow/parquet.

---

## 2. Per-capability feasibility table

Status verified against package state in 2026 (sources at bottom).

| # | Capability | Package(s) to use | Real status (2026) | Verdict |
|---|---|---|---|---|
| 1 | Columnar/lazy dataframe engine | **`nodejs-polars`** (primary); `@duckdb/node-api`; `@duckdb/duckdb-wasm` | `nodejs-polars` is the official pola-rs NAPI binding over the *same Rust core* as Python Polars — eager+lazy, `readParquet`/`writeParquet`/`toArrow` built in. DuckDB Neo (`@duckdb/node-api`) is at 1.5.x, the old `duckdb` package is formally deprecated in its favor. | **TS-NATIVE** |
| 2 | The specific expressions found in `ops.py`/`recipe.py` | `nodejs-polars` | All map 1:1: `str.jsonPathMatch('$.k')` (confirmed present in `StringNamespace`), `.cast(pl.Float64)`, `.filter`, `.unique({subset,keep,maintainOrder})`, `.sample({n,seed})`, `.select`, `pl.concat`, `.height`, `.toArrow`. In DuckDB the same set is one-line SQL (`DISTINCT ON`, `json_extract`, `CAST`, `WHERE`, `USING SAMPLE n REPEATABLE(seed)`, `UNION ALL`). | **TS-NATIVE** |
| 3 | Arrow interchange (zero-copy) | **`apache-arrow`** (JS) + `nodejs-polars.toArrow()` | `apache-arrow` JS is the official, mature Arrow implementation (zero-copy IPC, columnar). `nodejs-polars` emits Arrow IPC directly. *Caveat:* the DuckDB Neo client's **dedicated** Arrow API is still listed incomplete — so do Arrow via polars/apache-arrow, not via DuckDB's Arrow API. | **TS-NATIVE** |
| 4 | Parquet read/write | **`nodejs-polars`** native; or DuckDB `COPY … (FORMAT parquet)` / `read_parquet`; `parquet-wasm` | `nodejs-polars` and DuckDB both read/write Parquet natively and robustly. Avoid the original `parquetjs` (unmaintained); `@dsnp/parquetjs` exists but is unnecessary. Note: `apache-arrow` JS itself ships **no** Parquet codec — that's why the engine, not arrow-js, owns Parquet. | **TS-NATIVE** |
| 5 | blake3 + order-independent versioning | **`hash-wasm`** (portable WASM, blake3) or **`blake3`** npm (native+WASM) or `@noble/hashes`; `safe-stable-stringify` for canonical JSON | blake3 has multiple maintained JS impls; `hash-wasm` is the portable/no-build choice, the `blake3` native binding the throughput choice. `hash_unordered` (sort hexes, join, hash) and canonical JSON (sorted keys, compact separators) are trivial pure-TS — `safe-stable-stringify` gives deterministic key order; the `default=str` coercion is a one-line replacer. | **TS-NATIVE** |
| 6 | Content-addressed write-once store + manifests | node `fs` (`writeFile` to tmp + `fs.rename`) | `fs.rename` is atomic within a filesystem — exact analog of `os.replace`. Sharded dirs, idempotent `exists`, sidecar JSON manifest: pure stdlib. | **TS-NATIVE** |
| 7 | SQLite catalog + lineage DAG | **`better-sqlite3`** (+ `kysely` for typed queries); or builtin `node:sqlite` | `better-sqlite3` is the standard, synchronous, actively maintained; WAL + `busy_timeout` are first-class (`db.pragma(...)`), and it defaults WAL to `synchronous=NORMAL`. The 3-table schema and recursive lineage walk port directly (or use a SQLite recursive CTE). | **TS-NATIVE** |
| 8 | Schema/validation + discriminated unions + OpenAPI codegen | **`zod`** v4 (`z.discriminatedUnion('kind', …)`) or **`@sinclair/typebox`** (JSON-Schema-native); `zod-openapi`/`@hono/zod-openapi` | Discriminated unions are first-class. zod-openapi emits `oneOf` **with a `discriminator`** (members must be registered as named components) — i.e. byte-compatible with what FastAPI/Pydantic emits and what the UI's `openapi-typescript` already consumes. TypeBox produces JSON Schema directly, ideal for Fastify. | **TS-NATIVE** |
| 9 | HTTP service emitting UI-compatible OpenAPI | **`hono` + `@hono/zod-openapi`**, or **`fastify` + `@fastify/swagger`** (+ TypeBox) | Both generate OpenAPI 3.x that `openapi-typescript` 7.x ingests unchanged. NDJSON streaming, multipart upload, CORS all supported. The one manual bit: `Access-Control-Allow-Private-Network: true` on the preflight is a one-line header (Starlette auto-handles it today; here you set it). | **TS-NATIVE** |
| 10 | JSONL ingest + per-line kind auto-detection | pure TS (`readline`/byte-split + `JSON.parse`) | `detect_kind` and the shorthand normalizers are plain conditionals — no library needed. | **TS-NATIVE** |
| 11a | M2 synthesis (roadmap "distilabel") | Vercel AI SDK / `@anthropic-ai/sdk` / `openai` + your own pipeline | distilabel-the-library is Python, but it is only LLM-API orchestration. The *capability* (generate synthetic samples) is direct provider calls — squarely TS. Reusing distilabel itself is unnecessary, not required. | **TS-NATIVE** |
| 11b | M2 annotation (roadmap "Argilla") | external Argilla server via REST/SDK, **or** build natively on existing `signals`/`meta` | Argilla is a standalone server product (its own FastAPI+search deployment) **regardless of your stack** — you integrate over HTTP, you don't embed it. "Feedback as a data state" is already expressible with the non-destructive `signals` dict. No in-process Python. | **TS-WITH-CAVEATS** (external service, not embedded Python) |
| 11c | M3 Lance backend | **`@lancedb/lancedb`** | Official Node SDK, a thin NAPI wrapper over the Rust core (replaces deprecated `vectordb`). Full table/vector API in TS. | **TS-NATIVE** |
| 11d | M3 Ray Data (distributed scaling) | DuckDB out-of-core (covers the real need); Ray only if true cluster execution required | **No JS client for Ray** exists. This is the *only* genuinely Python-locked technology in the whole brief. But it is an *optional scaling backend* swapped in for single-node Polars, and the actual need it serves — larger-than-memory processing — is met by DuckDB's out-of-core engine **without Python**. Real distributed-cluster execution is the sole thing that would pull Python in. | **MUST-STAY-PYTHON** *only if* Ray-specific distribution is mandated; otherwise N/A |

---

## 3. Recommended TS-monorepo architecture

**Tooling:** pnpm workspaces + Turborepo, TypeScript project references, `tsup`
for builds.

```
databench/                      (monorepo root)
├─ packages/
│  ├─ core/        @databench/core     schema (zod v4 discriminated union),
│  │                                   hashing (hash-wasm), canonical-json,
│  │                                   Dataset/Manifest, COLUMNS layout
│  ├─ engine/      @databench/engine   nodejs-polars wrapper: dedup, filter_by_signal,
│  │                                   sample_n, recipe `mix`, arrow(), parquet IO
│  ├─ store/       @databench/store    CAS blob store (fs + atomic rename), manifests
│  ├─ catalog/     @databench/catalog  better-sqlite3 + kysely; datasets/runs/refs;
│  │                                   lineage walk (recursive CTE)
│  ├─ io/          @databench/io       JSONL ingest, detect_kind, export records
│  ├─ ops/         @databench/ops      transform registry (decorator → object)
│  └─ workspace/   @databench/workspace ties store+catalog; run/materialize/lineage/export
├─ apps/
│  ├─ service/     Hono + @hono/zod-openapi → /v1 REST; emits openapi.json
│  └─ cli/         thin CLI over @databench/workspace (optional)
├─ tooling/
│  └─ openapi-export/   boots the app, dumps deterministic openapi.json
│                       (sorted keys, fixed indent) — replaces scripts/export_openapi.py
└─ databench-ui/   UNCHANGED. `gen:client` runs openapi-typescript against
                   apps/service's openapi.json exactly as today.
```

**The engine bet:** **`nodejs-polars` as the primary dataframe spine.** Reasons:
(1) every expression in §1 is a mechanical 1:1 (`jsonPathMatch`, `cast`,
`filter`, `unique`, `sample`, `select`, `concat`), (2) it owns Parquet *and*
Arrow in one dependency, preserving the exact `Polars(lazy)+Arrow boundary`
design, (3) same Rust core as the Python original, so numeric/semantic behavior
matches.

**Keep DuckDB (`@duckdb/node-api`) resident in the tree anyway**, for three
jobs that aren't speculative: (a) out-of-core `materialize` of large recipes —
this is the all-TS answer to the "→ Ray Data" scaling line; (b)
`@duckdb/duckdb-wasm` lets the **UI** query Parquet slices in-browser for M3
exploration; (c) it is a complete drop-in fallback for every engine op (see
§2 row 2), which de-risks the one shaky dependency. If you wanted the
lowest-risk *single* engine, DuckDB would win outright — the operations are all
trivially SQL — and `nodejs-polars` is the only reason this is a judgment call
rather than a slam dunk.

**Where Python sits:** **nowhere, for the product as specified** (M1 + M2). There
is no in-process binding, no subprocess, no sidecar in the recommended build.
The *contingent* Python boundary is exactly one technology — Ray Data — and only
if someone later mandates true distributed-cluster execution that DuckDB's
out-of-core mode can't cover. If that day comes, the correct shape is a
**`databench-compute` sidecar service behind the same `/v1` REST contract** (it
already speaks transforms/materialize and records runs in the shared catalog) —
never an in-process FFI dependency. That keeps the boundary swappable and the
core 100% TS.

---

## 4. The single biggest technical risk

**`nodejs-polars` maturity relative to Python Polars.** It is the same Rust core
but a thinner, less-exercised binding: it lags the Python release cadence,
ships sparser docs, and has fewer eyeballs on edge cases (e.g. `maintainOrder`
semantics on `unique`, JSON/struct handling, and — most relevant here — Parquet
schema round-tripping for the all-`Utf8` canonical layout the store depends on,
plus prebuilt NAPI binaries across arch/libc). It is *capability-complete* for
everything databench does today, but it is the dependency most likely to surface
a sharp edge under load or on an unusual platform.

This risk is **bounded, not existential**, precisely because the engine's job is
so small and entirely SQL-expressible: DuckDB covers every operation
one-for-one, so a worst-case `nodejs-polars` failure is a swap, not a redesign,
and does not threaten the all-TS verdict. (Reproducible recipe mixing needs
deterministic seeded sampling either way — both `nodejs-polars` `.sample(seed)`
and DuckDB `REPEATABLE(seed)` provide it.) The risk is "you may have to switch
engines mid-build," not "TS can't do this."

---

## 5. Final verdict

Every M1 capability (schema, hashing, content-addressed versioning, CAS store,
SQLite catalog + lineage, transforms, recipes, JSONL ingest, Arrow/Parquet, the
OpenAPI-emitting service) is **TS-NATIVE**. M2 (synthesis, annotation) is
TS-native or an external service — no embedded Python. M3 Lance is TS-native.
The only Python-locked technology in the entire brief is **Ray Data**, an
optional future scaling backend whose actual need (larger-than-memory
processing) is already met by DuckDB in-process; if hard distributed execution
is ever required it lives as a sidecar behind the existing REST contract, not as
a core dependency. Minimal required Python surface for the product as specified:
**zero.**

### **`FEASIBLE-ALL-TS`** — bet the engine on `nodejs-polars`, keep DuckDB resident as the out-of-core path and fallback; the only thing that could ever force Python is adopting Ray Data specifically, and that is an optional sidecar, not a core capability.

---

*Sources:* [nodejs-polars StringNamespace](https://pola-rs.github.io/nodejs-polars/interfaces/StringNamespace.html) · [DuckDB Node Neo `@duckdb/node-api`](https://www.npmjs.com/package/@duckdb/node-api) · [DuckDB Node Neo overview/Arrow roadmap](https://duckdb.org/docs/current/clients/node_neo/overview) · [`hash-wasm`](https://www.npmjs.com/package/hash-wasm) · [`blake3` npm (connor4312)](https://github.com/connor4312/blake3) · [`better-sqlite3` WAL docs](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/performance.md) · [`@lancedb/lancedb`](https://www.npmjs.com/package/@lancedb/lancedb) · [`@hono/zod-openapi`](https://www.npmjs.com/package/@hono/zod-openapi) · [zod-openapi discriminated unions](https://deepwiki.com/samchungy/zod-openapi/6.2-unions-and-discriminated-unions)*

---

## Round 2 reconciliation (cross-review with Codex)

We agree on essentially the entire technical substance — M1 fully TS-native,
`nodejs-polars` primary + DuckDB resident, biggest risk = `nodejs-polars`
maturity/Arrow boundary. The only divergence was the headline, and Codex has
since moved to `FEASIBLE-ALL-TS` in its own Round 2 section. I hold ALL-TS, and
here's the precise resolution of the two driving points.

**(a) distilabel — framework reuse vs. capability.** The brief mandates the
*outcome*, not the framework. Its governing question (brief §"The ONLY
question") is *"can TS/Node implement each core capability?"* with the bar for
must-stay-Python set explicitly at *"technical impossibility or a hard
capability gap, not preference."* The roadmap line reads *"distilabel-backed
synthetic transforms"* — "distilabel-backed" names one **approach**, the same
way *"Argilla-style"* names a pattern, not a contract; §"Roadmap M2/M3" then asks
whether these *"force a Python component regardless?"* The synthesis capability
is synthetic-sample generation, which in TS is direct provider SDKs (Vercel AI
SDK / `@anthropic-ai/sdk` / `openai`) over the existing `Dataset`/`Workspace`
contract. So distilabel-the-framework is **one way** to get the capability, not a
stated requirement — no hard gap. **Codex's Round-2 concession here is correct
and I adopt its framing.**

**Where Codex stays right (and I affirm it):** *if* the owner ever specifies
"run distilabel exactly" or "run Ray Data exactly" — the framework itself, not
the capability — then Python is required *at that one integration boundary*.
That's a true statement about framework reuse; it is simply not the question the
brief poses, and it describes preference/convenience, not incapability.

**(b) Does an optional, never-in-core-path Python sidecar downgrade the
headline? No.** The brief's bar is a hard capability gap *in the core contract*.
A sidecar that (i) is optional, (ii) never sits in the dataset/store/catalog/
service path, and (iii) exists only to reuse a specific Python framework whose
*capability* TS already covers (synthesis via provider SDKs; out-of-core via
DuckDB) is by definition preference, not impossibility — exactly the case the
brief says does **not** qualify for must-stay-Python. Downgrading the headline
for it would let an optional convenience override a capability verdict, which
inverts the brief's own rule. The required Python surface for the product *as
specified* is zero; Ray-cluster execution is the lone contingent exception, and
only if hard distributed execution is later mandated beyond what DuckDB
out-of-core covers — at which point it's a sidecar behind the same `/v1`
contract, not a core dependency.

**Converged verdict: `FEASIBLE-ALL-TS`** — minimal Python surface for the
product as specified is **zero**; the only thing that could ever introduce
Python is a later hard requirement to reuse Ray Data (or distilabel)
*the framework specifically*, which is an optional sidecar behind the existing
REST contract, never in the core path.
