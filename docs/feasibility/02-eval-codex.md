# databench TypeScript Feasibility Report

Date: 2026-06-29

Verdict: `FEASIBLE-WITH-PYTHON-BOUNDARY`

The current databench core can be rebuilt in TypeScript. The only capabilities that genuinely force Python are optional M2/M3 execution integrations that are Python frameworks themselves: distilabel pipelines and Ray Data jobs. Keep that boundary outside the core dataset/store/catalog/service contract.

## Code Inventory

Files inspected: `databench/databench/ops.py`, `recipe.py`, `dataset.py`, `hashing.py`, `schema.py`, `store.py`, `catalog.py`, `io.py`, `workspace.py`, `transform.py`, and `service/`.

The actual dataframe surface is small and mostly eager, despite the README saying "Polars (lazy)":

| Area | Concrete operation in current code |
| --- | --- |
| Dataset layout | `pl.DataFrame({...}, schema={c: pl.Utf8 for c in COLUMNS})`; all physical columns are strings: `id`, `row_digest`, `kind`, `source`, `payload`, `meta`, `signals`. |
| Canonicalization | JSON dumps with sorted keys, no whitespace, UTF-8; `id = hash(payload_json)`; `row_digest = hash(payload_json + NUL + source + NUL + meta_json + NUL + signals_json)`. |
| Dataset versioning | `hash_unordered(digests)`: sort row digest hex strings, join with newline, hash. Empty dataset hashes `"empty"`. |
| Frame access | `frame.clone()`, `frame.height`, `frame.columns`, `frame.iter_rows(named=True)`, `df.to_arrow()`. |
| Dedup | `ds.polars().unique(subset=["id"], keep="first", maintain_order=True)`. |
| Signal filter | `pl.col("signals").str.json_path_match("$." + key).cast(pl.Float64, strict=False)`, `pl.lit(True)`, boolean `&`, `>=`, `<=`, `DataFrame.filter(cond)`. |
| Sample | `DataFrame.sample(n=p.n, seed=p.seed)` when `n < frame.height`. |
| Enrichment | Python object loop over typed samples; computes `char_len` and `word_len`, merges into `signals`, rebuilds dataset. No dataframe-specific requirement. |
| Recipe mixing | Per source: `f.select(COLUMNS)`, optional `sub.sample(n=count, seed=recipe.seed)`, `pl.concat(parts)`, or empty `pl.DataFrame(schema={c: pl.Utf8 for c in COLUMNS})`. Weight math is ordinary TS. |
| Parquet | `DataFrame.write_parquet(tmp_path)`, atomic `os.replace`, `pl.read_parquet(path)`. |
| Arrow | `Dataset.arrow()` returns `pyarrow.Table` from `self._frame.to_arrow()`. |
| JSONL ingest | Stream lines, `json.loads`, auto-detect kind: `chosen`+`rejected` => preference; `rollouts` => rl; `messages` with tool calls/tool role/tool_call_id => trajectory; otherwise sft. |
| Schema | Pydantic discriminated union over `kind`: `sft`, `preference`, `rl`, `trajectory`; open `meta` and `signals`; source/meta/signals excluded from sample identity. |
| Catalog | SQLite tables: `datasets`, `runs`, `refs`; WAL; `INSERT OR IGNORE`, `INSERT OR REPLACE`, `ON CONFLICT DO UPDATE`, lookup runs by `cache_key`, DAG walk via `runs.output_version`. |
| HTTP | FastAPI endpoints: `/health`, `/version`, `/capabilities`, `/v1/datasets`, `/v1/datasets:ingest-jsonl`, `/v1/datasets/{ref}`, `/v1/datasets/{ref}/samples`, `/v1/datasets/{ref}/export`, `/v1/transforms`, `/v1/transforms/{name}/run`, `/v1/recipes:materialize`, `/v1/lineage/{ref}`, `/v1/refs`, `/v1/refs/{name}`. |
| Not used | No `lazy()`, no `collect()`, no `group_by`/`groupby`, no joins, no window expressions in the actual backend code. Current `nodejs-polars` typings still expose lazy `collect`, groupBy, and the relevant expression API. |

## Feasibility Table

Package versions below were checked against npm registry metadata on 2026-06-29.

