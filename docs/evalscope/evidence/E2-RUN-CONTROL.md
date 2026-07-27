# E2 Evaluation Run Control Plane Evidence

- **Databench branch:** `feat/evalscope-integration-design`
- **EvalScope baseline:** `modelscope/evalscope@b2a62f05fd81e89ec2cf4f83b9a79ce0a5535d60`
- **Create identity profile:** `evaluation-run-create-v1`
- **Date:** 2026-07-27

## Boundary

E2 records only evaluations sourced from an immutable Databench Dataset version:

```text
exact Dataset version
  → re-inspect evalscope-general-qa normalized plan
  → verify accepted fidelity digest
  → derive benchmark + canonical create digest
  → create/replay evaluation_runs_v2
  → prepared → running → completed | failed | cancelled
```

It does not start EvalScope, proxy provider APIs, add `/evaluations/*` Web routes, archive result objects or index native
Benchmark/performance runs. All new API handlers reach persistence through Schema + Workspace.

## Persisted contract

Migration `0010_evaluation_runs_v2` adds an exact Dataset FK and namespace FK with `RESTRICT`, plus the unique locator
`(namespace_id, provider, provider_task_id)`. Raw checks enforce the provider, task/digest/name syntax, execution and
archive states, terminal timestamps, all-or-none artifact fields and bounded JSON shapes.

Postgres stores only normalized converter metadata, bounded metric summaries, opaque provider report IDs and bounded
errors. It rejects path/URL report locators, credential-like values, unknown metric/sample fields and oversized JSON.
Sample input, target, prediction, complete report and logs remain outside Postgres.

## Canonical create identity

`@databench/hashing` uses the domain
`databench.evaluation-run-create.evaluation-run-create-v1\0` and RFC 8785 serialization. The identity binds:

- provider and provider task ID;
- exact Dataset version and display-only source Ref;
- converter/version and normalized options;
- fidelity digest and derived benchmark;
- model summary and pinned EvalScope commit.

The committed fixed vector is:

```text
de467c5dd0ce450c5d234cbaefe483bf83ee97c307d578e3928f5150fa6d25b8
```

Concurrent Catalog creation has one winner. A replay with the same digest returns the existing run; the same provider
task with a different digest returns `evaluation_run_state_conflict/create_request_mismatch`.

## State and replay evidence

The Catalog transition is a single conditional `UPDATE`. Workspace accepts exact replays by comparing the canonical
terminal body and rejects a different body after terminal state. Tests cover:

- no direct `prepared → completed`;
- `prepared → running → completed`;
- `prepared|running → failed|cancelled`;
- same start/terminal replay;
- late or mismatched transition conflict;
- Ref movement after creation without changing the exact Dataset binding;
- Dataset/status-bound opaque pagination cursors.

## Real dependency evidence

- all 10 Prisma migrations deploy from an empty real Postgres test schema;
- Catalog: 36 tests, including a 16-way provider-task race, exact FK, transition matrix, maximum 32 × 512-byte report
  IDs and raw JSON rejection;
- Workspace real dependency suite: 155 passed, 10 unrelated gRPC tests skipped;
- API real dependency suite: 92 passed and exercises ingest → inspect → run create/replay/mismatch → start → complete
  → get/list over real Postgres and MinIO;
- CLI real dependency suite: 14 passed; existing Dataset/export behavior remains intact.

The EvalScope capability and UI route flags remain disabled. `evalscope:parity:check:green` must still fail because all
60 UI capabilities remain planned until E4-E7.
