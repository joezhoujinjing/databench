# ADR 0010 — Python Processing Service over internal gRPC

- **Status:** Accepted — owner confirmed the long-running Python service, gRPC
  transport, synchronous short tasks, asynchronous batch jobs, and the
  Proto/Zod boundary on 2026-07-23; owner further confirmed TS-client →
  Python-server direction, no v1 canonical finalizer, no initial LLM, and
  local/private-network-only v1. Same-day review amendment locks the importable
  generated namespace, deterministic v1 stream failure, durable cancel-first
  semantics, and cleanup fencing for the single worker slot
- **Date:** 2026-07-23
- **Deciders:** owner
- **Amends:** [ADR-0001](0001-rebuild-as-ts-monorepo.md) Python boundary
- **Depends on:**
  [ADR-0002](0002-http-framework.md),
  [ADR-0003](0003-storage-postgres-object-store.md),
  [ADR-0008](0008-object-store-aliyun-oss.md), and
  [ADR-0009](0009-canonical-post-training-record-v2.md)

## Context

Databench owns versioned datasets, immutable content-addressed storage, refs,
transform caching, and lineage. Its core and public product surfaces are
TypeScript. Some external processing frameworks that the product may integrate,
starting with Data-Juicer, are Python-native and are expensive to start for every
request. Future integrations may have the same constraint.

The product needs two execution shapes:

1. **Synchronous short tasks**, such as processing one or a few small records or
   previewing an operator. The caller waits for the result.
2. **Asynchronous batch jobs**, such as cleaning, filtering, deduplicating,
   desensitizing, or extracting a large dataset. The API returns a durable job ID
   immediately while processing continues with progress, cancellation, manual
   retry, and recovery.

Embedding Python into the Node process would cross the existing dependency and
runtime boundary. Starting a Python CLI subprocess per request would repeatedly
pay import/model initialization cost, make cancellation and health checks weak,
and complicate production isolation. Giving Python direct access to the catalog
or canonical object keys would create a second owner of Databench identity,
storage, and lineage.

The owner has selected **gRPC** rather than internal REST for communication with
Python. The existing Hono REST/OpenAPI surface remains the public product API.

## Decision

### 0. Keep the first version deliberately small

The first implementation is a **single-owner, trusted-environment** deployment,
not a multi-tenant processing platform. It runs one API deployment and one
Python Processing Service replica. It does not add tenants/projects, per-user
authorization, quotas, a general scheduler, a job-attempt history table, or an
external queue.

The initial execution surface is deliberately narrow:

- a generic deterministic fixture/operator preview through `ProcessInline`, used
  to prove the transport and validation path without selecting a product-domain
  processor or making an LLM/provider call;
- asynchronous, non-LLM Data-Juicer batch processing through `RunJob`, producing
  developer/test staging artifacts until the canonical v2 finalizer is ready.

The architecture preserves stable seams for later scale, but a future use case
must justify each added mechanism. In particular, multi-replica Python routing,
bidirectional job streams, automatic replay of paid LLM work, multi-tenancy,
fine-grained authorization/quotas, LLM-backed processors, and separate dispatcher
deployments are not part of v1. No v1 Dataset importer is added merely to bridge
the period before canonical v2 lands.

### 1. Add one long-running Python execution plane

Add a monorepo-owned service at:

```text
workers/processing-python/
  pyproject.toml
  uv.lock
  .python-version
  Dockerfile
  src/databench_worker/
    grpc_server.py
    job_runner.py
    registry.py
    adapters/
      data_juicer.py
  src/databench/processing/v1/
    processing_pb2.py
    processing_pb2_grpc.py
  tests/
```

The first adapter is Data-Juicer. Future Python-native processors belong behind
the same capability registry and transport instead of becoming separate product
backends. Only explicitly registered processor names and versions may run; the
protocol must not accept arbitrary Python modules, shell commands, or import
paths from a caller.

The service uses native ARM64 Python 3.11.15 initially, managed by native
`uv 0.11.1`, with
`pyproject.toml`, `.python-version`, and committed `uv.lock`. On Apple Silicon,
the codegen/runtime preflight must reject an x86_64 `uv` or Python and must not
fall back to the Rosetta tools under `/usr/local`. Tooling may accept an explicit
native `uv` executable path, but it must not depend on another project directory.
The container image is multi-architecture and pins the same Python minor and
dependency lock used by development and CI.

