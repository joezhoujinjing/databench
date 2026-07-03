# databench docs

Design, decision, maintenance, and historical migration records for the
all-TypeScript databench monorepo.

## Start here

- **[../AGENTS.md](../AGENTS.md)** — repo-wide agent operating guide and the
  current anti-drift contract. Read this before making changes.
- **[architecture.md](architecture.md)** — target monorepo layout, the active
  `nodejs-polars` engine, app/package surfaces, deployment shape, and
  Python boundary.
- **[tech-stack.md](tech-stack.md)** — current (Python) → target (TypeScript)
  technology mapping, layer by layer. Mostly historical, but still useful for
  why TS-native components were chosen.
- **[project-structure.md](project-structure.md)** — authoritative monorepo
  layout, per-package internal template, and the **dependency-direction rules**
  (the anti-drift core). Read before creating any app/package or cross-package
  dependency.
- **[directory-layout.md](directory-layout.md)** — file-level layout of every
  app/package (including `apps/api`, `apps/web`, and `apps/cli`), each file
  tagged with the feature IDs or adapter responsibility it carries. Read before
  creating files.
- **[conventions.md](conventions.md)** — naming, TS/module rules, the
  **determinism discipline** (canonicalJson / blake3 / banker's rounding tied to
  the golden gates), error mapping, contract-single-source, testing, env config,
  git. Read before writing any code.

## Current Surface Docs

- **[../apps/cli/README.md](../apps/cli/README.md)** — `@databench/cli`
  command surface, JSON/NDJSON output rules, exit codes, configuration, and
  agent-facing usage.
- Package READMEs under `../packages/*/README.md` summarize public package
  responsibilities. The authoritative dependency rules remain in
  [project-structure.md](project-structure.md).

## Decisions (ADRs)

- **[0001 — Rebuild as a TS monorepo](decisions/0001-rebuild-as-ts-monorepo.md)**
  — the decision + feasibility verdict (`FEASIBLE-ALL-TS`). *Accepted.*
- **[0002 — HTTP framework: Hono vs NestJS](decisions/0002-http-framework.md)**
  — **Hono**. *Accepted.*
- **[0003 — Storage: Postgres catalog + object-storage data plane](decisions/0003-storage-postgres-object-store.md)**
  — two stateful services (PG + object storage), no SQLite; object-store
  provider choice superseded by ADR-0008. *Accepted.*
- **[0004 — Toolchain & conventions](decisions/0004-toolchain-and-conventions.md)**
  — pnpm + Turborepo, Node 22 + Vitest, Biome, Prisma, GitHub Actions. *Accepted.*
- **[0005 — Infrastructure & deployment](decisions/0005-infrastructure-and-deployment.md)**
  — Postgres, deployment constraints, and current OSS env contract; earlier
  GCS/S3 details superseded by ADR-0008. *Accepted.*
- **[0006 — Frontend stack](decisions/0006-frontend-stack.md)**
  — React + Vite SPA, shadcn/ui + Tailwind, TanStack Router/Query/Virtual. *Accepted.*
- **[0007 — Agent-facing CLI](decisions/0007-agent-cli.md)**
  — `apps/cli` as a Thick `Workspace` adapter, zero-dependency `parseArgs`,
  JSON by default, API-aligned errors and exit codes. *Accepted.*
- **[0008 — Object store: Aliyun OSS](decisions/0008-object-store-aliyun-oss.md)**
  — native `ali-oss` SDK, no S3-compatible client or MinIO. *Accepted.*

## Deployment And Operations

- **[deployment/README.md](deployment/README.md)** — current deployment facts,
  required env vars, and API host constraints.
- **[migration/STATUS.md](migration/STATUS.md)** — historical progress record
  for the rewrite and later CLI extension.
- **[migration/d3-api-hosting-brief.md](migration/d3-api-hosting-brief.md)** —
  archived migration-era hosting comparison. It predates ADR-0008 and should be
  refreshed before use.
- **[HANDOFF.md](HANDOFF.md)** — maintenance handoff: current state, must-reads,
  hard rules, environment gotchas, and check-in protocol.

## Migration History (Python → TS)

These documents are historical evidence and regression contracts. They explain
how the rewrite reached parity; do not treat their "migration/rewrite" wording
as a current backlog or execution plan unless a current ADR or maintenance doc
explicitly revives the work.

- **[migration/PLAN.md](migration/PLAN.md)** — archived end-to-end execution plan
  for the completed rewrite, tying backend and frontend inventories into one
  ordered checklist.
- **[migration/feature-inventory.md](migration/feature-inventory.md)** — the
  backend migration inventory: all ~101 features indexed, dependency-sorted into
  13 phases with per-feature checkboxes and golden-test gates.
- [migration/inventory-domain.md](migration/inventory-domain.md) — 74
  domain/data-layer features, every hidden rule + acceptance test.
- [migration/inventory-service.md](migration/inventory-service.md) — service /
  contract / behavior features + the contract↔implementation reconciliation
  (including the now-implemented `vocabularies` contract).
- **[migration/frontend-inventory.md](migration/frontend-inventory.md)** — the
  frontend rewrite inventory (`apps/web`): phases FE-0..FE-5 + checkboxes +
  acceptance gates, backed by `_frontend-pages.md` (pages/flows) and
  `_frontend-shell.md` (components/api/i18n/shell).
- **[spikes/s1-determinism.md](spikes/s1-determinism.md)** — deterministic
  sampling and hashing spike. This remains an active regression constraint.
- **[reviews/2026-07-01-code-review.md](reviews/2026-07-01-code-review.md)** —
  historical code review and gate evidence.
- **[reviews/2026-07-03-design-qa.md](reviews/2026-07-03-design-qa.md)** —
  archived design QA evidence.
- **[briefs/2026-07-api-openapi-refactor-brief.md](briefs/2026-07-api-openapi-refactor-brief.md)** —
  archived API/OpenAPI refactor task brief.

## Feasibility evidence

Source material behind ADR-0001 — two independent evaluators + cross-review:

- [00-brief.md](feasibility/00-brief.md) — the question both evaluators answered
- [01-eval-claude.md](feasibility/01-eval-claude.md) — Claude's report (+ Round 2)
- [02-eval-codex.md](feasibility/02-eval-codex.md) — Codex's report (+ Round 2)

Both converged on **`FEASIBLE-ALL-TS`**; required Python surface for the product
as specified is **zero**.
