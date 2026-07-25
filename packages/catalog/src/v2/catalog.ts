import { randomUUID } from 'node:crypto'
import { Prisma, type PrismaClient } from '@prisma/client'
import { createPrismaClient } from '../client.js'
import {
  V2CatalogConsistencyError,
  V2CatalogDeterminismConflictError,
  V2CatalogImmutableConflictError,
  V2CatalogInputError,
  V2CatalogLineageCycleError,
  V2CatalogRefConflictError,
  V2CatalogRefStateConflictError,
  V2CatalogTargetNotCommittedError,
} from './errors.js'
import type {
  CatalogIdentityClaimInputV2,
  CatalogIdentityClaimResultV2,
  CatalogIdentityClaimRowV2,
  CatalogJsonValueV2,
  CatalogLayoutInputV2,
  CatalogLayoutRowV2,
  CatalogRecordParentRowV2,
  CatalogRecordRevisionV2,
  CatalogRefPageV2,
  CatalogRefRowV2,
  CatalogRunInputV2,
  CatalogRunPageV2,
  CatalogRunRowV2,
  CatalogSnapshotInputV2,
  CatalogSnapshotRowV2,
  CompareAndSetRefV2,
  DeleteRefResultV2,
  DeleteRefV2,
  RegisterLayoutV2,
  RegisterTransformResultV2,
  RestoreRefResultV2,
  RestoreRefV2,
} from './types.js'

const EXACT_VERSION = /^[0-9a-f]{64}$/
const REGISTRATION_TRANSACTION_TIMEOUT_MS = 30_000
const REGISTRATION_BATCH_SIZE = 1_000
const MAX_CATALOG_PAGE_SIZE = 1_000
const POSTGRES_BIGINT_MAX = 9_223_372_036_854_775_807n

export interface V2CatalogOptions {
  readonly databaseUrl?: string
  readonly prisma?: PrismaClient
}

interface IdentityClaimSqlRow {
  readonly namespace_id: string
  readonly entity_kind: string
  readonly claim_key_digest: string
  readonly claim_profile: string
  readonly request_profile: string
  readonly creation_profile: string
  readonly entity_id: string
  readonly request_digest: string
  readonly created_at: Date
}

interface RefSqlRow {
  readonly namespace_id: string
  readonly name: string
  readonly version: string
  readonly num_records: bigint
  readonly message: string | null
  readonly updated_at: Date
  readonly deleted_at: Date | null
}

interface RefStateMutationSqlRow {
  readonly deleted_at: Date | null
}

interface RecordRevisionSqlRow {
  readonly record_id: string
  readonly record_digest: string
}

interface RecordParentSqlRow extends RecordRevisionSqlRow {
  readonly position: number
  readonly parent_record_id: string
  readonly parent_record_digest: string
}

interface LineageSnapshotSequenceSqlRow {
  readonly snapshot_sequence: bigint
}

export class V2Catalog {
  readonly #client: PrismaClient
  readonly #ownsClient: boolean

  constructor(options: V2CatalogOptions = {}) {
    this.#client =
      options.prisma ??
      createPrismaClient(
        options.databaseUrl === undefined ? {} : { databaseUrl: options.databaseUrl },
      )
    this.#ownsClient = options.prisma === undefined
  }

