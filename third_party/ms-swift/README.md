# ms-swift upstream integration assets

This directory owns the third-party source inputs and compatibility baseline for ADR 0018. It intentionally contains
no Databench runtime service or deployment definition. Future Python Provider code belongs in
`workers/swift-studio/`; the Gateway belongs in `apps/api/src/swift-studio/`; Dockerfile, Compose and the deployment
runbook belong in `deploy/swift-studio/`. S1 provides those directories and a pinned, disabled-by-default GPU image.

## Locked upstream

```text
modelscope/ms-swift v4.4.2
commit f48847d23dbcd72ceb15fdbc5a1482cc7eb0359d
Gradio baseline 5.50.0
```

Files:

- `upstream.lock` — source, license, baseline environment, target image/ID/validation status and patch lock;
- `vendor/ms-swift-upstream.tar.gz` — deterministic `git archive` of the locked commit;
- `upstream-manifest.json` — tracked UI/build/license source digests;
- `gradio-baseline.json` — normalized 1,005-component and 115-callback config baseline;
- `gradio-routes.json` — 76 HTTP/SSE/WebSocket routes required by the complete native app;
- `runtime-capabilities.json` — separates visible surfaces from installed and validated runtimes;
- `runtime-requirements.in` — complete native UI dependency intent;
- `runtime-provided.txt` — exact CUDA/PyTorch distributions supplied by the base image;
- `runtime-requirements.lock` — hash-locked Linux/amd64 Python dependency closure;
- `upstream.lock.runtime_target.build_helper_*` — repository-relative path and SHA-256 for the audited
  `scripts/apply-swift-patch.py` image-build helper;
- `patches/0001-databench-session-prefill.patch` — root path and Session prefill integration patch;
- `patches/0002-python311-attrdict3-metadata.patch` — one-line Python 3.11 package-metadata compatibility patch.

## Regeneration

The source manifest is generated from a clean checkout at the locked commit:

```bash
node scripts/generate-swift-upstream-manifest.mjs /path/to/ms-swift
```

The Gradio baseline must use the exact versions in `baseline_environment`:

```bash
PYTHONPATH=/path/to/ms-swift \
  /path/to/locked/python \
  scripts/generate-swift-gradio-baseline.py /path/to/ms-swift
```

Regeneration is an explicit upstream upgrade action. Normal installs and builds consume the committed fixtures and do
not discover a floating checkout.

The Linux dependency lock is regenerated with the pinned resolver inputs:

```bash
pnpm swift:lock:generate
```

## Checks

```bash
pnpm swift:baseline:check
pnpm swift:baseline:test
pnpm swift:baseline:check:green
```

The checks validate the committed S0 evidence, including the digest-pinned Linux/NVIDIA base image, hashed dependency
lock and the separation between base-image-provided CUDA/PyTorch packages and pip-installed packages. The current
built image ID remains `cpu-gateway-browser-green-gpu-pending` until that same ID passes the real GS1 runner.

## Patch boundary

The downstream patch may touch only:

```text
swift/ui/app.py
swift/ui/llm_train/dataset.py
swift/ui/llm_train/hyper.py
swift/ui/llm_train/runtime.py
setup.py (only in the separate attrdict3 package-metadata patch)
```

It must preserve all seven top-level native surfaces and the upstream callback graph. Training execution continues to
belong to ms-swift until the separately accepted S6 control-plane work.
