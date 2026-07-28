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
| `EVALSCOPE_MODEL_ENDPOINT_ALLOWLIST` | `scheme|CIDR-or-host|port` entries; empty denies every model endpoint |
| `EVALSCOPE_DATASET_ENDPOINT_ALLOWLIST` | Optional reviewed `scheme|host-or-CIDR|port` entries used only by native Benchmark adapters; empty denies remote Dataset downloads |
| `EVALSCOPE_PLOTLY_ASSET_PATH` | Must point to the pinned local Plotly asset |
| `EVALSCOPE_PLOTLY_ASSET_SHA256` | Must equal the digest in `upstream.lock` |

Optional bounded settings are `EVALSCOPE_INPUT_MAX_BYTES`, `EVALSCOPE_OUTPUT_MAX_BYTES`,
`EVALSCOPE_REQUEST_MAX_BYTES`, `EVALSCOPE_RESPONSE_MAX_BYTES`, `EVALSCOPE_DOCUMENT_MAX_BYTES`,
`EVALSCOPE_DOCUMENT_TTL_SECONDS`, `EVALSCOPE_MAX_CONCURRENT_EVALS`, `EVALSCOPE_MAX_CONCURRENT_PERF` and
`EVALSCOPE_MAX_TASKS`. `EVALSCOPE_MODEL_REDIRECT_MAX_HOPS` must remain `0`.

The production command is fixed to one Gunicorn worker with eight threads. One process owns the in-memory upstream
process registry; the threads allow progress/log/stop requests while an invoke request blocks.

The model allowlist is enforced before a task is claimed. The child-process socket guard receives the union of the
model and Dataset allowlists so built-in Benchmark adapters can reach only operator-reviewed Dataset hosts. Adding a
Dataset host does not make that host an admissible browser-supplied model endpoint. Offline deployments keep the
Dataset allowlist empty and must pre-populate any native Benchmark data they intend to run.

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

The current offline Compose file carries the manifest but explicitly keeps this integration disabled. Adding the
prebuilt image, persistent volume and release lifecycle is an E9 release task; E3 does not silently change existing
offline installations.

## Verification

```bash
uv run --project workers/evalscope --frozen pytest -q workers/evalscope/tests
pnpm evalscope:parity:check
pnpm evalscope:parity:test
```

Runtime health is `GET /health`. Generated HTML is never returned by a report endpoint: the endpoint returns a
short-lived opaque document descriptor, and the document route requires `Sec-Fetch-Dest: iframe` and emits nonce CSP,
`nosniff` and `no-referrer` headers. The consumer iframe must omit `allow-same-origin`.
