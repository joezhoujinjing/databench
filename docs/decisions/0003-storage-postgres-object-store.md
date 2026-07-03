# ADR 0003 — Storage: Postgres catalog + object-storage data plane

- **Status:** Accepted — **object-store choice superseded by [ADR-0008](0008-object-store-aliyun-oss.md)**
  (Aliyun OSS via native `ali-oss`; no S3-compatible client / MinIO / GCS). The
  Postgres-catalog + object-store-data-plane split below still holds.
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
   The original provider/client choice here was superseded by ADR-0008: current
   implementation uses **Aliyun OSS** via native `ali-oss`, behind the unchanged
   `Store` interface.

Everything else is **in-process library code in the stateless API**, not infra:
current code uses `nodejs-polars`, `apache-arrow`, and `hash-wasm`. DuckDB and
Lance are optional future libraries, not third services to provision.

```
stateless Hono API (N replicas)
   ├── Postgres            ← catalog (the only relational DB)
   ├── object storage      ← Parquet data plane (Aliyun OSS)
   └── embedded libs       ← nodejs-polars, Arrow, hashing; future DuckDB/Lance if designed
```

## Why this is sufficient (through M3)

- **No Redis.** The `runs` table is already the transform cache; content
  addressing makes it idempotent.
- **No separate queue service.** If async M2 synthesis needs a job queue, run it
  *in Postgres* (`pg-boss`, or `FOR UPDATE SKIP LOCKED`).
- **Future M3 Lance would be embedded** (files on object storage), not a server.
- **Content addressing + object storage is a strong fit:** object keys are
  content hashes, parquet is written before manifest, and retry/self-healing
  behavior is encapsulated behind `Store`.

## Consequences

- **+** Horizontally scalable: stateless API replicas share PG + object storage.
- **+** One database everywhere (local/CI/prod) — no dialect drift, no
  SQLite-vs-PG split.
- **+** Only two stateful services to run and back up.
- **−** Local dev now requires Docker for Postgres plus real OSS credentials for
  real object-store IO; tests should inject the in-memory store when cloud IO is
  not the subject under test.
- **−** If DuckDB is wired up later for out-of-core materialize, OSS locality and
  read path need a fresh design check.

## Decision rule for "is X a third service?"

If it has a server process and its own durable state → it must justify itself
against "PG or object storage can already do this." So far nothing has.