Data-Juicer is imported as a library inside the long-running process. Its
dependencies and supported operators are installed and pinned when the image is
built. Runtime package installation is disabled. Network access is denied by
default and enabled only for an explicitly configured processor that requires a
model/provider endpoint.

### 2. Keep the public API HTTP and the internal execution transport gRPC

The product topology is:

```text
apps/web
   │ public REST/OpenAPI
   ▼
apps/api (Hono)
   │
   ▼
@databench/workspace ── internal gRPC ──► processing-python
   │                                          │
   ├── Postgres job/catalog control plane     └── Data-Juicer/adapters
   └── OSS/MinIO artifact and dataset plane          │
                 ▲────────────────────────────────────┘ signed URLs only
```

`apps/api` continues to depend only on `@databench/workspace` and
`@databench/schema`. It never imports gRPC-generated code or a Python client
directly. `@databench/workspace` owns a transport-neutral `ProcessingClient`
interface; its internal gRPC implementation uses the generated TypeScript stub.

The Python process is the gRPC server. It listens on an internal-only endpoint,
default port `50051`. Production does not publish that port to the Internet.
Local native development may bind it to loopback; container deployments expose
it only on the private Compose/orchestrator network.

### 3. Proto is the internal transport source; Zod remains the domain source

The gRPC source of truth lives at:

```text
proto/databench/processing/v1/processing.proto
```

The `.proto` file is the **only source of the internal transport contract** and
generates both TypeScript and Python bindings. Generated files are never edited
by hand, and CI verifies that generated output is current and that the Proto
schema passes lint/compatibility checks.

The file-system path deliberately matches the Proto package
`databench.processing.v1`, satisfying Buf's package-directory rule. With
`proto/` as the include root and the worker's `src/` as
the Python output root, `grpcio-tools` generates importable modules at
`databench.processing.v1.processing_pb2` and
`databench.processing.v1.processing_pb2_grpc`. Generated Python imports must
work from both the source tree and an installed wheel without import rewriting
or `PYTHONPATH` manipulation.

This does not change the existing Databench contract rule:

- **Zod in `@databench/schema`** owns Databench domain models, business
  validation, public REST request/response models, and OpenAPI generation.
- **Proto** owns only transport messages between TypeScript and Python.
- The Workspace boundary maps generated Proto DTOs to Zod domain values and
  validates them before any persistence, version calculation, or public
  response.
- Python may use Pydantic for local configuration and adapter validation, but a
  Pydantic model is not a second definition of the Databench domain model.

Canonical Databench records are not modeled field-by-field in Proto. When a
processor returns a domain-shaped JSON result, the transport carries UTF-8 JSON
bytes plus a schema name/version. Workspace parses those bytes through the
matching Zod schema. This prevents a second canonical schema and avoids losing
JSON numeric representation through `google.protobuf.Struct` before Databench
identity rules run.

### 4. Define synchronous and asynchronous RPCs separately

The initial service surface is conceptually:

```proto
service ProcessingService {
  rpc DescribeCapabilities(DescribeCapabilitiesRequest)
      returns (DescribeCapabilitiesResponse);

  rpc ProcessInline(ProcessInlineRequest)
      returns (ProcessInlineResponse);

  rpc RunJob(RunJobRequest)
      returns (stream JobEvent);

  rpc CancelJob(CancelJobRequest)
      returns (CancelJobResponse);
}
```

The implementation also serves the standard gRPC health service. Python uses
the bindings supplied by the pinned `grpcio-health-checking` dependency; the
standard health Proto is not copied into `processing.proto` and v1 Workspace
does not generate or call a separate TS health client. Workspace readiness uses
the bounded `DescribeCapabilities` RPC. Exact Processing message fields are
specified in the Proto change, but the following semantics are locked here.

#### `ProcessInline`

- Intended for one or a few small records, operator previews, and short
  bounded processing.
