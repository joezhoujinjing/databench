# ADR 0010 — Long-running Python Worker over internal gRPC

- **Status:** Accepted — owner accepted the original Python/gRPC boundary on
  2026-07-23 and amended it on 2026-07-25 after the v2-only product cutover.
  That amendment renames the service to **Worker**, makes it a generic Python
  capability host, removes the retired v1/artifact-only product design, and
  authorizes one narrow asynchronous v2 Data-Juicer transform that publishes a
  canonical Dataset through TypeScript. The 2026-07-27 amendment adds optional,
  create-only result naming without changing Dataset identity or transform-cache
  identity. A later 2026-07-27 ADR 0012 amendment explicitly includes this Worker
  in the Ubuntu single-host offline release; other deployments remain disabled by
  default.
- **Date:** 2026-07-23; amended 2026-07-25 and 2026-07-27
- **Deciders:** owner
- **Amends:** [ADR 0001](0001-rebuild-as-ts-monorepo.md) Python boundary
- **Depends on:**
  [ADR 0002](0002-http-framework.md),
  [ADR 0003](0003-storage-postgres-object-store.md),
  [ADR 0008](0008-object-store-aliyun-oss.md),
  [ADR 0009](0009-canonical-post-training-record-v2.md),
  [ADR 0011](0011-identity-hashing-versioning-v2.md), and
  [ADR 0013](0013-v2-product-cutover-and-v1-retirement.md)
- **Detailed design:**
  [Worker and Data-Juicer integration](../processing/TECHNICAL_DESIGN.md)

## Context

Databench is now a v2-only product. TypeScript owns the public REST/OpenAPI
surface, canonical record validation, Dataset identity, immutable object
publication, transform cache, Run metadata, lineage and Refs. The current
`V2Workspace.runTransform()` implementation is an eager, request-scoped path:
it materializes `V2Dataset`, executes a deterministic TypeScript operation and
publishes the result before returning HTTP 200.

Some useful computation frameworks are Python-native. Data-Juicer is the first
integration, but it must not determine the shape or name of the long-lived
service because later features may need unrelated Python libraries. Embedding
Python into Node or spawning a fresh Python CLI for every request would weaken
health, cancellation, dependency isolation and warm-start performance.

The local Data-Juicer 1.5.3 evaluation also proves that its useful batch path is
not a synchronous HTTP transform: `np=1` processed 100,000 rows in about 61.5
seconds and 500,000 rows in about 311.7 seconds. The current canonical Dataset
limit remains 100,000 records / 512 MiB, so 500,000 rows are a Worker benchmark,
not an authorized Databench end-to-end Dataset size.

The original ADR predated the completed v2 finalizer and v1 product retirement.
Its `/v1/processing/*`, v1 Dataset input and artifact-only completion model are
therefore obsolete and are replaced by this amendment.

## Decision

### 1. Add one optional long-running service named Worker

The service is called **Worker** in code and architecture documentation. It
is a monorepo-owned Python process at:

```text
workers/python/
```

It is a generic host for explicitly registered Python capabilities. Its first
capability is:

```text
data_juicer.batch@1
```

Future capabilities may be added behind the same Worker protocol only after
their TypeScript orchestration, input/output contract, resource limits and
security review are defined. Worker never accepts arbitrary Python modules,
functions, scripts, shell commands, package installation or import paths.

### 2. Keep all Databench business authority in TypeScript

TypeScript remains solely responsible for:

- resolving a Ref to an exact input Dataset version;
- mapping canonical records into an execution-specific temporary format;
- selecting and versioning the product transform definition;
- computing the transform cache key and deterministic Run ID;
- creating and updating durable transform jobs;
- validating Worker output against the exact input revisions;
- constructing the output `V2Dataset`;
- calculating record/Dataset/artifact identities through existing code;
- committing immutable objects and registering Run/lineage;
- exposing REST, CLI and Web behavior.

