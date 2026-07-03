# Deployment Notes

This is the current deployment entry point. Historical migration-era hosting
notes live under `docs/migration/` and may mention superseded GCS/S3/MinIO
assumptions.

## Current Infrastructure Facts

- API runtime: long-lived Node 22/Hono container with native dependencies such
  as `nodejs-polars`.
- Catalog/control plane: Postgres through Prisma.
- Data plane: Aliyun OSS through the native `ali-oss` SDK. See
  `docs/decisions/0008-object-store-aliyun-oss.md`.
- Local docker-compose runs Postgres only. There is no local OSS emulator.
- Tests that should not hit OSS should inject the in-memory store; store
  integration tests are credential-gated.
- Web app: Vite SPA static build, deployable separately from the API.

## Required Secrets

- `DATABASE_URL`
- `OSS_REGION`
- `OSS_BUCKET`
- `OSS_ACCESS_KEY_ID`
- `OSS_ACCESS_KEY_SECRET`
- Optional: `OSS_ENDPOINT`, `OSS_INTERNAL`, `OSS_SECURE`
- `DATABENCH_CORS_ORIGINS`
- `PORT`

Use a bucket-scoped RAM sub-account key for OSS. Do not commit secrets.

## API Host Requirements

Any API host must support:

- Custom long-lived container images.
- Linux native Node dependencies.
- Configurable CPU and memory.
- Streaming NDJSON responses.
- Longer ingest/materialize/export requests, or a clear path to move those
  operations behind a job/worker boundary.
- Platform-managed environment variables or secrets.

If a new hosting platform is selected, add or update an ADR and then document
the concrete runbook here.
