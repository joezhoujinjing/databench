# @databench/store

Conditional-create object storage for immutable v2 dataset artifacts and manifests.

Public API:

- `FileBackedV2Store`: bounded local staging plus immutable artifact publication.
- `OssConditionalObjectStoreV2`: Aliyun OSS production adapter.
- `S3ConditionalObjectStoreV2`: S3-compatible local MinIO adapter.
- `v2ObjectStoreConfigFromEnv()`: reads `DATABENCH_OBJECT_STORE`; defaults to `oss`, while
  local `.env` should set `DATABENCH_OBJECT_STORE=s3`.
- `v2ObjectKeys(identity)`: returns the stable `objects/v2/` artifact and manifest keys.
