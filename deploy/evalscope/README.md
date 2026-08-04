# EvalScope deployment

This directory contains the image and gateway deployment assets for the pinned, backend-only EvalScope service used
by the Databench Evaluation integration. The Databench-owned Python service source and tests live in
`workers/evalscope`; deployment code must not become an application source directory. The image deletes
`evalscope/web`, registers only the reviewed backend routes, and is reachable from a browser only through
Databench's same-origin `/evalscope-api` gateway.

## Pinned inputs

`upstream.lock` is the source of truth for the upstream commit, source archive, downstream patch, Python lock,
Plotly asset and NLTK `punkt_tab` data. The Docker build verifies every vendored payload before installing it and
fails if the patched package is missing report templates or Benchmark metadata, or if the upstream Web directory is
still present.

```bash
docker build --progress=plain \
  -f deploy/evalscope/Dockerfile \
  -t databench-evalscope:e3 .
```

The source, patch, Python dependency graph, base-image digest and runtime assets are pinned. A fresh build still needs
network access for Debian and PyPI downloads; this repository does not vendor a wheelhouse or Debian package mirror.
Offline installation must therefore load the prebuilt image from the release bundle. A fresh
`docker build --network=none` is intentionally outside the integration gate; target-host offline installation and
runtime remain mandatory.

## Runtime configuration

The service fails closed unless all required values are present:

| Variable | Purpose |
|---|---|
| `EVALSCOPE_SERVE_WEB=false` | Mandatory backend-only mode |
| `EVALSCOPE_OUTPUT_DIR` | Persistent task/report root |
| `EVALSCOPE_INPUT_DIR` | Bounded exact-Dataset staging root |
| `EVALSCOPE_ALLOWED_MEDIA_ROOTS` | Optional comma-separated roots contained by input/output roots |
| `EVALSCOPE_TASK_CONFIG_HMAC_KEY` | Stable secret, at least 32 UTF-8 bytes, for task claims |
| `EVALSCOPE_OPERATOR_TOKEN` | Stable operator-only reconcile credential, at least 32 UTF-8 bytes |
| `DATABENCH_BASE_URL` | Internal Databench API origin |
| `DATABENCH_SERVICE_CREDENTIAL` | Optional internal service credential |
| `DATABENCH_ORIGIN` | Exact browser origin used by generated-document CSP |
| `EVALSCOPE_MODEL_ENDPOINT_POLICY` | Absolute path to strict `model-endpoint-policy-v1` JSON; absent means deny all |
| `EVALSCOPE_MODEL_CREDENTIALS` | Optional absolute path to the read-only `evalscope` credential projection |
| `EVALSCOPE_PLOTLY_ASSET_PATH` | Must point to the pinned local Plotly asset |
| `EVALSCOPE_PLOTLY_ASSET_SHA256` | Must equal the digest in `upstream.lock` |

Optional bounded settings are `EVALSCOPE_INPUT_MAX_BYTES`, `EVALSCOPE_OUTPUT_MAX_BYTES`,
`EVALSCOPE_REQUEST_MAX_BYTES`, `EVALSCOPE_RESPONSE_MAX_BYTES`, `EVALSCOPE_DOCUMENT_MAX_BYTES`,
`EVALSCOPE_DOCUMENT_TTL_SECONDS`, `EVALSCOPE_MAX_CONCURRENT_EVALS`, `EVALSCOPE_MAX_CONCURRENT_PERF` and
`EVALSCOPE_MAX_TASKS`. E9 additionally bounds `EVALSCOPE_TASK_RUNTIME_SECONDS`,
`EVALSCOPE_EVALUATION_SAMPLE_LIMIT_MAX`, `EVALSCOPE_EVALUATION_BATCH_SIZE_MAX`,
`EVALSCOPE_EVALUATION_REPEATS_MAX`, `EVALSCOPE_PERFORMANCE_PARALLEL_MAX`,
`EVALSCOPE_PERFORMANCE_REQUESTS_MAX`, `EVALSCOPE_PERFORMANCE_RATE_MAX`,
`EVALSCOPE_MODEL_TOKENS_MAX` and `EVALSCOPE_REQUEST_TIMEOUT_SECONDS_MAX`.
`EVALSCOPE_MODEL_REDIRECT_MAX_HOPS` must remain `0`. ADR 0019 MR4 supersedes the former comma-separated
`EVALSCOPE_MODEL_ENDPOINT_ALLOWLIST` and `EVALSCOPE_DATASET_ENDPOINT_ALLOWLIST`; they are not runtime inputs.

