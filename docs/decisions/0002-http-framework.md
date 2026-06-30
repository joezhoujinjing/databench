# ADR 0002 — HTTP framework for `apps/api`: Hono vs NestJS

- **Status:** Accepted — **Hono** (confirmed by owner 2026-06-29)
- **Date:** 2026-06-29
- **Context question raised by:** owner ("why Hono, why not NestJS?")

## Context

`apps/api` exposes `/health`, `/version`, `/capabilities`, and ~15 `/v1/*`
routes. Its OpenAPI spec is **the contract** the frontend consumes via
`openapi-typescript`. The substantive logic lives in framework-agnostic packages
(`engine`, `store`, `catalog`, `workspace`); the HTTP layer is a thin typed
shell: request validation, NDJSON streaming, multipart upload, error envelope,
pagination.

## Options

### Hono + `@hono/zod-openapi` (recommended)

- **Schema is the product.** The zod discriminated union (`sft|preference|rl|
  trajectory`) is simultaneously the runtime validator, the OpenAPI source, and
  the inferred TS type — **one source of truth, no drift**. Direct hit for a
  contract-first data API.
- **No DI needed.** Core services are plain TS packages wired by `import`.
  Nest's biggest value-add (DI/modules/providers/request-scoping) sits idle here.
- **Web-standard** (`Request`/`Response`) → same handlers run on Node/Bun/Deno/
  edge, keeping the door open for the `duckdb-wasm` edge/browser M3 plan.
- **Light & testable:** no reflect-metadata cold start; handlers are fetch
  functions you call directly in tests. Streaming + multipart are first-class.

### NestJS + `@nestjs/swagger`

- Batteries-included: DI, modules, guards, interceptors, pipes, gateways,
  scheduling, microservice transports, first-class BullMQ.
- OpenAPI is generated from controller decorators + DTO classes (class-validator)
  — mature, but a **second representation** to keep in sync; discriminated-union
  `oneOf + discriminator` fidelity needs manual `@ApiExtraModels` / `getSchemaPath`
  wiring.
- Heavier (reflect-metadata, more boilerplate, Node-bound). Earns its weight when
  the **service itself** grows framework-shaped cross-cutting concerns.

### Fastify + `@fastify/swagger` (+ TypeBox) — the middle option

More plugin structure than Hono, far lighter than Nest, Node-native, very fast,
mature OpenAPI. Reasonable if you want *some* structure without Nest's weight.
(Nest can also run on a Fastify adapter later.)

## Decision rule

> If the HTTP layer stays a **thin typed shell over the engine packages** → Hono.
> If you expect the **service itself** to accumulate heavy framework concerns
> (auth/RBAC, job queues, websocket/SSE gateways, many modules) → NestJS.

databench today is squarely the former.

## Recommendation

**Hono + `@hono/zod-openapi`** — databench is a contract-first data API whose
value is zod/OpenAPI fidelity and whose logic lives in separate packages, which
is Hono's sweet spot. NestJS is a **defensible, non-wrong** alternative if you
standardize on Nest across your stack or expect the service to grow auth/queues/
gateways.

**This is the most reversible decision in the plan:** the engine/store/catalog/
workspace packages are framework-agnostic, so swapping the HTTP shell later is a
contained change. Low stakes either way.

## Resolution

Owner confirmed **Hono** on 2026-06-29. `apps/api` uses Hono +
`@hono/zod-openapi`; `tooling/openapi-export` boots the Hono app to emit
`openapi.json`. Revisit only if the service later grows heavy framework-shaped
concerns (auth/RBAC, job queues, gateways) — at which point NestJS becomes the
reconsideration target. The swap is contained (engine packages are
framework-agnostic).
