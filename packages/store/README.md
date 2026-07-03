# @databench/store

Content-addressed object storage for databench datasets and vocabularies.

Public API:

- `Store`: async dataset and vocabulary `exists`/`write`/`read`, plus optional `ping()`.
- `createStore(config)`: creates the Aliyun OSS-backed store.
- `OssStore`: native `ali-oss` implementation with lazy client construction.
- `storeObjectKeys(version)`: returns the legacy-compatible Parquet and manifest keys.
- `vocabularyObjectKeys(id)`: returns the vocabulary JSON object key.
