# @databench/store

Content-addressed Parquet object storage for databench datasets.

Public API:

- `Store`: async `exists(version)`, `write(dataset)`, and `read(version)`.
- `createStore(config)`: creates the S3-compatible store used for GCS and local MinIO.
- `storeObjectKeys(version)`: returns the legacy-compatible Parquet and manifest keys.
