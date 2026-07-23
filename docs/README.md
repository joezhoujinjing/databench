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
- **[0007 — Agent-facing CLI](decisions/0007-agent-cli.md)**
  — thick, in-process CLI over the same Workspace boundary. *Accepted.*
- **[0008 — Aliyun OSS production + MinIO local](decisions/0008-object-store-aliyun-oss.md)**
  — native OSS in production and the S3 adapter for local MinIO. *Accepted.*
- **[0009 — Canonical post-training record v2](decisions/0009-canonical-post-training-record-v2.md)**
  — one canonical record with derived trainer/task views. *Accepted for v2.*
- **[0010 — Python Processing Service over internal gRPC](decisions/0010-python-processing-service-grpc.md)**
  — long-running Python execution plane, Proto transport, Postgres job leases,
  and object-storage batch artifacts while Databench retains version/lineage
  ownership. *Accepted.*
- **[0011 — v2 identity, hashing, and versioning](decisions/0011-identity-hashing-versioning-v2.md)**
  — separates stable logical IDs, canonical record digests, logical dataset versions,
  and physical artifact digests. *Accepted for v2.*

## v2 design references

- **[v2 technical design](v2/TECHNICAL-DESIGN.md)**
  — v2 package/runtime、Parquet/manifest/catalog、Workspace/API，以及完整 Web vertical
  slice、exact-version cache、Unified Record renderer 与 fidelity workflow。*Accepted.*
- **[v2 implementation plan](v2/PLAN.md)**
  — additive v2 delivery sequence, package placement, physical layout, catalog/API rollout,
  and gates V0-V17. *Accepted; implementation starts at V0.*
- **[Canonical Record v2 扩展设计参考](v2/canonical-record-extended-profile.md)**
  — v2.0 最小 schema 暂不采用的候选字段、Part variants、适用边界与未来纳入条件。
  *Non-normative reference.*

## Processing

- **[Processing Service 交接包](processing/HANDOFF.md)**
  — 当前状态、权威文件顺序、锁定边界、P1–P6 切片、P1 首 PR 范围、验收清单与可直接
  交给实现者的 kickoff prompt。**交接从这里开始。**
- **[Processing Service 技术方案](processing/TECHNICAL_DESIGN.md)**
  — 在当前 monorepo 中落地内部 gRPC Python worker、同步短任务、Postgres
  batch job、OSS/MinIO 暂存工件和 Data-Juicer adapter 的分步设计。*Revised draft.*

## Deployment

- **[阿里云 ECS 部署手册](deployment/aliyun-ecs.zh-CN.md)** — 中文生产部署
  runbook，覆盖 GitHub Actions、ECS、RDS、OSS/CDN、GoDaddy DNS、首发检查、
  日常部署、回滚和排障。
- **[Aliyun ECS Deployment Runbook](deployment/aliyun-ecs.md)** — English
  deployment runbook for the same production setup.

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

Both converged on **`FEASIBLE-ALL-TS`** for the core/domain/public API; that
surface remains Python-free. ADR-0010 later authorizes a separate optional
Python Processing Service for explicitly selected Python-native frameworks such
as Data-Juicer, without importing Python into the TS core.