- Uses a unary request/response and an explicit deadline.
- Carries small text/JSON payloads directly in gRPC.
- Returns a structured result for Workspace to validate with Zod.
- Does not create a Databench dataset version by default. A product operation
  that saves the result must explicitly pass it through Workspace persistence.
- The initial inline fixture/processor is deterministic and makes no
  LLM/provider calls. Domain-specific and LLM-backed inline processors are later,
  separately reviewed adapters rather than architecture requirements.

#### `RunJob`

- Intended for dataset-scale or long-running processing.
- Receives a durable Databench job ID, attempt/lease token, versioned processor
  specification, artifact descriptors, and output write targets.
- Returns a server stream of typed events such as accepted, started, progress,
  heartbeat, artifact-created, completed, failed, and cancelled.
- The originating public HTTP request does not stay open. It returns a job
  resource immediately; the TS dispatcher consumes the gRPC stream in the
  background.
- A lost stream is not proof that the processor itself failed, but v1 has no
  artifact reconciliation algorithm. Without one valid terminal event followed
  by gRPC `OK` EOF, Databench deterministically marks the still-current attempt
  failed and requires an explicit new job; it never guesses success from an
  orphan upload.

The initial deployment has one Python replica and a configured maximum job
deadline. Signed artifact URLs live longer than that deadline plus a safety
buffer, so v1 does not need mid-stream URL refresh or a bidirectional RPC. A
user cancellation first wins a durable conditional transition in Postgres;
only then does TS cancel the active gRPC call and invoke `CancelJob` to drain the
execution. If measured job durations or
multi-replica routing invalidate these assumptions, `RunJob` may evolve to a
bidirectional v2 RPC without changing the public REST/domain contract.

`CancelJob` is idempotent cleanup at the Python execution layer. Databench
remains the authority for the durable cancelled state and rejects completion
from a stale attempt. Its response can release the database drain fence only
when it explicitly confirms that the matching execution has stopped or is
absent and the worker's single batch slot is idle; a token mismatch must never
stop another execution.

### 5. Keep Postgres as the durable job queue

Do not add Redis, RabbitMQ, or another durable queue. Postgres remains the
control plane, consistent with ADR-0003. The initial implementation uses one
`processing_jobs` catalog model for the current job state and lease; it does not
add attempt/event history tables. The minimum logical fields are:

```text
id
processor / processor_version
status
params_json
input_versions / input_artifacts
output_ref
output_artifacts
output_version
attempt / max_attempts
lease_owner / lease_token / lease_expires_at
progress_json
error_json
created_at / started_at / finished_at / updated_at
```

Sample payloads, complete logs, Data-Juicer statistics, and generated datasets
must not be stored in Postgres. JSON columns contain only bounded control-plane
metadata and artifact descriptors.

One small dispatcher loop starts and stops with the API process lifecycle (not
from request middleware). It claims queued work in a short Postgres transaction,
sets a time-bounded lease, commits that transaction, and only then invokes
`RunJob`; no database transaction stays open across gRPC execution. The lease
and conditional update shape preserves the option to run multiple dispatchers
later without requiring that complexity in v1.

The v1 default is `max_attempts = 1`. Lease expiry marks an execution failed;
the owner may submit a new job manually. Only TypeScript-owned `finalizing` may
retry automatically because it reuses an existing artifact and does not rerun
Python or incur new model/provider cost. Processor-declared automatic retry,
resume/checkpoint, and paid asynchronous LLM execution are deferred.

Every streamed event carries the job ID, attempt, and lease token. Catalog
updates and finalization are conditional on the current lease token. Output
artifacts use attempt-specific staging keys, so a late/stale Python attempt
cannot overwrite or finalize the current attempt.

The same lease token is also the durable execution-cleanup handle. A normal
terminal event followed by `OK` EOF proves the worker execution has stopped and
may clear it. A TS-side cancellation, lease expiry, deadline, protocol failure,
or non-OK stream termination writes the public terminal state and
`finished_at`, but retains the attempt/token as a cleanup-pending fence. Claim
must reject every row with such a fence, including terminal rows. The dispatcher
retries `CancelJob` across API restarts and clears the fence by CAS only after
the worker confirms its single slot is idle. A cleanup timeout therefore does
not permit the next job to be claimed and does not consume another job attempt
through `RESOURCE_EXHAUSTED`.

