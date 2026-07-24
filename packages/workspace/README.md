# @databench/workspace

Trusted orchestration boundary for canonical post-training datasets.

`V2Workspace` owns the catalog namespace, immutable object layout, cache, identity allocation,
transform concurrency, refs, lineage, audit, and converter/export lifecycle. Applications depend on
this package plus `@databench/schema`; they do not import Catalog, Store, Engine, Ops, or IO directly.

The `V2` names are stable protocol and persistence identifiers. Product UI and CLI routes are
unversioned, but these internal names remain explicit to protect stored data compatibility.
