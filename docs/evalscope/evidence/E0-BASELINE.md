# E0 EvalScope baseline evidence

- **Captured:** 2026-07-27
- **Upstream:** `modelscope/evalscope@b2a62f05fd81e89ec2cf4f83b9a79ce0a5535d60`
- **Tree:** `a47b532bc1644e9d19a4dac4110cf9dfcc7705bd`
- **Scope:** classification and threat evidence only; no EvalScope runtime or user route is enabled in E0

## Source baseline

The locked `evalscope/web/src` contains 183 files, 34 `*.test.ts(x)` files, 21,096 TypeScript/TSX lines and 544 CSS
lines. `apps/web/src/evaluations/upstream-manifest.json` records every file's SHA-256. Its generator verifies the Git
commit against `deploy/evalscope/upstream.lock` before writing.

Reproduction against an explicit checkout:

```bash
node scripts/generate-evalscope-upstream-manifest.mjs --upstream /path/to/evalscope
pnpm evalscope:parity:check
pnpm evalscope:parity:test
```

The baseline check accepts `planned` capability targets so implementation can proceed. GE7 uses
`pnpm evalscope:parity:check:green`, which rejects planned tests/evidence, missing target files and any non-green
capability.

## Router and CSS collision evidence

The locked `App.tsx` owns a `BrowserRouter`, wildcard redirect, `MainLayout`, theme/locale/report providers and eleven
page/redirect routes. None of that application boot is portable into the Databench root. The page mappings in the
technical design target the existing TanStack Router tree; direct refresh and typed search params are capability tests,
not React Router compatibility shims.

The locked `index.css` contains 544 lines and writes generic tokens such as `--radius`, `--bg`, `--accent`, `--text`,
`--border`, `--danger` and chat/chart tokens into `:root` and `[data-theme]`, plus global `html` and `body` rules. It is
therefore classified as supporting source, not imported CSS. E4 must map common controls to Databench primitives and
scope Evaluation-only tokens as `--es-*` under `.evaluation-surface`; CSS drift tests reject new root selectors and
unscoped generic variables.

The upstream web dependency lock is fixed in `deploy/evalscope/upstream.lock`. React Router is deliberately excluded;
Markdown, KaTeX, syntax highlighting and chart dependencies must remain lazy Evaluation chunks.

## Output-layout evidence

The service writes both execution state and report discovery data under `OUTPUT_DIR`:

```text
<OUTPUT_DIR>/<task_id>/
├── progress.json
├── logs/eval_log.log
├── reports/report.html
└── perf/
    ├── progress.json
    ├── benchmark.log
    └── perf_report.html
```

Historical performance discovery also accepts upstream CLI layouts such as `<timestamp>/<model>/`, per-run
`parallel_*`/`rate_*` directories and `benchmark_data.db`. Structured report endpoints resolve dataframes,
predictions, reviews, analyses and media relative to the selected report directory. E3 replaces every browser path
with an opaque provider locator, enforces configured-root realpath containment and keeps active process registration
separate from persistent output evidence. E8 archives a deterministic allowlist rather than copying an arbitrary
directory tree.

## Endpoint classification

`deploy/evalscope/api-routes.json` is the method + exact-path truth. Its default is blocked. It records 31 upstream
routes, two Databench-generated safe-document routes and the SPA root/catch-all exclusions.

Two upstream routes are explicitly blocked:

- `POST /api/v1/eval/resume/invoke`: the React UI does not call it and Databench does not claim subprocess recovery;
- `GET /api/v1/reports/scan`: replaced by configured-root `/reports/list` refresh without a browser-supplied path.

All `allowed-patched` responses require the Zod, size, path and active-content changes in E3 before the gateway can be
enabled. The manifest does not authorize a wildcard `/api/v1/*` proxy.

## Active-content threat inventory

| Source | Locked evidence | E3 control and negative evidence |
|---|---|---|
| evaluation report template | `report/template/report.html.j2`: Plotly script plus multiple `\| safe`, including `analysis_html` | parse/sanitize/rebuild; raw template bytes never reach browser |
| performance report template | `report/template/perf_report.html.j2`: Plotly script and chart `\| safe` blocks | same generated-document pipeline |
| evaluation report renderer | `report/renderer.py:74,124,138,162,299,324,335`: Markdown→HTML, Plotly HTML, `autoescape=False`, CDN injection | sanitize Markdown model; local Plotly; malicious Markdown/event/URL corpus |
| performance renderer | `perf/utils/report/generate_report.py:137,155`: `autoescape=False` and CDN injection | sanitize and local-asset rewrite |
| report chart endpoint | `service/blueprints/reports.py:608-610`: standalone Plotly HTML and external script | return opaque `GeneratedDocumentDescriptor`, never HTML |
| performance archive charts | `service/perf_archive.py:414-424`: standalone iframe HTML and external script | same descriptor and local renderer |
| viewer frames | `web/src/pages/ReportViewerPage.tsx:48`, `components/charts/ChartFrame.tsx:259` | iframe omits `allow-same-origin`; document endpoint requires iframe fetch destination |
| top-level navigation | `TaskMonitor.tsx:85`, `ReportHeader.tsx:90`, `ReportsPage.tsx:217`, `PerfReportsPage.tsx:161` | open Databench viewer with opaque ID; raw URLs rejected and `noopener noreferrer` required |

Generated-document response policy is fixed by the technical design: random nonce, `default-src 'none'`, local
digest-pinned Plotly only, no connect/object/frame sources, `sandbox allow-scripts`, `nosniff`, `no-referrer`, private
no-store and Databench-only `frame-ancestors`. Top-level document fetches fail closed.

## Plotly evidence

The locked source constant is
`https://resources.modelscope.cn/third-part/js/plotly/plotly-2.35.2.min.js`. On 2026-07-27 the retrieved asset was
4,558,696 bytes with SHA-256 `6d21266ce1bd7d9e5ab4e115989c70c20de0382fd973a8f26ab58619eba4d603`.
Plotly.js 2.35.2 is MIT licensed. E3 must vendor these exact bytes plus its license text into the image/offline manifest
and rewrite every source below:

- `evalscope/constants.py`;
- `evalscope/service/blueprints/reports.py`;
- `evalscope/service/perf_archive.py`;
- `evalscope/perf/utils/report/generate_report.py`;
- `evalscope/report/renderer.py`;
- `evalscope/report/template/report.html.j2`;
- `evalscope/report/template/perf_report.html.j2`.

Any missing rewrite or network request fails the offline gate.

## Benchmark fixture evidence

`apps/web/src/evaluations/fixtures/benchmarks-five-categories.json` is a pinned response fixture built from four locked
metadata files: `aa_lcr` (text/LLM), `a_okvqa` (multimodal/VLM), `automation_bench` (agent) and `evalmuse` (AIGC).
The `all` expectation is their aggregate. Source metadata SHA-256 values are embedded in the fixture.

The fixture proves schema and category preservation only. It does not claim that the entire upstream registry contains
four entries; the locked registry has 124 LLM, 57 VLM, 30 agent and 6 AIGC metadata files.

## E0 non-goals

E0 does not port a page, expose EvalScope, add a database table, change OpenAPI or alter V16/V17. Capability status
remains `planned`; no document may describe the UI as implemented until GE7 green mode passes.
