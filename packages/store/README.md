# @databench/store

Content-addressed Parquet object storage for databench datasets.

Public API:

- `Store`: async `exists(version)`, `write(dataset)`, and `read(version)`.
- `createStore(config)`: creates the selected object store.
  - `kind: "oss"` uses Aliyun OSS through `ali-oss` and is the production path.
  - `kind: "s3"` uses the S3-compatible adapter for local MinIO.
- `storeConfigFromEnv()`: reads `DATABENCH_OBJECT_STORE`; defaults to `oss`, while
  local `.env` should set `DATABENCH_OBJECT_STORE=s3`.
- `storeObjectKeys(version)`: returns the legacy-compatible Parquet and manifest keys.