The initial durable state machine is:

```text
queued → leased → running → uploading → finalizing → completed
             │         │          │           │
             └─────────┴──────────┴───────────┴── failed
                       lease expiry or execution failure

uploading → completed                           artifact-only developer job

queued / leased / running / uploading → cancelled
finalizing → finalizing                 idempotent TS retry
```

`finalizing` is a TypeScript-owned state. It validates and imports already
produced artifacts and can be retried without rerunning an expensive processor
when the staging output is intact.

### 6. Use gRPC as the control plane, not the bulk data plane

Small inline inputs, configuration, status, progress, bounded summaries, and
error details may travel in protobuf messages. Dataset bytes, large JSONL,
Parquet, complete logs, Data-Juicer statistics, and intermediate state do not.

Batch data moves through OSS/MinIO with short-lived, least-privilege signed URLs:

```text
processing/jobs/<job-id>/attempts/<attempt>/input.*
processing/jobs/<job-id>/attempts/<attempt>/uploads/<target-token>/output.*
processing/jobs/<job-id>/attempts/<attempt>/uploads/<target-token>/stats.json
processing/jobs/<job-id>/attempts/<attempt>/uploads/<target-token>/logs.jsonl
processing/jobs/<job-id>/attempts/<attempt>/artifacts/output.*
processing/jobs/<job-id>/attempts/<attempt>/artifacts/stats.json
processing/jobs/<job-id>/attempts/<attempt>/artifacts/logs.jsonl
```

The keys above are staging/sidecar keys, not canonical dataset keys. `uploads/`
is worker-writable and attempt/target-scoped; `artifacts/` is conditionally
sealed and never worker-writable. The Python service receives signed read/write targets and does not receive database
credentials, long-lived object-store credentials, or permission to choose
canonical `objects/<hash>/...` keys. URL values are secrets: they are redacted
from logs and expire after a bounded interval.

The URL issuer and Python worker must use an endpoint reachable from the worker;
signed URL hosts are not rewritten after signing. Local native execution may use
loopback MinIO, while an all-container topology uses the MinIO service endpoint.

For v1, signed URL lifetime is derived from the configured maximum job deadline
plus a safety buffer. Artifact-only success keeps the sealed staging artifacts
for the configured development retention period because no canonical object is
published. Failed/cancelled uploads and orphan sealed objects are removed by an
explicit namespace-restricted maintenance command initially rather than a new
background service. A future v2 finalizer may remove disposable staging objects
only after its canonical object is durable.

### 7. Databench alone will finalize versions, refs, cache, and lineage

Python returns only staged artifacts, typed execution status, and bounded
summaries. The following publication sequence becomes active only after the v2
prerequisite gates described below are met; artifact-only developer jobs skip
it. On a publishable successful execution, Workspace:

1. verifies the current job attempt/lease;
2. reads the produced staging artifact;
3. validates and normalizes it through the relevant Zod/domain importer;
4. constructs the Databench dataset/record representation;
5. computes canonical identity and version using Databench hashing rules;
6. writes the immutable canonical object and manifest;
7. records the run/cache/lineage edge;
8. conditionally updates the requested ref, if any;
9. marks the job completed with `output_version`.

Canonical object persistence happens first and is idempotent. Dataset/run/job
catalog updates and an optional ref update then happen in one Postgres control-
plane transaction conditional on the current lease token. If `output_ref` is
requested, job creation captures its current version and finalization uses
compare-and-set; a late job never silently overwrites a ref that changed while
it was running. A ref conflict preserves `output_version` and is reported to the
owner for an explicit follow-up choice.

Python must never calculate or assert the authoritative Databench dataset
version, mutate refs, write catalog runs, or publish canonical object keys. DVC,
if later exposed by this service, may publish an explicit exported artifact but
does not replace Databench semantic versioning or lineage.

ADR-0009's sidecar boundary remains in force: full Data-Juicer statistics,
intermediate state, large traces, dedup graphs, and similar workflow artifacts
remain sidecars keyed by job/record/candidate identity. Only stable, bounded
fields selected by the domain model enter canonical records.

