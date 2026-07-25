import { randomBytes, randomUUID } from 'node:crypto'
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
  V2CatalogTransformJobLeaseError,
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
  CatalogTransformJobCursorV2,
  CatalogTransformJobErrorV2,
  CatalogTransformJobPageV2,
  CatalogTransformJobProgressV2,
  CatalogTransformJobRowV2,
  CatalogTransformJobStatusV2,
  ClaimTransformJobV2,
  ClearCompletedTransformJobStagingV2,
  CompareAndSetRefV2,
  CompleteTransformJobV2,
  CreateTransformJobV2,
  DeleteRefResultV2,
  DeleteRefV2,
  FailTransformJobV2,
  RegisterLayoutV2,
  RegisterTransformResultV2,
  RestoreRefResultV2,
  RestoreRefV2,
  SetTransformJobStagingKeysV2,
  TransformJobLeaseV2,
  UpdateTransformJobProgressV2,
} from './types.js'

const EXACT_VERSION = /^[0-9a-f]{64}$/
const REGISTRATION_TRANSACTION_TIMEOUT_MS = 30_000
const REGISTRATION_BATCH_SIZE = 1_000
const MAX_CATALOG_PAGE_SIZE = 1_000
const POSTGRES_BIGINT_MAX = 9_223_372_036_854_775_807n
const JOB_ID = /^job_[0-9a-f]{64}$/
const SAFE_WORKER_NAME = /^[a-z][a-z0-9._-]{0,127}$/
const SAFE_WORKER_VERSION = /^[a-z0-9][a-z0-9._-]{0,127}$/
const MAX_JOB_JSON_BYTES = 16 * 1024
const MAX_JOB_LEASE_MS = 24 * 60 * 60 * 1_000

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

interface TransformJobSqlRow {
  readonly id: string
  readonly cache_key: string
  readonly op: string
  readonly op_version: string
  readonly params_json: Prisma.JsonValue
  readonly input_version: string
  readonly capability_name: string
  readonly capability_version: string
  readonly status: string
  readonly attempt: number
  readonly lease_owner: string | null
  readonly lease_token: Uint8Array | null
  readonly lease_expires_at: Date | null
  readonly progress_json: Prisma.JsonValue | null
  readonly input_key: string | null
  readonly output_key: string | null
  readonly input_count: bigint
  readonly output_count: bigint | null
  readonly output_version: string | null
  readonly cache_hit: boolean
  readonly error_json: Prisma.JsonValue | null
  readonly created_at: Date
  readonly started_at: Date | null
  readonly finished_at: Date | null
  readonly updated_at: Date
}

interface LockedTransformJobSqlRow extends TransformJobSqlRow {
  readonly lease_valid: boolean
}

