# E3 backend runtime and security boundary evidence

- **Databench branch:** `feat/evalscope-integration-design`
- **EvalScope baseline:** `modelscope/evalscope@b2a62f05fd81e89ec2cf4f83b9a79ce0a5535d60`
- **Image:** `databench-evalscope:e3`
- **Date:** 2026-07-27

## Boundary

E3 adds the provider runtime and same-origin gateway without adding an Evaluation product route:

```text
browser (future E4-E7 UI)
  → Databench /evalscope-api exact method/path gateway
  → one-process threaded Gunicorn boundary
  → patched EvalScope Flask service

Databench exact Dataset
  → evalscope-general-qa inspect/export
  → task-local atomic JSONL staging
  → EvalScope general_qa evaluation
  → Databench evaluation_runs_v2 callback
```

The integration is disabled by default. There is still no `/evaluations/*` route and no migrated EvalScope React UI.

## Source and image evidence

`deploy/evalscope/upstream.lock` records and the Docker build verifies:

| Input | SHA-256 |
|---|---|
| upstream source archive | `39073ef3b55906cef8fc072a4851ee27e3efa064fd9289f84837a67730ed1579` |
| downstream patch | `e35cdc900e71f86da57f7c8719e5ca5a54192dfbac7e6ebdc2dbc8b7423b007f` |
| runtime `pyproject.toml` | `7fb019fd00c78a4c36fc2855d032db3ee3f516b44a3b8f7ab863090958d590f8` |
| `uv.lock` | `77164936061604223355e3be7cd7f16b14409ae7d88099d773a46d920d9cb365` |
| Plotly 2.35.2 | `6d21266ce1bd7d9e5ab4e115989c70c20de0382fd973a8f26ab58619eba4d603` |
| Plotly license | `67a26cf80f03ff388f26945dfc1f6caed1a0746ff43871190339b3aee49b94bb` |
| NLTK `punkt_tab` | `e57f64187974277726a3417ca6f181ec5403676c717672eef6a748a7b20e0106` |

The final local build produced image ID
`sha256:5266dc68033c51a46d2992f7f679128b993aba747d940103d42a9961b93d1f1c`. A clean archive extraction accepted the
patch with `patch --dry-run`; `compileall` completed for the Databench runtime and installed EvalScope tree. Upstream
contains existing invalid-escape `SyntaxWarning`s, but no compile error.

The image copies the complete patched Python package tree so report Jinja templates and Benchmark `_meta` JSON remain
available, then deletes the entire installed `evalscope/web` directory. Final-image checks verified both required data
files exist and the Web directory does not. The image also carries the Plotly MIT license at `/opt/vendor` and verifies
its locked digest during the build.

Build reproducibility is qualified precisely: source, base image and Python inputs are pinned, runtime can start from a
prebuilt image without public network access, and report rendering uses no public asset. A fresh build downloads
locked Debian/PyPI inputs; no wheelhouse or Debian mirror is committed. Owner decision on 2026-07-28 defines the
prebuilt image as the offline release boundary, so fresh `docker build --network=none` is intentionally not a GE3/GE9
requirement. The target-host prebuilt-image install/lifecycle remains an E9 gate.

## Backend-only and gateway evidence

The runtime exposes 32 routes: 31 reviewed browser/provider routes plus the operator-only reconcile route. The route
set exactly matches `api-routes.json` after excluding its explicit blocked entries. Tests and the final container verify:

- `GET /health` returns the pinned commit and readiness;
- upstream `/`, SPA catch-all, resume, scan and a synthetic new endpoint are unavailable;
- a wrong method, unknown/duplicate query field, arbitrary root and unexpected body fail before proxying;
- the API process validates the route manifest against its separately compiled allowlist before enabling;
- redirects, media-type confusion and oversized responses are rejected;
- browser `Authorization`, cookies and unrelated headers are not forwarded;
- Vite and offline Caddy route `/evalscope-api` only to the Databench API, never directly to EvalScope.

