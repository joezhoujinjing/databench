# @databench/engine

Dataset, frame, transform, Parquet, and deterministic engine helpers.

Public API:

- `Dataset`: immutable content-addressed dataset construction, sample iteration, head, Arrow/Polars conversion, and manifest/version access.
- Transform helpers: `Transform`, `defineTransform`, and parameter canonicalization used by built-in ops and workspace runs.
- Deterministic helpers: `bankersRound`, row digest/version construction, and Python-compatible JSON loading behavior.
- Parquet helpers used by `@databench/store`; object storage code stays outside this package.