Worker does not understand Dataset, Ref, canonical record, candidate, lineage,
cache or publication semantics. It does not connect to Postgres, does not hold
long-lived OSS/MinIO credentials, does not calculate Databench identities and
cannot write `objects/v2/` canonical keys.

Worker necessarily contains technical adapter logic: capability registration,
parameter safety checks, downloads/uploads, temporary files, subprocess or
library execution, progress, cancellation, deadlines and cleanup. These are
execution responsibilities, not a second Databench business layer.

### 3. Use internal gRPC; keep public HTTP/OpenAPI

The topology is:

```text
Web / CLI
    │ public /v2 REST or in-process Workspace
    ▼
TypeScript Workspace
    ├── Postgres: transform job + catalog control plane
    ├── OSS/MinIO: temporary exchange + canonical data plane
    └── internal gRPC ──► Worker ──► capability adapter
```

TypeScript is the gRPC client and Worker is the gRPC server. The browser never
uses gRPC. `apps/api` and `apps/cli` continue to depend only on Workspace and
Schema; generated Proto types remain private to Workspace.

The internal transport source is:

```text
proto/databench/worker/v1/worker.proto
package databench.worker.v1;
```

The protocol version is independent from the Databench product/API version.
Generated sources are deterministic, committed and never edited manually.

### 4. Proto owns transport; Zod owns product and domain contracts

Proto defines only generic Worker transport concepts:

- capability name/version;
- bounded JSON parameter bytes plus schema identifier;
- input artifact descriptors and output targets;
- attempt/lease token;
- accepted/started/progress/heartbeat/terminal events;
- cancellation result and safe technical errors.

Proto must not define Databench canonical records, Data-Juicer presets, public
transform job resources or REST DTOs. Those remain Zod-owned. Workspace maps
between generated transport values and validated domain values at both
directions. Python may use Pydantic for local adapter/config validation, but it
is not a second public/domain schema source.

### 5. Implement only one fixed Data-Juicer vertical slice first

The first product operation is a named asynchronous v2 transform:

```text
basic-clean@1
```

It has one exact input Dataset, no public parameters and one TS-owned fixed
execution plan named `basic-clean-v1`. There is no operator composer, custom
field selector, arbitrary YAML, custom preset, LLM call or runtime dependency
installation in this phase.

The operation is selection-only. TypeScript projects each input revision into:

```json
{"record_id":"rec_...","record_digest":"...","text":"..."}
```

Worker/Data-Juicer returns only retained identities:

```json
{"record_id":"rec_...","record_digest":"..."}
```

TypeScript verifies that results are unique members of the exact input set and
rebuilds the output from the original canonical records. Data-Juicer-modified
text is never published in this version, so record identity mode is preserve.

### 6. Add a narrow asynchronous v2 transform job, not a Processing product

The public concept is a **transform job** under the existing Transform product.
It is not a restored Processing surface. Web top-level navigation remains
Dataset / Ingest / Transform and REST remains `/v2/*`.

The first implementation uses one API process, one in-process dispatcher, one
Worker replica and one active batch slot. Postgres is the durable queue; no
Redis, RabbitMQ, external workflow engine or separate dispatcher deployment is
added.

A mutable transform job and an immutable successful Run are different things:

- Job tracks queued/running/finalizing/failed/cancelled execution state.
- Run exists only after canonical output publication succeeds and remains the
  existing cache/lineage authority.

`completed` means the canonical output Dataset and Run are registered. A
Worker terminal event or uploaded file alone is never product completion.

### 7. Reuse the current v2 publication path

After valid retained identities are loaded, TypeScript builds a `V2Dataset` and
reuses/refactors the existing publication invariants:

1. Store `prepare()` and conditional `commit()`;
2. catalog layout registration plus `V2Run` registration in one transaction;
3. deterministic conflict handling for the same cache key;
4. read-after-register verification;
5. optional result Ref adoption is recorded with the completed job.

