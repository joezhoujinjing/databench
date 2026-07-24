# @databench/catalog

Prisma/Postgres v2 control-plane catalog for immutable snapshots and layouts,
identity claims, transform runs, record lineage, and compare-and-set refs.

Public API:

- `V2Catalog`: v2 catalog operations and concurrency controls.
- `createPrismaClient(options)`: Prisma client factory using the Postgres driver adapter.