const TRANSFORM_JOB_COLUMNS = Prisma.sql`
  "id", "cache_key", "op", "op_version", "params_json", "input_version",
  "capability_name", "capability_version", "status", "attempt", "lease_owner",
  "lease_token", "lease_expires_at", "progress_json", "input_key", "output_key",
  "input_count", "output_count", "output_version", "cache_hit", "error_json",
  "created_at", "started_at", "finished_at", "updated_at"
`

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

  async completeTransformJob(input: CompleteTransformJobV2): Promise<CatalogTransformJobRowV2> {
    validateRegistrationInput(input)
    validateRunInput(input)
    validateCompleteTransformJob(input)
    return await this.#client.$transaction(
      async (tx) => {
        await acquireLineageRegistrationLock(tx)
        const locked = await tx.$queryRaw<LockedTransformJobSqlRow[]>(Prisma.sql`
          SELECT ${TRANSFORM_JOB_COLUMNS},
            COALESCE("lease_expires_at" > clock_timestamp(), false) AS "lease_valid"
          FROM "transform_jobs_v2"
          WHERE "id" = ${input.job.id}
          FOR UPDATE
        `)
        const row = locked[0]
        if (!row || locked.length !== 1) {
          throw new V2CatalogTransformJobLeaseError(input.job.id)
        }
        assertTransformJobCompletionIdentity(row, input)

        if (row.status === 'completed') {
          if (
            row.attempt !== input.job.attempt ||
            row.output_version !== input.run.outputVersion ||
            row.output_count !== input.outputCount
          ) {
            throw new V2CatalogTransformJobLeaseError(input.job.id)
          }
          await assertRunInTransaction(tx, input.run)
          return sqlRowToTransformJob(row)
        }

        if (
          row.status !== 'finalizing' ||
          row.attempt !== input.job.attempt ||
          !sameBytes(row.lease_token, input.job.leaseToken) ||
          !row.lease_valid
        ) {
          throw new V2CatalogTransformJobLeaseError(input.job.id)
        }
        validateStagingKeys({
          ...input.job,
          inputKey: row.input_key ?? '',
          outputKey: row.output_key ?? '',
        })
        const inputSnapshot = await tx.v2DatasetSnapshot.findUnique({
          where: { version: row.input_version },
        })
        if (!inputSnapshot || inputSnapshot.numRecords !== row.input_count) {
          throw new V2CatalogConsistencyError(
            'Transform job input count does not match its immutable snapshot',
          )
        }

        await registerLayoutInTransaction(tx, input)
        const runRegistration = await registerRunInTransaction(tx, input.run)
        const completed = await tx.$queryRaw<TransformJobSqlRow[]>(Prisma.sql`
          UPDATE "transform_jobs_v2"
          SET
            "status" = 'completed',
            "output_count" = ${input.outputCount},
            "output_version" = ${input.run.outputVersion},
            "cache_hit" = ${runRegistration === 'existing'},
            "error_json" = NULL,
            "finished_at" = clock_timestamp(),
            "lease_owner" = NULL,
            "lease_token" = NULL,
            "lease_expires_at" = NULL,
            "updated_at" = clock_timestamp()
          WHERE
            "id" = ${input.job.id} AND
            "attempt" = ${input.job.attempt} AND
            "lease_token" = ${Buffer.from(input.job.leaseToken)} AND
            "lease_expires_at" > clock_timestamp() AND
            "status" = 'finalizing'
          RETURNING ${TRANSFORM_JOB_COLUMNS}
        `)
        const completedRow = completed[0]
        if (!completedRow || completed.length !== 1) {
          throw new V2CatalogTransformJobLeaseError(input.job.id)
        }
        return sqlRowToTransformJob(completedRow)
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

  async createOrReadTransformJob(input: CreateTransformJobV2): Promise<CatalogTransformJobRowV2> {
    validateCreateTransformJob(input)
    return await this.#client.$transaction(
      async (tx) => {
        const inputSnapshot = await tx.v2DatasetSnapshot.findUnique({
          where: { version: input.inputVersion },
        })
        if (!inputSnapshot) {
          throw new V2CatalogInputError('Transform job input snapshot is not registered')
        }
        if (inputSnapshot.numRecords !== input.inputCount) {
          throw new V2CatalogInputError(
            'Transform job input count must equal its immutable snapshot count',
          )
        }
        const run = await tx.v2Run.findUnique({
          where: { cacheKey: input.cacheKey },
          include: { inputs: { orderBy: { position: 'asc' } } },
        })
        if (
          run &&
          (run.id !== `run_${input.cacheKey}` ||
            run.op !== input.op ||
            run.opVersion !== input.opVersion ||
            !sameJsonValue(run.params, input.params) ||
            run.inputs.length !== 1 ||
            run.inputs[0]?.position !== 0 ||
            run.inputs[0]?.datasetVersion !== input.inputVersion)
        ) {
          throw new V2CatalogDeterminismConflictError(input.cacheKey)
        }
        const outputSnapshot = run
          ? await tx.v2DatasetSnapshot.findUnique({ where: { version: run.outputVersion } })
          : null
        if (run && !outputSnapshot) {
          throw new V2CatalogConsistencyError(
            'Transform cache run output snapshot is not registered',
          )
        }

        await tx.v2TransformJob.createMany({
          data: [
            {
              id: input.id,
              cacheKey: input.cacheKey,
              op: input.op,
              opVersion: input.opVersion,
              params: input.params as Prisma.InputJsonObject,
              inputVersion: input.inputVersion,
              capabilityName: input.capabilityName,
              capabilityVersion: input.capabilityVersion,
              status: run ? 'completed' : 'queued',
              inputCount: input.inputCount,
              outputCount: outputSnapshot?.numRecords ?? null,
              outputVersion: run?.outputVersion ?? null,
              cacheHit: run !== null,
              finishedAt: run ? new Date() : null,
            },
          ],
          skipDuplicates: true,
        })

        let row = await tx.v2TransformJob.findUnique({ where: { id: input.id } })
        if (!row) {
          throw new V2CatalogConsistencyError(
            'Transform job insert completed without a readable row',
          )
        }
        assertTransformJobIdentity(row, input)

        if (row.status === 'completed') {
          if (
            !run ||
            !outputSnapshot ||
            row.outputVersion !== run.outputVersion ||
            row.outputCount !== outputSnapshot.numRecords
          ) {
            throw new V2CatalogConsistencyError(
              'Completed transform job does not have its matching immutable run',
            )
          }
        } else if (run && row.status === 'queued' && row.attempt === 0) {
          await tx.$executeRaw`
            UPDATE "transform_jobs_v2"
            SET "status" = 'completed', "output_version" = ${run.outputVersion},
                "output_count" = ${outputSnapshot?.numRecords ?? null},
                "cache_hit" = true, "finished_at" = clock_timestamp(),
                "updated_at" = clock_timestamp()
            WHERE "id" = ${input.id} AND "status" = 'queued' AND "attempt" = 0
              AND "lease_token" IS NULL
          `
          const completed = await tx.v2TransformJob.findUnique({ where: { id: input.id } })
          if (!completed) {
            throw new V2CatalogConsistencyError('Transform job disappeared during cache-hit update')
          }
          row = completed
        }
        return prismaRowToTransformJob(row)
      },
      { timeout: REGISTRATION_TRANSACTION_TIMEOUT_MS },
    )
  }

  async getTransformJob(id: string): Promise<CatalogTransformJobRowV2 | null> {
    validateJobId(id)
    const row = await this.#client.v2TransformJob.findUnique({ where: { id } })
    return row ? prismaRowToTransformJob(row) : null
  }

  async listTransformJobs(
    before: CatalogTransformJobCursorV2 | null,
    limit: number,
  ): Promise<CatalogTransformJobPageV2> {
    const fetchLimit = checkedPageFetchLimit(limit, 'Transform job page limit')
    if (before !== null) validateTransformJobCursor(before)
    const rows = await this.#client.$queryRaw<TransformJobSqlRow[]>(Prisma.sql`
      SELECT ${TRANSFORM_JOB_COLUMNS}
      FROM "transform_jobs_v2"
      WHERE
        ${
          before === null
            ? Prisma.sql`TRUE`
            : Prisma.sql`
              date_trunc('milliseconds', "created_at") < ${before.createdAt} OR
              (
                date_trunc('milliseconds', "created_at") = ${before.createdAt} AND
                "id" COLLATE "C" < ${before.id}
              )
            `
        }
      ORDER BY date_trunc('milliseconds', "created_at") DESC, "id" COLLATE "C" DESC
      LIMIT ${fetchLimit}
    `)
    const hasMore = rows.length > limit
    const pageRows = rows.slice(0, limit).map(sqlRowToTransformJob)
    const last = hasMore ? pageRows.at(-1) : undefined
    return {
      rows: Object.freeze(pageRows),
      nextCursor:
        last === undefined
          ? null
          : Object.freeze({ createdAt: truncateDateToMilliseconds(last.createdAt), id: last.id }),
    }
  }

  async claimNextTransformJob(
    input: ClaimTransformJobV2,
  ): Promise<CatalogTransformJobRowV2 | null> {
    validateLeaseOwner(input.leaseOwner)
    validateLeaseDuration(input.leaseDurationMs)
    const leaseToken = randomBytes(32)
    return await this.#client.$transaction(
      async (tx) => {
        await tx.$queryRaw`
          SELECT 1 AS "locked"
          FROM pg_advisory_xact_lock(
            hashtext('databench-worker-job-claim'),
            hashtext(current_schema())
          )
        `
        const fences = await tx.$queryRaw<Array<{ readonly active: boolean }>>`
          SELECT EXISTS(
            SELECT 1 FROM "transform_jobs_v2" WHERE "lease_token" IS NOT NULL
          ) AS "active"
        `
        if (fences[0]?.active !== false) return null

        const rows = await tx.$queryRaw<TransformJobSqlRow[]>(Prisma.sql`
          WITH "candidate" AS (
            SELECT "id" AS "candidate_id"
            FROM "transform_jobs_v2"
            WHERE "status" = 'queued'
            ORDER BY "created_at" ASC, "id" COLLATE "C" ASC
            FOR UPDATE SKIP LOCKED
            LIMIT 1
          )
          UPDATE "transform_jobs_v2" AS "job"
          SET
            "status" = 'leased',
            "attempt" = "job"."attempt" + 1,
            "lease_owner" = ${input.leaseOwner},
            "lease_token" = ${leaseToken},
            "lease_expires_at" = clock_timestamp() +
              (${input.leaseDurationMs} * INTERVAL '1 millisecond'),
            "updated_at" = clock_timestamp()
          FROM "candidate"
          WHERE "job"."id" = "candidate"."candidate_id"
          RETURNING ${TRANSFORM_JOB_COLUMNS}
        `)
        const row = rows[0]
        if (rows.length > 1) {
          throw new V2CatalogConsistencyError('Transform job claim returned more than one row')
        }
        return row ? sqlRowToTransformJob(row) : null
      },
      { timeout: REGISTRATION_TRANSACTION_TIMEOUT_MS },
    )
  }

  async renewTransformJobLease(
    input: TransformJobLeaseV2,
    leaseDurationMs: number,
  ): Promise<boolean> {
    validateTransformJobLease(input)
    validateLeaseDuration(leaseDurationMs)
    const rows = await this.#client.$queryRaw<Array<{ readonly id: string }>>(Prisma.sql`
      UPDATE "transform_jobs_v2"
      SET
        "lease_expires_at" = clock_timestamp() +
          (${leaseDurationMs} * INTERVAL '1 millisecond'),
        "updated_at" = clock_timestamp()
      WHERE
        "id" = ${input.id} AND
        "attempt" = ${input.attempt} AND
        "lease_token" = ${Buffer.from(input.leaseToken)} AND
        "lease_expires_at" > clock_timestamp() AND
        "status" IN ('leased', 'running', 'finalizing')
      RETURNING "id"
    `)
    return rows.length === 1
  }

  async markTransformJobRunning(
    input: TransformJobLeaseV2,
  ): Promise<CatalogTransformJobRowV2 | null> {
    return await this.#transitionTransformJob(
      input,
      ['leased'],
      Prisma.sql`
      "status" = 'running',
      "started_at" = COALESCE("started_at", clock_timestamp())
    `,
    )
  }

  async updateTransformJobProgress(input: UpdateTransformJobProgressV2): Promise<boolean> {
    validateTransformJobLease(input)
    validateProgress(input.progress)
    const value = JSON.stringify({
      phase: input.progress.phase,
      completed_units: input.progress.completedUnits.toString(),
      total_units: input.progress.totalUnits?.toString() ?? null,
    })
    const rows = await this.#client.$queryRaw<Array<{ readonly id: string }>>(Prisma.sql`
      UPDATE "transform_jobs_v2"
      SET "progress_json" = ${value}::jsonb, "updated_at" = clock_timestamp()
      WHERE
        "id" = ${input.id} AND
        "attempt" = ${input.attempt} AND
        "lease_token" = ${Buffer.from(input.leaseToken)} AND
        "lease_expires_at" > clock_timestamp() AND
        "status" = 'running'
      RETURNING "id"
    `)
    return rows.length === 1
  }

  async setTransformJobStagingKeys(input: SetTransformJobStagingKeysV2): Promise<boolean> {
    validateTransformJobLease(input)
    validateStagingKeys(input)
    const rows = await this.#client.$queryRaw<Array<{ readonly id: string }>>(Prisma.sql`
      UPDATE "transform_jobs_v2"
      SET "input_key" = ${input.inputKey}, "output_key" = ${input.outputKey},
          "updated_at" = clock_timestamp()
      WHERE
        "id" = ${input.id} AND
        "attempt" = ${input.attempt} AND
        "lease_token" = ${Buffer.from(input.leaseToken)} AND
        "lease_expires_at" > clock_timestamp() AND
        "status" = 'leased' AND
        (("input_key" IS NULL AND "output_key" IS NULL) OR
          ("input_key" = ${input.inputKey} AND "output_key" = ${input.outputKey}))
      RETURNING "id"
    `)
    return rows.length === 1
  }

  async markTransformJobFinalizing(
    input: TransformJobLeaseV2,
  ): Promise<CatalogTransformJobRowV2 | null> {
    return await this.#transitionTransformJob(
      input,
      ['running'],
      Prisma.sql`
      "status" = 'finalizing'
    `,
    )
  }

  async markTransformJobFailed(
    input: FailTransformJobV2,
  ): Promise<CatalogTransformJobRowV2 | null> {
    validateError(input.error)
    const errorJson = JSON.stringify(input.error)
    return await this.#transitionTransformJob(
      input,
      ['leased', 'running', 'finalizing'],
      Prisma.sql`
        "status" = 'failed',
        "error_json" = ${errorJson}::jsonb,
        "finished_at" = clock_timestamp()
      `,
    )
  }

  async markTransformJobCancelled(
    input: TransformJobLeaseV2,
  ): Promise<CatalogTransformJobRowV2 | null> {
    return await this.#transitionTransformJob(
      input,
      ['leased', 'running', 'finalizing'],
      Prisma.sql`
        "status" = 'cancelled',
        "finished_at" = clock_timestamp()
      `,
    )
  }

  async requestTransformJobCancellation(id: string): Promise<CatalogTransformJobRowV2 | null> {
    validateJobId(id)
    const rows = await this.#client.$queryRaw<TransformJobSqlRow[]>(Prisma.sql`
      UPDATE "transform_jobs_v2"
      SET "status" = 'cancelled', "finished_at" = clock_timestamp(),
          "updated_at" = clock_timestamp()
      WHERE "id" = ${id} AND "status" IN ('queued', 'leased', 'running', 'finalizing')
      RETURNING ${TRANSFORM_JOB_COLUMNS}
    `)
    const updated = rows[0]
    if (updated) return sqlRowToTransformJob(updated)
    return await this.getTransformJob(id)
  }

  async clearTransformJobLeaseFence(input: TransformJobLeaseV2): Promise<boolean> {
    validateTransformJobLease(input)
    const rows = await this.#client.$queryRaw<Array<{ readonly id: string }>>(Prisma.sql`
      UPDATE "transform_jobs_v2"
      SET "lease_owner" = NULL, "lease_token" = NULL, "lease_expires_at" = NULL,
          "updated_at" = clock_timestamp()
      WHERE
        "id" = ${input.id} AND
        "attempt" = ${input.attempt} AND
        "lease_token" = ${Buffer.from(input.leaseToken)} AND
        "input_key" IS NULL AND "output_key" IS NULL AND
        "status" IN ('failed', 'cancelled')
      RETURNING "id"
    `)
    return rows.length === 1
  }

  async clearTransformJobStagingKeys(input: TransformJobLeaseV2): Promise<boolean> {
    validateTransformJobLease(input)
    const rows = await this.#client.$queryRaw<Array<{ readonly id: string }>>(Prisma.sql`
      UPDATE "transform_jobs_v2"
      SET "input_key" = NULL, "output_key" = NULL, "updated_at" = clock_timestamp()
      WHERE
        "id" = ${input.id} AND
        "attempt" = ${input.attempt} AND
        "lease_token" = ${Buffer.from(input.leaseToken)} AND
        "status" IN ('failed', 'cancelled')
      RETURNING "id"
    `)
    return rows.length === 1
  }

  async clearCompletedTransformJobStagingKeys(
    input: ClearCompletedTransformJobStagingV2,
  ): Promise<boolean> {
    validateCompletedStagingCleanup(input)
    const rows = await this.#client.$queryRaw<Array<{ readonly id: string }>>(Prisma.sql`
      UPDATE "transform_jobs_v2"
      SET "input_key" = NULL, "output_key" = NULL, "updated_at" = clock_timestamp()
      WHERE
        "id" = ${input.id} AND
        "attempt" = ${input.attempt} AND
        "status" = 'completed' AND
        "output_version" = ${input.outputVersion} AND
        (("input_key" = ${input.inputKey} AND "output_key" = ${input.outputKey}) OR
          ("input_key" IS NULL AND "output_key" IS NULL))
      RETURNING "id"
    `)
    return rows.length === 1
  }

  async failExpiredTransformJobLeases(): Promise<number> {
    const errorJson = JSON.stringify({
      code: 'lease_expired',
      message: 'Worker job lease expired',
      retryable: false,
    })
    const rows = await this.#client.$queryRaw<Array<{ readonly id: string }>>(Prisma.sql`
      UPDATE "transform_jobs_v2"
      SET "status" = 'failed', "error_json" = ${errorJson}::jsonb,
          "finished_at" = clock_timestamp(), "updated_at" = clock_timestamp()
      WHERE
        "lease_token" IS NOT NULL AND
        "lease_expires_at" <= clock_timestamp() AND
        "status" IN ('leased', 'running', 'finalizing')
      RETURNING "id"
    `)
    return rows.length
  }

  async findTransformJobCleanupFence(): Promise<CatalogTransformJobRowV2 | null> {
    const rows = await this.#client.$queryRaw<TransformJobSqlRow[]>(Prisma.sql`
      SELECT ${TRANSFORM_JOB_COLUMNS}
      FROM "transform_jobs_v2"
      WHERE "lease_token" IS NOT NULL AND "status" IN ('failed', 'cancelled')
      ORDER BY "updated_at" ASC, "id" COLLATE "C" ASC
      LIMIT 1
    `)
    return rows[0] ? sqlRowToTransformJob(rows[0]) : null
  }

  async retryTransformJob(id: string): Promise<CatalogTransformJobRowV2 | null> {
    validateJobId(id)
    const rows = await this.#client.$queryRaw<TransformJobSqlRow[]>(Prisma.sql`
      UPDATE "transform_jobs_v2"
      SET
        "status" = 'queued', "progress_json" = NULL, "error_json" = NULL,
        "output_count" = NULL, "started_at" = NULL, "finished_at" = NULL,
        "updated_at" = clock_timestamp()
      WHERE
        "id" = ${id} AND
        "status" IN ('failed', 'cancelled') AND
        "lease_token" IS NULL AND
        "input_key" IS NULL AND "output_key" IS NULL
      RETURNING ${TRANSFORM_JOB_COLUMNS}
    `)
    return rows[0] ? sqlRowToTransformJob(rows[0]) : null
  }

  async #transitionTransformJob(
    input: TransformJobLeaseV2,
    fromStatuses: readonly CatalogTransformJobStatusV2[],
    assignments: Prisma.Sql,
  ): Promise<CatalogTransformJobRowV2 | null> {
    validateTransformJobLease(input)
    const rows = await this.#client.$queryRaw<TransformJobSqlRow[]>(Prisma.sql`
      UPDATE "transform_jobs_v2"
      SET ${assignments}, "updated_at" = clock_timestamp()
      WHERE
        "id" = ${input.id} AND
        "attempt" = ${input.attempt} AND
        "lease_token" = ${Buffer.from(input.leaseToken)} AND
        "lease_expires_at" > clock_timestamp() AND
        "status" IN (${Prisma.join(fromStatuses)})
      RETURNING ${TRANSFORM_JOB_COLUMNS}
    `)
    return rows[0] ? sqlRowToTransformJob(rows[0]) : null
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
): Promise<'created' | 'existing'> {
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
  await assertRunInTransaction(tx, input)
  return runInsert.count === 1 ? 'created' : 'existing'
}

async function assertRunInTransaction(
  tx: Prisma.TransactionClient,
  input: CatalogRunInputV2,
): Promise<void> {
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

function validateCompleteTransformJob(input: CompleteTransformJobV2): void {
  validateTransformJobLease(input.job)
  if (
    input.outputCount < 0n ||
    input.outputCount > POSTGRES_BIGINT_MAX ||
    input.outputCount !== input.snapshot.numRecords
  ) {
    throw new V2CatalogInputError(
      'Transform job output count must equal the registered snapshot count',
    )
  }
  if (input.job.id !== `job_${input.run.cacheKey}` || input.run.inputVersions.length !== 1) {
    throw new V2CatalogInputError(
      'Transform job completion must contain its deterministic single-input run',
    )
  }
}

function assertTransformJobCompletionIdentity(
  row: TransformJobSqlRow,
  input: CompleteTransformJobV2,
): void {
  if (
    row.id !== input.job.id ||
    row.cache_key !== input.run.cacheKey ||
    row.op !== input.run.op ||
    row.op_version !== input.run.opVersion ||
    !sameJsonValue(row.params_json, input.run.params) ||
    row.input_version !== input.run.inputVersions[0] ||
    input.outputCount > row.input_count
  ) {
    throw new V2CatalogDeterminismConflictError(input.run.cacheKey)
  }
}

function validateCompletedStagingCleanup(input: ClearCompletedTransformJobStagingV2): void {
  validateJobId(input.id)
  if (!Number.isSafeInteger(input.attempt) || input.attempt < 1) {
    throw new V2CatalogInputError('Transform job cleanup attempt must be a positive safe integer')
  }
  if (!EXACT_VERSION.test(input.outputVersion)) {
    throw new V2CatalogInputError('Transform job cleanup output version is invalid')
  }
  validateStagingKeys({
    id: input.id,
    attempt: input.attempt,
    leaseToken: new Uint8Array(32),
    inputKey: input.inputKey,
    outputKey: input.outputKey,
  })
}

function sameBytes(left: Uint8Array | null, right: Uint8Array): boolean {
  return left !== null && Buffer.from(left).equals(Buffer.from(right))
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

function prismaRowToTransformJob(row: {
  id: string
  cacheKey: string
  op: string
  opVersion: string
  params: Prisma.JsonValue
  inputVersion: string
  capabilityName: string
  capabilityVersion: string
  status: string
  attempt: number
  leaseOwner: string | null
  leaseToken: Uint8Array | null
  leaseExpiresAt: Date | null
  progress: Prisma.JsonValue | null
  inputKey: string | null
  outputKey: string | null
  inputCount: bigint
  outputCount: bigint | null
  outputVersion: string | null
  cacheHit: boolean
  error: Prisma.JsonValue | null
  createdAt: Date
  startedAt: Date | null
  finishedAt: Date | null
  updatedAt: Date
}): CatalogTransformJobRowV2 {
  const status = parseTransformJobStatus(row.status)
  assertStoredLeaseShape(row.leaseOwner, row.leaseToken, row.leaseExpiresAt)
  if ((status === 'completed') !== (row.outputVersion !== null)) {
    throw new V2CatalogConsistencyError('Stored transform job completion shape is invalid')
  }
  return {
    id: row.id,
    cacheKey: row.cacheKey,
    op: row.op,
    opVersion: row.opVersion,
    params: parseStoredJsonObject(row.params, 'Transform job params'),
    inputVersion: row.inputVersion,
    capabilityName: row.capabilityName,
    capabilityVersion: row.capabilityVersion,
    status,
    attempt: row.attempt,
    leaseOwner: row.leaseOwner,
    leaseToken: row.leaseToken === null ? null : new Uint8Array(row.leaseToken),
    leaseExpiresAt: row.leaseExpiresAt,
    progress: parseStoredTransformJobProgress(row.progress),
    inputKey: row.inputKey,
    outputKey: row.outputKey,
    inputCount: row.inputCount,
    outputCount: row.outputCount,
    outputVersion: row.outputVersion,
    cacheHit: row.cacheHit,
    error: parseStoredTransformJobError(row.error),
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    updatedAt: row.updatedAt,
  }
}

function sqlRowToTransformJob(row: TransformJobSqlRow): CatalogTransformJobRowV2 {
  return prismaRowToTransformJob({
    id: row.id,
    cacheKey: row.cache_key,
    op: row.op,
    opVersion: row.op_version,
    params: row.params_json,
    inputVersion: row.input_version,
    capabilityName: row.capability_name,
    capabilityVersion: row.capability_version,
    status: row.status,
    attempt: row.attempt,
    leaseOwner: row.lease_owner,
    leaseToken: row.lease_token,
    leaseExpiresAt: row.lease_expires_at,
    progress: row.progress_json,
    inputKey: row.input_key,
    outputKey: row.output_key,
    inputCount: row.input_count,
    outputCount: row.output_count,
    outputVersion: row.output_version,
    cacheHit: row.cache_hit,
    error: row.error_json,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    updatedAt: row.updated_at,
  })
}

function validateCreateTransformJob(input: CreateTransformJobV2): void {
  validateJobId(input.id)
  if (!EXACT_VERSION.test(input.cacheKey) || input.id !== `job_${input.cacheKey}`) {
    throw new V2CatalogInputError('Transform job ID must equal job_ plus its cache key')
  }
  if (!EXACT_VERSION.test(input.inputVersion)) {
    throw new V2CatalogInputError('Transform job input version must be 64 lowercase hex')
  }
  for (const [label, value] of [
    ['operation', input.op],
    ['capability', input.capabilityName],
  ] as const) {
    if (!SAFE_WORKER_NAME.test(value))
      throw new V2CatalogInputError(`Transform job ${label} is invalid`)
  }
  for (const [label, value] of [
    ['operation version', input.opVersion],
    ['capability version', input.capabilityVersion],
  ] as const) {
    if (!SAFE_WORKER_VERSION.test(value)) {
      throw new V2CatalogInputError(`Transform job ${label} is invalid`)
    }
  }
  if (input.inputCount < 0n || input.inputCount > POSTGRES_BIGINT_MAX) {
    throw new V2CatalogInputError('Transform job input count must fit a non-negative bigint')
  }
  validateBoundedJson(input.params, 'Transform job params')
}

function assertTransformJobIdentity(
  row: {
    id: string
    cacheKey: string
    op: string
    opVersion: string
    params: Prisma.JsonValue
    inputVersion: string
    capabilityName: string
    capabilityVersion: string
    inputCount: bigint
  },
  input: CreateTransformJobV2,
): void {
  if (
    row.id !== input.id ||
    row.cacheKey !== input.cacheKey ||
    row.op !== input.op ||
    row.opVersion !== input.opVersion ||
    !sameJsonValue(row.params, input.params) ||
    row.inputVersion !== input.inputVersion ||
    row.capabilityName !== input.capabilityName ||
    row.capabilityVersion !== input.capabilityVersion ||
    row.inputCount !== input.inputCount
  ) {
    throw new V2CatalogDeterminismConflictError(input.cacheKey)
  }
}

function validateJobId(id: string): void {
  if (!JOB_ID.test(id)) {
    throw new V2CatalogInputError('Transform job ID must be job_ plus 64 lowercase hex')
  }
}

function validateTransformJobCursor(cursor: CatalogTransformJobCursorV2): void {
  if (!(cursor.createdAt instanceof Date) || !Number.isFinite(cursor.createdAt.getTime())) {
    throw new V2CatalogInputError('Transform job cursor timestamp is invalid')
  }
  if (cursor.createdAt.getTime() !== truncateDateToMilliseconds(cursor.createdAt).getTime()) {
    throw new V2CatalogInputError('Transform job cursor timestamp must use millisecond precision')
  }
  validateJobId(cursor.id)
}

function truncateDateToMilliseconds(value: Date): Date {
  return new Date(value.getTime())
}

function validateLeaseOwner(value: string): void {
  if (!SAFE_WORKER_NAME.test(value)) {
    throw new V2CatalogInputError('Transform job lease owner is invalid')
  }
}

function validateLeaseDuration(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_JOB_LEASE_MS) {
    throw new V2CatalogInputError('Transform job lease duration is outside the allowed range')
  }
}

function validateTransformJobLease(input: TransformJobLeaseV2): void {
  validateJobId(input.id)
  if (!Number.isSafeInteger(input.attempt) || input.attempt < 1) {
    throw new V2CatalogInputError('Transform job attempt must be a positive safe integer')
  }
  if (!(input.leaseToken instanceof Uint8Array) || input.leaseToken.byteLength !== 32) {
    throw new V2CatalogInputError('Transform job lease token must contain exactly 32 bytes')
  }
}

function validateStagingKeys(input: SetTransformJobStagingKeysV2): void {
  const prefix = `staging/worker/v1/${input.id}/${input.attempt}`
  if (input.inputKey !== `${prefix}/input.jsonl` || input.outputKey !== `${prefix}/output.jsonl`) {
    throw new V2CatalogInputError('Transform job staging keys do not match the exact attempt')
  }
}

function validateProgress(progress: CatalogTransformJobProgressV2): void {
  if (!SAFE_WORKER_NAME.test(progress.phase)) {
    throw new V2CatalogInputError('Transform job progress phase is invalid')
  }
  if (
    progress.completedUnits < 0n ||
    progress.completedUnits > POSTGRES_BIGINT_MAX ||
    (progress.totalUnits !== null &&
      (progress.totalUnits < progress.completedUnits || progress.totalUnits > POSTGRES_BIGINT_MAX))
  ) {
    throw new V2CatalogInputError('Transform job progress units are invalid')
  }
}

function validateError(error: CatalogTransformJobErrorV2): void {
  if (
    !SAFE_WORKER_NAME.test(error.code) ||
    error.message.length < 1 ||
    error.message.length > 2_048
  ) {
    throw new V2CatalogInputError('Transform job error is invalid')
  }
  validateBoundedJson(
    { code: error.code, message: error.message, retryable: error.retryable },
    'Transform job error',
  )
}

function validateBoundedJson(value: CatalogJsonValueV2, label: string): void {
  const encoded = JSON.stringify(value)
  if (Buffer.byteLength(encoded, 'utf8') > MAX_JOB_JSON_BYTES) {
    throw new V2CatalogInputError(`${label} exceeds ${MAX_JOB_JSON_BYTES} bytes`)
  }
}

function parseTransformJobStatus(value: string): CatalogTransformJobStatusV2 {
  if (
    value === 'queued' ||
    value === 'leased' ||
    value === 'running' ||
    value === 'finalizing' ||
    value === 'completed' ||
    value === 'failed' ||
    value === 'cancelled'
  ) {
    return value
  }
  throw new V2CatalogConsistencyError('Stored transform job status is invalid')
}

function parseStoredTransformJobProgress(
  value: Prisma.JsonValue | null,
): CatalogTransformJobProgressV2 | null {
  if (value === null) return null
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new V2CatalogConsistencyError('Stored transform job progress is invalid')
  }
  const phase = value.phase
  const completedUnits = parseStoredDecimal(value.completed_units)
  const totalUnits = value.total_units === null ? null : parseStoredDecimal(value.total_units)
  if (typeof phase !== 'string') {
    throw new V2CatalogConsistencyError('Stored transform job progress phase is invalid')
  }
  const progress = { phase, completedUnits, totalUnits }
  try {
    validateProgress(progress)
  } catch (error) {
    throw new V2CatalogConsistencyError('Stored transform job progress is invalid', {
      cause: error,
    })
  }
  return progress
}

function parseStoredTransformJobError(
  value: Prisma.JsonValue | null,
): CatalogTransformJobErrorV2 | null {
  if (value === null) return null
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new V2CatalogConsistencyError('Stored transform job error is invalid')
  }
  const { code, message, retryable } = value
  if (typeof code !== 'string' || typeof message !== 'string' || typeof retryable !== 'boolean') {
    throw new V2CatalogConsistencyError('Stored transform job error fields are invalid')
  }
  const error = { code, message, retryable }
  try {
    validateError(error)
  } catch (cause) {
    throw new V2CatalogConsistencyError('Stored transform job error is invalid', { cause })
  }
  return error
}

function parseStoredDecimal(value: Prisma.JsonValue | undefined): bigint {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new V2CatalogConsistencyError('Stored transform job quantity is invalid')
  }
  return BigInt(value)
}

function assertStoredLeaseShape(
  owner: string | null,
  token: Uint8Array | null,
  expiresAt: Date | null,
): void {
  const nullCount = [owner, token, expiresAt].filter((value) => value === null).length
  if (nullCount !== 0 && nullCount !== 3) {
    throw new V2CatalogConsistencyError('Stored transform job lease shape is invalid')
  }
  if (token !== null && token.byteLength !== 32) {
    throw new V2CatalogConsistencyError('Stored transform job lease token size is invalid')
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
  const locked = await tx.$queryRaw<Array<{ readonly namespace_id: string }>>`
    SELECT "namespace_id"
    FROM "refs_v2"
    WHERE "namespace_id" = ${namespaceId}::uuid AND "name" = ${name}
    FOR UPDATE
  `
  if (locked.length > 1) {
    throw new V2CatalogConsistencyError('V2 ref state lookup returned more than one row')
  }
  if (locked.length === 0) return null

  // Read the joined snapshot metadata only after the ref row lock is held. A
  // joined SELECT ... FOR UPDATE can otherwise lose a concurrently updated ref
  // during PostgreSQL EvalPlanQual rechecks and incorrectly report `missing`.
  const row = await tx.v2Ref.findUnique({
    where: { namespaceId_name: { namespaceId, name } },
    include: { dataset: { select: { numRecords: true } } },
  })
  if (!row) {
    throw new V2CatalogConsistencyError('V2 locked ref disappeared before state lookup')
  }
  return prismaRowToRef(row)
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
