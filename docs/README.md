# databench docs

Design and decision records for the all-TypeScript monorepo rebuild.

## Start here

- **[architecture.md](architecture.md)** — target monorepo layout, the engine
  bet (`nodejs-polars` + DuckDB), per-capability stack, the Python boundary, the
  biggest risk and the first action.
- **[tech-stack.md](tech-stack.md)** — current (Python) → target (TypeScript)
  technology mapping, layer by layer.
- **[project-structure.md](project-structure.md)** — authoritative monorepo
  layout, per-package internal template, and the **dependency-direction rules**
  (the anti-drift core). Read before creating any package.
- **[directory-layout.md](directory-layout.md)** — file-level layout of every
  app/package (incl. the full Hono `apps/api` internal structure), each file
  tagged with the feature IDs it carries. Read before creating any file.
- **[conventions.md](conventions.md)** — naming, TS/module rules, the
  **determinism discipline** (canonicalJson / blake3 / banker's rounding tied to
  the golden gates), error mapping, contract-single-source, testing, env config,
  git. Read before writing any code.

## Decisions (ADRs)

- **[0001 — Rebuild as a TS monorepo](decisions/0001-rebuild-as-ts-monorepo.md)**
  — the decision + feasibility verdict (`FEASIBLE-ALL-TS`). *Accepted.*
- **[0002 — HTTP framework: Hono vs NestJS](decisions/0002-http-framework.md)**
  — **Hono**. *Accepted.*
- **[0003 — Storage: Postgres catalog + object-storage data plane](decisions/0003-storage-postgres-object-store.md)**
  — two stateful services (PG + object storage), no SQLite. *Accepted.*
- **[0004 — Toolchain & conventions](decisions/0004-toolchain-and-conventions.md)**
  — pnpm + Turborepo, Node 22 + Vitest, Biome, Prisma, GitHub Actions. *Accepted.*
- **[0005 — Infrastructure & deployment](decisions/0005-infrastructure-and-deployment.md)**
  — Supabase Postgres, GCS object storage (S3-compat), API host TBD. *Accepted.*
- **[0006 — Frontend stack](decisions/0006-frontend-stack.md)**
  — React + Vite SPA, shadcn/ui + Tailwind, TanStack Router/Query/Virtual. *Accepted.*

## Migration (Python → TS)

- **[HANDOFF.md](HANDOFF.md)** — **implementation handoff** for the agent that
  will build this (goal mode): current state, must-reads, hard rules, decision-gate
  defaults, environment gotchas, Definition of Done, check-in protocol, and a
  ready-to-paste kickoff prompt. **Give this to the implementing agent.**
- **[migration/PLAN.md](migration/PLAN.md)** — **the end-to-end execution plan**
  (M0..M6, steps S0..S22 + decision gates), tying the backend and frontend
  inventories into one ordered, one-PR-per-step checklist. **Start here to execute.**
- [migration/STATUS.md](migration/STATUS.md) — live per-step progress tracker
  (maintained by the implementing agent).

- **[migration/feature-inventory.md](migration/feature-inventory.md)** — the
  authoritative migration plan: all ~101 features indexed, dependency-sorted into
  13 phases with per-feature checkboxes and golden-test gates. **Start here when
  migrating.**
- [migration/inventory-domain.md](migration/inventory-domain.md) — 74
  domain/data-layer features, every hidden rule + acceptance test.
- [migration/inventory-service.md](migration/inventory-service.md) — service /
  contract / behavior features + the contract↔implementation reconciliation
  (including the now-implemented `vocabularies` contract).
- **[migration/frontend-inventory.md](migration/frontend-inventory.md)** — the
  authoritative **frontend** rewrite plan (`apps/web`): phases FE-0..FE-5 +
  checkboxes + acceptance gates, backed by `_frontend-pages.md` (pages/flows) and
  `_frontend-shell.md` (components/api/i18n/shell + 118 i18n keys).

## Feasibility evidence

Source material behind ADR-0001 — two independent evaluators + cross-review:

- [00-brief.md](feasibility/00-brief.md) — the question both evaluators answered
- [01-eval-claude.md](feasibility/01-eval-claude.md) — Claude's report (+ Round 2)
- [02-eval-codex.md](feasibility/02-eval-codex.md) — Codex's report (+ Round 2)

Both converged on **`FEASIBLE-ALL-TS`**; required Python surface for the product
as specified is **zero**.
