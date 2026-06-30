# @databench/workspace

Workspace orchestration for ingest, transforms, recipes, lineage, refs, and export.

Public API:

- `Workspace`: async orchestration over `@databench/store` and `@databench/catalog`.
- `mix`, `recipeFingerprint`, `transformCacheKey`, and `recipeCacheKey`: deterministic recipe/run helpers used by the workspace and tests.
