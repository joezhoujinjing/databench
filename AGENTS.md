# databench-ts — Agent Guide

This file is the durable operating guide for coding agents in this repository.
Keep it practical, current, and focused on rules that should apply to future
work. Historical migration notes belong in `docs/migration/`; architecture
changes belong in ADRs or the relevant docs.

## Project Overview

databench-ts is an all-TypeScript monorepo for LLM post-training data
infrastructure: versioned datasets, content-addressed storage, lineage,
reproducible recipes, transforms, exports, and vocabulary workflows.

The product has three user-facing surfaces over one shared core:

- `apps/api`: Hono HTTP API for `/health`, `/version`, `/capabilities`, and `/v1/*`.
- `apps/web`: React/Vite SPA that consumes the generated OpenAPI client only.
- `apps/cli`: agent-facing Thick CLI that opens `Workspace` directly.

## Repository Layout

```text
apps/{api,web,cli}
packages/{hashing,schema,engine,io,ops,store,catalog,workspace}
tooling/openapi-export
prisma
docs
```

Key package roles:

- `@databench/schema`: zod schemas, wire contracts, constants, vocabulary models, and typed domain errors.
- `@databench/workspace`: orchestration boundary for ingest, transforms, recipes, refs, lineage, export, and vocabularies.
- `@databench/store`: object-storage data plane for Parquet and vocabulary blobs.
- `@databench/catalog`: Prisma/Postgres control plane for metadata, refs, runs, and lineage rows.
- `@databench/engine`, `@databench/io`, `@databench/ops`, `@databench/hashing`: deterministic data and transform primitives.

## Setup And Commands

Run commands from the repository root. Use Node 22 from `.nvmrc`.

```bash
docker compose up -d
pnpm install
pnpm dev
pnpm lint
pnpm typecheck
pnpm test
pnpm openapi:check
pnpm --filter @databench/<pkg> <script>
pnpm --filter @databench/cli dev -- <args>
```

Use narrower package-level checks while iterating, then run the broader gates
when a change crosses package, API, schema, CLI, or deterministic behavior
boundaries.

## Architecture Rules

- Keep the dependency direction one-way:
  `hashing <- schema <- {engine,io,catalog} <- {ops,store} <- workspace <- {apps/api,apps/cli}`.
- `apps/api` and `apps/cli` are adapters. They may depend on `@databench/workspace` and `@databench/schema`; they must not directly import `store`, `catalog`, `engine`, `ops`, or `io`.
- `apps/web` must not import backend packages. It consumes generated OpenAPI types and frontend runtime wrappers under `apps/web/src/api`.
- New business capabilities should land in core packages and `workspace` first, then be exposed through API, CLI, and Web as needed.
- Do not deep import from internal files of another package. Use each package's public `index` export.
- If a task intentionally changes these boundaries, update the relevant docs or ADR and add tests that protect the new boundary.

## API And Schema Rules

- Wire contracts live in `@databench/schema` as zod schemas. Do not maintain duplicate request/response types in API, CLI, or Web.
- `apps/api` uses `@hono/zod-openapi`; contract changes must update `openapi.json` through the repo tooling.
- `apps/web` types come from `openapi-typescript`. Runtime-only frontend types are allowed only when they are not API wire contracts.
- API errors use the envelope `{ error: { code, message, detail? } }`.
- CLI errors use the same schema/error classification and map to documented exit codes.
- Capability flags must reflect real implemented behavior across API, Web, and CLI.

## Data And Determinism Rules

- Sample data never goes into Postgres. Parquet and vocabulary blobs live in object storage; Postgres stores catalog metadata only.
- Hash-bound serialization must go through `@databench/hashing` `canonicalJson`; do not use raw `JSON.stringify` as hash input.
- Keep BLAKE3 fixed for content hashes.
- Preserve `null` in hash-bound content. Do not accidentally drop fields by converting to `undefined`.
- Recipe counts use `bankersRound`; do not replace it with `Math.round`.
- Recipe weight fallback intentionally follows `weight || 1.0`.
- Empty dataset version is `hashText("empty")`.
- Any change affecting `id`, `version`, `cache_key`, lineage, export rows, or sampling requires focused golden/parity coverage.

## Frontend Rules

- Keep `apps/web` a SPA and a pure REST client.
- Server state belongs in TanStack Query; avoid copying server data into broad client state.
- Keep API calls in `apps/web/src/api`, not inside React components.
- Keep generated API types generated. Do not hand-edit `apps/web/src/api/generated/schema.ts`.
- UI should remain dense, operational, and suited for repeated data work.
- i18n defaults and existing locale behavior are part of the user experience; update locale tests when changing copy keys.

## CLI Rules

- `apps/cli` is a Thick local adapter over `Workspace`, not an HTTP client and not a second backend.
- Commands should mirror API/workspace parsing paths so CLI and API produce the same versions, lineage, and errors.
- Output is JSON by default. The documented exception is raw NDJSON streaming for dataset export without an output file.
- `help --json` is a machine-readable command contract; update it with command surface changes.
- Add new probes or business operations to `Workspace` or core packages first; CLI should call them.

## Testing And Done Criteria

Before handing off changes, run the narrowest useful verification and report it.

- Schema/API contract changes: `pnpm openapi:check` plus relevant API and Web checks.
- Core deterministic changes: relevant package tests plus golden/parity tests.
- Workspace changes: `pnpm --filter @databench/workspace test` and affected adapters.
- API changes: `pnpm --filter @databench/api test`.
- Web changes: `pnpm --filter @databench/web test`, `typecheck`, and `build` when UI/runtime behavior changes.
- CLI changes: `pnpm --filter @databench/cli test`.
- Cross-package changes: `pnpm lint`, `pnpm typecheck`, and `pnpm test` when practical.

If verification cannot be run, say exactly why.

## Safety Rules

- Check `git status --short` before editing and preserve unrelated user changes.
- Never revert or overwrite changes you did not make unless explicitly asked.
- Do not commit, push, create branches, or open PRs unless explicitly requested.
- Do not introduce dependencies without a clear reason and a package manifest update.
- Do not write secrets to the repository. Use `.env` locally and platform secrets in deployed environments.
- Treat `~/Desktop/databench/` as read-only legacy reference/golden material when it is needed.