There is deliberately **no v1 batch finalizer**. Until ADR-0009's
identity/version ADR and v2 plan gates are met, Data-Juicer batch execution is a
developer/test path that may complete with staging `output_artifacts` but has no
authoritative `output_version`, ref update, or lineage edge. `ProcessInline`
returns validated structured JSON without creating a canonical dataset.

Processor responses still carry a schema name/version. Once canonical v2
identity and physical layout are accepted, a v2 finalizer implements the steps
above without changing the gRPC service boundary. Public product behavior must
not present an artifact-only developer job as a published Databench dataset.

### 8. Preserve the monorepo dependency boundary

The expected TypeScript additions are:

```text
packages/schema/src/processing.ts          # domain/public API Zod contracts
packages/catalog/src/processing-jobs.ts   # bounded job metadata and leases
packages/workspace/src/processing.ts       # orchestration and finalization
packages/workspace/src/internal/grpc/      # generated client adapter (private)
apps/api/src/routes/processing-jobs.ts     # public REST job surface
apps/web/src/features/processing/          # job UX, added in a later phase
```

This does not add a dependency from `apps/api` to catalog, store, gRPC, or
generated Proto code. Catalog remains Prisma-only and transport-agnostic.
Workspace is the only layer that composes catalog, store, domain validation, and
the processing transport.

Existing synchronous `/v1/transforms/{name}/run` behavior is not changed. The
new asynchronous public surface is separate, conceptually:

```text
POST /v1/processing/jobs
GET  /v1/processing/jobs/{id}
POST /v1/processing/jobs/{id}:cancel
```

Short product operations may expose purpose-specific HTTP endpoints that call
`ProcessInline`; the web UI never calls Python gRPC directly.

### 9. Isolate execution, errors, and observability

- The Python gRPC server separates network I/O from a bounded execution pool so
  CPU/memory-heavy processors cannot block health checks and cancellation.
- Each request/job carries `request_id`, `trace_id`, processor name/version, and
  for jobs the job ID, attempt, and lease token.
- Large logs are artifacts. Postgres stores only bounded progress and the final
  normalized error summary.
- Python gRPC status codes are transport details. Workspace maps them to typed
  domain errors; only `apps/api` maps domain errors to the public HTTP error
  envelope.
- Python exception traces are retained in protected logs/artifacts and are not
  returned verbatim to the browser.
- Inline deadlines, maximum message bytes, job heartbeat/lease duration,
  per-processor concurrency, memory, and CPU are explicit configuration with
  bounded defaults. Exact values are selected and tested during implementation.

### 10. Secure the internal channel

The initial Processing feature is for a single owner on loopback/local Compose
or a trusted private network. Plaintext gRPC is allowed only there. Processing
routes are disabled unless the Python target is explicitly configured, and v1
must not expose them through an Internet-facing deployment. No public auth,
shared-token scheme, or multi-tenant authorization system is introduced in this
phase.

Production gRPC must run only on a private service network with authenticated
transport. The exact mTLS versus TLS-plus-service-credential mechanism is chosen
with the hosting platform rather than implemented speculatively in the local
v1.

The public browser token is not reused as the worker credential. Secrets are
injected at deployment time, never stored in job parameters or Proto artifacts,
and never included in progress/error messages.

This ADR does not decide the still-open API/worker hosting platform. The design
requires long-running containers, internal networking, native ARM64/amd64
images, configurable CPU/memory, and no edge/FaaS runtime. The platform decision
remains a separate deployment ADR/gate.

### 11. Explicitly deferred extensions

The following are extension points, not v1 implementation requirements:

- multiple Python replicas and worker-aware cancellation/routing;
- bidirectional job streams and mid-job signed URL refresh;
- `processing_job_attempts` / event-history tables;
- automatic retries, checkpoints, and resumable processors;
- all LLM-backed processors, including inline and asynchronous batch processing;
- multi-tenancy, projects, per-user RBAC, quotas, and billing controls;
- a separate TS dispatcher service, Redis, RabbitMQ, or a workflow engine;
- cross-job processing cache/deduplication;
- automated staging-artifact retention/garbage-collection service;
- any v1 canonical finalizer or compatibility importer;
- canonical v2 finalization before ADR-0009's prerequisite decisions land.

