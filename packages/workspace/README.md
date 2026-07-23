# @databench/workspace

Workspace orchestration for ingest, transforms, recipes, lineage, refs, and export.

Public API:

- `Workspace`: async orchestration over `@databench/store` and `@databench/catalog`.
- `V2Workspace`: immutable publish/read/transform/lineage orchestration plus
  exact-version converter inspect and fidelity-authorized streaming export.
- `mix`, `recipeFingerprint`, `transformCacheKey`, and `recipeCacheKey`: deterministic recipe/run helpers used by the workspace and tests.
