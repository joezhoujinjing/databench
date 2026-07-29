# EvalScope upstream UI and Python upgrade runbook

EvalScope upgrades are source migrations, not a floating dependency bump. The current baseline is
`modelscope/evalscope@b2a62f05fd81e89ec2cf4f83b9a79ce0a5535d60`.

## Required inputs

1. Select one full upstream commit and record commit, tree and commit date.
2. Produce a deterministic source archive and record its byte size/SHA-256.
3. Lock Python and Web dependency inputs, base-image digest, Plotly bytes/license and required offline data assets.
4. Regenerate the file-level source manifest; no upstream production/test file may be unclassified.
5. Diff Flask `url_map` against `deploy/evalscope/api-routes.json`. Every new method/path starts blocked.

Do not update `upstream.lock`, the vendor archive, downstream patch or dependency lock independently.

## Compatibility matrix

| Surface | Required comparison |
|---|---|
| Python task API | invoke/stop/progress/log/report schemas, process registry, output layout |
| Reports | list/load/dataframe/predictions/analysis/media and active HTML generation |
| Performance | invoke/catalogue/detail/chart/runs/requests/history/compare |
| Benchmarks | all/text/multimodal/agent/aigc metadata and task configuration |
| Databench adapter | `general_qa`, `_databench` metadata, exact Dataset input and callbacks |
| UI | every upstream business capability against the Databench migrated target |
| Security | path/Dataset locators, SSRF/DNS/redirect, task claim, sanitizer/CSP/Plotly, secrets |
| Release | backend-only image, seven-image offline bundle, drain/backup/upgrade/rollback |

For each row record compatible, adapted, replaced, excluded or blocking with a target test/evidence link. Brand shell
exclusions cannot hide a business behavior.

## Execution order

1. Update the vendor archive and `upstream.lock` in one change.
2. Rebase the downstream patch. Keep `EVALSCOPE_SERVE_WEB=false`, duplicate process registration protection, socket
   guard and local Plotly rewrite.
3. Re-lock `workers/evalscope/uv.lock`; inspect additions for GPU/CUDA packages, executable downloads and network
   clients.
4. Regenerate upstream/capability manifests and pinned response/Benchmark fixtures.
5. Re-run Python/API/Web parity, active-content and egress failure injection before allowing a new route.
6. Build a linux/amd64 backend-only image; verify `evalscope/web` is absent and the image uses no floating input.
7. Build a new offline bundle and execute disconnected install → eval → report → archive → restart → upgrade →
   rollback on Ubuntu 22.04 amd64.

## Route decision rule

A new upstream endpoint is not automatically proxied. Add it only when a migrated Databench capability requires it,
its method/path/query/body/response are bounded, active-content and locator behavior are reviewed, and both compiled
allowlist plus manifest change together. Operator endpoints remain internal and must never enter the browser gateway.

## Rollback decision

Stop the upgrade if any fixed fixture changes without an accepted semantic explanation, an upstream route appears
without classification, raw HTML/CDN assets return, a new dependency needs unreviewed egress/GPU, or the previous
offline release cannot read the expanded database/object layout. Keep the old image, source archive, release bundle
and backup generation until the disconnected rollback gate passes.
