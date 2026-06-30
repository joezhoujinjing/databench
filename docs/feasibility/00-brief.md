# Feasibility brief: rebuild `databench` as a TypeScript monorepo

## Context
`databench` is infrastructure for managing **LLM post-training data** (versioned datasets, automatic lineage, reproducible mixtures). Two projects live under `~/Desktop/databench/`:

- `databench/`     — backend, currently **Python**. Read this code to ground your assessment.
- `databench-ui/`  — frontend, already **React + Vite + TypeScript**, consumes the backend purely via an OpenAPI-generated typed client (`openapi-typescript` from `schema/openapi.json`).

The current backend's core:
- **Polars** lazy columnar dataframe engine (`databench/dataset.py`, `ops.py`, `recipe.py`, `workspace.py`)
- **PyArrow** as the interchange boundary (`Dataset.arrow()`)
- **Parquet** content-addressed, write-once blob store (`databench/store.py`)
- **blake3** content hashing for identity/versioning (`databench/hashing.py`, note `hash_unordered`)
- **SQLite** catalog + **lineage DAG** (`databench/catalog.py`)
- **Pydantic** schemas (`databench/schema.py`), discriminated union over sft/preference/rl/trajectory samples
- **FastAPI** service exposing `/v1/...` REST (`databench/service/`), OpenAPI spec is the contract the UI consumes
- Roadmap M2/M3 names: distilabel (synthetic), Argilla (annotation), Lance, Ray Data

## THE DECISION IS ALREADY MADE — DO NOT RELITIGATE IT
The owner has decided to **rebuild the whole stack as a TypeScript monorepo, greenfield**. The existing Python code is disposable; "porting difficulty" and "rewrite cost" are NOT concerns and must not appear in your analysis. Do **not** argue to stay on Python for reasons of maturity, ecosystem richness, or convenience.

## The ONLY question you are answering
**Can TypeScript / the Node ecosystem actually implement each core capability?** Python is permitted *inside the monorepo* ONLY where TS is genuinely **incapable** — the bar for "must stay Python" is *technical impossibility or a hard capability gap*, not preference. If TS can do it (even if a bit less mature), the verdict is TS.

## What to produce
1. **Read the actual code** under `~/Desktop/databench/databench/` — especially `ops.py`, `recipe.py`, `store.py`, `dataset.py`, `hashing.py`, `schema.py`, and `service/`. List the concrete operations the engine actually performs (every Polars expression used, e.g. `str.json_path_match`, `cast`, `concat`, `filter`, lazy `collect`, parquet read/write, arrow export).

2. **Per-capability feasibility table.** For each capability below, name the concrete npm package(s) you'd use, their real current status, and a verdict of `TS-NATIVE` / `TS-WITH-CAVEATS` / `MUST-STAY-PYTHON`:
   - Columnar/lazy dataframe engine (candidates: `nodejs-polars`, `apache-arrow` JS, `duckdb`/`duckdb-async` (DuckDB-Node), `duckdb-wasm`)
   - The specific expressions found in `ops.py`/`recipe.py` (json path extraction, casts, concat, filters, groupby)
   - Arrow interchange in JS (`apache-arrow`, zero-copy)
   - Parquet read/write (`parquetjs`, `parquet-wasm`, via DuckDB, via arrow)
   - blake3 hashing + order-independent dataset versioning (`blake3` npm, `hash-wasm`)
   - Content-addressed write-once store + manifests (filesystem, atomic rename)
   - SQLite catalog + lineage DAG (`better-sqlite3`, `kysely`/`drizzle`)
   - Schema/validation + discriminated unions (`zod`/`typebox`/`valibot`) and OpenAPI generation so the existing UI codegen keeps working
   - HTTP service layer (`hono`/`fastify`/`nestjs`) emitting an OpenAPI spec compatible with the UI's `openapi-typescript` flow
   - JSONL ingestion + per-line kind auto-detection
   - Roadmap M2/M3 integrations (distilabel/Argilla/Lance/Ray) — do these force a Python component regardless?

3. **Recommended TS-monorepo architecture.** Workspace layout, the dataframe-engine choice you'd actually bet on, and — IF any capability is `MUST-STAY-PYTHON` — exactly where the Python boundary sits and how TS talks to it (in-process binding? subprocess? sidecar service behind the same REST contract?).

4. **The single biggest technical risk** to "all-TS works."

5. **Final verdict, one of:** `FEASIBLE-ALL-TS` / `FEASIBLE-WITH-PYTHON-BOUNDARY` / `NOT-FEASIBLE`. If the middle one, state the minimal Python surface.

## Output format
Be concrete and decisive — cite real package names and their real state as of 2026. This is for an expert owner; no hand-holding, no rehashing the "should we" debate. End with your one-line verdict.