| Capability | Packages and current status | Verdict |
| --- | --- | --- |
| Columnar/lazy dataframe engine | Use `nodejs-polars@0.25.1` as the primary engine. It is the server-side Node/Bun/Deno Polars binding, latest published June 2026, Node `>=20`, native N-API binaries. Keep `@duckdb/node-api@1.5.4-r.1` as a SQL/out-of-core escape hatch; DuckDB docs list Node.js Neo as the current primary high-level package at stable 1.5.4. Treat the older `duckdb@1.4.4` package as legacy positioning, not the main bet. `@duckdb/duckdb-wasm@1.33.1-dev57.0` is useful for browser/edge experiments, not the local core. | `TS-WITH-CAVEATS` |
| Specific expressions in `ops.py` / `recipe.py` | `nodejs-polars@0.25.1` package typings include `str.jsonPathMatch`, `Expr.cast(dtype, strict)`, `DataFrame.filter`, `sample`, `unique({ subset, keep, maintainOrder })`, `select`, `concat`, `groupBy`, lazy `collect`, parquet read/write, and row/record extraction. Names are camelCase in TS, but capability exists. Current backend has no actual groupby. | `TS-NATIVE` |
| Arrow interchange | Use `apache-arrow@21.1.0` for JS Arrow `Table`, vectors, IPC, typed arrays. JS Arrow supports zero-copy vector creation from typed arrays. Caveat: Python's direct `DataFrame.to_arrow() -> pyarrow.Table` is cleaner than the TS path. With `nodejs-polars`, expose Arrow via IPC buffers (`writeIPC`/`readIPC`) and parse with `apache-arrow`; DuckDB Neo docs still list Arrow APIs as roadmap/incomplete. | `TS-WITH-CAVEATS` |
| Parquet read/write | Prefer `nodejs-polars` read/write Parquet for the content-addressed store, or DuckDB SQL `read_parquet` / `COPY ... TO ... (FORMAT parquet)` for scan/export workflows. Avoid basing the core on `parquetjs@0.11.2`; it is pure JS but stale. `parquet-wasm@0.7.1` is a viable Arrow/Parquet WASM fallback, especially browser/edge. | `TS-NATIVE` |
| BLAKE3 hashing and order-independent versioning | Use `hash-wasm@4.12.0` or `@hashbuf/blake3@1.1.0`; both support BLAKE3 from JS/WASM. The older `blake3@3.0.0` package exists but is not the best default. `canonicalJson`, `hashText`, `hashObj`, and `hashUnordered([...].sort().join("\n"))` are trivial TS. | `TS-NATIVE` |
| Content-addressed write-once store and manifests | Node `fs/promises`, `mkdir({ recursive: true })`, temp files, `rename` for atomic same-filesystem replacement, JSON manifests. Same two-level prefix path scheme (`objects/${version.slice(0,2)}`). | `TS-NATIVE` |
| SQLite catalog and lineage DAG | Use `better-sqlite3@12.11.1` for local synchronous SQLite with WAL pragmas; optional query typing via `kysely@0.29.2` or `drizzle-orm@0.45.2`. The schema and DAG traversal map directly. | `TS-NATIVE` |
| Schema/validation, discriminated unions, OpenAPI generation | Use `zod@4.4.3` for `z.discriminatedUnion("kind", [...])`, open dictionaries, inference, and runtime validation. Use `@asteasolutions/zod-to-openapi@8.5.0` or `zod-openapi@6.0.0` to emit OpenAPI. `typebox@0.34.49` is also strong if JSON Schema-first is preferred; `valibot@1.4.2` is good but less direct for OpenAPI. | `TS-NATIVE` |
| HTTP service layer and UI-compatible OpenAPI | Recommended: `hono@4.12.27` plus `@hono/zod-openapi@1.4.0`, because it keeps schemas close to handlers and can serve `/openapi.json`. `fastify@5.9.0` plus `@fastify/swagger@9.7.0` is equally viable. `@nestjs/core@11.1.27` is heavier than this service needs. Existing UI can keep `openapi-typescript@7.13.0`. | `TS-NATIVE` |
| JSONL ingestion and per-line kind auto-detection | Node streams/readline, `JSON.parse`, Zod validation, same heuristics. Multipart upload support is routine in Hono/Fastify. | `TS-NATIVE` |
| M2/M3: distilabel, Argilla, Lance, Ray Data | Lance is TS-capable through `@lancedb/lancedb@0.30.0` and official JS/TS SDK docs. Argilla has a Python SDK and Python FastAPI server, but it exposes REST, so TS can integrate over HTTP. distilabel is a Python framework. Ray/Ray Data is explicitly a Python application/data API ecosystem. Direct distilabel and Ray Data execution therefore need Python workers. | `MUST-STAY-PYTHON` for distilabel/Ray execution only |

## Recommended Monorepo Architecture

Use `pnpm` workspaces:

```text
apps/
  api/                         # Hono/Fastify Node service, /health + /v1 REST + /openapi.json
  web/                         # existing databench-ui Vite React app
packages/
  schema/                      # Zod sample union, recipe, manifest, OpenAPI components
  core/                        # Dataset, Workspace, transforms, recipes, hashing
  dataframe/                   # nodejs-polars adapter; DuckDB adapter for SQL/large scans
  store-fs/                    # content-addressed Parquet + manifest filesystem store
  catalog-sqlite/              # better-sqlite3 catalog and lineage DAG
  service-contract/            # OpenAPI generation, generated TS client fixtures
  integrations/                # Argilla REST, LanceDB JS, Python job client interfaces
workers/
  python-distilabel-ray/       # optional Python boundary, not imported by core TS
```

