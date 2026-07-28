# E7 complete native UI parity evidence

Date: 2026-07-28
Upstream: `modelscope/evalscope@b2a62f05fd81e89ec2cf4f83b9a79ce0a5535d60`

## Scope and fixture boundary

E7 completes the remaining EvalScope React business surfaces inside the existing Databench SPA:
Dashboard, Evaluation Compare, Performance catalogue/detail/runs/requests/compare, Benchmark catalogue/detail,
and the safe HTML viewer. Databench continues to own the application shell, TanStack Router, locale, theme and
visual system. No EvalScope logo, top navigation, `BrowserRouter`, second SPA or editable server path is present.

The desktop browser session used the configured local EvalScope source and contained:

- 1 evaluation report;
- 3 performance reports;
- 217 Benchmarks: 124 text, 57 multimodal, 30 agent and 6 AIGC.

The single evaluation report is an explicit fixture-cardinality limit: a real two-report Evaluation Compare could
not be produced without creating synthetic result state or rerunning an evaluation. The browser therefore verifies
the less-than-two state, while 2–3 slots, URL recovery, intersection, filters, keyboard navigation and per-column
failure isolation are covered by the migrated domain and static tests. No fake report was created for this gate.

Owner direction excludes phone portrait layout from this Web gate. E7 was reviewed as a desktop Web surface; it
does not make a mobile-portrait acceptance claim.

## Browser

The browser ran against `http://127.0.0.1:5173` with the Databench API and the configured same-origin EvalScope
gateway available.

### Dashboard

- Rendered evaluation, performance, distinct-model and latest-run KPIs from both configured report sources.
- KPI navigation, recent-run type filter, search, page state and direct-refresh URL restoration worked.
- The merged feed kept evaluation and performance entries sorted by time without pre-truncating one source.
- The partial-source path preserves successful data; welcome, no-data and no-match states remain explicit.

### Evaluation Compare

- Direct navigation normalized URL state to `tab=score`, `threshold=0.5` and `sample=1`.
- With one real evaluation report, the page rendered the named “请选择至少2个报告进行对比” state and linked
  back to Reports instead of rendering an invalid comparison.
- `domain/compare.test.ts`, `routes/contracts.test.ts` and `e7-static.test.ts` cover the 2–3 report cap, add/remove,
  URL serialization, common dataset/subset intersection, no-intersection state, metric-native score model,
  per-model presets, aligned pagination, Left/Right navigation and independent failed report columns.

### Performance

- The catalogue rendered three real reports with independent Provider and Protocol fields, search/sort, selection,
  clear, HTML-viewer and two-or-more Compare actions.
- Performance Compare selected the oldest report as baseline and the newest as candidate, supported swap, persisted
  both sides in the URL across reload, and rendered absolute/percent deltas, direction-aware verdicts, sample-size
  severity, workload compatibility, symmetric configuration differences and chart/table fallbacks.
- Detail routes covered single-run default routing, hidden Charts for a single run, summary/best/config/recommendation
  content, `INF` as closed-loop, workload rows, nullable percentile cells, All/Success/Failed request filtering and
  chart/table states.
- P90/P95/P99 de-emphasis followed the locked `<30`, `30–99` and `>=100` sample thresholds.

### Benchmarks

- Category buttons and counts matched the configured 217-entry source: All 217, Text 124, Multimodal 57, Agent 30
  and AIGC 6. Selecting Multimodal wrote `category=multimodal&page=1` to the URL.
- The 300 ms search wrote `search=ChartQA`; a direct reload restored the query and the single matching card.
- Selecting `Knowledge` and `QA` wrote both tags to the URL and used any-tag matching: cards containing only
  `Knowledge` and cards containing only `QA` both remained visible. Removing both chips reset the URL and list.
- The ChartQA detail dialog rendered localized Markdown headings, lists, tables, code samples, full metadata and
  Paper fallback. Escape closed the dialog and restored focus to the originating ChartQA card.
- “用于测评任务” navigated to `/evaluations/tasks?benchmark=chartqa&tab=eval`; the Evaluation tab and built-in
  Benchmark source opened with the dataset combobox preselected to `chartqa`. This Databench extension is tracked
  separately and does not increase upstream parity coverage.

### Safe viewer and security replacement

- A generated report loaded only through `/evalscope-api/generated-documents/<opaque-id>`.
- The document frame uses `sandbox="allow-scripts"` and never grants `allow-same-origin`.
- Same-page and new-tab actions target the Databench `/evaluations/viewer?document=<opaque-id>` route; raw generated
  HTML is not used as top-level navigation.
- Viewer loading, load completion and error states are explicit, and chart content retains a text/table fallback.

### Console and visual shell

- The final desktop route session reported no browser `warn` or `error` console entries.
- Visual inspection confirmed the existing Databench header and Evaluation secondary navigation on every route,
  with Databench typography, spacing, control primitives and status language. There is no EvalScope application
  header, logo, GitHub entry, theme switch, locale switch or editable output-root control.

## Automated closure

- `e7-static.test.ts` locks the page-level Dashboard, Compare, Performance, Benchmark and Viewer contracts and maps
  every non-excluded upstream file plus all 34 upstream test files to an existing local target.
- `domain/dashboard.test.ts`, `domain/compare.test.ts`, `domain/benchmarks.test.ts` and
  `domain/performance/*.test.ts` cover the migrated pure behavior against pinned response shapes.
- `api/client.test.ts`, `api/routes.test.ts`, schema tests and `routes/contracts.test.ts` retain exact-operation,
  fail-closed response and URL normalization boundaries.
- `pnpm evalscope:parity:check:green` is the capability-level completion gate; the full repository gate is recorded
  in `docs/evalscope/STATUS.md`.
