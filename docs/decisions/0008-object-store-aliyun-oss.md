# ADR 0008 — Object store: Aliyun OSS in production, MinIO/S3 for local development

- **Status:** Accepted — amended 2026-07-06 to restore local MinIO while keeping
  production on Aliyun OSS.
- **Date:** 2026-07-03
- **Supersedes:** the object-store choice in [ADR-0003](0003-storage-postgres-object-store.md)
  for production. The Postgres-catalog + object-store-data-plane split from
  0003 is unchanged.

## Context

The initial production environment is deployed on **Alibaba Cloud**. The
production object store — the Parquet/vocabulary data plane — is **Aliyun OSS**.
ADR-0003 had targeted a generic S3-compatible store (`@aws-sdk/client-s3`, MinIO
locally, GCS/S3/R2 in prod), partly to keep the "engine reads the object store
directly over the S3 protocol" (DuckDB) door open.

Re-checked at decision time: **DuckDB is not used anywhere** (zero dependency,
zero imports; the active engine is 100% `nodejs-polars`). It is only a documented
future/fallback. So the "must stay S3-compatible for the engine" argument no
longer constrains this choice — and if DuckDB is ever wired up, it can read OSS
through OSS's own S3-compatible endpoint independently of how the app writes.

## Decision

- **Production object store = Aliyun OSS**, accessed with the native `ali-oss`
  SDK through `OssStore`.
- **Local development object store = MinIO**, accessed through the
  S3-compatible `S3Store` (`@aws-sdk/client-s3`).
- The `Store` interface remains unchanged. Callers choose a backend only through
  `StoreConfig` / env, not by branching business logic.
- Config is env-driven:
  - `DATABENCH_OBJECT_STORE=oss` selects Aliyun OSS. This is the default and is
    pinned in `deploy/ecs/docker-compose.yml`.
  - `DATABENCH_OBJECT_STORE=s3` selects the S3-compatible adapter for local
    MinIO.
  - OSS config: `OSS_REGION`, `OSS_BUCKET`, `OSS_ACCESS_KEY_ID`,
    `OSS_ACCESS_KEY_SECRET`, optional `OSS_ENDPOINT` / `OSS_INTERNAL` /
    `OSS_SECURE`.
  - S3/MinIO config: `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`,
    `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, optional
    `S3_FORCE_PATH_STYLE`.
- Production uses a RAM sub-account key scoped to the OSS bucket; the bucket is
  pre-created. The app never creates buckets in production — it only reads/writes
  objects and calls `getBucketInfo` for the `doctor` probe. `OSS_INTERNAL=true`
  selects the VPC endpoint on ECS.

## Consequences

- **Local object-store emulator is available again.** `docker-compose.yml`
  includes MinIO + a bucket init job, and `.env.example` selects
  `DATABENCH_OBJECT_STORE=s3` for local development.
  - Unit/e2e tests inject an **in-memory store** (`createMemoryStore`), so
    `workspace`/`apps/api`/`apps/cli` tests do not require MinIO or OSS.
  - The store integration test (`packages/store`) is backend-gated: it runs
    against real OSS only when `OSS_*` are set, and against MinIO only when
    `RUN_MINIO_STORE_TESTS=true` or `S3_ENDPOINT` is set.
- **Lazy client.** `ali-oss`'s constructor validates credentials, so `OssStore`
  builds the client lazily — an unconfigured `Workspace.open()` does not throw;
  storage ops fail cleanly (and `meta doctor` reports `store: { ok: false }`).
- **Object key layout unchanged** (`objects/<vv>/<version>.{parquet,manifest.json}`,
  `vocabularies/<vv>/<id>.json`) — versions/ids are still content hashes, writes
  idempotent, parquet-before-manifest so `exists` self-heals.
- Production remains Aliyun-locked for the object store. Local MinIO is a
  development backend, not a production multi-cloud commitment. If a second
  production cloud is ever needed, revisit with a new ADR.
