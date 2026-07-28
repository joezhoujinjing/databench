# Swift Studio deployment

This directory contains deployment-only assets for the native ms-swift runtime. Upstream source, patches and locks
remain under `third_party/ms-swift/`; Databench Provider source remains under `workers/swift-studio/`.

## Build

The canonical image reference is digest pinned in `third_party/ms-swift/upstream.lock`. If Docker Hub is unreachable,
the same manifest may be read through a mirror while retaining the locked digest:

```bash
docker buildx build \
  --platform linux/amd64 \
  --build-arg SWIFT_BASE_IMAGE=docker.m.daocloud.io/pytorch/pytorch@sha256:417bd75df6365104c283ea4c1651fb3530d9eb5a4c2fafa51943cff2a94e6385 \
  --load \
  -f deploy/swift-studio/Dockerfile \
  -t databench/swift-studio:4.4.2 .
```

## GPU runtime

On a Linux host with the NVIDIA Container Toolkit:

```bash
docker compose -f deploy/swift-studio/compose.yaml --profile swift-gpu up -d --build
```

The local profile exposes exactly one GPU to the Studio and defaults to host device `0`. Select another device
explicitly with `DATABENCH_SWIFT_GPU_DEVICE_ID`; multi-GPU allocation belongs to the later allocator step.

The development Compose file publishes Gradio and Provider only on loopback ports `17860` and `17861`. Databench
still embeds Gradio through its `/swift-studio/*` Gateway; those loopback bindings are not production product ports.
Production deployment should keep both container ports private.

Configure a locally running API with:

```text
DATABENCH_SWIFT_STUDIO_ENABLED=true
DATABENCH_SWIFT_STUDIO_DATABENCH_BASE_URL=http://host.docker.internal:8000
DATABENCH_SWIFT_STUDIO_INTERNAL_BASE_URL=http://127.0.0.1:17860
DATABENCH_SWIFT_STUDIO_PROVIDER_BASE_URL=http://127.0.0.1:17861
DATABENCH_SWIFT_STUDIO_ROUTES_MANIFEST=<absolute-repo-path>/third_party/ms-swift/gradio-routes.json
DATABENCH_SWIFT_STUDIO_MAX_CONCURRENT_REQUESTS=64
DATABENCH_SWIFT_STUDIO_MAX_WEBSOCKET_CONNECTIONS=32
```

The Provider must also be able to call that Databench API origin to stream the exact export. The development
Compose profile defaults `DATABENCH_SWIFT_DATABENCH_BASE_URL` to `http://host.docker.internal:8000` and maps the
Linux host gateway. When API-to-Provider authentication is enabled, set the same bounded secret in both
`DATABENCH_SWIFT_STUDIO_PROVIDER_CREDENTIAL` for the API and `DATABENCH_SWIFT_PROVIDER_CREDENTIAL` for Compose.
The Provider uses that bearer in both directions: incoming Session control and outgoing Databench export.

The Gateway defaults to a 2 GiB request limit, 16 GiB response limit, 24 hour streaming timeout, 64 concurrent
HTTP responses and 32 WebSocket connections. Upload/download/Queue/SSE routes use the streaming timeout; document
and static routes use the regular timeout. Browser cookies and Databench Authorization are not forwarded into
Gradio.

For a development API on a non-default port, point Vite at it without changing source:

```bash
DATABENCH_DEV_API_ORIGIN=http://127.0.0.1:18080 pnpm --filter @databench/web dev
```

The browser iframe remains fixed at the same-origin `/swift-studio/` path. A cross-origin API base is intentionally
reported as unsupported because iframe navigation cannot carry the Databench bearer header and the Gateway uses
`SAMEORIGIN` framing.

## Dataset and Session bridge

The product API owns the public `/v2/swift-studio-sessions*` contract. It resolves an exact Dataset version, checks
the pinned `ms-swift@1.0.0` converter fidelity, measures the deterministic export, and then asks the private Provider
to create one active Session. The Provider streams that exact export from Databench, verifies BLAKE3, byte count,
LF-delimited record count and content type, then publishes the input with partial + fsync + rename.

For a ready Session the native Gradio load callbacks read the private Provider context and prefill the same Dataset,
output and logging roots in Train, RLHF and GRPO. The complete native UI and upstream callbacks remain present. When
there is no ready Session, `/training` does not mount the iframe and the native banner also reports that a Databench
Session is required.

The initial bridge intentionally allows only one active Session per configured namespace/runtime. Session close and
Provider cleanup use the exact opaque Session locator; they do not scan or prefix-delete workspace directories.
Multi-Session allocation and GPU scheduling belong to the later S5 control-plane step.
