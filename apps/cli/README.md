# @databench/cli

Agent-facing CLI for the canonical Databench workspace. It is a thin in-process adapter alongside
`apps/api`: both call the same `@databench/workspace` v2 lifecycle and therefore share identity,
storage, lineage, fidelity, cancellation, and error semantics.

- **In-process.** Opens its own PostgreSQL and object-store connections; no running API is required.
- **Machine-readable.** Results go to stdout as JSON. Errors use the API error envelope on stderr.
  Binary/NDJSON export bytes are the deliberate exception.
- **Stable exit codes.** `0` ok · `1` internal · `2` bad input · `3` not found · `4` conflict ·
  `5` validation.
- **Dependency boundary.** Depends only on `@databench/workspace` and `@databench/schema`.

## Configuration

The CLI reads `DATABASE_URL`, `DATABENCH_V2_CURSOR_SECRET`, `DATABENCH_ROOT`, and the object-store
environment selected by `DATABENCH_OBJECT_STORE` (`OSS_*` for Aliyun OSS or `S3_*` for S3/MinIO).
Local development also loads the monorepo-root `.env` when present.

Global flags are `--database-url <url>` and `--compact`; both may appear anywhere in the command.

## Commands

```bash
pnpm --filter @databench/cli build
databench help --compact

databench dataset ingest ./canonical.jsonl --ref demo --message "initial import"
databench dataset show demo
databench dataset records demo --limit 20
databench dataset audit demo
databench dataset export demo --inspect --converter canonical-jsonl
databench dataset export demo --output ./demo.jsonl --converter canonical-jsonl

databench converter list
databench converter show canonical-jsonl

databench transform list
databench transform run subset --input demo --params '{"count":5}' --ref demo-small

databench ref list
databench ref show demo
databench ref move demo <new-version> --expected-version <old-version>

databench lineage show demo
```

`dataset export` always inspects the exact resolved version first. A converter that reports semantic
loss requires `--accept-fidelity <digest>`. `--output/-o` writes through a mode-`0600` temporary file,
fsyncs it, and atomically renames it; without `--output`, export bytes stream to stdout and binary TTY
output is rejected.

During development, run without building:

```bash
pnpm --filter @databench/cli dev -- <args>
```
