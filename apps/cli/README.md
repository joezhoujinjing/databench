# @databench/cli

Agent-facing CLI over the databench `Workspace` core. It is the second thin
adapter alongside `apps/api` (HTTP): both map to the same `@databench/workspace`
methods, so they produce byte-identical version hashes and lineage. See
[ADR-0007](../../docs/decisions/0007-agent-cli.md).

- **In-process (Thick).** Opens its own Prisma + object-store connections via
  `Workspace.open()`; no running API required.
- **JSON by default.** Results → stdout as JSON; errors → stderr in the same
  `{ error: { code, message, detail? } }` envelope the API uses. **One
  documented exception:** `dataset export` without `--out` streams a raw
  **NDJSON** dataset to stdout (with `--out` it writes the file and prints
  `{ "path": ... }` JSON). Each verb declares its output kind in `help --json`.
- **Exit codes** mirror the API status map: `0` ok · `1` internal · `2`
  bad input / usage · `3` not found · `4` conflict · `5` validation.
- **Boundary.** Depends only on `@databench/workspace` + `@databench/schema` —
  never `store`/`catalog`/`engine`/`ops`/`io` directly — so it stays a thin
  adapter over the same core the API uses, with no re-implemented logic.

## Configuration

`Workspace.open()` reads env directly — `DATABASE_URL` and `S3_*` (same defaults
as `apps/api`). Global flags: `--database-url <url>` (overrides the catalog DB;
the object store is configured only via `S3_*` env) and `--compact` (single-line
JSON). Both may appear anywhere in the command line.

## Usage

```bash
pnpm --filter @databench/cli build
databench help --compact            # machine-readable command catalog

databench dataset add ./samples.jsonl --name demo
databench dataset show demo
databench dataset samples demo --limit 5
databench dataset export demo --fmt sft -o out.jsonl

databench transform list
databench transform run sample_n --input demo --params '{"n":5}' --ref demo_small

databench lineage demo_small
databench meta capabilities
databench meta doctor               # probe DB + object store connectivity
databench help --compact            # full machine-readable command contract
```

### `dataset add --samples`

`databench dataset add --samples file.json` ingests samples from a JSON file
(instead of JSONL). The file may be **either** a bare samples array `[ {…}, … ]`
**or** the API request body shape `{ "samples": [ … ], "name": …, "message": … }`
— the same body `POST /v1/datasets` accepts.

Samples must be **canonical** (each carries an explicit `kind`, e.g.
`{ "kind": "sft", "messages": [ … ] }`), exactly like the API body — this path
does **not** auto-detect kind (only the JSONL path does). It uses the
lexeme-preserving parse path for hash parity. If the body carries
`name`/`message` they are used; `--name`/`--message` flags **override** them.

### `meta doctor`

Probes the two stateful backends and prints `{ database, store }`, each
`{ ok, error? }`. It exits `0` on a successful probe run — inspect the report to
tell an unhealthy environment (DB unreachable, migrations not applied, bucket
missing) apart from an ordinary not-found ref.

During development, run without building: `pnpm --filter @databench/cli dev -- <args>`.