The operator reconcile endpoint is not in the browser gateway. It requires exact task syntax and a constant-time bearer
token check, converges persisted evidence and never resumes a provider subprocess.

## Task correctness and Databench Dataset evidence

The shared evaluation/performance admission path performs recursive native `dataset_args` locator rejection and model
endpoint authorization before creating a task claim. Tests cover normalized key aliases and nested objects/arrays,
POSIX/Windows/UNC paths, traversal, `file:`/URI-like values, scheme/host/port mismatch, metadata/link-local/private
addresses, DNS changes and redirects. The child-process socket guard revalidates every `getaddrinfo` result against the
operator allowlist immediately before the HTTP client connects.

Task claims use exclusive create plus a stable HMAC digest. Atomic manifests persist stop intent, terminal evidence and
callback confirmation without the API key, prompt, prediction, absolute path or signed URL. Tests cover same-ID races,
same-config active and terminal replay, mismatched config, process-registry overwrite rejection, stop/fail precedence,
malformed manifest quarantine, callback loss, manual reconcile and startup convergence of interrupted tasks.

A real isolated-schema smoke used:

```text
schema: databench_test_evalscope_e3
ref: evalscope-e3-smoke
version: fbcad2d79efa5756588c9ae91d5fe94180c8a959bb0fba09a5b9be8fba7cc65e
fidelity: ca0b8c91ec0112577b69753b3c112fd2a9e02edfe816b7443b70e64d071150aa
```

The completed path was:

```text
Databench ingest
→ evalscope-general-qa exact inspect/export
→ task-local general_qa injection
→ fake OpenAI-compatible model
→ EvalScope BLEU/ROUGE
→ Databench complete callback
→ evaluation_runs_v2 completed
```

Provider task `eval_123e4567-e89b-42d3-a456-426614174003` mapped to Databench run
`cc4874fe-b0a3-419e-8bfd-5923f75d3e0e`. Prediction metadata retained Dataset version, record ID/digest and candidate
ID under `_databench`. A second slow task, `eval_123e4567-e89b-42d3-a456-426614174004`, exercised concurrent
progress/log polling and stop; the Databench run converged to `cancelled` with `user_cancelled`.

The real run exposed one missing runtime input: EvalScope's default BLEU/ROUGE path requires NLTK `punkt_tab`. E3 now
vendors and verifies that exact package in the image.

## Generated content and report evidence

Raw upstream report/chart/performance HTML never crosses the boundary. It is parsed, sanitized and rebuilt from
bounded Plotly JSON with a fixed local asset. The descriptor contains an opaque 43-character ID and expiry; the
document route rejects top-level requests and requires `Sec-Fetch-Dest: iframe`.

The final image replayed the real report and verified:

- configured-root list returned one report and generation `1`;
- the text Benchmark catalogue returned 22 entries;
- top-level document request returned 403 and iframe request returned 200;
- CSP included `sandbox allow-scripts`, a per-document nonce and `connect-src 'none'`;
- `nosniff`, `no-referrer`, exact frame ancestor and no `allow-same-origin` dependency;
- no iframe/event-handler content and no public HTTP(S) resource remained;
- the served Plotly bytes matched the pinned SHA-256;
- numeric-leading Plotly element IDs from the real report were accepted safely.

Media responses additionally require realpath containment under configured roots plus an allowlisted extension,
MIME type and file signature.

## Automated evidence

- Python boundary suite: 51 passed;
- fresh patch application: passed;
- patched tree/runtime `compileall`: passed, with upstream-only warnings;
- final container: healthy, upstream Web absent, templates and Benchmark metadata present;
- real Dataset evaluation and stop/callback paths: passed;
- blocking invoke with concurrent progress/log polling: passed;
- gateway unit tests cover exact route/query/body/response and generated-document enforcement;
- real Postgres/MinIO suites: Workspace 155 passed, API 100 passed and CLI 14 passed;
- final image with Docker network mode `none`: health, real report document and pinned Plotly asset passed with no
  public resource locator;
- `pnpm evalscope:parity:check:green` remains an intentional failure because E4-E7 UI capabilities are still planned.