The batch-job request may include one `result_ref`. It is a product label for the
output and is deliberately excluded from the transform cache key: content still
determines the immutable Dataset version, while naming does not trigger another
Python execution. A deterministic job can bind at most one result name. During
cache-hit adoption or canonical completion, Catalog handles that name in the same
transaction using create-only semantics:

- a missing live Ref is created at the exact output version;
- a live Ref already at that version is an idempotent success;
- a live Ref at another version, or a deleted Ref with that name, is a conflict
  and is never overwritten or restored.

The job still completes when naming conflicts because its exact immutable output
remains valid; its public `result_ref` reports `pending`, `updated` or `conflict`
and the observed version. Additional aliases or intentional movement of an
existing Ref remain explicit operations through the standalone Ref CAS surface.
If cleaning retains every record, the result Ref is still created but points to
the unchanged input/output version.

### 8. Use temporary object-store exchange for large inputs and outputs

Large rows do not travel inside gRPC. Workspace creates attempt-scoped exact
keys under a non-canonical namespace, writes the input and issues short-lived
signed URLs. Worker gets only those URLs.

```text
staging/worker/v1/<job-id>/<attempt>/input.jsonl
staging/worker/v1/<job-id>/<attempt>/output.jsonl
```

Staging output is not a user-facing artifact and is never authoritative. After
Worker stops writing, TypeScript reads it once with size/digest limits,
validates it, finalizes the canonical Dataset and deletes the exact temporary
keys. No staging seal/copy subsystem is required for this first slice because a
completed job never references staging. Cleanup must use exact known keys,
never prefix deletion.

### 9. Keep durable cancellation and stale-attempt fencing

The dispatcher claims queued work with a short Postgres transaction and
`FOR UPDATE SKIP LOCKED`, assigns an attempt and random lease token, and renews
using database time. Every event and terminal transition is conditional on
job ID + attempt + lease token + non-expired lease.

Cancellation first commits a durable conditional job transition, then cancels
the gRPC call and invokes Worker cleanup. A cancelled/failed attempt retains a
cleanup fence until Worker confirms the matching execution is stopped or
absent. A stale token cannot stop or complete a newer attempt. The first version
does not automatically retry failed work; a user may explicitly retry the same
deterministic job only after its cleanup fence is cleared.

A Worker `completed` event is only a candidate. Workspace requires the valid
terminal event followed by gRPC `OK` EOF, then verifies the output. Any abnormal
EOF, protocol violation, deadline or lost lease fails the current attempt; it
never guesses success from an orphan upload.

### 10. API entrypoint owns runtime lifecycle

The current request middleware lazily opens `V2Workspace`; that is insufficient
for a background dispatcher. Worker integration adds an explicit optional
runtime composition owned by the real API entrypoint:

1. open `V2Workspace`;
2. create gRPC Worker client;
3. start dispatcher;
4. start Hono server;
5. on shutdown, stop intake, drain/cancel within a deadline, close Worker
   client, close Workspace and close the HTTP server.

`createApp()`, OpenAPI generation and tests remain side-effect free: they do not
start timers, connect to Worker or launch a dispatcher.

### 11. Keep deployment local/private and explicitly scoped

Worker is disabled unless explicitly configured. Local native development binds
gRPC to loopback; containers expose it only on a private network. The initial
implementation does not make this capability Internet-facing, multi-tenant or
multi-replica.

ADR 0012 originally did not automatically gain Worker. Its later narrow amendment
now explicitly adds the Worker image and lifecycle to the trusted-intranet Ubuntu
offline release and requires a new bundle/lifecycle gate. This does not enable
Worker in ECS, public-cloud or arbitrary deployments.

### 12. Pin the Python runtime and dependencies

The first implementation uses native ARM64 Python 3.11.15 and native
`uv 0.11.1` for Apple Silicon development, with committed `.python-version`,
`pyproject.toml` and `uv.lock`. It must reject Rosetta Python/uv under
`/usr/local`. CI/container builds use the same Python minor and lock.