Adding one of these later must preserve the current public REST/Zod contract,
versioned Proto compatibility, and Databench ownership of finalization.

## Rejected alternatives

### Import Python or use in-process FFI from Node

Rejected. It couples two runtimes and native dependency stacks in the core API
process, weakens isolation, and violates the existing Python boundary.

### Spawn `dj-process` or a Python script for every operation

Rejected. It repeats interpreter/import/model startup, makes health and
cancellation coarse, and is unsuitable for a reusable multi-adapter service.

### Use internal REST/JSON instead of gRPC

Rejected by owner decision. Public REST remains unchanged; internal Python
execution uses typed gRPC with streaming progress and deadlines.

### Send complete datasets through gRPC streaming

Rejected. It creates avoidable memory/backpressure/message-limit pressure and
duplicates the existing object-storage data plane. gRPC carries control and
small payloads; object storage carries bulk artifacts.

### Let Python access Postgres or canonical object-store keys directly

Rejected. It would create a second catalog/version/lineage owner and make stale
attempts capable of publishing authoritative state.

### Let Pydantic mirror the Databench domain model

Rejected. Zod remains the handwritten domain source. Proto/Pydantic types are
transport or adapter-local validation only.

### Add Redis or an external queue

Rejected for the initial design. Postgres leases provide the required durable
queue while preserving the two-stateful-service architecture. Revisit only with
measured contention or scheduling requirements that Postgres cannot satisfy.

## Consequences

- **+** Python-native frameworks can be integrated without putting Python in the
  TS core or exposing them directly to the UI.
- **+** One warm service amortizes Data-Juicer imports, models, and caches.
- **+** Unary and server-streaming gRPC cover quick previews and observable long
  jobs without changing the public REST contract.
- **+** Postgres leases and attempt-scoped artifacts make dispatch recoverable
  without another durable queue.
- **+** Databench remains the single authority for validation, identity,
  versions, refs, cache, and lineage.
- **+** The Python service is stateless with respect to authoritative product
  data and can be scaled/replaced independently.
- **−** The repository gains a second language toolchain, Proto generation, and
  cross-language compatibility tests.
- **−** Long-running gRPC streams, cancellation, lease expiry, and stale-attempt
  fencing require careful integration tests.
- **−** Signed URL generation must be implemented for both Aliyun OSS and local
  S3/MinIO adapters, with worker-reachable endpoints.
- **−** A Python dependency/image policy is required to prevent adapter extras
  from producing an unmaintainable single environment.

## Implementation order

This ADR authorizes the architecture, not an unreviewed all-at-once code change.
Implementation should be split into independently gated changes:

1. Proto v1, deterministic TS/Python generation, capability messages, standard
   health binding source policy, native-toolchain/import smoke, and wire-vector
   contract tests.
2. Native Python 3.11/`uv` worker skeleton plus a TS `ProcessingClient` fake and
   gRPC adapter; implement standard Python health and a minimal normal
   `RunJob` terminal-to-`OK EOF` test here.
3. Deterministic, non-LLM `ProcessInline` end-to-end with a generic fixture and
   Zod validation; do not introduce a domain-specific product schema here.
4. One processing-job table, one API-lifecycle dispatcher loop, single-attempt
   leasing, durable cleanup fencing, and cancellation/stale-result/crash tests.
5. OSS/MinIO staging artifacts and signed URLs, then the full `RunJob` stream
   automaton and abnormal-EOF/seal-crash tests.
6. Data-Juicer adapter with pinned operators/dependencies and no runtime install,
   initially producing developer/test artifacts only.
7. Pause canonical publication until ADR-0009's prerequisites land; then add an
   idempotent v2 Workspace finalizer into dataset/run/ref/lineage.
8. Add local/private processing REST routes and UI; do not expose the feature as
   an Internet-facing or published-dataset workflow before the relevant gates.

Each public contract change still follows Zod → OpenAPI → generated web client,
and each Proto change regenerates and verifies both language bindings in the
same change.