Dataframe bet: use `nodejs-polars` as the core dataframe engine because it matches the current Polars expression surface directly. Keep DuckDB Neo as a secondary engine for SQL-heavy transforms, out-of-core analytics, and robust Parquet scan/export paths. Do not route the core through pure JS Parquet.

The Python boundary, if enabled, should be outside the service contract:

- TS owns dataset versions, manifests, store paths, refs, cache keys, and lineage.
- TS writes input data for the job as JSONL or Parquet under the content-addressed store.
- TS invokes Python either as a local subprocess for desktop/local mode or as a sidecar/job service for Ray clusters.
- Python returns only declared outputs: produced Parquet/JSONL path, manifest summary, logs, and status.
- TS validates and registers the output dataset, then records lineage as `op = "distilabel:..."` or `op = "ray-data:..."`.
- The UI never talks to Python directly; it continues to consume the same OpenAPI REST contract.

## Biggest Technical Risk

The biggest risk to "all-TS works" is relying on `nodejs-polars` as a long-lived first-class core dependency. The exact current operations are supported, but the Node binding is still a native wrapper with platform packaging and API-parity risk, and the Arrow boundary is weaker than Python's `polars -> pyarrow.Table` handoff. This is not a blocker for the current engine, but it is the area to spike first with golden tests for Parquet compatibility, seeded sampling determinism, JSONPath filtering, and version hash stability.

## Sources

- `nodejs-polars`: [npm](https://www.npmjs.com/package/nodejs-polars), [GitHub](https://github.com/pola-rs/nodejs-polars), [package metadata](https://app.unpkg.com/nodejs-polars%400.25.1/files/package.json)
- Polars core capabilities: [Polars user guide](https://docs.pola.rs/), [Polars project page](https://pola.rs/)
- DuckDB Node and Parquet: [Node.js Client Neo](https://duckdb.org/docs/current/clients/node_neo/overview.html), [client overview](https://duckdb.org/docs/current/clients/overview.html), [Parquet docs](https://duckdb.org/docs/current/data/parquet/overview.html)
- Arrow JS: [Apache Arrow JavaScript docs](https://arrow.apache.org/docs/js/)
- Parquet alternatives: [parquet-wasm npm](https://www.npmjs.com/package/parquet-wasm), [parquet-wasm docs](https://kylebarron.dev/parquet-wasm/functions/esm_parquet_wasm.readParquet.html), [parquetjs package](https://www.jsdelivr.com/package/npm/parquetjs)
- Hashing: [hash-wasm npm](https://www.npmjs.com/package/hash-wasm), [`@hashbuf/blake3` npm](https://www.npmjs.com/package/@hashbuf/blake3)
- SQLite: [`better-sqlite3` GitHub](https://github.com/WiseLibs/better-sqlite3), [Kysely](https://kysely.dev/), [Drizzle ORM](https://orm.drizzle.team/)
- Schema/OpenAPI/service: [Zod](https://zod.dev/), [`zod-to-openapi`](https://github.com/asteasolutions/zod-to-openapi), [Hono zod-openapi](https://hono.dev/examples/zod-openapi), [Fastify Swagger](https://github.com/fastify/fastify-swagger), [openapi-typescript](https://openapi-ts.dev/)
- Roadmap integrations: [distilabel docs](https://distilabel.argilla.io/), [Argilla developer architecture](https://docs.argilla.io/latest/community/developer/), [Ray docs](https://docs.ray.io/en/latest/), [Ray Data API](https://docs.ray.io/en/latest/data/api/dataset.html), [LanceDB JS SDK](https://lancedb.github.io/lancedb/js/)

One-line verdict: `FEASIBLE-WITH-PYTHON-BOUNDARY` - core databench can be TypeScript; keep only distilabel/Ray Data execution in optional Python workers.

## Round 2 reconciliation

Claude is right on the headline framing. My first verdict treated named roadmap projects as implementation requirements when the brief's core question is capability feasibility in TS/Node. Under that standard, the required Python surface is zero for the product as specified.

Distilabel: the roadmap line says `distilabel (synthetic)`, but it does not mandate embedding the distilabel Python framework. The capability is synthetic data generation/pipeline orchestration. That is TS-native with provider SDKs, the Vercel AI SDK, queue/workflow libraries, and the existing Dataset/Workspace contract. If the owner later requires running distilabel-the-library specifically, that would be an optional Python worker. It is not a hard capability gap.

Ray Data: no meaningful JS client exists, so Ray-specific distributed execution remains Python-locked. But Ray Data is not a core dependency in the current product contract; it is a possible future scaling backend. The underlying need, larger-than-memory processing, is covered in TS by DuckDB out-of-core execution, with `nodejs-polars` for the current Polars-shaped API. Only a later hard requirement for Ray cluster execution would add an optional sidecar.

What I still hold: if the requirement is "run distilabel exactly" or "run Ray Data exactly", Python is required at that integration boundary. That is not the same as saying databench's synthesis or scaling capabilities require Python.

Converged verdict: `FEASIBLE-ALL-TS`.