The first adapter pins `py-data-juicer==1.5.3`, runs with `np=1`, disables
runtime installation and denies network access by default. A dependency that
cannot safely coexist in this environment may later use another Worker
deployment speaking the same protocol; the first version does not build worker
pool routing.

## Explicitly out of scope

- operator composition or custom Data-Juicer YAML;
- user-selectable canonical fields or JSONPath;
- publishing Data-Juicer-rewritten text;
- LLM/provider execution;
- multi-tenancy, quotas or per-user scheduling;
- multiple Worker replicas or distributed compute;
- automatic retries;
- general-purpose arbitrary Python execution;
- automatically enabling Worker outside the explicitly amended ADR 0012 offline bundle;
- raising the current 100k / 512 MiB canonical Dataset limits.

## Alternatives rejected

### Import Python into Node

Rejected because it couples runtimes, deployment and failure isolation inside
the API process.

### Spawn a fresh CLI for every request

Rejected because imports and environment initialization repeat, cancellation
and health are weak, and future Python capabilities would duplicate wrappers.

### Create a Data-Juicer-specific service

Rejected because Data-Juicer is only the first Python capability. The Worker
transport and runtime are generic; Data-Juicer remains an adapter.

### Let Worker own Databench Dataset publication

Rejected because it would create a second authority for canonical schema,
identity, Store keys, Run and lineage.

### Send the complete dataset through gRPC messages

Rejected for batch work because it adds transport buffering, message-size and
reconnect complexity. Existing OSS/MinIO is already the large-object data plane.

### Keep artifact-only completion

Rejected because canonical v2 publication, Run, cache and lineage now exist.
An artifact-only result would create a second, incomplete product state.

### Add Redis or a workflow engine

Rejected for the single dispatcher/single slot design. Postgres leases are
sufficient and preserve the current stateful-service boundary.

## Consequences

- **+** Python libraries can be added without entering the TypeScript core.
- **+** Data-Juicer becomes a normal v2 transform with Dataset/Run/lineage.
- **+** Worker remains replaceable and stateless with respect to authoritative
  product data.
- **+** The first slice has one fixed operation and no premature composer.
- **−** The repository gains Python, Proto and cross-language gates.
- **−** API startup/shutdown and durable background work become more complex.
- **−** OSS and S3/MinIO adapters need bounded temporary object and signed URL
  support in addition to canonical conditional objects.
- **−** Long-running cancellation, lease expiry and abnormal EOF need real
  Postgres/MinIO/Worker integration tests.

## Implementation order

Each accepted step is a separate commit/PR and must pass its gate before the
next begins:

1. **P0 — documentation alignment:** this ADR amendment, detailed design, v2
   non-goal amendment and planned layout.
2. **P1 — Worker foundation:** Proto, deterministic TS/Python generation,
   native toolchain, Python package, health/capabilities, gRPC client and a
   test-only deterministic capability.
3. **P2 — transform job control:** Zod/OpenAPI job contracts, Prisma migration,
   Catalog CAS/lease methods and API-entrypoint dispatcher lifecycle using a
   fake Worker client.
4. **P3 — temporary data plane:** exact staging keys, signed GET/PUT, bounded
   verification/cleanup and a fake capability end-to-end.
5. **P4 — Data-Juicer adapter:** pinned 1.5.3, fixed `basic-clean-v1`, `np=1`,
   selection-only input/output and 100/10k/100k tests.
6. **P5 — canonical finalizer:** retained-subset validation, output
   `V2Dataset`, shared publish helpers, atomic job+Run registration, cache and
   lineage tests.
7. **P6 — product surface:** `/v2` transform-job REST, generated client and a
   minimal Transform-page submit/progress/cancel/result flow.
8. **P7 — final gate:** full repository gates plus real Postgres, MinIO,
   Worker, restart/cancel/determinism and browser lifecycle smoke.