  async close(): Promise<void> {
    if (this.#ownsClient) await this.#client.$disconnect()
  }

  async getOrCreateNamespace(scope: 'default'): Promise<string> {
    const proposedId = randomUUID()
    const inserted = await this.#client.$queryRaw<Array<{ readonly id: string }>>`
      INSERT INTO "identity_namespaces_v2" ("id", "scope")
      VALUES (${proposedId}::uuid, ${scope})
      ON CONFLICT DO NOTHING
      RETURNING "id"
    `
    const created = inserted[0]
    if (created) return created.id

    const existing = await this.#client.v2IdentityNamespace.findUnique({ where: { scope } })
    if (!existing) {
      throw new V2CatalogConsistencyError(
        'V2 namespace insert conflicted but the winning row could not be read',
      )
    }
    return existing.id
  }

  async insertOrReadIdentityClaim(
    input: CatalogIdentityClaimInputV2,
  ): Promise<CatalogIdentityClaimResultV2> {
    return await this.#client.$transaction(async (tx) => {
      const inserted = await tx.$queryRaw<IdentityClaimSqlRow[]>`
        INSERT INTO "identity_claims_v2" (
          "namespace_id",
          "entity_kind",
          "claim_key_digest",
          "claim_profile",
          "request_profile",
          "creation_profile",
          "entity_id",
          "request_digest"
        )
        VALUES (
          ${input.namespaceId}::uuid,
          ${input.entityKind},
          ${input.claimKeyDigest},
          ${input.claimProfile},
          ${input.requestProfile},
          ${input.creationProfile},
          ${input.entityId},
          ${input.requestDigest}
        )
        ON CONFLICT DO NOTHING
        RETURNING
          "namespace_id",
          "entity_kind",
          "claim_key_digest",
          "claim_profile",
          "request_profile",
          "creation_profile",
          "entity_id",
          "request_digest",
          "created_at"
      `
      const created = inserted[0]
      if (created) return { status: 'created', row: sqlRowToClaim(created) }

      const existingClaim = await tx.v2IdentityClaim.findFirst({
        where: {
          namespaceId: input.namespaceId,
          entityKind: input.entityKind,
          claimKeyDigest: input.claimKeyDigest,
        },
      })
      if (existingClaim) {
        return { status: 'existing_claim', row: prismaRowToClaim(existingClaim) }
      }

      const existingEntity = await tx.v2IdentityClaim.findFirst({
        where: { namespaceId: input.namespaceId, entityId: input.entityId },
      })
      if (existingEntity) {
        return { status: 'existing_entity', row: prismaRowToClaim(existingEntity) }
      }

      throw new V2CatalogConsistencyError(
        'V2 identity claim insert conflicted but neither winning key could be read',
      )
    })
  }

  async registerCommittedLayout(input: RegisterLayoutV2): Promise<void> {
    validateRegistrationInput(input)
    await this.#client.$transaction(
      async (tx) => {
        await acquireLineageRegistrationLock(tx)
        await registerLayoutInTransaction(tx, input)
      },
      { timeout: REGISTRATION_TRANSACTION_TIMEOUT_MS },
    )
  }

  async registerTransformResult(input: RegisterTransformResultV2): Promise<void> {
    validateRegistrationInput(input)
    validateRunInput(input)
    await this.#client.$transaction(
      async (tx) => {
        await acquireLineageRegistrationLock(tx)
        await registerLayoutInTransaction(tx, input)
        await registerRunInTransaction(tx, input.run)
      },
      { timeout: REGISTRATION_TRANSACTION_TIMEOUT_MS },
    )
  }

  async getSnapshot(version: string): Promise<CatalogSnapshotRowV2 | null> {
    const row = await this.#client.v2DatasetSnapshot.findUnique({ where: { version } })
    return row ? prismaRowToSnapshot(row) : null
  }

  async getLayout(version: string, layout: string): Promise<CatalogLayoutRowV2 | null> {
    const row = await this.#client.v2DatasetLayout.findUnique({
      where: { datasetVersion_layoutVersion: { datasetVersion: version, layoutVersion: layout } },
    })
    return row ? prismaRowToLayout(row) : null
  }

  async findRun(cacheKey: string): Promise<CatalogRunRowV2 | null> {
    const row = await this.#client.v2Run.findUnique({
      where: { cacheKey },
      include: { inputs: { orderBy: { position: 'asc' } } },
    })
    return row ? prismaRowToRun(row) : null
  }

  async lineageSnapshotSequence(): Promise<bigint> {
    return await this.#client.$transaction(
      async (tx) => {
        await acquireLineageRegistrationLock(tx)
        const rows = await tx.$queryRaw<LineageSnapshotSequenceSqlRow[]>`
          SELECT COALESCE(MAX("lineage_seq"), 0)::bigint AS "snapshot_sequence"
          FROM "runs_v2"
        `
        const value = rows[0]?.snapshot_sequence
        if (rows.length !== 1 || typeof value !== 'bigint' || value < 0n) {
          throw new V2CatalogConsistencyError(
            'V2 lineage snapshot query did not return exactly one valid run sequence',
          )
        }
        return value
      },
      { timeout: REGISTRATION_TRANSACTION_TIMEOUT_MS },
    )
  }

  async listRunsProducing(
    version: string,
    afterCacheKey: string | null,
    limit: number,
    lineageSequenceAtOrBefore: bigint,
  ): Promise<CatalogRunPageV2> {
    const fetchLimit = checkedPageFetchLimit(limit, 'V2 producing-run page limit')
    if (!EXACT_VERSION.test(version)) {
      throw new V2CatalogInputError('V2 producing-run version must be 64 lowercase hex characters')
    }
    if (afterCacheKey !== null && !EXACT_VERSION.test(afterCacheKey)) {
      throw new V2CatalogInputError('V2 producing-run seek key must be 64 lowercase hex characters')
    }
    if (
      typeof lineageSequenceAtOrBefore !== 'bigint' ||
      lineageSequenceAtOrBefore < 0n ||
      lineageSequenceAtOrBefore > POSTGRES_BIGINT_MAX
    ) {
      throw new V2CatalogInputError(
        'V2 producing-run snapshot sequence must fit a non-negative PostgreSQL bigint',
      )
    }
    const keys =
      afterCacheKey === null
        ? await this.#client.$queryRaw<Array<{ readonly cache_key: string }>>`
            SELECT "cache_key"
            FROM "runs_v2"
            WHERE
              "output_version" = ${version} AND
              "lineage_seq" <= ${lineageSequenceAtOrBefore}
            ORDER BY "cache_key" COLLATE "C" ASC
            LIMIT ${fetchLimit}
          `
        : await this.#client.$queryRaw<Array<{ readonly cache_key: string }>>`
            SELECT "cache_key"
            FROM "runs_v2"
            WHERE
              "output_version" = ${version} AND
              "lineage_seq" <= ${lineageSequenceAtOrBefore} AND
              "cache_key" COLLATE "C" > ${afterCacheKey}
            ORDER BY "cache_key" COLLATE "C" ASC
            LIMIT ${fetchLimit}
          `
    const orderedKeys = keys.map(({ cache_key }) => cache_key)
    const rows = await this.#client.v2Run.findMany({
      where: {
        cacheKey: { in: orderedKeys },
        outputVersion: version,
        lineageSeq: { lte: lineageSequenceAtOrBefore },
      },
      include: { inputs: { orderBy: { position: 'asc' } } },
    })
    const rowsByKey = new Map(rows.map((row) => [row.cacheKey, row]))
    const orderedRows = orderedKeys.map((cacheKey) => {
      const row = rowsByKey.get(cacheKey)
      if (!row) {
        throw new V2CatalogConsistencyError(
          `V2 producing-run seek selected a missing run: ${cacheKey}`,
        )
      }
      return row
    })
    const hasMore = orderedRows.length > limit
    const visible = hasMore ? orderedRows.slice(0, limit) : orderedRows
    return {
      rows: visible.map(prismaRowToRun),
      nextCacheKey: hasMore ? (visible.at(-1)?.cacheKey ?? null) : null,
    }
  }

  async locateRecordRevision(recordId: string, recordDigest: string): Promise<string | null> {
    const row = await this.#client.v2RecordRevisionLocation.findUnique({
      where: { recordId_recordDigest: { recordId, recordDigest } },
      select: { datasetVersion: true },
    })
    return row?.datasetVersion ?? null
  }

  async getRecordParents(
    recordId: string,
    recordDigest: string,
  ): Promise<CatalogRecordParentRowV2[]> {
    const rows = await this.#client.v2RecordParentEdge.findMany({
      where: { childRecordId: recordId, childRecordDigest: recordDigest },
      orderBy: { position: 'asc' },
    })
    return rows.map((row) => ({
      position: row.position,
      parentRecordId: row.parentRecordId,
      parentRecordDigest: row.parentRecordDigest,
    }))
  }

  async getRef(namespaceId: string, name: string): Promise<CatalogRefRowV2 | null> {
    const row = await this.#client.v2Ref.findFirst({
      where: { namespaceId, name, deletedAt: null },
      include: { dataset: { select: { numRecords: true } } },
    })
    return row ? prismaRowToRef(row) : null
  }

  async getDeletedRef(namespaceId: string, name: string): Promise<CatalogRefRowV2 | null> {
    const row = await this.#client.v2Ref.findFirst({
      where: { namespaceId, name, deletedAt: { not: null } },
      include: { dataset: { select: { numRecords: true } } },
    })
    return row ? prismaRowToRef(row) : null
  }

  async resolveRef(namespaceId: string, nameOrVersion: string): Promise<string> {
    if (EXACT_VERSION.test(nameOrVersion)) return nameOrVersion
    return (await this.getRef(namespaceId, nameOrVersion))?.version ?? nameOrVersion
  }

  async compareAndSetRef(input: CompareAndSetRefV2): Promise<CatalogRefRowV2> {
    const changed =
      input.expectedVersion === null
        ? await this.#client.$queryRaw<RefSqlRow[]>`
            WITH changed AS (
              INSERT INTO "refs_v2" (
                "namespace_id", "name", "version", "message", "updated_at"
              )
              SELECT
                ${input.namespaceId}::uuid,
                ${input.name},
                ${input.newVersion},
                ${input.message},
                transaction_timestamp()
              WHERE EXISTS (
                SELECT 1
                FROM "dataset_layouts_v2"
                WHERE "dataset_version" = ${input.newVersion}
              )
              ON CONFLICT DO NOTHING
              RETURNING "namespace_id", "name", "version", "message", "updated_at", "deleted_at"
            )
            SELECT changed.*, snapshots."num_records"
            FROM changed
            JOIN "dataset_snapshots_v2" AS snapshots
              ON snapshots."version" = changed."version"
          `
        : await this.#client.$queryRaw<RefSqlRow[]>`
            WITH changed AS (
              UPDATE "refs_v2"
              SET
                "version" = ${input.newVersion},
                "message" = ${input.message},
                "updated_at" = transaction_timestamp()
              WHERE
                "namespace_id" = ${input.namespaceId}::uuid AND
                "name" = ${input.name} AND
                "version" = ${input.expectedVersion} AND
                "deleted_at" IS NULL AND
                EXISTS (
                  SELECT 1
                  FROM "dataset_layouts_v2"
                  WHERE "dataset_version" = ${input.newVersion}
                )
              RETURNING "namespace_id", "name", "version", "message", "updated_at", "deleted_at"
            )
            SELECT changed.*, snapshots."num_records"
            FROM changed
            JOIN "dataset_snapshots_v2" AS snapshots
              ON snapshots."version" = changed."version"
          `
    const committed = changed[0]
    if (committed && changed.length === 1) return sqlRowToRef(committed)

    const targetLayout = await this.#client.v2DatasetLayout.findFirst({
      where: { datasetVersion: input.newVersion },
      select: { datasetVersion: true },
    })
    if (!targetLayout) throw new V2CatalogTargetNotCommittedError(input.newVersion)

    const current = await this.#client.v2Ref.findUnique({
      where: { namespaceId_name: { namespaceId: input.namespaceId, name: input.name } },
    })
    throw new V2CatalogRefConflictError({
      namespaceId: input.namespaceId,
      refName: input.name,
      expectedVersion: input.expectedVersion,
      currentVersion: current?.version ?? null,
      newVersion: input.newVersion,
    })
  }

  async deleteRef(input: DeleteRefV2): Promise<DeleteRefResultV2> {
    return await this.#client.$transaction(async (tx) => {
      const row = await lockRefForStateChange(tx, input.namespaceId, input.name)
      if (row === null) return { status: 'missing' }
      if (row.version !== input.expectedVersion) {
        throw refStateConflict(input, row, 'delete')
      }
      if (row.deletedAt !== null) return { status: 'already_deleted', row }

      const changed = await tx.$queryRaw<RefStateMutationSqlRow[]>`
        UPDATE "refs_v2"
        SET "deleted_at" = transaction_timestamp()
        WHERE
          "namespace_id" = ${input.namespaceId}::uuid AND
          "name" = ${input.name} AND
          "version" = ${input.expectedVersion} AND
          "deleted_at" IS NULL
        RETURNING "deleted_at"
      `
      const deletedAt = changed[0]?.deleted_at
      if (changed.length !== 1 || deletedAt === null || deletedAt === undefined) {
        throw new V2CatalogConsistencyError('V2 ref delete did not change exactly one row')
      }
      return { status: 'deleted', row: { ...row, deletedAt } }
    })
  }

  async restoreRef(input: RestoreRefV2): Promise<RestoreRefResultV2> {
    return await this.#client.$transaction(async (tx) => {
      const row = await lockRefForStateChange(tx, input.namespaceId, input.name)
      if (row === null) return { status: 'missing' }
      if (row.version !== input.expectedVersion) {
        throw refStateConflict(input, row, 'restore')
      }
      if (row.deletedAt === null) return { status: 'already_active', row }

      const changed = await tx.$queryRaw<RefStateMutationSqlRow[]>`
        UPDATE "refs_v2"
        SET "deleted_at" = NULL
        WHERE
          "namespace_id" = ${input.namespaceId}::uuid AND
          "name" = ${input.name} AND
          "version" = ${input.expectedVersion} AND
          "deleted_at" IS NOT NULL
        RETURNING "deleted_at"
      `
      if (changed.length !== 1 || changed[0]?.deleted_at !== null) {
        throw new V2CatalogConsistencyError('V2 ref restore did not change exactly one row')
      }
      return { status: 'restored', row: { ...row, deletedAt: null } }
    })
  }

  async listRefs(
    namespaceId: string,
    afterName: string | null,
    limit: number,
  ): Promise<CatalogRefPageV2> {
    const fetchLimit = checkedPageFetchLimit(limit, 'V2 ref page limit')
    const rows =
      afterName === null
        ? await this.#client.$queryRaw<RefSqlRow[]>`
            SELECT refs."namespace_id", refs."name", refs."version", snapshots."num_records",
              refs."message", refs."updated_at", refs."deleted_at"
            FROM "refs_v2" AS refs
            JOIN "dataset_snapshots_v2" AS snapshots ON snapshots."version" = refs."version"
            WHERE refs."namespace_id" = ${namespaceId}::uuid AND refs."deleted_at" IS NULL
            ORDER BY refs."name" COLLATE "C" ASC
            LIMIT ${fetchLimit}
          `
        : await this.#client.$queryRaw<RefSqlRow[]>`
            SELECT refs."namespace_id", refs."name", refs."version", snapshots."num_records",
              refs."message", refs."updated_at", refs."deleted_at"
            FROM "refs_v2" AS refs
            JOIN "dataset_snapshots_v2" AS snapshots ON snapshots."version" = refs."version"
            WHERE
              refs."namespace_id" = ${namespaceId}::uuid AND
              refs."deleted_at" IS NULL AND
              refs."name" COLLATE "C" > ${afterName}
            ORDER BY refs."name" COLLATE "C" ASC
            LIMIT ${fetchLimit}
          `
    const hasMore = rows.length > limit
    const visible = hasMore ? rows.slice(0, limit) : rows
    return {
      rows: visible.map(sqlRowToRef),
      nextName: hasMore ? (visible.at(-1)?.name ?? null) : null,
    }
  }

  async listDeletedRefs(
    namespaceId: string,
    afterName: string | null,
    limit: number,
  ): Promise<CatalogRefPageV2> {
    const fetchLimit = checkedPageFetchLimit(limit, 'V2 deleted ref page limit')
    const rows =
      afterName === null
        ? await this.#client.$queryRaw<RefSqlRow[]>`
            SELECT refs."namespace_id", refs."name", refs."version", snapshots."num_records",
              refs."message", refs."updated_at", refs."deleted_at"
            FROM "refs_v2" AS refs
            JOIN "dataset_snapshots_v2" AS snapshots ON snapshots."version" = refs."version"
            WHERE refs."namespace_id" = ${namespaceId}::uuid AND refs."deleted_at" IS NOT NULL
            ORDER BY refs."name" COLLATE "C" ASC
            LIMIT ${fetchLimit}
          `
        : await this.#client.$queryRaw<RefSqlRow[]>`
            SELECT refs."namespace_id", refs."name", refs."version", snapshots."num_records",
              refs."message", refs."updated_at", refs."deleted_at"
            FROM "refs_v2" AS refs
            JOIN "dataset_snapshots_v2" AS snapshots ON snapshots."version" = refs."version"
            WHERE
              refs."namespace_id" = ${namespaceId}::uuid AND
              refs."deleted_at" IS NOT NULL AND
              refs."name" COLLATE "C" > ${afterName}
            ORDER BY refs."name" COLLATE "C" ASC
            LIMIT ${fetchLimit}
          `
    const hasMore = rows.length > limit
    const visible = hasMore ? rows.slice(0, limit) : rows
    return {
      rows: visible.map(sqlRowToRef),
      nextName: hasMore ? (visible.at(-1)?.name ?? null) : null,
    }
  }
}

function checkedPageFetchLimit(limit: number, label: string): number {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new V2CatalogInputError(`${label} must be a positive safe integer`)
  }
  if (limit > MAX_CATALOG_PAGE_SIZE) {
    throw new V2CatalogInputError(`${label} must not exceed ${MAX_CATALOG_PAGE_SIZE}`)
  }
  const fetchLimit = limit + 1
  if (!Number.isSafeInteger(fetchLimit)) {
    throw new V2CatalogInputError(`${label} is too large`)
  }
  return fetchLimit
}

async function acquireLineageRegistrationLock(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$queryRaw`
    SELECT 1 AS "locked"
    FROM pg_advisory_xact_lock(
      hashtext('databench-v2-lineage-registration'),
      hashtext(current_schema())
    )
  `
}

async function registerLayoutInTransaction(
  tx: Prisma.TransactionClient,
  input: RegisterLayoutV2,
): Promise<void> {
  await ensureSnapshot(tx, input.snapshot)
  await ensureLayout(tx, input.layout)
  await ensureRecordRevisions(tx, input.snapshot.version, input.revisions)
}

async function ensureSnapshot(
  tx: Prisma.TransactionClient,
  input: CatalogSnapshotInputV2,
): Promise<void> {
  await tx.v2DatasetSnapshot.createMany({
    data: [
      {
        version: input.version,
        identityProfile: input.identityProfile,
        recordSchemaVersion: input.recordSchemaVersion,
        numRecords: input.numRecords,
      },
    ],
    skipDuplicates: true,
  })
  const row = await tx.v2DatasetSnapshot.findUnique({ where: { version: input.version } })
  if (!row) {
    throw new V2CatalogConsistencyError('V2 snapshot insert completed without a readable row')
  }
  if (
    row.identityProfile !== input.identityProfile ||
    row.recordSchemaVersion !== input.recordSchemaVersion ||
    row.numRecords !== input.numRecords
  ) {
    throw new V2CatalogImmutableConflictError('snapshot', input.version)
  }
}

async function ensureLayout(
  tx: Prisma.TransactionClient,
  input: CatalogLayoutInputV2,
): Promise<void> {
  await tx.v2DatasetLayout.createMany({
    data: [
      {
        datasetVersion: input.datasetVersion,
        layoutVersion: input.layoutVersion,
        artifactDigest: input.artifactDigest,
        artifactSizeBytes: input.artifactSizeBytes,
        manifestKey: input.manifestKey,
        columns: [...input.columns],
      },
    ],
    skipDuplicates: true,
  })
  const row = await tx.v2DatasetLayout.findUnique({
    where: {
      datasetVersion_layoutVersion: {
        datasetVersion: input.datasetVersion,
        layoutVersion: input.layoutVersion,
      },
    },
  })
  if (
    !row ||
    row.artifactDigest !== input.artifactDigest ||
    row.artifactSizeBytes !== input.artifactSizeBytes ||
    row.manifestKey !== input.manifestKey ||
    !sameStringArray(row.columns, input.columns)
  ) {
    throw new V2CatalogImmutableConflictError(
      'layout',
      `${input.datasetVersion}/${input.layoutVersion}`,
    )
  }
}

async function ensureRecordRevisions(
  tx: Prisma.TransactionClient,
  datasetVersion: string,
  revisions: readonly CatalogRecordRevisionV2[],
): Promise<void> {
  const createdRevisionKeys = new Set<string>()

  // The snapshot limit is 100k records. Keep database round trips proportional
  // to chunks, not records, while RETURNING preserves the first-writer-only
  // rule for immutable parent metadata under concurrent registrations.
  for (const batch of batchesOf(revisions, REGISTRATION_BATCH_SIZE)) {
    const created = await tx.$queryRaw<RecordRevisionSqlRow[]>(
      Prisma.sql`
        INSERT INTO "record_revision_locations_v2" (
          "record_id", "record_digest", "dataset_version"
        )
        VALUES ${Prisma.join(
          batch.map(
            (revision) =>
              Prisma.sql`(${revision.recordId}, ${revision.recordDigest}, ${datasetVersion})`,
          ),
        )}
        ON CONFLICT DO NOTHING
        RETURNING "record_id", "record_digest"
      `,
    )
    for (const row of created) {
      createdRevisionKeys.add(recordRevisionKey(row.record_id, row.record_digest))
    }
  }

  const newEdges = revisions.flatMap((revision) => {
    if (!createdRevisionKeys.has(recordRevisionKey(revision.recordId, revision.recordDigest))) {
      return []
    }
    return revision.parents.map((parent, position) => ({
      childRecordId: revision.recordId,
      childRecordDigest: revision.recordDigest,
      position,
      parentRecordId: parent.recordId,
      parentRecordDigest: parent.recordDigest,
    }))
  })
  for (const batch of batchesOf(newEdges, REGISTRATION_BATCH_SIZE)) {
    await tx.v2RecordParentEdge.createMany({ data: [...batch] })
  }

  for (const batch of batchesOf(revisions, REGISTRATION_BATCH_SIZE)) {
    const storedParents = await tx.$queryRaw<RecordParentSqlRow[]>(
      Prisma.sql`
        SELECT
          "child_record_id" AS "record_id",
          "child_record_digest" AS "record_digest",
          "position",
          "parent_record_id",
          "parent_record_digest"
        FROM "record_parent_edges_v2"
        WHERE ("child_record_id", "child_record_digest") IN (
          ${Prisma.join(
            batch.map((revision) => Prisma.sql`(${revision.recordId}, ${revision.recordDigest})`),
          )}
        )
        ORDER BY "child_record_id", "child_record_digest", "position"
      `,
    )
    const storedByRevision = new Map<string, RecordParentSqlRow[]>()
    for (const row of storedParents) {
      const key = recordRevisionKey(row.record_id, row.record_digest)
      const rows = storedByRevision.get(key)
      if (rows) rows.push(row)
      else storedByRevision.set(key, [row])
    }
    for (const revision of batch) {
      const stored =
        storedByRevision.get(recordRevisionKey(revision.recordId, revision.recordDigest)) ?? []
      if (!sameParents(stored, revision.parents)) {
        throw new V2CatalogImmutableConflictError(
          'record_parents',
          `${revision.recordId}/${revision.recordDigest}`,
        )
      }
    }
  }

  const cycleOrigins = revisions.filter(
    (revision) =>
      revision.parents.length > 0 &&
      createdRevisionKeys.has(recordRevisionKey(revision.recordId, revision.recordDigest)),
  )
  for (const batch of batchesOf(cycleOrigins, REGISTRATION_BATCH_SIZE)) {
    const cycle = await tx.$queryRaw<RecordRevisionSqlRow[]>(
      Prisma.sql`
        WITH RECURSIVE "ancestors" (
          "origin_record_id",
          "origin_record_digest",
          "record_id",
          "record_digest"
        ) AS (
          SELECT
            "child_record_id",
            "child_record_digest",
            "parent_record_id",
            "parent_record_digest"
          FROM "record_parent_edges_v2"
          WHERE ("child_record_id", "child_record_digest") IN (
            ${Prisma.join(
              batch.map((revision) => Prisma.sql`(${revision.recordId}, ${revision.recordDigest})`),
            )}
          )
          UNION
          SELECT
            "ancestor"."origin_record_id",
            "ancestor"."origin_record_digest",
            "edge"."parent_record_id",
            "edge"."parent_record_digest"
          FROM "record_parent_edges_v2" AS "edge"
          INNER JOIN "ancestors" AS "ancestor"
            ON "edge"."child_record_id" = "ancestor"."record_id"
            AND "edge"."child_record_digest" = "ancestor"."record_digest"
        )
        SELECT
          "origin_record_id" AS "record_id",
          "origin_record_digest" AS "record_digest"
        FROM "ancestors"
        WHERE
          "record_id" = "origin_record_id" AND
          "record_digest" = "origin_record_digest"
        LIMIT 1
      `,
    )
    const found = cycle[0]
    if (found) throw new V2CatalogLineageCycleError(found.record_id, found.record_digest)
  }
}

function sameParents(
  stored: readonly RecordParentSqlRow[],
  expected: CatalogRecordRevisionV2['parents'],
): boolean {
  return (
    stored.length === expected.length &&
    stored.every((row, position) => {
      const parent = expected[position]
      return (
        parent !== undefined &&
        row.position === position &&
        row.parent_record_id === parent.recordId &&
        row.parent_record_digest === parent.recordDigest
      )
    })
  )
}

function recordRevisionKey(recordId: string, recordDigest: string): string {
  return `${recordId}\0${recordDigest}`
}

function* batchesOf<T>(values: readonly T[], size: number): Generator<readonly T[]> {
  for (let offset = 0; offset < values.length; offset += size) {
    yield values.slice(offset, offset + size)
  }
}

async function registerRunInTransaction(
  tx: Prisma.TransactionClient,
  input: CatalogRunInputV2,
): Promise<void> {
  const runInsert = await tx.v2Run.createMany({
    data: [
      {
        id: input.id,
        cacheKey: input.cacheKey,
        op: input.op,
        opVersion: input.opVersion,
        params: input.params as Prisma.InputJsonObject,
        outputVersion: input.outputVersion,
      },
    ],
    skipDuplicates: true,
  })
  // As with the run row itself, ordered inputs are write-once. Existing runs
  // are compared below but never extended, even when the old list is a prefix.
  if (runInsert.count === 1 && input.inputVersions.length > 0) {
    await tx.v2RunInput.createMany({
      data: input.inputVersions.map((datasetVersion, position) => ({
        cacheKey: input.cacheKey,
        position,
        datasetVersion,
      })),
    })
  }
  const row = await tx.v2Run.findUnique({
    where: { cacheKey: input.cacheKey },
    include: { inputs: { orderBy: { position: 'asc' } } },
  })
  if (
    !row ||
    row.id !== input.id ||
    row.op !== input.op ||
    row.opVersion !== input.opVersion ||
    row.outputVersion !== input.outputVersion ||
    !sameJsonValue(row.params, input.params) ||
    row.inputs.length !== input.inputVersions.length ||
    row.inputs.some(
      (item, position) =>
        item.position !== position || item.datasetVersion !== input.inputVersions[position],
    )
  ) {
    throw new V2CatalogDeterminismConflictError(input.cacheKey)
  }
}

function validateRegistrationInput(input: RegisterLayoutV2): void {
  if (input.layout.datasetVersion !== input.snapshot.version) {
    throw new V2CatalogInputError('V2 layout datasetVersion must equal snapshot version')
  }
  if (input.snapshot.numRecords !== BigInt(input.revisions.length)) {
    throw new V2CatalogInputError('V2 snapshot numRecords must equal the revision count')
  }
  const childIds = new Set<string>()
  for (const revision of input.revisions) {
    if (childIds.has(revision.recordId)) {
      throw new V2CatalogInputError('V2 snapshot contains duplicate logical record IDs')
    }
    childIds.add(revision.recordId)
    const parentIds = new Set<string>()
    for (const parent of revision.parents) {
      if (parent.recordId === revision.recordId) {
        throw new V2CatalogInputError('V2 record cannot name its own logical ID as a parent')
      }
      if (parentIds.has(parent.recordId)) {
        throw new V2CatalogInputError('V2 record contains a duplicate parent logical ID')
      }
      parentIds.add(parent.recordId)
    }
  }
}

function validateRunInput(input: RegisterTransformResultV2): void {
  if (input.run.outputVersion !== input.snapshot.version) {
    throw new V2CatalogInputError('V2 run outputVersion must equal the registered snapshot version')
  }
  if (input.run.id !== `run_${input.run.cacheKey}`) {
    throw new V2CatalogInputError('V2 run id must equal run_ plus its cache key')
  }
}

function sqlRowToClaim(row: IdentityClaimSqlRow): CatalogIdentityClaimRowV2 {
  return {
    namespaceId: row.namespace_id,
    entityKind: row.entity_kind as CatalogIdentityClaimRowV2['entityKind'],
    claimKeyDigest: row.claim_key_digest,
    claimProfile: row.claim_profile as CatalogIdentityClaimRowV2['claimProfile'],
    requestProfile: row.request_profile as CatalogIdentityClaimRowV2['requestProfile'],
    creationProfile: row.creation_profile as CatalogIdentityClaimRowV2['creationProfile'],
    entityId: row.entity_id,
    requestDigest: row.request_digest,
    createdAt: row.created_at,
  }
}

function prismaRowToClaim(row: {
  namespaceId: string
  entityKind: string
  claimKeyDigest: string
  claimProfile: string
  requestProfile: string
  creationProfile: string
  entityId: string
  requestDigest: string
  createdAt: Date
}): CatalogIdentityClaimRowV2 {
  return {
    namespaceId: row.namespaceId,
    entityKind: row.entityKind as CatalogIdentityClaimRowV2['entityKind'],
    claimKeyDigest: row.claimKeyDigest,
    claimProfile: row.claimProfile as CatalogIdentityClaimRowV2['claimProfile'],
    requestProfile: row.requestProfile as CatalogIdentityClaimRowV2['requestProfile'],
    creationProfile: row.creationProfile as CatalogIdentityClaimRowV2['creationProfile'],
    entityId: row.entityId,
    requestDigest: row.requestDigest,
    createdAt: row.createdAt,
  }
}

function prismaRowToSnapshot(row: {
  version: string
  identityProfile: string
  recordSchemaVersion: string
  numRecords: bigint
  createdAt: Date
}): CatalogSnapshotRowV2 {
  return {
    version: row.version,
    identityProfile: row.identityProfile,
    recordSchemaVersion: row.recordSchemaVersion,
    numRecords: row.numRecords,
    createdAt: row.createdAt,
  }
}

function prismaRowToLayout(row: {
  datasetVersion: string
  layoutVersion: string
  artifactDigest: string
  artifactSizeBytes: bigint
  manifestKey: string
  columns: Prisma.JsonValue
  committedAt: Date
}): CatalogLayoutRowV2 {
  return {
    datasetVersion: row.datasetVersion,
    layoutVersion: row.layoutVersion,
    artifactDigest: row.artifactDigest,
    artifactSizeBytes: row.artifactSizeBytes,
    manifestKey: row.manifestKey,
    columns: parseStoredStringArray(row.columns, 'V2 layout columns'),
    committedAt: row.committedAt,
  }
}

function prismaRowToRun(row: {
  id: string
  cacheKey: string
  lineageSeq: bigint
  op: string
  opVersion: string
  params: Prisma.JsonValue
  outputVersion: string
  createdAt: Date
  inputs: Array<{ position: number; datasetVersion: string }>
}): CatalogRunRowV2 {
  if (row.lineageSeq <= 0n) {
    throw new V2CatalogConsistencyError('Stored V2 run lineage sequence is not positive')
  }
  const params = parseStoredJsonObject(row.params, 'V2 run params')
  const inputVersions = row.inputs.map((input, position) => {
    if (input.position !== position) {
      throw new V2CatalogConsistencyError('Stored V2 run inputs are not zero-based and contiguous')
    }
    return input.datasetVersion
  })
  return {
    id: row.id,
    cacheKey: row.cacheKey,
    lineageSequence: row.lineageSeq,
    op: row.op,
    opVersion: row.opVersion,
    params,
    inputVersions,
    outputVersion: row.outputVersion,
    createdAt: row.createdAt,
  }
}

function prismaRowToRef(row: {
  namespaceId: string
  name: string
  version: string
  dataset: { numRecords: bigint }
  message: string | null
  updatedAt: Date
  deletedAt: Date | null
}): CatalogRefRowV2 {
  return {
    namespaceId: row.namespaceId,
    name: row.name,
    version: row.version,
    numRecords: row.dataset.numRecords,
    message: row.message,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  }
}

function sqlRowToRef(row: RefSqlRow): CatalogRefRowV2 {
  return {
    namespaceId: row.namespace_id,
    name: row.name,
    version: row.version,
    numRecords: row.num_records,
    message: row.message,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  }
}

function refStateConflict(
  input: DeleteRefV2 | RestoreRefV2,
  row: { readonly version: string; readonly deletedAt: Date | null },
  operation: 'delete' | 'restore',
): V2CatalogRefStateConflictError {
  return new V2CatalogRefStateConflictError({
    namespaceId: input.namespaceId,
    refName: input.name,
    expectedVersion: input.expectedVersion,
    currentVersion: row.version,
    currentState: row.deletedAt === null ? 'active' : 'deleted',
    operation,
  })
}

async function lockRefForStateChange(
  tx: Prisma.TransactionClient,
  namespaceId: string,
  name: string,
): Promise<CatalogRefRowV2 | null> {
  const rows = await tx.$queryRaw<RefSqlRow[]>`
    SELECT refs."namespace_id", refs."name", refs."version", snapshots."num_records",
      refs."message", refs."updated_at", refs."deleted_at"
    FROM "refs_v2" AS refs
    JOIN "dataset_snapshots_v2" AS snapshots ON snapshots."version" = refs."version"
    WHERE refs."namespace_id" = ${namespaceId}::uuid AND refs."name" = ${name}
    FOR UPDATE OF refs
  `
  if (rows.length > 1) {
    throw new V2CatalogConsistencyError('V2 ref state lookup returned more than one row')
  }
  return rows[0] ? sqlRowToRef(rows[0]) : null
}

function sameStringArray(stored: Prisma.JsonValue, expected: readonly string[]): boolean {
  return (
    Array.isArray(stored) &&
    stored.length === expected.length &&
    stored.every((value, index) => value === expected[index])
  )
}

function sameJsonValue(stored: Prisma.JsonValue, expected: CatalogJsonValueV2): boolean {
  // JSON/JCS treats -0 and 0 as the same number, and PostgreSQL JSONB reads
  // both back as 0. JavaScript strict equality intentionally gives that JSON
  // semantic here, unlike Object.is/isDeepStrictEqual.
  if (stored === expected) return true
  if (stored === null || expected === null) return false
  if (typeof stored !== 'object' || typeof expected !== 'object') return false

  if (Array.isArray(stored)) {
    return (
      Array.isArray(expected) &&
      stored.length === expected.length &&
      stored.every((value, index) => {
        const expectedValue = expected[index]
        return expectedValue !== undefined && sameJsonValue(value, expectedValue)
      })
    )
  }
  if (Array.isArray(expected)) return false

  const storedKeys = Object.keys(stored)
  const expectedObject = expected as { readonly [key: string]: CatalogJsonValueV2 }
  const expectedKeys = Object.keys(expectedObject)
  if (storedKeys.length !== expectedKeys.length) return false
  return storedKeys.every((key) => {
    if (!Object.hasOwn(expectedObject, key)) return false
    const storedValue = stored[key]
    const expectedValue = expectedObject[key]
    return (
      storedValue !== undefined &&
      expectedValue !== undefined &&
      sameJsonValue(storedValue, expectedValue)
    )
  })
}

function parseStoredStringArray(value: Prisma.JsonValue, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new V2CatalogConsistencyError(`${label} are not a string array`)
  }
  return [...value] as string[]
}

function parseStoredJsonObject(
  value: Prisma.JsonValue,
  label: string,
): Record<string, CatalogRunRowV2['params'][string]> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new V2CatalogConsistencyError(`${label} are not a JSON object`)
  }
  return structuredClone(value) as Record<string, CatalogRunRowV2['params'][string]>
}
