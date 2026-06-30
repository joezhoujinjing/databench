# @databench/catalog

Prisma/Postgres control-plane catalog for dataset metadata, transform cache rows, lineage producers, and named refs.

Public API:

- `Catalog`: async dataset/run/ref catalog operations.
- `createPrismaClient(options)`: Prisma client factory using the Postgres driver adapter.
