# ADR 0008 — Object store: Aliyun OSS (native ali-oss), dropping the S3-compatible client

- **Status:** Accepted — **Aliyun OSS via the native `ali-oss` SDK**(owner confirmed 2026-07-03)
- **Date:** 2026-07-03
- **Supersedes:** the object-store choice in [ADR-0003](0003-storage-postgres-object-store.md)
  (S3-compatible client; GCS/S3/R2 in deployed envs; MinIO local). The
  Postgres-catalog + object-store-data-plane split from 0003 is unchanged.

## Context

The test (and initial production) environment is deployed on **Alibaba Cloud**.
The object store — the Parquet/vocabulary data plane — is **Aliyun OSS**. ADR-0003
had targeted a generic S3-compatible store (`@aws-sdk/client-s3`, MinIO locally,
GCS/S3/R2 in prod), partly to keep the "engine reads the object store directly
over the S3 protocol" (DuckDB) door open.

Re-checked at decision time: **DuckDB is not used anywhere** (zero dependency,
zero imports; the active engine is 100% `nodejs-polars`). It is only a documented
future/fallback. So the "must stay S3-compatible for the engine" argument no
longer constrains this choice — and if DuckDB is ever wired up, it can read OSS
through OSS's own S3-compatible endpoint independently of how the app writes.

## Decision

- **Object store = Aliyun OSS**, accessed with the **native `ali-oss`** SDK.
  `packages/store` ships a single `OssStore` (implements the unchanged `Store`
  interface); `@aws-sdk/client-s3` is removed.
- **No S3 anywhere** — neither the AWS service nor the generic S3-compatible
  framing. GCS/R2/MinIO are dropped.
- Config is env-driven: `OSS_REGION`, `OSS_BUCKET`, `OSS_ACCESS_KEY_ID`,
  `OSS_ACCESS_KEY_SECRET`, optional `OSS_ENDPOINT` / `OSS_INTERNAL` / `OSS_SECURE`.
  Use a **RAM sub-account key scoped to the bucket**; the bucket is pre-created
  (the app never creates buckets — it only reads/writes objects + `getBucketInfo`
  for the `doctor` probe). `OSS_INTERNAL=true` selects the VPC endpoint (no egress
  cost from ECS/ACK).

## Consequences

- **No local object-store emulator.** `ali-oss` speaks the OSS protocol, not S3,
  so MinIO cannot stand in. MinIO + `minio-init` are removed from
  `docker-compose.yml`; only Postgres runs locally.
  - Unit/e2e tests inject an **in-memory store** (`createMemoryStore`), so
    `workspace`/`apps/api`/`apps/cli` tests are unaffected.
  - The store integration test (`packages/store`) is **OSS-credential-gated**
    (`describe.runIf` on `OSS_*`) — it runs only with real creds and skips in CI /
    on dev machines without them. The pure key-layout test always runs.
  - Running the app locally against real data now requires OSS creds (or an
    injected store).
- **Lazy client.** `ali-oss`'s constructor validates credentials, so `OssStore`
  builds the client lazily — an unconfigured `Workspace.open()` does not throw;
  storage ops fail cleanly (and `meta doctor` reports `store: { ok: false }`).
- **Object key layout unchanged** (`objects/<vv>/<version>.{parquet,manifest.json}`,
  `vocabularies/<vv>/<id>.json`) — versions/ids are still content hashes, writes
  idempotent, parquet-before-manifest so `exists` self-heals.
- Aliyun-locked for the object store. Acceptable: deployment target is Alibaba
  Cloud. If a second cloud is ever needed, revisit with a new ADR.