The production command is fixed to one Gunicorn worker with eight threads. One process owns the in-memory upstream
process registry; the threads allow progress/log/stop requests while an invoke request blocks.

After payload validation and digesting, a new task is atomically claimed before capacity, drain, Registry, endpoint,
credential or provider I/O. Existing active/terminal claims replay without consulting current capacity, Deployment
lifecycle, endpoint policy or credentials. A new Model Version Deployment task resolves internal v2 exactly once,
then applies endpoint policy and resolves any bearer credential just in time. The child process installs the
pinned-address socket guard before importing the upstream execution path; every connection must remain inside the one
approved DNS snapshot, redirects and ambient proxies are disabled, and normal hostname-based TLS verification stays
enabled.

Bearer secrets cross the spawn boundary only through an anonymous file descriptor handed off with
`multiprocessing.reduction.DupFd`. The child reads the descriptor into memory; the parent task config, argv,
environment, task claim, integration manifest, response and archive never contain the secret. `auth_profile=none`
does not create or send a credential descriptor.
Offline native Benchmark data must be pre-populated or supplied through the reviewed Databench Dataset path; there is
no general remote Dataset allowlist runtime input.

## Databench gateway

The API gateway remains disabled unless the operator sets all three values:

```text
DATABENCH_EVALSCOPE_ENABLED=true
DATABENCH_EVALSCOPE_INTERNAL_BASE_URL=http://evalscope:9000
DATABENCH_EVALSCOPE_ALLOWED_ROUTES_MANIFEST=/app/evalscope-api-routes.json
```

The manifest is checked against the compiled method/path allowlist at startup. Unknown paths, methods, query fields,
redirects, response media types and oversized bodies fail closed. Browser authorization and cookies are not forwarded.
The upstream root, `/api/v1/eval/resume/invoke` and `/api/v1/reports/scan` are intentionally unavailable.

`DATABENCH_EVALSCOPE_INTRANET_HTTP_DOCUMENTS` defaults to `false`. The ADR 0012 trusted-network offline Compose
sets it to `true` because browsers omit Fetch Metadata on non-loopback plain HTTP origins. That compatibility path
accepts only requests with all Fetch Metadata absent and a same-origin HTTP `Referer` below `/evaluations`; explicit
top-level destinations, missing/cross-origin referrers and partial metadata remain forbidden. The gateway still injects
`Sec-Fetch-Dest: iframe` toward the provider, whose document route remains strict.

The E9 offline Compose enables this gateway only in the ADR 0012 trusted-network release. It loads the digest-locked
prebuilt image, mounts persistent input/output roots, publishes no EvalScope host port and applies CPU/memory/PID/GPU
bounds. General deployments remain disabled-by-default; this scoped offline enablement is not public-cloud
authorization.

## Drain and lifecycle

The internal operator endpoints `/internal/v1/operator/drain`, `/internal/v1/operator/status` and
`/internal/v1/operator/resume` require the stable operator token and are not part of the browser gateway manifest.
Drain atomically rejects new invoke requests while progress/log/stop/report remain available. Offline backup,
upgrade, rollback and restart stop Web admission, drain active tasks, then stop API/EvalScope/Worker. A drain timeout
cancels maintenance and resumes admission instead of killing a task silently.

Offline backup contains the EvalScope input/output volume together with PostgreSQL and MinIO, and encrypts the
stable EvalScope config for escrow. The operator procedure is in
`deploy/offline/EVALSCOPE-OPERATOR-GUIDE.zh-CN.md`; upstream source/UI/Python updates follow
`docs/evalscope/UPSTREAM-UPGRADE.md`.

## Verification

```bash
uv run --project workers/evalscope --frozen pytest -q workers/evalscope/tests
pnpm evalscope:parity:check
pnpm evalscope:parity:test
```

Runtime health is `GET /health`. Generated HTML is never returned by a report endpoint: the endpoint returns a
short-lived opaque document descriptor, and the document route requires `Sec-Fetch-Dest: iframe` and emits nonce CSP,
`nosniff` and `no-referrer` headers. The consumer iframe must omit `allow-same-origin`.
