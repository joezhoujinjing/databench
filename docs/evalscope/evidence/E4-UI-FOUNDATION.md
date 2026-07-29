# E4 — Databench Evaluation UI foundation evidence

## Outcome

E4 establishes the Databench-native Evaluation surface without claiming any E5–E7 business page as complete:

- the existing Databench React/Vite application and TanStack Router remain the only application shell;
- `/evaluations` plus tasks, reports, report detail, compare, performance list/detail/compare,
  Benchmarks and viewer routes are direct-refreshable lazy entries;
- the EvalScope browser adapter has one fixed `/evalscope-api/api/v1` base, exact operation descriptors and
  Zod validation for every allowed JSON endpoint;
- public config is strict and path-free; generated document descriptors bind their opaque ID to the only accepted
  same-origin document URL;
- report and performance locators use canonical UTF-8 base64url route keys and reject absolute, traversal, drive,
  URI-like, control-character and non-canonical values;
- the complete 322-key upstream English/Chinese business dictionary is registered lazily under
  `evaluations.*`; Databench remains the only locale owner;
- shared Button, Card, Tabs, Badge, Field, Alert, Skeleton and Table behavior maps to Databench primitives;
- all EvalScope visual tokens live under `.evaluation-surface` as `--es-*` variables.

The empty E4 routes state explicitly that their business controls are not migrated. They exist only to prove the
router, service boundary, locale, loading/error/not-found states and responsive shell. The corresponding dashboard,
task, report, comparison, performance, Benchmark and viewer capabilities remain `planned`.

## Contract and static checks

- `apps/web/src/evaluations/api/routes.test.ts` compares the Web exact-operation registry with
  `deploy/evalscope/api-routes.json`; all 32 browser-allowed JSON/document/media/asset routes match and no blocked
  route is exposed.
- `apps/web/src/evaluations/api/client.test.ts` covers fixed-base requests, invoke task headers, unknown query denial,
  404 unavailable mapping, strict path-free config, generated-document ID/URL binding and the committed five-category
  Benchmark fixture.
- `apps/web/src/evaluations/foundation-static.test.ts` rejects React Router, a second BrowserRouter, ThemeContext,
  LocaleContext, bare provider API paths and root Evaluation CSS tokens; it also asserts all 10 page routes and the
  lazy layout boundary.
- `apps/web/src/components/ui/tabs.test.tsx` covers the connected tab/tablist/tabpanel ARIA model, roving tab stop and
  wrapping Arrow/Home/End navigation.
- `apps/web/src/i18n/i18n.test.ts` checks English/Chinese key parity for both the Databench locale and the complete
  migrated EvalScope dictionary.
- production build emits 11 Evaluation dynamic entries. The automated bundle check records 844,927 initial JS bytes
  against a 950,000-byte budget and rejects Evaluation API, layouts, routes or full dictionaries in the Dataset
  initial static graph.

## Browser

The browser smoke used the E3 backend container at `127.0.0.1:19000` behind the real Hono same-origin gateway, then
restarted the API with the gateway disabled to exercise the unavailable boundary.

- Desktop ready: 1440×1000, `/evaluations`, config `200`, zero browser errors/warnings after stable load.
- Narrow ready: 390×844, same route, horizontal primary/subnavigation remains reachable, content reflows to one
  column, zero browser errors/warnings.
- Direct refresh: dashboard, tasks, reports, report detail, compare, performance list/detail/compare, Benchmarks and
  viewer all resolved inside the Databench shell. Unknown `/evaluations/unknown-route` rendered the localized nested
  404 state.
- `/evaluations/performance/compare?embedding=0` retained the canonical unquoted `embedding=0` search value across
  direct navigation and reload, rendered the correct route, and produced zero browser errors/warnings.
- Disabled gateway: config `404` produced the expected single failed-resource console entry and the accessible
  “测评服务不可用 / Retry” alert rather than a blank page or generic Databench failure.
- Databench LanguageSwitcher changed the complete shell and Evaluation boundary from Chinese to English; no
  EvalScope locale control or storage was mounted.
- React StrictMode cancelled superseded health/capability/config requests; subsequent requests completed `200`,
  demonstrating the cancellation boundary without stale UI.

Screenshots:

- [desktop ready](assets/e4/desktop-ready.png) —
  SHA-256 `7d6a70559a978f9fc8ec20dd27eb73b6b9468b66b4e44abf7fb17210bf22dd68`
- [narrow ready](assets/e4/narrow-ready.png) —
  SHA-256 `be1f6c6580e88e0b0d7b8434d2c56b2e33f6fbc8dcfb5037ce4bf39c2cf3a265`
- [desktop unavailable](assets/e4/desktop-unavailable.png) —
  SHA-256 `7dc27750ff8dff7ec3c8c1881d9e8d0bf4eda885396585e3e30c053d097679a8`

## Gate

Recorded after the final E4 tree:

- Web: 28 files / 88 tests;
- EvalScope parity baseline and negative checker tests;
- full repository lint, build, typecheck, test, OpenAPI, v2 status, peer and offline static gates;
- `git diff --check`.

`pnpm evalscope:parity:check:green` remains intentionally red because E5–E7 business capabilities are still
`planned`. E4 does not change V16/V17, public-cloud D3 or the disabled-by-default runtime policy.
