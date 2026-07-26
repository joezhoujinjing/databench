# Databench Worker

The Worker is a private, long-running Python capability host. It does not own Databench domain
models, Postgres state, canonical identity, or object publication.

Native Apple Silicon development requires the pinned ARM64 Python 3.11.15 and uv 0.11.1:

```bash
workers/python/scripts/native-preflight.sh
uv sync --directory workers/python --frozen
uv run --directory workers/python databench-worker --listen 127.0.0.1:50051
```

The gRPC bind address defaults to `127.0.0.1:50051`. Set `DATABENCH_WORKER_BIND` to change the
service default, or pass `--listen` to override it explicitly. `DATABENCH_WORKER_TEMP_ROOT` selects
the private root used for per-job temporary directories.

The P1-only `fixture.copy@1` capability is disabled by default. Tests enable it explicitly with
`DATABENCH_WORKER_ENABLE_TEST_CAPABILITIES=1`; it must not be enabled in a product deployment.

Regenerate and verify committed protocol bindings from the repository root:

```bash
pnpm codegen:worker
pnpm codegen:worker:check
pnpm test:worker:python
pnpm --filter @databench/workspace test:worker
```
