# ADR 0003 — Storage: Postgres catalog + object-storage data plane

- **Status:** Accepted
- **Date:** 2026-06-29
- **Deciders:** owner
- **Supersedes:** the SQLite catalog choice from ADR-0001 / early architecture draft

## Context

This is a **production, hosted, multi-user service**, not a local/embedded tool.
The original databench used an embedded SQLite catalog and a local-filesystem
Parquet store — appropriate for a single-node library (`Workspace.open("./bench")`),
but wrong for a horizontally-scaled hosted service:

- SQLite is single-writer, file-local, and **cannot be shared across multiple
  stateless API instances** — a hard blocker for horizontal scale.
- No network access, HA, online backup, or replication.
- A local-filesystem blob store has the same multi-instance problem.

The owner also decided there is **no separate local-dev story**: local, CI, and
production all run the same database (Postgres via Docker locally). No SQLite.

## Decision

The system has exactly **two stateful services to operate**:

1. **Catalog (control plane) → Postgres.** Tables `datasets`, `runs` (lineage +
   transform cache), `refs`. Lineage DAG via `WITH RECURSIVE`. Typed access +
   migrations via **Prisma ORM** (Rust-free TS/WASM client + driver adapter
   `@prisma/adapter-pg` / `-neon`); the recursive lineage CTE uses Prisma
   **TypedSQL** / `$queryRaw` (Prisma's query API has no native recursive CTE) —
   see ADR-0004. Managed in production (Neon / Supabase / RDS — Neon's serverless
   + branch-per-preview fits this project); plain Postgres container locally.
2. **Data plane → object storage.** Content-addressed, write-once Parquet blobs +
   sibling manifests, keyed by content hash (`objects/<hash[:2]>/<hash>.parquet`).
   S3 / R2 / GCS in deployed envs; **MinIO** (S3-compatible) in local Docker.
   Behind a `Store` interface (so an `fs` impl remains possible for tests).

Everything else is **in-process library code in the stateless API**, not infra:
`nodejs-polars` and **DuckDB** (which reads Parquet directly from object storage
via `httpfs` — it is *not* a third database to provision), `apache-arrow`,
`hash-wasm`, `@lancedb/lancedb`.

```
stateless Hono API (N replicas)
   ├── Postgres            ← catalog (the only relational DB)
   ├── object storage      ← Parquet data plane (S3/R2; MinIO local)
   └── embedded libs       ← nodejs-polars, DuckDB(→reads S3 directly), Lance
```

## Why this is sufficient (through M3)

- **No Redis.** The `runs` table is already the transform cache; content
  addressing makes it idempotent.
- **No separate queue service.** If async M2 synthesis needs a job queue, run it
  *in Postgres* (`pg-boss`, or `FOR UPDATE SKIP LOCKED`).
- **M3 Lance is embedded** (files on object storage), not a server.
- **Content addressing + object storage is a strong fit:** S3 `PUT` is
  per-object atomic and keys are content hashes, so write-once is race-free
  without atomic rename.

## Consequences

- **+** Horizontally scalable: stateless API replicas share PG + object storage.
- **+** One database everywhere (local/CI/prod) — no dialect drift, no
  SQLite-vs-PG split.
- **+** Only two stateful services to run and back up.
- **−** Local dev now requires Docker (Postgres + MinIO) — accepted by the owner.
- **−** DuckDB-over-S3 (`httpfs`) and S3 latency need attention for large
  out-of-core materialize; revisit caching/locality if it bites.

## Decision rule for "is X a third service?"

If it has a server process and its own durable state → it must justify itself
against "PG or object storage can already do this." So far nothing has.
