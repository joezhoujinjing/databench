# Tech stack — current v2-only implementation

> This file describes the implemented stack after ADR 0013 product cutover.
> Earlier Python-to-TypeScript evaluations remain under `docs/feasibility/` and
> `docs/migration/` as historical records.

## Backend

| Layer | Choice |
|---|---|
| Runtime | TypeScript + Node 22 LTS, pure ESM |
| Monorepo/build | pnpm workspaces + Turborepo + tsup |
| HTTP/OpenAPI | Hono + `@hono/zod-openapi` |
| Validation | Zod v4 |
| Identity | RFC 8785 JCS + BLAKE3 |
| Dataset artifact | hyparquet + hyparquet-writer + zstd-wasm |
| Catalog | PostgreSQL 17 + Prisma driver adapter |
| Object storage | Aliyun OSS; S3-compatible MinIO for local/offline |
| API streaming | Web Streams + bounded multipart parsing |
| Tests | Vitest; real Postgres/MinIO integration gates |

The current core/domain/public API has no Python runtime. The retired Processing
worker design is preserved only in its ADR/design history.

## Frontend

| Layer | Choice |
|---|---|
| Framework/build | React 19 + Vite |
| Routing | TanStack Router |
| Server state | TanStack Query |
| Virtualization | TanStack Virtual |
| UI/style | Tailwind v4 + local shadcn-style primitives + lucide-react |
| API client | openapi-typescript + openapi-fetch |
| Forms | react-hook-form + Zod |
| Lineage | React Flow (`@xyflow/react`) |
| i18n | i18next + react-i18next |
| Tests | Vitest |

The Web app is a REST-only SPA and imports no backend package. Product routes are
unversioned; the generated client consumes the stable `/v2` API contract.

## Tooling and deployment

| Area | Choice |
|---|---|
| Lint/format | Biome |
| Git hooks | Lefthook |
| OpenAPI | deterministic `tooling/openapi-export` |
| Local services | Docker Compose Postgres + MinIO |
| Hosted object store | Aliyun OSS |
| Offline single host | Docker Compose + Caddy + Postgres + MinIO |
| Public cloud API host | pending D3 owner decision |

V16/V17 recovery/security/capacity work remains separate from the product
cutover and is not implied by this implemented stack.
