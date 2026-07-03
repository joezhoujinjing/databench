# @databench/ops

Built-in transforms and the registry consumed through `@databench/workspace`.

Public API:

- `BUILTIN_TRANSFORMS`: fixed registry for `dedup`, `filter_by_signal`, `sample_n`, and `enrich_length`.
- Individual transform exports for focused tests and future workspace wiring.

Apps must not import this package directly; route or command handlers go through
`@databench/workspace`.
