# E8 evaluation result archive evidence

Date: 2026-07-28
Upstream: `modelscope/evalscope@b2a62f05fd81e89ec2cf4f83b9a79ce0a5535d60`

## Boundary and lifecycle

E8 archives completed Databench Dataset evaluation results without making archive success part of execution
success. A run may remain `completed` while its archive is `not_requested`, `pending`, `uploading`, `available` or
`failed`. Native Benchmark and performance tasks remain provider-owned and are not forced into the Databench
evaluation-run table.

The archive lifecycle is:

1. EvalScope deterministically packages an allowlisted result tree as `result.tar.zst`.
2. `:prepare-result-upload` allocates or replays an archive attempt and returns a 15-minute exact-key conditional
   `PUT` descriptor.
3. EvalScope uploads to
   `staging/evaluations/v1/<run-id>/<attempt>/result.tar.zst` without receiving an object-store credential.
4. `:finalize-result-upload` verifies the staged media type, declared size, configured size cap and BLAKE3 digest,
   then conditionally creates
   `objects/v2/evaluation-result-v1/<digest-prefix>/<digest>.tar.zst`.
5. Workspace commits the immutable locator to PostgreSQL before deleting only the exact staging key.
6. `:fail-result-upload` records a bounded, redacted archive error and cleans only that attempt's exact staging key.

The sequence is intentionally orphan-safe. If the PostgreSQL finalize fails after immutable object creation, the
immutable object and staging object remain; replaying finalize repairs the row and then performs exact cleanup.
A lost prepare, upload or finalize response can therefore be retried without overwriting the first bytes or
changing execution status.

## Packaging and secret boundary

`workers/evalscope/src/databench_evalscope/archive.py` uses UTF-8 path ordering, fixed tar metadata and fixed zstd
parameters. The packager admits only reviewed result files and rejects:

- absolute paths, traversal and files outside the configured task result root;
- symlinks and hardlinks;
- credential-like structured keys and values;
- unsupported file types and oversize input/output.

The uploader receives only the exact signed URL and required conditional headers. It does not reuse the model API
key or any Databench/object-store long-lived credential. Signed URLs are not persisted in PostgreSQL, archive
manifests or application logs.

## Storage and state verification

The real MinIO store suite verified:

- conditional presigned `PUT` to the attempt-scoped staging key;
- a second write returns `412` and cannot replace the first bytes;
- staged size and BLAKE3 verification;
- conditional creation and replay of the immutable content-addressed object;
- exact staging cleanup after successful PostgreSQL finalization.

The real PostgreSQL/MinIO Workspace and API suites verified prepare replay, concurrent prepare/finalize behavior,
wrong attempt/digest/size conflicts, failed archive state, PostgreSQL failure ordering, finalize response loss and
repair by replay. The OSS adapter contract test separately locks conditional presign headers and exact-key
semantics.

Python tests cover deterministic bytes, secret/path/link rejection, size limits, expired signed URLs, upload
response loss, `412`, finalize response loss and permanent policy failure. The final Python suite contained 62
tests.

## Web states

Databench Dataset task URLs persist the Dataset version and Databench run ID so refresh can recover both provider
and archive state. The task monitor presents execution and retention independently:

- online report available;
- online report unavailable;
- archive processing;
- archive available;
- archive failed;
- archive unavailable/not requested.

The desktop browser verified a real completed Databench evaluation with the online report available and archive
unavailable, including direct URL restoration and a clean console. The remaining online/archive combinations are
locked by Web state tests. Phone portrait layout is excluded from this Web gate by owner direction.

## Gate record

The E8 gate passed with:

- `pnpm lint`, `pnpm build`, `pnpm typecheck`, `pnpm test`, `pnpm openapi:check`;
- `pnpm v2:status:check`, `pnpm peers check`, `pnpm offline:check`, `git diff --check`;
- `pnpm evalscope:parity:check`, `pnpm evalscope:parity:check:green` and
  `pnpm evalscope:parity:test` (7/7);
- `uv lock --check` and 62 EvalScope provider Python tests;
- Store 90/90 against real MinIO;
- Workspace 156 tests with 10 skipped against real PostgreSQL/MinIO;
- API 101/101 and CLI 14/14 against real PostgreSQL/MinIO;
- Catalog 37/37 against real PostgreSQL;
- desktop browser direct-refresh and console verification.

Web production output retained 11 lazy Evaluation route entries; the initial JavaScript bundle was 853,184 bytes,
below the 950,000-byte budget.
