import { randomBytes, randomUUID } from 'node:crypto'
import { Prisma, type PrismaClient } from '@prisma/client'
import { createPrismaClient } from '../client.js'
import {
  V2CatalogConsistencyError,
  V2CatalogDeterminismConflictError,
  V2CatalogImmutableConflictError,
  V2CatalogInputError,
  V2CatalogLineageCycleError,
  V2CatalogModelArtifactImportConflictError,
  V2CatalogModelDeploymentAdmissionError,
  V2CatalogRefConflictError,
  V2CatalogRefStateConflictError,
  V2CatalogSwiftStudioSessionConflictError,
  V2CatalogTargetNotCommittedError,
  V2CatalogTransformJobLeaseError,
} from './errors.js'
import type {
  CatalogEvaluationMetricV2,
  CatalogEvaluationRunCursorV2,
  CatalogEvaluationRunErrorV2,
  CatalogEvaluationRunListFilterV2,
  CatalogEvaluationRunPageV2,
  CatalogEvaluationRunRowV2,
  CatalogEvaluationRunStatusV2,
  CatalogIdentityClaimInputV2,
  CatalogIdentityClaimResultV2,
  CatalogIdentityClaimRowV2,
  CatalogJsonValueV2,
  CatalogLayoutInputV2,
  CatalogLayoutRowV2,
  CatalogModelArtifactCursorV2,
  CatalogModelArtifactFinalizeResultV2,
  CatalogModelArtifactImportCreateResultV2,
  CatalogModelArtifactImportFailureV2,
  CatalogModelArtifactImportRowV2,
  CatalogModelArtifactImportStatusV2,
  CatalogModelArtifactListFilterV2,
  CatalogModelArtifactManifestV2,
  CatalogModelArtifactPageV2,
  CatalogModelArtifactRowV2,
  CatalogModelDeploymentCursorV2,
  CatalogModelDeploymentHealthV2,
  CatalogModelDeploymentListFilterV2,
  CatalogModelDeploymentPageV2,
  CatalogModelDeploymentRowV2,
  CatalogRecordParentRowV2,
  CatalogRecordRevisionV2,
  CatalogRefPageV2,
  CatalogRefRowV2,
  CatalogRunInputV2,
  CatalogRunPageV2,
  CatalogRunRowV2,
  CatalogSnapshotInputV2,
  CatalogSnapshotRowV2,
  CatalogSwiftStudioSessionCreateResultV2,
  CatalogSwiftStudioSessionCursorV2,
  CatalogSwiftStudioSessionFailureV2,
  CatalogSwiftStudioSessionListFilterV2,
  CatalogSwiftStudioSessionPageV2,
  CatalogSwiftStudioSessionPreparationClaimResultV2,
  CatalogSwiftStudioSessionRowV2,
  CatalogSwiftStudioSessionStatusV2,
  CatalogTransformJobCursorV2,
  CatalogTransformJobErrorV2,
  CatalogTransformJobPageV2,
  CatalogTransformJobProgressV2,
  CatalogTransformJobResultRefStatusV2,
  CatalogTransformJobRowV2,
  CatalogTransformJobStatusV2,
  ClaimTransformJobV2,
  ClearCompletedTransformJobStagingV2,
  CompareAndSetRefV2,
  CompleteTransformJobV2,
  CreateEvaluationRunV2,
  CreateModelArtifactImportV2,
  CreateModelDeploymentV2,
  CreateSwiftStudioSessionV2,
  CreateTransformJobV2,
  DeleteRefResultV2,
  DeleteRefV2,
  FailEvaluationRunArchiveV2,
  FailTransformJobV2,
  FinalizeEvaluationRunArchiveV2,
  FinalizeModelArtifactImportV2,
  MarkEvaluationRunArchiveUploadingV2,
  PrepareEvaluationRunArchiveV2,
  RegisterLayoutV2,
  RegisterTransformResultV2,
  RestoreRefResultV2,
  RestoreRefV2,
  SetTransformJobStagingKeysV2,
  TransformJobLeaseV2,
  TransitionEvaluationRunV2,
  TransitionModelArtifactImportV2,
  TransitionSwiftStudioSessionV2,
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
const SAFE_REF_NAME = /^[a-z0-9][a-z0-9._-]{0,127}$/
const MAX_JOB_JSON_BYTES = 16 * 1024
const MAX_JOB_LEASE_MS = 24 * 60 * 60 * 1_000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const PROVIDER_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/
const PROVIDER_REPORT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,511}$/
const SAFE_EVALUATION_NAME = /^[a-z][a-z0-9._-]{0,127}$/
const SAFE_EVALUATION_VERSION = /^[a-z0-9][a-z0-9._-]{0,127}$/
const GIT_COMMIT = /^[0-9a-f]{40}$/
const CREDENTIAL_VALUE =
  /(?:\bsk-(?:proj-)?[A-Za-z0-9_-]{8,}\b)|(?:\b(?:authorization|x-api-key|api[_-]?key|token)\s*[:=]\s*\S+)/i
const MAX_EVALUATION_OPTIONS_BYTES = 64 * 1024
const MAX_EVALUATION_METRICS = 10_000
const MAX_EVALUATION_METRICS_BYTES = 8 * 1024 * 1024
const MAX_PROVIDER_REPORT_IDS = 32
const SWIFT_PROVIDER_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/
const MAX_SWIFT_OPTIONS_BYTES = 64 * 1024
const MAX_SWIFT_PREPARATION_ABANDON_GRACE_MS = 24 * 60 * 60 * 1_000
const MODEL_ARTIFACT_PROVIDER_IMPORT_ID = /^swai_[A-Za-z0-9_-]{16,128}$/
const MODEL_ARTIFACT_STAGING_KEY = /^staging\/swift-artifact\/v1\/[0-9a-f-]{36}\/archive\.tar\.zst$/
const MODEL_ARTIFACT_OBJECT_LOCATOR =
  /^objects\/v2\/model-artifact-v1\/[0-9a-f]{2}\/[0-9a-f]{64}\.tar\.zst$/
const MODEL_REVISION = /^[A-Za-z0-9][A-Za-z0-9._/+:-]{0,255}$/
const ABSOLUTE_PATH = /^(?:\/|\\|[A-Za-z]:[\\/]|file:|(?:\.\.?)[\\/]|(?:~)[\\/])/i
const ALLOWED_ADAPTER_FILE =
  /^(?:additional_config\.json|adapter_config\.json|adapter_model\.safetensors|adapter_model-\d{5}-of-\d{5}\.safetensors|adapter_model\.safetensors\.index\.json|tokenizer\.json|tokenizer_config\.json|special_tokens_map\.json|added_tokens\.json|merges\.txt|vocab\.json|preprocessor_config\.json|processor_config\.json|chat_template\.json)$/
const MAX_MODEL_ARTIFACT_MANIFEST_BYTES = 256 * 1024
const MAX_MODEL_ARTIFACT_FILES = 256

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

interface TransformJobResultRefSqlRow {
  readonly version: string
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
  readonly result_ref_namespace_id: string | null
  readonly result_ref_name: string | null
  readonly result_ref_status: string | null
  readonly result_ref_version: string | null
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

interface EvaluationRunSqlRow {
  readonly id: string
  readonly namespace_id: string
  readonly provider: string
  readonly provider_task_id: string
  readonly create_profile: string
  readonly create_request_digest: string
  readonly provider_report_ids_json: Prisma.JsonValue | null
  readonly dataset_version: string
  readonly source_ref: string | null
  readonly converter: string
  readonly converter_version: string
  readonly converter_options_json: Prisma.JsonValue
  readonly fidelity_digest: string
  readonly benchmark: string
  readonly model_name: string | null
  readonly model_deployment_id: string | null
  readonly model_artifact_id: string | null
  readonly model_deployment_digest: string | null
  readonly evalscope_commit: string | null
  readonly scoring_config_json: Prisma.JsonValue | null
  readonly primary_metric_id: string | null
  readonly primary_output_key: string | null
  readonly status: string
  readonly metrics_json: Prisma.JsonValue | null
  readonly error_json: Prisma.JsonValue | null
  readonly archive_status: string
  readonly archive_attempt: number
  readonly result_artifact_key: string | null
  readonly result_artifact_digest: string | null
  readonly result_artifact_size_bytes: bigint | null
  readonly archive_error_json: Prisma.JsonValue | null
  readonly created_at: Date
  readonly started_at: Date | null
  readonly finished_at: Date | null
  readonly updated_at: Date
}

interface SwiftStudioSessionSqlRow {
  readonly id: string
  readonly namespace_id: string
  readonly create_digest: string
  readonly status: string
  readonly dataset_version: string
  readonly display_ref: string | null
  readonly converter: string
  readonly converter_version: string
  readonly normalized_options_json: Prisma.JsonValue
  readonly fidelity_digest: string
  readonly export_output_count: bigint
  readonly export_digest: string | null
  readonly export_size_bytes: bigint | null
  readonly provider: string
  readonly provider_session_id: string
  readonly upstream_commit: string
  readonly image_digest: string
  readonly runtime_capability_digest: string
  readonly failure_json: Prisma.JsonValue | null
  readonly preparation_owner_token: string
  readonly preparation_abandoned_at: Date | null
  readonly preparation_expires_at: Date
  readonly created_at: Date
  readonly ready_at: Date | null
  readonly closed_at: Date | null
  readonly updated_at: Date
}

interface ModelArtifactImportSqlRow {
  readonly id: string
  readonly namespace_id: string
  readonly create_digest: string
  readonly status: string
  readonly studio_session_id: string
  readonly output_handle_digest: string
  readonly artifact_kind: string
  readonly display_name: string
  readonly base_model_reference: string
  readonly base_model_revision: string | null
  readonly provider_import_id: string | null
  readonly output_snapshot_digest: string | null
  readonly staging_object_key: string | null
  readonly archive_digest: string | null
  readonly archive_size_bytes: bigint | null
  readonly manifest_digest: string | null
  readonly manifest_json: Prisma.JsonValue | null
  readonly dataset_lineage_status: string | null
  readonly dataset_version: string | null
  readonly dataset_export_digest: string | null
  readonly base_model_binding_status: string | null
  readonly artifact_id: string | null
  readonly failure_json: Prisma.JsonValue | null
  readonly created_at: Date
  readonly staging_at: Date | null
  readonly finalizing_at: Date | null
  readonly completed_at: Date | null
  readonly failed_at: Date | null
  readonly staging_cleaned_at: Date | null
  readonly updated_at: Date
}

interface ModelArtifactSqlRow {
  readonly id: string
  readonly namespace_id: string
  readonly display_name: string
  readonly artifact_kind: string
  readonly artifact_format: string
  readonly archive_format: string
  readonly archive_digest: string
  readonly archive_size_bytes: bigint
  readonly object_locator: string
  readonly manifest_digest: string
  readonly manifest_json: Prisma.JsonValue
  readonly source_kind: string
  readonly source_session_id: string
  readonly source_import_id: string
  readonly dataset_lineage_status: string
  readonly dataset_version: string | null
  readonly dataset_export_digest: string | null
  readonly base_model_reference: string
  readonly base_model_revision: string | null
  readonly base_model_binding_status: string
  readonly upstream_commit: string
  readonly image_digest: string
  readonly created_at: Date
}

interface ModelDeploymentSqlRow {
  readonly id: string
  readonly namespace_id: string
  readonly create_digest: string
  readonly artifact_id: string
  readonly provider: string
  readonly display_name: string
  readonly served_model_name: string
  readonly endpoint_base_url: string
  readonly auth_mode: string
  readonly status: string
  readonly health_status: string
  readonly health_checked_at: Date | null
  readonly health_error: string | null
  readonly created_at: Date
  readonly disabled_at: Date | null
  readonly updated_at: Date
}

const TRANSFORM_JOB_COLUMNS = Prisma.sql`
  "id", "cache_key", "op", "op_version", "params_json", "input_version",
  "capability_name", "capability_version", "status", "attempt", "lease_owner",
  "lease_token", "lease_expires_at", "progress_json", "input_key", "output_key",
  "input_count", "output_count", "output_version", "result_ref_namespace_id",
  "result_ref_name", "result_ref_status", "result_ref_version", "cache_hit", "error_json",
  "created_at", "started_at", "finished_at", "updated_at"
`

const EVALUATION_RUN_COLUMNS = Prisma.sql`
  "id", "namespace_id", "provider", "provider_task_id", "create_profile",
  "create_request_digest",
  "provider_report_ids_json", "dataset_version", "source_ref", "converter",
  "converter_version", "converter_options_json", "fidelity_digest", "benchmark",
  "model_name", "model_deployment_id", "model_artifact_id", "model_deployment_digest",
  "evalscope_commit", "scoring_config_json", "primary_metric_id", "primary_output_key",
  "status", "metrics_json", "error_json",
  "archive_status", "archive_attempt", "result_artifact_key", "result_artifact_digest",
  "result_artifact_size_bytes", "archive_error_json", "created_at", "started_at",
  "finished_at", "updated_at"
`

const SWIFT_STUDIO_SESSION_COLUMNS = Prisma.sql`
  "id", "namespace_id", "create_digest", "status", "dataset_version", "display_ref",
  "converter", "converter_version", "normalized_options_json", "fidelity_digest",
  "export_output_count", "export_digest", "export_size_bytes", "provider",
  "provider_session_id", "upstream_commit", "image_digest", "runtime_capability_digest",
  "failure_json", "preparation_owner_token", "preparation_abandoned_at",
  "preparation_expires_at", "created_at", "ready_at", "closed_at", "updated_at"
`

const MODEL_ARTIFACT_IMPORT_COLUMNS = Prisma.sql`
  "id", "namespace_id", "create_digest", "status", "studio_session_id",
  "output_handle_digest", "artifact_kind", "display_name", "base_model_reference",
  "base_model_revision", "provider_import_id", "output_snapshot_digest",
  "staging_object_key", "archive_digest", "archive_size_bytes", "manifest_digest",
  "manifest_json", "dataset_lineage_status", "dataset_version",
  "dataset_export_digest", "base_model_binding_status", "artifact_id", "failure_json",
  "created_at", "staging_at", "finalizing_at", "completed_at", "failed_at",
  "staging_cleaned_at", "updated_at"
`

const MODEL_ARTIFACT_COLUMNS = Prisma.sql`
  "id", "namespace_id", "display_name", "artifact_kind", "artifact_format",
  "archive_format", "archive_digest", "archive_size_bytes", "object_locator",
  "manifest_digest", "manifest_json", "source_kind", "source_session_id",
  "source_import_id", "dataset_lineage_status", "dataset_version",
  "dataset_export_digest", "base_model_reference", "base_model_revision",
  "base_model_binding_status", "upstream_commit", "image_digest", "created_at"
`

const MODEL_DEPLOYMENT_COLUMNS = Prisma.sql`
  "id", "namespace_id", "create_digest", "artifact_id", "provider", "display_name",
  "served_model_name", "endpoint_base_url", "auth_mode", "status", "health_status",
  "health_checked_at", "health_error", "created_at", "disabled_at", "updated_at"
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
        const resultRef =
          row.result_ref_namespace_id !== null && row.result_ref_name !== null
            ? await adoptTransformJobResultRefInTransaction(
                tx,
                row.result_ref_namespace_id,
                row.result_ref_name,
                input.run.outputVersion,
              )
            : null
        const completed = await tx.$queryRaw<TransformJobSqlRow[]>(Prisma.sql`
          UPDATE "transform_jobs_v2"
          SET
            "status" = 'completed',
            "output_count" = ${input.outputCount},
            "output_version" = ${input.run.outputVersion},
            "result_ref_status" = ${resultRef?.status ?? null},
            "result_ref_version" = ${resultRef?.version ?? null},
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

  async createOrReadEvaluationRun(
    input: CreateEvaluationRunV2,
  ): Promise<CatalogEvaluationRunRowV2> {
    validateCreateEvaluationRun(input)
    return await this.#client.$transaction(async (tx) => {
      await acquireEvaluationRunAdmissionLock(tx, input)
      const existing = await tx.$queryRaw<EvaluationRunSqlRow[]>(Prisma.sql`
        SELECT ${EVALUATION_RUN_COLUMNS}
        FROM "evaluation_runs_v2"
        WHERE
          "namespace_id" = ${input.namespaceId}::uuid AND
          "provider" = ${input.provider} AND
          "provider_task_id" = ${input.providerTaskId}
      `)
      if (existing.length > 1) {
        throw new V2CatalogConsistencyError('Evaluation run replay lookup returned multiple rows')
      }
      if (existing[0]) return sqlRowToEvaluationRun(existing[0])

      if (
        input.createProfile === 'evaluation-run-create-v2' ||
        input.createProfile === 'evaluation-run-create-v4'
      ) {
        const deployments = await tx.$queryRaw<ModelDeploymentSqlRow[]>(Prisma.sql`
          SELECT ${MODEL_DEPLOYMENT_COLUMNS}
          FROM "model_deployments_v2"
          WHERE
            "namespace_id" = ${input.namespaceId}::uuid AND
            "id" = ${input.modelDeploymentId}::uuid AND
            "artifact_id" = ${input.modelArtifactId}::uuid AND
            "create_digest" = ${input.modelDeploymentDigest}
          FOR SHARE
        `)
        if (deployments.length > 1) {
          throw new V2CatalogConsistencyError(
            'Evaluation run admission locked multiple Model Deployments',
          )
        }
        const deployment = deployments[0]
        if (!deployment) {
          throw new V2CatalogInputError('Evaluation run Model Deployment binding is not registered')
        }
        if (deployment.status !== 'active') {
          throw new V2CatalogModelDeploymentAdmissionError('disabled', deployment.id)
        }
        if (deployment.served_model_name !== input.modelName) {
          throw new V2CatalogInputError(
            'Evaluation run model name must match its immutable Model Deployment',
          )
        }
      }

      const id = randomUUID()
      const converterOptionsJson = JSON.stringify(input.converterOptions)
      const scoringConfigJson =
        input.scoringConfig === null ? null : JSON.stringify(input.scoringConfig)
      const inserted = await tx.$queryRaw<EvaluationRunSqlRow[]>(Prisma.sql`
        INSERT INTO "evaluation_runs_v2" (
          "id", "namespace_id", "provider", "provider_task_id", "create_profile",
          "create_request_digest", "dataset_version", "source_ref", "converter",
          "converter_version", "converter_options_json", "fidelity_digest", "benchmark",
          "model_name", "model_deployment_id", "model_artifact_id",
          "model_deployment_digest", "evalscope_commit", "scoring_config_json",
          "primary_metric_id", "primary_output_key", "status"
        )
        VALUES (
          ${id}::uuid, ${input.namespaceId}::uuid, ${input.provider}, ${input.providerTaskId},
          ${input.createProfile}, ${input.createRequestDigest}, ${input.datasetVersion},
          ${input.sourceRef}, ${input.converter}, ${input.converterVersion},
          ${converterOptionsJson}::jsonb, ${input.fidelityDigest}, ${input.benchmark},
          ${input.modelName}, ${input.modelDeploymentId}::uuid, ${input.modelArtifactId}::uuid,
          ${input.modelDeploymentDigest}, ${input.evalscopeCommit},
          ${scoringConfigJson}::jsonb, ${input.primaryMetricId}, ${input.primaryOutputKey},
          'prepared'
        )
        ON CONFLICT ("namespace_id", "provider", "provider_task_id") DO NOTHING
        RETURNING ${EVALUATION_RUN_COLUMNS}
      `)
      if (inserted.length > 1) {
        throw new V2CatalogConsistencyError('Evaluation run insert returned more than one row')
      }
      const created = inserted[0]
      if (created) return sqlRowToEvaluationRun(created)

      const winner = await tx.$queryRaw<EvaluationRunSqlRow[]>(Prisma.sql`
        SELECT ${EVALUATION_RUN_COLUMNS}
        FROM "evaluation_runs_v2"
        WHERE
          "namespace_id" = ${input.namespaceId}::uuid AND
          "provider" = ${input.provider} AND
          "provider_task_id" = ${input.providerTaskId}
      `)
      if (winner.length !== 1 || !winner[0]) {
        throw new V2CatalogConsistencyError(
          'Evaluation run insert conflicted but the winning row could not be read',
        )
      }
      return sqlRowToEvaluationRun(winner[0])
    })
  }

  async getEvaluationRun(
    namespaceId: string,
    id: string,
  ): Promise<CatalogEvaluationRunRowV2 | null> {
    validateNamespaceId(namespaceId)
    validateEvaluationRunId(id)
    const rows = await this.#client.$queryRaw<EvaluationRunSqlRow[]>(Prisma.sql`
      SELECT ${EVALUATION_RUN_COLUMNS}
      FROM "evaluation_runs_v2"
      WHERE "namespace_id" = ${namespaceId}::uuid AND "id" = ${id}::uuid
    `)
    if (rows.length > 1) {
      throw new V2CatalogConsistencyError('Evaluation run lookup returned more than one row')
    }
    return rows[0] ? sqlRowToEvaluationRun(rows[0]) : null
  }

  async listEvaluationRuns(
    namespaceId: string,
    filter: CatalogEvaluationRunListFilterV2,
    before: CatalogEvaluationRunCursorV2 | null,
    limit: number,
  ): Promise<CatalogEvaluationRunPageV2> {
    validateNamespaceId(namespaceId)
    validateEvaluationRunListFilter(filter)
    if (before !== null) validateEvaluationRunCursor(before)
    const fetchLimit = checkedPageFetchLimit(limit, 'Evaluation run page limit')
    const rows = await this.#client.$queryRaw<EvaluationRunSqlRow[]>(Prisma.sql`
      SELECT ${EVALUATION_RUN_COLUMNS}
      FROM "evaluation_runs_v2"
      WHERE
        "namespace_id" = ${namespaceId}::uuid AND
        ${
          filter.datasetVersion === null
            ? Prisma.sql`TRUE`
            : Prisma.sql`"dataset_version" = ${filter.datasetVersion}`
        } AND
        ${
          filter.modelDeploymentId === null
            ? Prisma.sql`TRUE`
            : Prisma.sql`"model_deployment_id" = ${filter.modelDeploymentId}::uuid`
        } AND
        ${filter.status === null ? Prisma.sql`TRUE` : Prisma.sql`"status" = ${filter.status}`} AND
        ${
          before === null
            ? Prisma.sql`TRUE`
            : Prisma.sql`
              (
                date_trunc('milliseconds', "created_at") < ${before.createdAt} OR
                (
                  date_trunc('milliseconds', "created_at") = ${before.createdAt} AND
                  "id"::text COLLATE "C" < ${before.id}
                )
              )
            `
        }
      ORDER BY date_trunc('milliseconds', "created_at") DESC, "id"::text COLLATE "C" DESC
      LIMIT ${fetchLimit}
    `)
    const hasMore = rows.length > limit
    const pageRows = rows.slice(0, limit).map(sqlRowToEvaluationRun)
    const last = hasMore ? pageRows.at(-1) : undefined
    return {
      rows: Object.freeze(pageRows),
      nextCursor:
        last === undefined
          ? null
          : Object.freeze({ createdAt: truncateDateToMilliseconds(last.createdAt), id: last.id }),
    }
  }

  async transitionEvaluationRun(
    input: TransitionEvaluationRunV2,
  ): Promise<CatalogEvaluationRunRowV2 | null> {
    validateEvaluationRunTransition(input)
    const fromStatuses: readonly CatalogEvaluationRunStatusV2[] =
      input.status === 'running'
        ? ['prepared']
        : input.status === 'completed'
          ? ['running']
          : ['prepared', 'running']
    let assignments: Prisma.Sql
    if (input.status === 'running') {
      assignments = Prisma.sql`
        "status" = 'running',
        "started_at" = COALESCE("started_at", clock_timestamp())
      `
    } else if (input.status === 'completed') {
      const metricsJson = JSON.stringify(
        input.metrics.map((metric) => ({
          dataset: metric.dataset,
          subset: metric.subset,
          metric_id: metric.metricId,
          output_key: metric.outputKey,
          metric: metric.metric,
          score: metric.score,
          sample_count: metric.sampleCount,
          categories: metric.categories,
        })),
      )
      const reportIdsJson = JSON.stringify(input.providerReportIds)
      assignments = Prisma.sql`
        "status" = 'completed',
        "metrics_json" = ${metricsJson}::jsonb,
        "provider_report_ids_json" = ${reportIdsJson}::jsonb,
        "finished_at" = clock_timestamp()
      `
    } else {
      const errorJson = JSON.stringify(input.error)
      assignments = Prisma.sql`
        "status" = ${input.status},
        "error_json" = ${errorJson}::jsonb,
        "finished_at" = clock_timestamp()
      `
    }
    const rows = await this.#client.$queryRaw<EvaluationRunSqlRow[]>(Prisma.sql`
      UPDATE "evaluation_runs_v2"
      SET ${assignments}, "updated_at" = clock_timestamp()
      WHERE
        "namespace_id" = ${input.namespaceId}::uuid AND
        "id" = ${input.id}::uuid AND
        "status" IN (${Prisma.join(fromStatuses)})
      RETURNING ${EVALUATION_RUN_COLUMNS}
    `)
    if (rows.length > 1) {
      throw new V2CatalogConsistencyError('Evaluation run transition returned more than one row')
    }
    return rows[0]
      ? sqlRowToEvaluationRun(rows[0])
      : await this.getEvaluationRun(input.namespaceId, input.id)
  }

  async createOrReadSwiftStudioSession(
    input: CreateSwiftStudioSessionV2,
  ): Promise<CatalogSwiftStudioSessionCreateResultV2> {
    validateCreateSwiftStudioSession(input)
    return await this.#client.$transaction(async (tx) => {
      await acquireSwiftStudioSessionLock(tx)
      const id = randomUUID()
      const preparationOwnerToken = randomUUID()
      const normalizedOptionsJson = JSON.stringify(input.normalizedOptions)
      const inserted = await tx.$queryRaw<SwiftStudioSessionSqlRow[]>(Prisma.sql`
        INSERT INTO "swift_studio_sessions_v2" (
          "id", "namespace_id", "create_digest", "status", "dataset_version", "display_ref",
          "converter", "converter_version", "normalized_options_json", "fidelity_digest",
          "export_output_count", "provider", "provider_session_id", "upstream_commit",
          "image_digest", "runtime_capability_digest", "preparation_owner_token"
        )
        VALUES (
          ${id}::uuid, ${input.namespaceId}::uuid, ${input.createDigest}, 'preparing',
          ${input.datasetVersion}, ${input.displayRef}, ${input.converter},
          ${input.converterVersion}, ${normalizedOptionsJson}::jsonb, ${input.fidelityDigest},
          ${input.exportOutputCount}, ${input.provider}, ${input.providerSessionId},
          ${input.upstreamCommit}, ${input.imageDigest}, ${input.runtimeCapabilityDigest},
          ${preparationOwnerToken}::uuid
        )
        ON CONFLICT DO NOTHING
        RETURNING ${SWIFT_STUDIO_SESSION_COLUMNS}
      `)
      if (inserted.length > 1) {
        throw new V2CatalogConsistencyError(
          'Swift Studio Session insert returned more than one row',
        )
      }
      const created = inserted[0]
      if (created) {
        return Object.freeze({ row: sqlRowToSwiftStudioSession(created), created: true })
      }

      const replayRows = await tx.$queryRaw<SwiftStudioSessionSqlRow[]>(Prisma.sql`
        SELECT ${SWIFT_STUDIO_SESSION_COLUMNS}
        FROM "swift_studio_sessions_v2"
        WHERE
          "namespace_id" = ${input.namespaceId}::uuid AND
          "create_digest" = ${input.createDigest}
      `)
      if (replayRows.length > 1) {
        throw new V2CatalogConsistencyError(
          'Swift Studio Session replay lookup returned more than one row',
        )
      }
      const replay = replayRows[0]
      if (replay) {
        const row = sqlRowToSwiftStudioSession(replay)
        if (!sameSwiftStudioSessionCreate(row, input)) {
          throw new V2CatalogSwiftStudioSessionConflictError(
            'create_request_mismatch',
            row.id,
            row.status,
            null,
          )
        }
        return Object.freeze({ row, created: false })
      }

      const activeRows = await tx.$queryRaw<SwiftStudioSessionSqlRow[]>(Prisma.sql`
        SELECT ${SWIFT_STUDIO_SESSION_COLUMNS}
        FROM "swift_studio_sessions_v2"
        WHERE "provider" = ${input.provider} AND "status" IN ('preparing', 'ready', 'closing')
      `)
      if (activeRows.length > 1) {
        throw new V2CatalogConsistencyError('More than one active Swift Studio Session exists')
      }
      const active = activeRows[0]
      if (active) {
        const row = sqlRowToSwiftStudioSession(active)
        throw new V2CatalogSwiftStudioSessionConflictError(
          'active_session_exists',
          row.id,
          row.status,
          null,
        )
      }

      const locatorRows = await tx.$queryRaw<SwiftStudioSessionSqlRow[]>(Prisma.sql`
        SELECT ${SWIFT_STUDIO_SESSION_COLUMNS}
        FROM "swift_studio_sessions_v2"
        WHERE
          "provider" = ${input.provider} AND
          "provider_session_id" = ${input.providerSessionId}
      `)
      if (locatorRows.length !== 1 || !locatorRows[0]) {
        throw new V2CatalogConsistencyError(
          'Swift Studio Session insert conflicted but the winning row could not be read',
        )
      }
      const locator = sqlRowToSwiftStudioSession(locatorRows[0])
      throw new V2CatalogSwiftStudioSessionConflictError(
        'create_request_mismatch',
        locator.id,
        locator.status,
        null,
      )
    })
  }

  async getSwiftStudioSession(
    namespaceId: string,
    id: string,
  ): Promise<CatalogSwiftStudioSessionRowV2 | null> {
    validateNamespaceId(namespaceId)
    validateSwiftStudioSessionId(id)
    const rows = await this.#client.$queryRaw<SwiftStudioSessionSqlRow[]>(Prisma.sql`
      SELECT ${SWIFT_STUDIO_SESSION_COLUMNS}
      FROM "swift_studio_sessions_v2"
      WHERE "namespace_id" = ${namespaceId}::uuid AND "id" = ${id}::uuid
    `)
    if (rows.length > 1) {
      throw new V2CatalogConsistencyError('Swift Studio Session lookup returned more than one row')
    }
    return rows[0] ? sqlRowToSwiftStudioSession(rows[0]) : null
  }

  async abandonSwiftStudioSessionPreparation(
    namespaceId: string,
    id: string,
    preparationOwnerToken: string,
  ): Promise<boolean> {
    validateNamespaceId(namespaceId)
    validateSwiftStudioSessionId(id)
    validateSwiftStudioSessionPreparationOwnerToken(preparationOwnerToken)
    const rows = await this.#client.$queryRaw<Array<{ readonly id: string }>>(Prisma.sql`
      UPDATE "swift_studio_sessions_v2"
      SET
        "preparation_abandoned_at" = COALESCE(
          "preparation_abandoned_at",
          clock_timestamp()
        ),
        "updated_at" = clock_timestamp()
      WHERE
        "namespace_id" = ${namespaceId}::uuid AND
        "id" = ${id}::uuid AND
        "status" = 'preparing' AND
        "preparation_owner_token" = ${preparationOwnerToken}::uuid
      RETURNING "id"
    `)
    if (rows.length > 1) {
      throw new V2CatalogConsistencyError(
        'Swift Studio Session preparation abandon returned more than one row',
      )
    }
    return rows.length === 1
  }

  async renewSwiftStudioSessionPreparation(
    namespaceId: string,
    id: string,
    preparationOwnerToken: string,
  ): Promise<boolean> {
    validateNamespaceId(namespaceId)
    validateSwiftStudioSessionId(id)
    validateSwiftStudioSessionPreparationOwnerToken(preparationOwnerToken)
    const rows = await this.#client.$queryRaw<Array<{ readonly id: string }>>(Prisma.sql`
      UPDATE "swift_studio_sessions_v2"
      SET
        "preparation_abandoned_at" = NULL,
        "preparation_expires_at" = clock_timestamp() + INTERVAL '5 hours',
        "updated_at" = clock_timestamp()
      WHERE
        "namespace_id" = ${namespaceId}::uuid AND
        "id" = ${id}::uuid AND
        "status" = 'preparing' AND
        "preparation_owner_token" = ${preparationOwnerToken}::uuid
      RETURNING "id"
    `)
    if (rows.length > 1) {
      throw new V2CatalogConsistencyError(
        'Swift Studio Session preparation renew returned more than one row',
      )
    }
    return rows.length === 1
  }

  async claimSwiftStudioSessionPreparation(
    namespaceId: string,
    id: string,
    observedPreparationOwnerToken: string,
    preparationAbandonGraceMs: number,
  ): Promise<CatalogSwiftStudioSessionPreparationClaimResultV2> {
    validateNamespaceId(namespaceId)
    validateSwiftStudioSessionId(id)
    validateSwiftStudioSessionPreparationOwnerToken(observedPreparationOwnerToken)
    validateSwiftStudioSessionPreparationAbandonGrace(preparationAbandonGraceMs)
    const preparationOwnerToken = randomUUID()
    const rows = await this.#client.$queryRaw<SwiftStudioSessionSqlRow[]>(Prisma.sql`
      UPDATE "swift_studio_sessions_v2"
      SET
        "preparation_owner_token" = ${preparationOwnerToken}::uuid,
        "preparation_abandoned_at" = NULL,
        "preparation_expires_at" = clock_timestamp() + INTERVAL '5 hours',
        "updated_at" = clock_timestamp()
      WHERE
        "namespace_id" = ${namespaceId}::uuid AND
        "id" = ${id}::uuid AND
        "status" = 'preparing' AND
        "preparation_owner_token" = ${observedPreparationOwnerToken}::uuid AND
        (
          "preparation_expires_at" <= clock_timestamp() OR
          (
            "preparation_abandoned_at" IS NOT NULL AND
            "preparation_abandoned_at" <= clock_timestamp() -
              (${preparationAbandonGraceMs} * INTERVAL '1 millisecond')
          )
        )
      RETURNING ${SWIFT_STUDIO_SESSION_COLUMNS}
    `)
    if (rows.length > 1) {
      throw new V2CatalogConsistencyError(
        'Swift Studio Session preparation claim returned more than one row',
      )
    }
    const claimed = rows[0]
    if (claimed) {
      return Object.freeze({ row: sqlRowToSwiftStudioSession(claimed), claimed: true })
    }
    return Object.freeze({
      row: await this.getSwiftStudioSession(namespaceId, id),
      claimed: false,
    })
  }

  async listSwiftStudioSessions(
    namespaceId: string,
    filter: CatalogSwiftStudioSessionListFilterV2,
    before: CatalogSwiftStudioSessionCursorV2 | null,
    limit: number,
  ): Promise<CatalogSwiftStudioSessionPageV2> {
    validateNamespaceId(namespaceId)
    validateSwiftStudioSessionListFilter(filter)
    if (before !== null) validateSwiftStudioSessionCursor(before)
    const fetchLimit = checkedPageFetchLimit(limit, 'Swift Studio Session page limit')
    const rows = await this.#client.$queryRaw<SwiftStudioSessionSqlRow[]>(Prisma.sql`
      SELECT ${SWIFT_STUDIO_SESSION_COLUMNS}
      FROM "swift_studio_sessions_v2"
      WHERE
        "namespace_id" = ${namespaceId}::uuid AND
        ${
          filter.datasetVersion === null
            ? Prisma.sql`TRUE`
            : Prisma.sql`"dataset_version" = ${filter.datasetVersion}`
        } AND
        ${filter.status === null ? Prisma.sql`TRUE` : Prisma.sql`"status" = ${filter.status}`} AND
        ${
          before === null
            ? Prisma.sql`TRUE`
            : Prisma.sql`
              (
                date_trunc('milliseconds', "created_at") < ${before.createdAt} OR
                (
                  date_trunc('milliseconds', "created_at") = ${before.createdAt} AND
                  "id"::text COLLATE "C" < ${before.id}
                )
              )
            `
        }
      ORDER BY date_trunc('milliseconds', "created_at") DESC, "id"::text COLLATE "C" DESC
      LIMIT ${fetchLimit}
    `)
    const hasMore = rows.length > limit
    const pageRows = rows.slice(0, limit).map(sqlRowToSwiftStudioSession)
    const last = hasMore ? pageRows.at(-1) : undefined
    return {
      rows: Object.freeze(pageRows),
      nextCursor:
        last === undefined
          ? null
          : Object.freeze({ createdAt: truncateDateToMilliseconds(last.createdAt), id: last.id }),
    }
  }

  async transitionSwiftStudioSession(
    input: TransitionSwiftStudioSessionV2,
  ): Promise<CatalogSwiftStudioSessionRowV2 | null> {
    validateSwiftStudioSessionTransition(input)
    return await this.#client.$transaction(async (tx) => {
      await acquireSwiftStudioSessionLock(tx)
      const fromStatus =
        input.status === 'ready'
          ? 'preparing'
          : input.status === 'closing'
            ? 'ready'
            : input.status === 'closed'
              ? 'closing'
              : 'preparing'
      const preparationOwnerFence =
        input.status === 'ready' || input.status === 'failed'
          ? Prisma.sql`AND "preparation_owner_token" = ${input.preparationOwnerToken}::uuid`
          : Prisma.empty
      const closingImportFence =
        input.status === 'closing'
          ? Prisma.sql`
              AND NOT EXISTS (
                SELECT 1
                FROM "model_artifact_imports_v2" AS "artifact_import"
                WHERE
                  "artifact_import"."studio_session_id" = "swift_studio_sessions_v2"."id" AND
                  "artifact_import"."status" NOT IN ('completed', 'failed')
              )
            `
          : Prisma.empty
      let assignments: Prisma.Sql
      if (input.status === 'ready') {
        assignments = Prisma.sql`
          "status" = 'ready',
          "export_digest" = ${input.exportDigest},
          "export_size_bytes" = ${input.exportSizeBytes},
          "preparation_abandoned_at" = NULL,
          "ready_at" = clock_timestamp()
        `
      } else if (input.status === 'failed') {
        const failureJson = JSON.stringify(input.failure)
        assignments = Prisma.sql`
          "status" = 'failed',
          "preparation_abandoned_at" = NULL,
          "failure_json" = ${failureJson}::jsonb
        `
      } else if (input.status === 'closed') {
        assignments = Prisma.sql`
          "status" = 'closed',
          "closed_at" = clock_timestamp()
        `
      } else {
        assignments = Prisma.sql`"status" = 'closing'`
      }
      const updatedRows = await tx.$queryRaw<SwiftStudioSessionSqlRow[]>(Prisma.sql`
        UPDATE "swift_studio_sessions_v2"
        SET ${assignments}, "updated_at" = clock_timestamp()
        WHERE
          "namespace_id" = ${input.namespaceId}::uuid AND
          "id" = ${input.id}::uuid AND
          "status" = ${fromStatus}
          ${preparationOwnerFence}
          ${closingImportFence}
        RETURNING ${SWIFT_STUDIO_SESSION_COLUMNS}
      `)
      if (updatedRows.length > 1) {
        throw new V2CatalogConsistencyError(
          'Swift Studio Session transition returned more than one row',
        )
      }
      const updated = updatedRows[0]
      if (updated) return sqlRowToSwiftStudioSession(updated)

      const existingRows = await tx.$queryRaw<SwiftStudioSessionSqlRow[]>(Prisma.sql`
        SELECT ${SWIFT_STUDIO_SESSION_COLUMNS}
        FROM "swift_studio_sessions_v2"
        WHERE "namespace_id" = ${input.namespaceId}::uuid AND "id" = ${input.id}::uuid
      `)
      if (existingRows.length > 1) {
        throw new V2CatalogConsistencyError(
          'Swift Studio Session transition lookup returned more than one row',
        )
      }
      const existingSql = existingRows[0]
      if (!existingSql) return null
      const existing = sqlRowToSwiftStudioSession(existingSql)
      if (existing.status !== input.status) {
        throw new V2CatalogSwiftStudioSessionConflictError(
          'invalid_transition',
          existing.id,
          existing.status,
          input.status,
        )
      }
      if (!sameSwiftStudioSessionTransitionBody(existing, input)) {
        throw new V2CatalogSwiftStudioSessionConflictError(
          'terminal_body_mismatch',
          existing.id,
          existing.status,
          input.status,
        )
      }
      return existing
    })
  }

  async reopenBusySwiftStudioSession(
    namespaceId: string,
    id: string,
  ): Promise<CatalogSwiftStudioSessionRowV2 | null> {
    validateNamespaceId(namespaceId)
    validateSwiftStudioSessionId(id)
    return await this.#client.$transaction(async (tx) => {
      await acquireSwiftStudioSessionLock(tx)
      const reopenedRows = await tx.$queryRaw<SwiftStudioSessionSqlRow[]>(Prisma.sql`
        UPDATE "swift_studio_sessions_v2"
        SET "status" = 'ready', "updated_at" = clock_timestamp()
        WHERE
          "namespace_id" = ${namespaceId}::uuid AND
          "id" = ${id}::uuid AND
          "status" = 'closing'
        RETURNING ${SWIFT_STUDIO_SESSION_COLUMNS}
      `)
      if (reopenedRows.length > 1) {
        throw new V2CatalogConsistencyError(
          'Swift Studio Session busy rollback returned more than one row',
        )
      }
      if (reopenedRows[0]) return sqlRowToSwiftStudioSession(reopenedRows[0])

      const existingRows = await tx.$queryRaw<SwiftStudioSessionSqlRow[]>(Prisma.sql`
        SELECT ${SWIFT_STUDIO_SESSION_COLUMNS}
        FROM "swift_studio_sessions_v2"
        WHERE "namespace_id" = ${namespaceId}::uuid AND "id" = ${id}::uuid
      `)
      if (existingRows.length > 1) {
        throw new V2CatalogConsistencyError(
          'Swift Studio Session busy rollback lookup returned more than one row',
        )
      }
      return existingRows[0] ? sqlRowToSwiftStudioSession(existingRows[0]) : null
    })
  }

  async createOrReadModelArtifactImport(
    input: CreateModelArtifactImportV2,
  ): Promise<CatalogModelArtifactImportCreateResultV2> {
    validateCreateModelArtifactImport(input)
    return await this.#client.$transaction(async (tx) => {
      const sessionRows = await tx.$queryRaw<SwiftStudioSessionSqlRow[]>(Prisma.sql`
        SELECT ${SWIFT_STUDIO_SESSION_COLUMNS}
        FROM "swift_studio_sessions_v2"
        WHERE
          "namespace_id" = ${input.namespaceId}::uuid AND
          "id" = ${input.studioSessionId}::uuid
        FOR SHARE
      `)
      if (sessionRows.length !== 1 || !sessionRows[0]) {
        throw new V2CatalogInputError('Model Artifact import Studio Session is not registered')
      }
      const session = sqlRowToSwiftStudioSession(sessionRows[0])
      const existingReplayRows = await tx.$queryRaw<ModelArtifactImportSqlRow[]>(Prisma.sql`
        SELECT ${MODEL_ARTIFACT_IMPORT_COLUMNS}
        FROM "model_artifact_imports_v2"
        WHERE
          "namespace_id" = ${input.namespaceId}::uuid AND
          "create_digest" = ${input.createDigest}
      `)
      if (existingReplayRows.length > 1) {
        throw new V2CatalogConsistencyError(
          'Model Artifact import replay lookup returned more than one row',
        )
      }
      if (existingReplayRows[0]) {
        const replay = sqlRowToModelArtifactImport(existingReplayRows[0])
        if (!sameModelArtifactImportCreate(replay, input)) {
          throw new V2CatalogModelArtifactImportConflictError(
            'create_request_mismatch',
            replay.id,
            replay.status,
            null,
          )
        }
        return Object.freeze({ row: replay, created: false })
      }
      if (session.status !== 'ready') {
        throw new V2CatalogInputError('Model Artifact import Studio Session has no ready output')
      }

      const id = randomUUID()
      const inserted = await tx.$queryRaw<ModelArtifactImportSqlRow[]>(Prisma.sql`
        INSERT INTO "model_artifact_imports_v2" (
          "id", "namespace_id", "create_digest", "status", "studio_session_id",
          "output_handle_digest", "artifact_kind", "display_name",
          "base_model_reference", "base_model_revision"
        )
        VALUES (
          ${id}::uuid, ${input.namespaceId}::uuid, ${input.createDigest}, 'requested',
          ${input.studioSessionId}::uuid, ${input.outputHandleDigest}, ${input.artifactKind},
          ${input.displayName}, ${input.baseModelReference}, ${input.baseModelRevision}
        )
        ON CONFLICT DO NOTHING
        RETURNING ${MODEL_ARTIFACT_IMPORT_COLUMNS}
      `)
      if (inserted.length > 1) {
        throw new V2CatalogConsistencyError(
          'Model Artifact import insert returned more than one row',
        )
      }
      if (inserted[0]) {
        return Object.freeze({
          row: sqlRowToModelArtifactImport(inserted[0]),
          created: true,
        })
      }

      const replayRows = await tx.$queryRaw<ModelArtifactImportSqlRow[]>(Prisma.sql`
        SELECT ${MODEL_ARTIFACT_IMPORT_COLUMNS}
        FROM "model_artifact_imports_v2"
        WHERE
          "namespace_id" = ${input.namespaceId}::uuid AND
          "create_digest" = ${input.createDigest}
      `)
      if (replayRows.length === 1 && replayRows[0]) {
        const replay = sqlRowToModelArtifactImport(replayRows[0])
        if (!sameModelArtifactImportCreate(replay, input)) {
          throw new V2CatalogModelArtifactImportConflictError(
            'create_request_mismatch',
            replay.id,
            replay.status,
            null,
          )
        }
        return Object.freeze({ row: replay, created: false })
      }

      const outputRows = await tx.$queryRaw<ModelArtifactImportSqlRow[]>(Prisma.sql`
        SELECT ${MODEL_ARTIFACT_IMPORT_COLUMNS}
        FROM "model_artifact_imports_v2"
        WHERE
          "namespace_id" = ${input.namespaceId}::uuid AND
          "studio_session_id" = ${input.studioSessionId}::uuid AND
          "output_handle_digest" = ${input.outputHandleDigest} AND
          "artifact_kind" = ${input.artifactKind}
      `)
      const existing = outputRows[0]
      if (outputRows.length !== 1 || !existing) {
        throw new V2CatalogConsistencyError(
          'Model Artifact import conflicted but the winning row could not be read',
        )
      }
      const row = sqlRowToModelArtifactImport(existing)
      throw new V2CatalogModelArtifactImportConflictError(
        'output_already_imported',
        row.id,
        row.status,
        null,
      )
    })
  }

  async getModelArtifactImport(
    namespaceId: string,
    id: string,
  ): Promise<CatalogModelArtifactImportRowV2 | null> {
    validateNamespaceId(namespaceId)
    validateModelArtifactImportId(id)
    const rows = await this.#client.$queryRaw<ModelArtifactImportSqlRow[]>(Prisma.sql`
      SELECT ${MODEL_ARTIFACT_IMPORT_COLUMNS}
      FROM "model_artifact_imports_v2"
      WHERE "namespace_id" = ${namespaceId}::uuid AND "id" = ${id}::uuid
    `)
    if (rows.length > 1) {
      throw new V2CatalogConsistencyError('Model Artifact import lookup returned more than one row')
    }
    return rows[0] ? sqlRowToModelArtifactImport(rows[0]) : null
  }

  async markModelArtifactImportStagingCleaned(
    namespaceId: string,
    id: string,
  ): Promise<CatalogModelArtifactImportRowV2 | null> {
    validateNamespaceId(namespaceId)
    validateModelArtifactImportId(id)
    const rows = await this.#client.$queryRaw<ModelArtifactImportSqlRow[]>(Prisma.sql`
      UPDATE "model_artifact_imports_v2"
      SET
        "staging_cleaned_at" = COALESCE("staging_cleaned_at", clock_timestamp()),
        "updated_at" = CASE
          WHEN "staging_cleaned_at" IS NULL THEN clock_timestamp()
          ELSE "updated_at"
        END
      WHERE
        "namespace_id" = ${namespaceId}::uuid AND
        "id" = ${id}::uuid AND
        "status" IN ('completed', 'failed')
      RETURNING ${MODEL_ARTIFACT_IMPORT_COLUMNS}
    `)
    if (rows.length > 1) {
      throw new V2CatalogConsistencyError(
        'Model Artifact staging cleanup returned more than one import',
      )
    }
    return rows[0] ? sqlRowToModelArtifactImport(rows[0]) : null
  }

  async transitionModelArtifactImport(
    input: TransitionModelArtifactImportV2,
  ): Promise<CatalogModelArtifactImportRowV2 | null> {
    validateModelArtifactImportTransition(input)
    return await this.#client.$transaction(async (tx) => {
      let assignments: Prisma.Sql
      let fromStatuses: Prisma.Sql
      if (input.status === 'staging') {
        assignments = Prisma.sql`
          "status" = 'staging',
          "provider_import_id" = ${input.providerImportId},
          "output_snapshot_digest" = ${input.outputSnapshotDigest},
          "staging_at" = clock_timestamp()
        `
        fromStatuses = Prisma.sql`"status" = 'requested'`
      } else if (input.status === 'finalizing') {
        const manifestJson = JSON.stringify(input.manifest)
        assignments = Prisma.sql`
          "status" = 'finalizing',
          "staging_object_key" = ${input.stagingObjectKey},
          "archive_digest" = ${input.archiveDigest},
          "archive_size_bytes" = ${input.archiveSizeBytes},
          "manifest_digest" = ${input.manifestDigest},
          "manifest_json" = ${manifestJson}::jsonb,
          "dataset_lineage_status" = ${input.datasetLineageStatus},
          "dataset_version" = ${input.datasetVersion},
          "dataset_export_digest" = ${input.datasetExportDigest},
          "base_model_binding_status" = ${input.baseModelBindingStatus},
          "finalizing_at" = clock_timestamp()
        `
        fromStatuses = Prisma.sql`"status" = 'staging'`
      } else {
        const failureJson = JSON.stringify(input.failure)
        assignments = Prisma.sql`
          "status" = 'failed',
          "failure_json" = ${failureJson}::jsonb,
          "failed_at" = clock_timestamp()
        `
        fromStatuses = Prisma.sql`"status" IN ('requested', 'staging', 'finalizing')`
      }

      if (input.status === 'finalizing') {
        const importRows = await tx.$queryRaw<ModelArtifactImportSqlRow[]>(Prisma.sql`
          SELECT ${MODEL_ARTIFACT_IMPORT_COLUMNS}
          FROM "model_artifact_imports_v2"
          WHERE "namespace_id" = ${input.namespaceId}::uuid AND "id" = ${input.id}::uuid
          FOR UPDATE
        `)
        const artifactImportSql = importRows[0]
        if (importRows.length !== 1 || !artifactImportSql) {
          return null
        }
        const artifactImport = sqlRowToModelArtifactImport(artifactImportSql)
        const sessionRows = await tx.$queryRaw<SwiftStudioSessionSqlRow[]>(Prisma.sql`
          SELECT ${SWIFT_STUDIO_SESSION_COLUMNS}
          FROM "swift_studio_sessions_v2"
          WHERE
            "namespace_id" = ${input.namespaceId}::uuid AND
            "id" = ${artifactImport.studioSessionId}::uuid
          FOR SHARE
        `)
        const sessionSql = sessionRows[0]
        if (sessionRows.length !== 1 || !sessionSql) {
          throw new V2CatalogConsistencyError(
            'Model Artifact import source Session could not be read',
          )
        }
        const session = sqlRowToSwiftStudioSession(sessionSql)
        if (
          input.manifest.output_snapshot_digest !== artifactImport.outputSnapshotDigest ||
          input.manifest.source.studio_session_id !== artifactImport.studioSessionId ||
          input.manifest.source.upstream_commit !== session.upstreamCommit ||
          input.manifest.source.image_digest !== session.imageDigest ||
          input.manifest.base_model.reference !== artifactImport.baseModelReference ||
          input.manifest.base_model.revision !== artifactImport.baseModelRevision
        ) {
          throw new V2CatalogInputError(
            'Model Artifact manifest does not match its immutable import source',
          )
        }
        if (
          input.datasetLineageStatus === 'verified' &&
          (input.datasetVersion !== session.datasetVersion ||
            input.datasetExportDigest !== session.exportDigest)
        ) {
          throw new V2CatalogInputError(
            'Verified Model Artifact lineage must match the exact Session export',
          )
        }
      }

      const updatedRows = await tx.$queryRaw<ModelArtifactImportSqlRow[]>(Prisma.sql`
        UPDATE "model_artifact_imports_v2"
        SET ${assignments}, "updated_at" = clock_timestamp()
        WHERE
          "namespace_id" = ${input.namespaceId}::uuid AND
          "id" = ${input.id}::uuid AND
          ${fromStatuses}
        RETURNING ${MODEL_ARTIFACT_IMPORT_COLUMNS}
      `)
      if (updatedRows.length > 1) {
        throw new V2CatalogConsistencyError(
          'Model Artifact import transition returned more than one row',
        )
      }
      if (updatedRows[0]) return sqlRowToModelArtifactImport(updatedRows[0])

      const existingRows = await tx.$queryRaw<ModelArtifactImportSqlRow[]>(Prisma.sql`
        SELECT ${MODEL_ARTIFACT_IMPORT_COLUMNS}
        FROM "model_artifact_imports_v2"
        WHERE "namespace_id" = ${input.namespaceId}::uuid AND "id" = ${input.id}::uuid
      `)
      if (existingRows.length > 1) {
        throw new V2CatalogConsistencyError(
          'Model Artifact import transition lookup returned more than one row',
        )
      }
      if (!existingRows[0]) return null
      const existing = sqlRowToModelArtifactImport(existingRows[0])
      const replayable =
        existing.status === input.status ||
        (input.status === 'staging' &&
          (existing.status === 'finalizing' || existing.status === 'completed')) ||
        (input.status === 'finalizing' && existing.status === 'completed')
      if (!replayable) {
        throw new V2CatalogModelArtifactImportConflictError(
          'invalid_transition',
          existing.id,
          existing.status,
          input.status,
        )
      }
      if (!sameModelArtifactImportTransitionBody(existing, input)) {
        throw new V2CatalogModelArtifactImportConflictError(
          'terminal_body_mismatch',
          existing.id,
          existing.status,
          input.status,
        )
      }
      return existing
    })
  }

  async finalizeModelArtifactImport(
    input: FinalizeModelArtifactImportV2,
  ): Promise<CatalogModelArtifactFinalizeResultV2 | null> {
    validateFinalizeModelArtifactImport(input)
    return await this.#client.$transaction(async (tx) => {
      const importRows = await tx.$queryRaw<ModelArtifactImportSqlRow[]>(Prisma.sql`
        SELECT ${MODEL_ARTIFACT_IMPORT_COLUMNS}
        FROM "model_artifact_imports_v2"
        WHERE "namespace_id" = ${input.namespaceId}::uuid AND "id" = ${input.id}::uuid
        FOR UPDATE
      `)
      if (importRows.length > 1) {
        throw new V2CatalogConsistencyError(
          'Model Artifact finalization lookup returned more than one import',
        )
      }
      if (!importRows[0]) return null
      const artifactImport = sqlRowToModelArtifactImport(importRows[0])
      if (artifactImport.status === 'completed') {
        const artifactRows = await tx.$queryRaw<ModelArtifactSqlRow[]>(Prisma.sql`
          SELECT ${MODEL_ARTIFACT_COLUMNS}
          FROM "model_artifacts_v2"
          WHERE
            "namespace_id" = ${input.namespaceId}::uuid AND
            "id" = ${artifactImport.artifactId}::uuid
        `)
        if (artifactRows.length !== 1 || !artifactRows[0]) {
          throw new V2CatalogConsistencyError(
            'Completed Model Artifact import has no immutable Artifact',
          )
        }
        const artifact = sqlRowToModelArtifact(artifactRows[0])
        if (artifact.objectLocator !== input.objectLocator) {
          throw new V2CatalogModelArtifactImportConflictError(
            'terminal_body_mismatch',
            artifactImport.id,
            artifactImport.status,
            'completed',
          )
        }
        return Object.freeze({ artifactImport, artifact })
      }
      if (artifactImport.status !== 'finalizing') {
        throw new V2CatalogModelArtifactImportConflictError(
          'invalid_transition',
          artifactImport.id,
          artifactImport.status,
          'completed',
        )
      }
      if (
        artifactImport.archiveDigest === null ||
        artifactImport.archiveSizeBytes === null ||
        artifactImport.manifestDigest === null ||
        artifactImport.manifest === null ||
        artifactImport.datasetLineageStatus === null ||
        artifactImport.baseModelBindingStatus === null
      ) {
        throw new V2CatalogConsistencyError(
          'Finalizing Model Artifact import is missing immutable metadata',
        )
      }
      validateModelArtifactObjectLocator(input.objectLocator, artifactImport.archiveDigest)

      const sessionRows = await tx.$queryRaw<SwiftStudioSessionSqlRow[]>(Prisma.sql`
        SELECT ${SWIFT_STUDIO_SESSION_COLUMNS}
        FROM "swift_studio_sessions_v2"
        WHERE
          "namespace_id" = ${input.namespaceId}::uuid AND
          "id" = ${artifactImport.studioSessionId}::uuid
        FOR SHARE
      `)
      if (sessionRows.length !== 1 || !sessionRows[0]) {
        throw new V2CatalogConsistencyError(
          'Model Artifact finalization source Session could not be read',
        )
      }
      const session = sqlRowToSwiftStudioSession(sessionRows[0])
      const artifactId = randomUUID()
      const manifestJson = JSON.stringify(artifactImport.manifest)
      const inserted = await tx.$queryRaw<ModelArtifactSqlRow[]>(Prisma.sql`
        INSERT INTO "model_artifacts_v2" (
          "id", "namespace_id", "display_name", "artifact_kind", "artifact_format",
          "archive_format", "archive_digest", "archive_size_bytes", "object_locator",
          "manifest_digest", "manifest_json", "source_kind", "source_session_id",
          "source_import_id", "dataset_lineage_status", "dataset_version",
          "dataset_export_digest", "base_model_reference", "base_model_revision",
          "base_model_binding_status", "upstream_commit", "image_digest"
        )
        VALUES (
          ${artifactId}::uuid, ${artifactImport.namespaceId}::uuid,
          ${artifactImport.displayName}, ${artifactImport.artifactKind},
          'swift-lora-adapter-v1', 'deterministic-tar-zst-v1',
          ${artifactImport.archiveDigest}, ${artifactImport.archiveSizeBytes},
          ${input.objectLocator}, ${artifactImport.manifestDigest}, ${manifestJson}::jsonb,
          'swift_studio_session', ${artifactImport.studioSessionId}::uuid,
          ${artifactImport.id}::uuid, ${artifactImport.datasetLineageStatus},
          ${artifactImport.datasetVersion}, ${artifactImport.datasetExportDigest},
          ${artifactImport.baseModelReference}, ${artifactImport.baseModelRevision},
          ${artifactImport.baseModelBindingStatus}, ${session.upstreamCommit},
          ${session.imageDigest}
        )
        ON CONFLICT ("source_import_id") DO NOTHING
        RETURNING ${MODEL_ARTIFACT_COLUMNS}
      `)
      let artifactSql = inserted[0]
      if (!artifactSql) {
        const existingRows = await tx.$queryRaw<ModelArtifactSqlRow[]>(Prisma.sql`
          SELECT ${MODEL_ARTIFACT_COLUMNS}
          FROM "model_artifacts_v2"
          WHERE "source_import_id" = ${artifactImport.id}::uuid
        `)
        artifactSql = existingRows[0]
        if (existingRows.length !== 1 || !artifactSql) {
          throw new V2CatalogConsistencyError(
            'Model Artifact source import conflicted but the immutable row could not be read',
          )
        }
        const existing = sqlRowToModelArtifact(artifactSql)
        if (
          existing.sourceImportId !== artifactImport.id ||
          !sameModelArtifactFinalizeBody(existing, artifactImport, input.objectLocator)
        ) {
          throw new V2CatalogModelArtifactImportConflictError(
            'archive_identity_mismatch',
            artifactImport.id,
            artifactImport.status,
            'completed',
          )
        }
      }
      const artifact = sqlRowToModelArtifact(artifactSql)
      const completedRows = await tx.$queryRaw<ModelArtifactImportSqlRow[]>(Prisma.sql`
        UPDATE "model_artifact_imports_v2"
        SET
          "status" = 'completed',
          "artifact_id" = ${artifact.id}::uuid,
          "completed_at" = clock_timestamp(),
          "updated_at" = clock_timestamp()
        WHERE
          "namespace_id" = ${input.namespaceId}::uuid AND
          "id" = ${input.id}::uuid AND
          "status" = 'finalizing'
        RETURNING ${MODEL_ARTIFACT_IMPORT_COLUMNS}
      `)
      if (completedRows.length !== 1 || !completedRows[0]) {
        throw new V2CatalogConsistencyError(
          'Model Artifact import completion lost its finalizing row',
        )
      }
      return Object.freeze({
        artifactImport: sqlRowToModelArtifactImport(completedRows[0]),
        artifact,
      })
    })
  }

  async getModelArtifact(
    namespaceId: string,
    id: string,
  ): Promise<CatalogModelArtifactRowV2 | null> {
    validateNamespaceId(namespaceId)
    validateModelArtifactId(id)
    const rows = await this.#client.$queryRaw<ModelArtifactSqlRow[]>(Prisma.sql`
      SELECT ${MODEL_ARTIFACT_COLUMNS}
      FROM "model_artifacts_v2"
      WHERE "namespace_id" = ${namespaceId}::uuid AND "id" = ${id}::uuid
    `)
    if (rows.length > 1) {
      throw new V2CatalogConsistencyError('Model Artifact lookup returned more than one row')
    }
    return rows[0] ? sqlRowToModelArtifact(rows[0]) : null
  }

  async listModelArtifacts(
    namespaceId: string,
    filter: CatalogModelArtifactListFilterV2,
    before: CatalogModelArtifactCursorV2 | null,
    limit: number,
  ): Promise<CatalogModelArtifactPageV2> {
    validateNamespaceId(namespaceId)
    validateModelArtifactListFilter(filter)
    if (before !== null) validateModelArtifactCursor(before)
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_CATALOG_PAGE_SIZE) {
      throw new V2CatalogInputError('Model Artifact page limit is invalid')
    }
    const rows = await this.#client.$queryRaw<ModelArtifactSqlRow[]>(Prisma.sql`
      SELECT ${MODEL_ARTIFACT_COLUMNS}
      FROM "model_artifacts_v2"
      WHERE
        "namespace_id" = ${namespaceId}::uuid AND
        (${filter.datasetVersion}::text IS NULL OR "dataset_version" = ${filter.datasetVersion}) AND
        (${filter.artifactKind}::text IS NULL OR "artifact_kind" = ${filter.artifactKind}) AND
        ${
          before === null
            ? Prisma.sql`TRUE`
            : Prisma.sql`
              (
                date_trunc('milliseconds', "created_at") < ${before.createdAt} OR
                (
                  date_trunc('milliseconds', "created_at") = ${before.createdAt} AND
                  "id"::text COLLATE "C" < ${before.id}
                )
              )
            `
        }
      ORDER BY date_trunc('milliseconds', "created_at") DESC, "id"::text COLLATE "C" DESC
      LIMIT ${limit + 1}
    `)
    const hasMore = rows.length > limit
    const pageRows = rows.slice(0, limit).map(sqlRowToModelArtifact)
    const last = hasMore ? pageRows.at(-1) : undefined
    return Object.freeze({
      rows: Object.freeze(pageRows),
      nextCursor:
        last === undefined
          ? null
          : Object.freeze({
              createdAt: truncateDateToMilliseconds(last.createdAt),
              id: last.id,
            }),
    })
  }

  async createOrReadModelDeployment(
    input: CreateModelDeploymentV2,
  ): Promise<CatalogModelDeploymentRowV2> {
    validateCreateModelDeployment(input)
    const id = randomUUID()
    const inserted = await this.#client.$queryRaw<ModelDeploymentSqlRow[]>(Prisma.sql`
      INSERT INTO "model_deployments_v2" (
        "id", "namespace_id", "create_digest", "artifact_id", "provider",
        "display_name", "served_model_name", "endpoint_base_url", "auth_mode", "status"
      )
      VALUES (
        ${id}::uuid, ${input.namespaceId}::uuid, ${input.createDigest},
        ${input.artifactId}::uuid, ${input.provider}, ${input.displayName},
        ${input.servedModelName}, ${input.endpointBaseUrl}, ${input.authMode}, 'active'
      )
      ON CONFLICT ("namespace_id", "create_digest") DO NOTHING
      RETURNING ${MODEL_DEPLOYMENT_COLUMNS}
    `)
    if (inserted.length > 1) {
      throw new V2CatalogConsistencyError('Model Deployment insert returned more than one row')
    }
    if (inserted[0]) return sqlRowToModelDeployment(inserted[0])
    const rows = await this.#client.$queryRaw<ModelDeploymentSqlRow[]>(Prisma.sql`
      SELECT ${MODEL_DEPLOYMENT_COLUMNS}
      FROM "model_deployments_v2"
      WHERE "namespace_id" = ${input.namespaceId}::uuid AND "create_digest" = ${input.createDigest}
    `)
    if (rows.length !== 1 || !rows[0]) {
      throw new V2CatalogConsistencyError(
        'Model Deployment insert conflicted but the winning row could not be read',
      )
    }
    const deployment = sqlRowToModelDeployment(rows[0])
    if (!sameModelDeploymentCreate(deployment, input)) {
      throw new V2CatalogConsistencyError(
        'Model Deployment create digest resolved to another request',
      )
    }
    return deployment
  }

  async getModelDeployment(
    namespaceId: string,
    id: string,
  ): Promise<CatalogModelDeploymentRowV2 | null> {
    validateNamespaceId(namespaceId)
    validateModelDeploymentId(id)
    const rows = await this.#client.$queryRaw<ModelDeploymentSqlRow[]>(Prisma.sql`
      SELECT ${MODEL_DEPLOYMENT_COLUMNS}
      FROM "model_deployments_v2"
      WHERE "namespace_id" = ${namespaceId}::uuid AND "id" = ${id}::uuid
    `)
    if (rows.length > 1) {
      throw new V2CatalogConsistencyError('Model Deployment lookup returned more than one row')
    }
    return rows[0] ? sqlRowToModelDeployment(rows[0]) : null
  }

  async listModelDeployments(
    namespaceId: string,
    filter: CatalogModelDeploymentListFilterV2,
    before: CatalogModelDeploymentCursorV2 | null,
    limit: number,
  ): Promise<CatalogModelDeploymentPageV2> {
    validateNamespaceId(namespaceId)
    validateModelDeploymentListFilter(filter)
    if (before !== null) validateModelDeploymentCursor(before)
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_CATALOG_PAGE_SIZE) {
      throw new V2CatalogInputError('Model Deployment page limit is invalid')
    }
    const rows = await this.#client.$queryRaw<ModelDeploymentSqlRow[]>(Prisma.sql`
      SELECT ${MODEL_DEPLOYMENT_COLUMNS}
      FROM "model_deployments_v2"
      WHERE
        "namespace_id" = ${namespaceId}::uuid AND
        (${filter.artifactId}::text IS NULL OR "artifact_id" = ${filter.artifactId}::uuid) AND
        (${filter.status}::text IS NULL OR "status" = ${filter.status}) AND
        ${
          before === null
            ? Prisma.sql`TRUE`
            : Prisma.sql`
              (
                date_trunc('milliseconds', "created_at") < ${before.createdAt} OR
                (
                  date_trunc('milliseconds', "created_at") = ${before.createdAt} AND
                  "id"::text COLLATE "C" < ${before.id}
                )
              )
            `
        }
      ORDER BY date_trunc('milliseconds', "created_at") DESC, "id"::text COLLATE "C" DESC
      LIMIT ${limit + 1}
    `)
    const hasMore = rows.length > limit
    const pageRows = rows.slice(0, limit).map(sqlRowToModelDeployment)
    const last = hasMore ? pageRows.at(-1) : undefined
    return Object.freeze({
      rows: Object.freeze(pageRows),
      nextCursor:
        last === undefined
          ? null
          : Object.freeze({
              createdAt: truncateDateToMilliseconds(last.createdAt),
              id: last.id,
            }),
    })
  }

  async disableModelDeployment(
    namespaceId: string,
    id: string,
  ): Promise<CatalogModelDeploymentRowV2 | null> {
    validateNamespaceId(namespaceId)
    validateModelDeploymentId(id)
    return await this.#client.$transaction(async (transaction) => {
      const rows = await transaction.$queryRaw<ModelDeploymentSqlRow[]>(Prisma.sql`
        SELECT ${MODEL_DEPLOYMENT_COLUMNS}
        FROM "model_deployments_v2"
        WHERE "namespace_id" = ${namespaceId}::uuid AND "id" = ${id}::uuid
        FOR UPDATE
      `)
      if (rows.length > 1) {
        throw new V2CatalogConsistencyError('Model Deployment disable locked multiple rows')
      }
      const current = rows[0]
      if (!current) return null
      if (current.status === 'disabled') return sqlRowToModelDeployment(current)
      const updated = await transaction.$queryRaw<ModelDeploymentSqlRow[]>(Prisma.sql`
        UPDATE "model_deployments_v2"
        SET
          "status" = 'disabled',
          "disabled_at" = clock_timestamp(),
          "updated_at" = clock_timestamp()
        WHERE "namespace_id" = ${namespaceId}::uuid AND "id" = ${id}::uuid
        RETURNING ${MODEL_DEPLOYMENT_COLUMNS}
      `)
      if (updated.length !== 1 || !updated[0]) {
        throw new V2CatalogConsistencyError('Model Deployment disable lost its locked row')
      }
      return sqlRowToModelDeployment(updated[0])
    })
  }

  async updateModelDeploymentHealth(
    namespaceId: string,
    id: string,
    health: CatalogModelDeploymentHealthV2,
  ): Promise<CatalogModelDeploymentRowV2 | null> {
    validateNamespaceId(namespaceId)
    validateModelDeploymentId(id)
    validateModelDeploymentHealth(health)
    const rows = await this.#client.$queryRaw<ModelDeploymentSqlRow[]>(Prisma.sql`
      UPDATE "model_deployments_v2"
      SET
        "health_status" = ${health.status},
        "health_checked_at" = clock_timestamp(),
        "health_error" = ${health.error},
        "updated_at" = clock_timestamp()
      WHERE "namespace_id" = ${namespaceId}::uuid AND "id" = ${id}::uuid
      RETURNING ${MODEL_DEPLOYMENT_COLUMNS}
    `)
    if (rows.length > 1) {
      throw new V2CatalogConsistencyError('Model Deployment health update affected multiple rows')
    }
    return rows[0] ? sqlRowToModelDeployment(rows[0]) : null
  }

  async prepareEvaluationRunArchive(
    input: PrepareEvaluationRunArchiveV2,
  ): Promise<CatalogEvaluationRunRowV2 | null> {
    validateEvaluationArchiveIdentity(input)
    const rows = await this.#client.$queryRaw<EvaluationRunSqlRow[]>(Prisma.sql`
      UPDATE "evaluation_runs_v2"
      SET
        "archive_status" = 'pending',
        "archive_attempt" = "archive_attempt" + 1,
        "archive_error_json" = NULL,
        "updated_at" = clock_timestamp()
      WHERE
        "namespace_id" = ${input.namespaceId}::uuid AND
        "id" = ${input.id}::uuid AND
        "status" = 'completed' AND
        "archive_status" IN ('not_requested', 'failed')
      RETURNING ${EVALUATION_RUN_COLUMNS}
    `)
    return await this.#archiveMutationResult(input, rows, 'prepare')
  }

  async markEvaluationRunArchiveUploading(
    input: MarkEvaluationRunArchiveUploadingV2,
  ): Promise<CatalogEvaluationRunRowV2 | null> {
    validateEvaluationArchiveAttempt(input)
    const rows = await this.#client.$queryRaw<EvaluationRunSqlRow[]>(Prisma.sql`
      UPDATE "evaluation_runs_v2"
      SET "archive_status" = 'uploading', "updated_at" = clock_timestamp()
      WHERE
        "namespace_id" = ${input.namespaceId}::uuid AND
        "id" = ${input.id}::uuid AND
        "archive_status" = 'pending' AND
        "archive_attempt" = ${input.archiveAttempt}
      RETURNING ${EVALUATION_RUN_COLUMNS}
    `)
    return await this.#archiveMutationResult(input, rows, 'mark uploading')
  }

  async finalizeEvaluationRunArchive(
    input: FinalizeEvaluationRunArchiveV2,
  ): Promise<CatalogEvaluationRunRowV2 | null> {
    validateFinalizeEvaluationArchive(input)
    const rows = await this.#client.$queryRaw<EvaluationRunSqlRow[]>(Prisma.sql`
      UPDATE "evaluation_runs_v2"
      SET
        "archive_status" = 'available',
        "result_artifact_key" = ${input.resultArtifactKey},
        "result_artifact_digest" = ${input.resultArtifactDigest},
        "result_artifact_size_bytes" = ${input.resultArtifactSizeBytes},
        "archive_error_json" = NULL,
        "updated_at" = clock_timestamp()
      WHERE
        "namespace_id" = ${input.namespaceId}::uuid AND
        "id" = ${input.id}::uuid AND
        "archive_status" = 'uploading' AND
        "archive_attempt" = ${input.archiveAttempt}
      RETURNING ${EVALUATION_RUN_COLUMNS}
    `)
    return await this.#archiveMutationResult(input, rows, 'finalize')
  }

  async failEvaluationRunArchive(
    input: FailEvaluationRunArchiveV2,
  ): Promise<CatalogEvaluationRunRowV2 | null> {
    validateEvaluationArchiveAttempt(input)
    validateEvaluationError(input.error)
    const errorJson = JSON.stringify(input.error)
    const rows = await this.#client.$queryRaw<EvaluationRunSqlRow[]>(Prisma.sql`
      UPDATE "evaluation_runs_v2"
      SET
        "archive_status" = 'failed',
        "archive_error_json" = ${errorJson}::jsonb,
        "updated_at" = clock_timestamp()
      WHERE
        "namespace_id" = ${input.namespaceId}::uuid AND
        "id" = ${input.id}::uuid AND
        "archive_status" IN ('pending', 'uploading') AND
        "archive_attempt" = ${input.archiveAttempt}
      RETURNING ${EVALUATION_RUN_COLUMNS}
    `)
    return await this.#archiveMutationResult(input, rows, 'fail')
  }

  async #archiveMutationResult(
    input: PrepareEvaluationRunArchiveV2,
    rows: EvaluationRunSqlRow[],
    action: string,
  ): Promise<CatalogEvaluationRunRowV2 | null> {
    if (rows.length > 1) {
      throw new V2CatalogConsistencyError(`Evaluation archive ${action} returned more than one row`)
    }
    return rows[0]
      ? sqlRowToEvaluationRun(rows[0])
      : await this.getEvaluationRun(input.namespaceId, input.id)
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

        const initialResultRef =
          run && input.resultRefNamespaceId !== null && input.resultRefName !== null
            ? await adoptTransformJobResultRefInTransaction(
                tx,
                input.resultRefNamespaceId,
                input.resultRefName,
                run.outputVersion,
              )
            : null

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
              resultRefNamespaceId: input.resultRefNamespaceId,
              resultRefName: input.resultRefName,
              resultRefStatus:
                input.resultRefName === null ? null : (initialResultRef?.status ?? 'pending'),
              resultRefVersion: initialResultRef?.version ?? null,
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

        if (
          row.resultRefName === null &&
          input.resultRefNamespaceId !== null &&
          input.resultRefName !== null
        ) {
          const adopted =
            row.status === 'completed' && row.outputVersion !== null
              ? await adoptTransformJobResultRefInTransaction(
                  tx,
                  input.resultRefNamespaceId,
                  input.resultRefName,
                  row.outputVersion,
                )
              : { status: 'pending' as const, version: null }
          const attached = await tx.v2TransformJob.updateMany({
            where: { id: input.id, resultRefName: null },
            data: {
              resultRefNamespaceId: input.resultRefNamespaceId,
              resultRefName: input.resultRefName,
              resultRefStatus: adopted.status,
              resultRefVersion: adopted.version,
            },
          })
          if (attached.count !== 1) {
            throw new V2CatalogConsistencyError(
              'Transform job result ref attachment lost a concurrent update',
            )
          }
          const attachedRow = await tx.v2TransformJob.findUnique({ where: { id: input.id } })
          if (!attachedRow) {
            throw new V2CatalogConsistencyError(
              'Transform job disappeared after result ref attachment',
            )
          }
          row = attachedRow
        }

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
          const adopted =
            row.resultRefNamespaceId !== null && row.resultRefName !== null
              ? await adoptTransformJobResultRefInTransaction(
                  tx,
                  row.resultRefNamespaceId,
                  row.resultRefName,
                  run.outputVersion,
                )
              : null
          await tx.$executeRaw`
            UPDATE "transform_jobs_v2"
            SET "status" = 'completed', "output_version" = ${run.outputVersion},
                "output_count" = ${outputSnapshot?.numRecords ?? null},
                "result_ref_status" = ${adopted?.status ?? null},
                "result_ref_version" = ${adopted?.version ?? null},
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

async function acquireSwiftStudioSessionLock(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$queryRaw`
    SELECT 1 AS "locked"
    FROM pg_advisory_xact_lock(
      hashtext('databench-swift-studio-session-singleton'),
      hashtext(current_schema())
    )
  `
}

async function acquireEvaluationRunAdmissionLock(
  tx: Prisma.TransactionClient,
  input: CreateEvaluationRunV2,
): Promise<void> {
  const locator = `${input.namespaceId}|${input.provider}|${input.providerTaskId}`
  await tx.$queryRaw`
    SELECT 1 AS "locked"
    FROM pg_advisory_xact_lock(
      hashtext('databench-evaluation-run-admission'),
      hashtext(${locator})
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

function sqlRowToEvaluationRun(row: EvaluationRunSqlRow): CatalogEvaluationRunRowV2 {
  const createProfile = parseEvaluationRunCreateProfile(row.create_profile)
  const status = parseEvaluationRunStatus(row.status)
  const providerReportIds = parseStoredProviderReportIds(row.provider_report_ids_json)
  const metrics = parseStoredEvaluationMetrics(row.metrics_json)
  const error = parseStoredEvaluationError(row.error_json, 'execution')
  const archiveStatus = parseEvaluationArchiveStatus(row.archive_status)
  const archiveError = parseStoredEvaluationError(row.archive_error_json, 'archive')
  const scoringConfig =
    row.scoring_config_json === null
      ? null
      : parseStoredJsonObject(row.scoring_config_json, 'Evaluation scoring config')
  if (row.provider !== 'evalscope') {
    throw new V2CatalogConsistencyError('Stored evaluation run provider is invalid')
  }
  const terminal = status === 'completed' || status === 'failed' || status === 'cancelled'
  if (terminal !== (row.finished_at !== null)) {
    throw new V2CatalogConsistencyError('Stored evaluation run terminal timestamp is invalid')
  }
  if ((status === 'running' || status === 'completed') && row.started_at === null) {
    throw new V2CatalogConsistencyError('Stored evaluation run start timestamp is invalid')
  }
  if ((status === 'completed') !== (metrics !== null && providerReportIds !== null)) {
    throw new V2CatalogConsistencyError('Stored evaluation run completion body is invalid')
  }
  if ((status === 'failed' || status === 'cancelled') !== (error !== null)) {
    throw new V2CatalogConsistencyError('Stored evaluation run error body is invalid')
  }
  const artifactCount = [
    row.result_artifact_key,
    row.result_artifact_digest,
    row.result_artifact_size_bytes,
  ].filter((value) => value !== null).length
  if (artifactCount !== 0 && artifactCount !== 3) {
    throw new V2CatalogConsistencyError('Stored evaluation run artifact shape is invalid')
  }
  if ((archiveStatus === 'available') !== (artifactCount === 3)) {
    throw new V2CatalogConsistencyError('Stored evaluation run archive availability is invalid')
  }
  if ((archiveStatus === 'failed') !== (archiveError !== null)) {
    throw new V2CatalogConsistencyError('Stored evaluation run archive error is invalid')
  }
  const result: CatalogEvaluationRunRowV2 = {
    id: row.id,
    namespaceId: row.namespace_id,
    provider: row.provider,
    providerTaskId: row.provider_task_id,
    createProfile,
    createRequestDigest: row.create_request_digest,
    providerReportIds,
    datasetVersion: row.dataset_version,
    sourceRef: row.source_ref,
    converter: row.converter,
    converterVersion: row.converter_version,
    converterOptions: parseStoredJsonObject(
      row.converter_options_json,
      'Evaluation run converter options',
    ),
    fidelityDigest: row.fidelity_digest,
    benchmark: row.benchmark,
    modelName: row.model_name,
    modelDeploymentId: row.model_deployment_id,
    modelArtifactId: row.model_artifact_id,
    modelDeploymentDigest: row.model_deployment_digest,
    evalscopeCommit: row.evalscope_commit,
    scoringConfig,
    primaryMetricId: row.primary_metric_id,
    primaryOutputKey: row.primary_output_key,
    status,
    metrics,
    error,
    archiveStatus,
    archiveAttempt: row.archive_attempt,
    resultArtifactKey: row.result_artifact_key,
    resultArtifactDigest: row.result_artifact_digest,
    resultArtifactSizeBytes: row.result_artifact_size_bytes,
    archiveError,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    updatedAt: row.updated_at,
  }
  try {
    validateCreateEvaluationRun(result)
    if (!Number.isSafeInteger(result.archiveAttempt) || result.archiveAttempt < 0) {
      throw new V2CatalogInputError('Evaluation archive attempt is invalid')
    }
    if (result.resultArtifactDigest !== null && !EXACT_VERSION.test(result.resultArtifactDigest)) {
      throw new V2CatalogInputError('Evaluation result artifact digest is invalid')
    }
    if (
      result.resultArtifactSizeBytes !== null &&
      (result.resultArtifactSizeBytes < 0n || result.resultArtifactSizeBytes > POSTGRES_BIGINT_MAX)
    ) {
      throw new V2CatalogInputError('Evaluation result artifact size is invalid')
    }
  } catch (cause) {
    throw new V2CatalogConsistencyError('Stored evaluation run is invalid', { cause })
  }
  return result
}

function sqlRowToModelArtifactImport(
  row: ModelArtifactImportSqlRow,
): CatalogModelArtifactImportRowV2 {
  const status = parseModelArtifactImportStatus(row.status)
  const manifest =
    row.manifest_json === null ? null : parseStoredModelArtifactManifest(row.manifest_json)
  const failure = parseStoredModelArtifactImportFailure(row.failure_json)
  const datasetLineageStatus =
    row.dataset_lineage_status === null
      ? null
      : parseModelArtifactDatasetLineageStatus(row.dataset_lineage_status)
  const baseModelBindingStatus =
    row.base_model_binding_status === null
      ? null
      : parseModelArtifactBaseModelBindingStatus(row.base_model_binding_status)
  if (row.artifact_kind !== 'lora_adapter') {
    throw new V2CatalogConsistencyError('Stored Model Artifact import kind is invalid')
  }
  const result: CatalogModelArtifactImportRowV2 = {
    id: row.id,
    namespaceId: row.namespace_id,
    createDigest: row.create_digest,
    status,
    studioSessionId: row.studio_session_id,
    outputHandleDigest: row.output_handle_digest,
    artifactKind: row.artifact_kind,
    displayName: row.display_name,
    baseModelReference: row.base_model_reference,
    baseModelRevision: row.base_model_revision,
    providerImportId: row.provider_import_id,
    outputSnapshotDigest: row.output_snapshot_digest,
    stagingObjectKey: row.staging_object_key,
    archiveDigest: row.archive_digest,
    archiveSizeBytes: row.archive_size_bytes,
    manifestDigest: row.manifest_digest,
    manifest,
    datasetLineageStatus,
    datasetVersion: row.dataset_version,
    datasetExportDigest: row.dataset_export_digest,
    baseModelBindingStatus,
    artifactId: row.artifact_id,
    failure,
    createdAt: row.created_at,
    stagingAt: row.staging_at,
    finalizingAt: row.finalizing_at,
    completedAt: row.completed_at,
    failedAt: row.failed_at,
    stagingCleanedAt: row.staging_cleaned_at,
    updatedAt: row.updated_at,
  }
  try {
    validateCreateModelArtifactImport(result)
    validateModelArtifactImportId(result.id)
    validateStoredModelArtifactImportShape(result)
  } catch (cause) {
    throw new V2CatalogConsistencyError('Stored Model Artifact import is invalid', { cause })
  }
  return Object.freeze(result)
}

function sqlRowToModelArtifact(row: ModelArtifactSqlRow): CatalogModelArtifactRowV2 {
  if (
    row.artifact_kind !== 'lora_adapter' ||
    row.artifact_format !== 'swift-lora-adapter-v1' ||
    row.archive_format !== 'deterministic-tar-zst-v1' ||
    row.source_kind !== 'swift_studio_session'
  ) {
    throw new V2CatalogConsistencyError('Stored Model Artifact fixed format is invalid')
  }
  const result: CatalogModelArtifactRowV2 = {
    id: row.id,
    namespaceId: row.namespace_id,
    displayName: row.display_name,
    artifactKind: row.artifact_kind,
    artifactFormat: row.artifact_format,
    archiveFormat: row.archive_format,
    archiveDigest: row.archive_digest,
    archiveSizeBytes: row.archive_size_bytes,
    objectLocator: row.object_locator,
    manifestDigest: row.manifest_digest,
    manifest: parseStoredModelArtifactManifest(row.manifest_json),
    sourceKind: row.source_kind,
    sourceSessionId: row.source_session_id,
    sourceImportId: row.source_import_id,
    datasetLineageStatus: parseModelArtifactDatasetLineageStatus(row.dataset_lineage_status),
    datasetVersion: row.dataset_version,
    datasetExportDigest: row.dataset_export_digest,
    baseModelReference: row.base_model_reference,
    baseModelRevision: row.base_model_revision,
    baseModelBindingStatus: parseModelArtifactBaseModelBindingStatus(row.base_model_binding_status),
    upstreamCommit: row.upstream_commit,
    imageDigest: row.image_digest,
    createdAt: row.created_at,
  }
  try {
    validateModelArtifactId(result.id)
    validateNamespaceId(result.namespaceId)
    validateModelArtifactDisplayName(result.displayName)
    validateModelArtifactBaseModel(
      result.baseModelReference,
      result.baseModelRevision,
      result.baseModelBindingStatus,
    )
    validateModelArtifactArchiveMetadata(
      result.archiveDigest,
      result.archiveSizeBytes,
      result.manifestDigest,
    )
    validateModelArtifactObjectLocator(result.objectLocator, result.archiveDigest)
    validateModelArtifactLineage(
      result.datasetLineageStatus,
      result.datasetVersion,
      result.datasetExportDigest,
    )
    if (!GIT_COMMIT.test(result.upstreamCommit) || !EXACT_VERSION.test(result.imageDigest)) {
      throw new V2CatalogInputError('Model Artifact runtime identity is invalid')
    }
    validateModelArtifactManifest(result.manifest)
    if (
      result.manifest.archive_digest !== result.archiveDigest ||
      BigInt(result.manifest.archive_size_bytes) !== result.archiveSizeBytes ||
      result.manifest.source.studio_session_id !== result.sourceSessionId ||
      result.manifest.source.upstream_commit !== result.upstreamCommit ||
      result.manifest.source.image_digest !== result.imageDigest ||
      !sameModelArtifactManifestLineage(
        result.manifest.dataset_lineage,
        result.datasetLineageStatus,
        result.datasetVersion,
        result.datasetExportDigest,
      ) ||
      result.manifest.base_model.reference !== result.baseModelReference ||
      result.manifest.base_model.revision !== result.baseModelRevision ||
      result.manifest.base_model.binding_status !== result.baseModelBindingStatus
    ) {
      throw new V2CatalogInputError('Model Artifact manifest metadata is inconsistent')
    }
  } catch (cause) {
    throw new V2CatalogConsistencyError('Stored Model Artifact is invalid', { cause })
  }
  return Object.freeze(result)
}

function sqlRowToModelDeployment(row: ModelDeploymentSqlRow): CatalogModelDeploymentRowV2 {
  const result: CatalogModelDeploymentRowV2 = {
    id: row.id,
    namespaceId: row.namespace_id,
    createDigest: row.create_digest,
    artifactId: row.artifact_id,
    provider: parseModelDeploymentProvider(row.provider),
    displayName: row.display_name,
    servedModelName: row.served_model_name,
    endpointBaseUrl: row.endpoint_base_url,
    authMode: parseModelDeploymentAuthMode(row.auth_mode),
    status: parseModelDeploymentStatus(row.status),
    healthStatus: parseModelDeploymentHealthStatus(row.health_status),
    healthCheckedAt: row.health_checked_at,
    healthError: row.health_error,
    createdAt: row.created_at,
    disabledAt: row.disabled_at,
    updatedAt: row.updated_at,
  }
  try {
    validateModelDeploymentId(result.id)
    validateCreateModelDeployment(result)
    if ((result.status === 'disabled') !== (result.disabledAt !== null)) {
      throw new V2CatalogInputError('Model Deployment disabled timestamp is invalid')
    }
    if ((result.healthStatus === 'unknown') !== (result.healthCheckedAt === null)) {
      throw new V2CatalogInputError('Model Deployment health timestamp is invalid')
    }
    if ((result.healthStatus === 'unhealthy') !== (result.healthError !== null)) {
      throw new V2CatalogInputError('Model Deployment health error is invalid')
    }
    if (
      !Number.isFinite(result.createdAt.getTime()) ||
      !Number.isFinite(result.updatedAt.getTime()) ||
      result.updatedAt < result.createdAt ||
      (result.disabledAt !== null &&
        (!Number.isFinite(result.disabledAt.getTime()) || result.disabledAt < result.createdAt)) ||
      (result.healthCheckedAt !== null &&
        (!Number.isFinite(result.healthCheckedAt.getTime()) ||
          result.healthCheckedAt < result.createdAt))
    ) {
      throw new V2CatalogInputError('Model Deployment timestamps are invalid')
    }
  } catch (cause) {
    throw new V2CatalogConsistencyError('Stored Model Deployment is invalid', { cause })
  }
  return Object.freeze(result)
}

function sqlRowToSwiftStudioSession(row: SwiftStudioSessionSqlRow): CatalogSwiftStudioSessionRowV2 {
  const status = parseSwiftStudioSessionStatus(row.status)
  const failure = parseStoredSwiftStudioSessionFailure(row.failure_json)
  if (row.provider !== 'swift-studio' || row.converter !== 'ms-swift') {
    throw new V2CatalogConsistencyError('Stored Swift Studio Session runtime is invalid')
  }
  if (row.converter_version !== '1.0.0') {
    throw new V2CatalogConsistencyError('Stored Swift Studio Session converter version is invalid')
  }
  const hasExport = row.export_digest !== null && row.export_size_bytes !== null
  if ((row.export_digest === null) !== (row.export_size_bytes === null)) {
    throw new V2CatalogConsistencyError('Stored Swift Studio Session export shape is invalid')
  }
  const reachedReady = status === 'ready' || status === 'closing' || status === 'closed'
  if (reachedReady !== (row.ready_at !== null && hasExport)) {
    throw new V2CatalogConsistencyError('Stored Swift Studio Session ready shape is invalid')
  }
  if ((status === 'failed') !== (failure !== null)) {
    throw new V2CatalogConsistencyError('Stored Swift Studio Session failure shape is invalid')
  }
  if ((status === 'closed') !== (row.closed_at !== null)) {
    throw new V2CatalogConsistencyError('Stored Swift Studio Session close shape is invalid')
  }
  const result: CatalogSwiftStudioSessionRowV2 = {
    id: row.id,
    namespaceId: row.namespace_id,
    createDigest: row.create_digest,
    status,
    datasetVersion: row.dataset_version,
    displayRef: row.display_ref,
    converter: row.converter,
    converterVersion: row.converter_version,
    normalizedOptions: parseStoredJsonObject(
      row.normalized_options_json,
      'Swift Studio Session normalized options',
    ),
    fidelityDigest: row.fidelity_digest,
    exportOutputCount: row.export_output_count,
    exportDigest: row.export_digest,
    exportSizeBytes: row.export_size_bytes,
    provider: row.provider,
    providerSessionId: row.provider_session_id,
    upstreamCommit: row.upstream_commit,
    imageDigest: row.image_digest,
    runtimeCapabilityDigest: row.runtime_capability_digest,
    failure,
    preparationOwnerToken: row.preparation_owner_token,
    preparationAbandonedAt: row.preparation_abandoned_at,
    preparationExpiresAt: row.preparation_expires_at,
    createdAt: row.created_at,
    readyAt: row.ready_at,
    closedAt: row.closed_at,
    updatedAt: row.updated_at,
  }
  try {
    validateCreateSwiftStudioSession(result)
    validateSwiftStudioSessionId(result.id)
    validateSwiftStudioSessionPreparationOwnerToken(result.preparationOwnerToken)
    if (
      result.exportDigest !== null &&
      (!EXACT_VERSION.test(result.exportDigest) ||
        result.exportSizeBytes === null ||
        result.exportSizeBytes < 0n ||
        result.exportSizeBytes > POSTGRES_BIGINT_MAX)
    ) {
      throw new V2CatalogInputError('Swift Studio Session export metadata is invalid')
    }
    if (
      !Number.isFinite(result.preparationExpiresAt.getTime()) ||
      result.preparationExpiresAt < result.createdAt ||
      (result.preparationAbandonedAt !== null &&
        (!Number.isFinite(result.preparationAbandonedAt.getTime()) ||
          result.status !== 'preparing' ||
          result.preparationAbandonedAt < result.createdAt))
    ) {
      throw new V2CatalogInputError('Swift Studio Session preparation ownership is invalid')
    }
  } catch (cause) {
    throw new V2CatalogConsistencyError('Stored Swift Studio Session is invalid', { cause })
  }
  return result
}

function parseSwiftStudioSessionStatus(value: string): CatalogSwiftStudioSessionStatusV2 {
  if (
    value === 'preparing' ||
    value === 'ready' ||
    value === 'closing' ||
    value === 'closed' ||
    value === 'failed'
  ) {
    return value
  }
  throw new V2CatalogConsistencyError('Stored Swift Studio Session status is invalid')
}

function parseStoredSwiftStudioSessionFailure(
  value: Prisma.JsonValue | null,
): CatalogSwiftStudioSessionFailureV2 | null {
  if (value === null) return null
  if (
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== 3 ||
    typeof value.phase !== 'string' ||
    typeof value.code !== 'string' ||
    typeof value.message !== 'string'
  ) {
    throw new V2CatalogConsistencyError('Stored Swift Studio Session failure is invalid')
  }
  const failure = { phase: value.phase, code: value.code, message: value.message }
  try {
    validateSwiftStudioSessionFailure(failure)
  } catch (cause) {
    throw new V2CatalogConsistencyError('Stored Swift Studio Session failure is invalid', { cause })
  }
  return failure
}

function parseEvaluationRunCreateProfile(
  value: string,
): CatalogEvaluationRunRowV2['createProfile'] {
  if (
    value === 'evaluation-run-create-v1' ||
    value === 'evaluation-run-create-v2' ||
    value === 'evaluation-run-create-v3' ||
    value === 'evaluation-run-create-v4'
  ) {
    return value
  }
  throw new V2CatalogConsistencyError('Stored evaluation run create profile is invalid')
}

function parseEvaluationRunStatus(value: string): CatalogEvaluationRunStatusV2 {
  if (
    value === 'prepared' ||
    value === 'running' ||
    value === 'completed' ||
    value === 'failed' ||
    value === 'cancelled'
  ) {
    return value
  }
  throw new V2CatalogConsistencyError('Stored evaluation run status is invalid')
}

function parseEvaluationArchiveStatus(value: string): CatalogEvaluationRunRowV2['archiveStatus'] {
  if (
    value === 'not_requested' ||
    value === 'pending' ||
    value === 'uploading' ||
    value === 'available' ||
    value === 'failed'
  ) {
    return value
  }
  throw new V2CatalogConsistencyError('Stored evaluation archive status is invalid')
}

function parseStoredProviderReportIds(value: Prisma.JsonValue | null): readonly string[] | null {
  if (value === null) return null
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new V2CatalogConsistencyError('Stored provider report IDs are invalid')
  }
  const ids = [...value] as string[]
  try {
    validateProviderReportIds(ids)
  } catch (cause) {
    throw new V2CatalogConsistencyError('Stored provider report IDs are invalid', { cause })
  }
  return Object.freeze(ids)
}

function parseStoredEvaluationMetrics(
  value: Prisma.JsonValue | null,
): readonly CatalogEvaluationMetricV2[] | null {
  if (value === null) return null
  if (!Array.isArray(value)) {
    throw new V2CatalogConsistencyError('Stored evaluation metrics are invalid')
  }
  const metrics = value.map((item) => {
    const keys = item === null || typeof item !== 'object' ? [] : Object.keys(item)
    const legacyShape = keys.length === 6
    const metricShape = keys.length === 8
    if (
      item === null ||
      typeof item !== 'object' ||
      Array.isArray(item) ||
      (!legacyShape && !metricShape) ||
      typeof item.dataset !== 'string' ||
      (item.subset !== null && typeof item.subset !== 'string') ||
      (metricShape && item.metric_id !== null && typeof item.metric_id !== 'string') ||
      (metricShape && item.output_key !== null && typeof item.output_key !== 'string') ||
      typeof item.metric !== 'string' ||
      (item.score !== null && typeof item.score !== 'number') ||
      (item.sample_count !== null && typeof item.sample_count !== 'number') ||
      !Array.isArray(item.categories) ||
      item.categories.some((category) => typeof category !== 'string')
    ) {
      throw new V2CatalogConsistencyError('Stored evaluation metric item is invalid')
    }
    return {
      dataset: item.dataset,
      subset: item.subset,
      metricId: metricShape ? (item.metric_id as string | null) : null,
      outputKey: metricShape ? (item.output_key as string | null) : null,
      metric: item.metric,
      score: item.score,
      sampleCount: item.sample_count,
      categories: [...item.categories] as string[],
    }
  })
  try {
    validateEvaluationMetrics(metrics)
  } catch (cause) {
    throw new V2CatalogConsistencyError('Stored evaluation metrics are invalid', { cause })
  }
  return Object.freeze(metrics)
}

function parseStoredEvaluationError(
  value: Prisma.JsonValue | null,
  kind: 'execution' | 'archive',
): CatalogEvaluationRunErrorV2 | null {
  if (value === null) return null
  if (
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== 3 ||
    typeof value.phase !== 'string' ||
    typeof value.code !== 'string' ||
    typeof value.message !== 'string'
  ) {
    throw new V2CatalogConsistencyError(`Stored evaluation ${kind} error is invalid`)
  }
  const error = { phase: value.phase, code: value.code, message: value.message }
  try {
    validateEvaluationError(error)
  } catch (cause) {
    throw new V2CatalogConsistencyError(`Stored evaluation ${kind} error is invalid`, { cause })
  }
  return error
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
  resultRefNamespaceId: string | null
  resultRefName: string | null
  resultRefStatus: string | null
  resultRefVersion: string | null
  cacheHit: boolean
  error: Prisma.JsonValue | null
  createdAt: Date
  startedAt: Date | null
  finishedAt: Date | null
  updatedAt: Date
}): CatalogTransformJobRowV2 {
  const status = parseTransformJobStatus(row.status)
  const resultRef = parseStoredTransformJobResultRef(
    row.resultRefNamespaceId,
    row.resultRefName,
    row.resultRefStatus,
    row.resultRefVersion,
  )
  assertStoredLeaseShape(row.leaseOwner, row.leaseToken, row.leaseExpiresAt)
  if ((status === 'completed') !== (row.outputVersion !== null)) {
    throw new V2CatalogConsistencyError('Stored transform job completion shape is invalid')
  }
  if (resultRef !== null) {
    if ((status === 'completed') !== (resultRef.status !== 'pending')) {
      throw new V2CatalogConsistencyError('Stored transform job result ref state is invalid')
    }
    if (resultRef.status === 'updated' && resultRef.version !== row.outputVersion) {
      throw new V2CatalogConsistencyError('Stored transform job result ref target is invalid')
    }
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
    resultRefNamespaceId: resultRef?.namespaceId ?? null,
    resultRefName: resultRef?.name ?? null,
    resultRef,
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
    resultRefNamespaceId: row.result_ref_namespace_id,
    resultRefName: row.result_ref_name,
    resultRefStatus: row.result_ref_status,
    resultRefVersion: row.result_ref_version,
    cacheHit: row.cache_hit,
    error: row.error_json,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    updatedAt: row.updated_at,
  })
}

function validateCreateSwiftStudioSession(input: CreateSwiftStudioSessionV2): void {
  validateNamespaceId(input.namespaceId)
  if (!EXACT_VERSION.test(input.createDigest)) {
    throw new V2CatalogInputError('Swift Studio Session create digest is invalid')
  }
  if (!EXACT_VERSION.test(input.datasetVersion)) {
    throw new V2CatalogInputError('Swift Studio Session Dataset version is invalid')
  }
  if (
    input.displayRef !== null &&
    (!SAFE_REF_NAME.test(input.displayRef) ||
      EXACT_VERSION.test(input.displayRef) ||
      input.displayRef === '.' ||
      input.displayRef === '..')
  ) {
    throw new V2CatalogInputError('Swift Studio Session display Ref is invalid')
  }
  if (input.converter !== 'ms-swift' || input.converterVersion !== '1.0.0') {
    throw new V2CatalogInputError('Swift Studio Session converter is invalid')
  }
  let optionsJson: string
  try {
    optionsJson = JSON.stringify(input.normalizedOptions)
  } catch (cause) {
    throw new V2CatalogInputError('Swift Studio Session normalized options are invalid', {
      cause,
    })
  }
  if (Buffer.byteLength(optionsJson) > MAX_SWIFT_OPTIONS_BYTES) {
    throw new V2CatalogInputError('Swift Studio Session normalized options exceed the bound')
  }
  if (!EXACT_VERSION.test(input.fidelityDigest)) {
    throw new V2CatalogInputError('Swift Studio Session fidelity digest is invalid')
  }
  if (input.exportOutputCount <= 0n || input.exportOutputCount > POSTGRES_BIGINT_MAX) {
    throw new V2CatalogInputError('Swift Studio Session output count must be a positive bigint')
  }
  if (
    input.provider !== 'swift-studio' ||
    !SWIFT_PROVIDER_SESSION_ID.test(input.providerSessionId) ||
    Buffer.byteLength(input.providerSessionId) > 256
  ) {
    throw new V2CatalogInputError('Swift Studio Session provider locator is invalid')
  }
  if (!GIT_COMMIT.test(input.upstreamCommit)) {
    throw new V2CatalogInputError('Swift Studio Session upstream commit is invalid')
  }
  if (
    !EXACT_VERSION.test(input.imageDigest) ||
    !EXACT_VERSION.test(input.runtimeCapabilityDigest)
  ) {
    throw new V2CatalogInputError('Swift Studio Session runtime digest is invalid')
  }
}

function validateSwiftStudioSessionId(value: string): void {
  if (!UUID.test(value)) throw new V2CatalogInputError('Swift Studio Session ID is invalid')
}

function validateSwiftStudioSessionPreparationOwnerToken(value: string): void {
  if (!UUID.test(value)) {
    throw new V2CatalogInputError('Swift Studio Session preparation owner token is invalid')
  }
}

function validateSwiftStudioSessionPreparationAbandonGrace(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_SWIFT_PREPARATION_ABANDON_GRACE_MS) {
    throw new V2CatalogInputError('Swift Studio Session preparation abandon grace is invalid')
  }
}

function validateSwiftStudioSessionListFilter(filter: CatalogSwiftStudioSessionListFilterV2): void {
  if (filter.datasetVersion !== null && !EXACT_VERSION.test(filter.datasetVersion)) {
    throw new V2CatalogInputError('Swift Studio Session Dataset filter is invalid')
  }
  if (filter.status !== null) parseSwiftStudioSessionStatus(filter.status)
}

function validateSwiftStudioSessionCursor(cursor: CatalogSwiftStudioSessionCursorV2): void {
  if (!(cursor.createdAt instanceof Date) || !Number.isFinite(cursor.createdAt.getTime())) {
    throw new V2CatalogInputError('Swift Studio Session cursor timestamp is invalid')
  }
  if (cursor.createdAt.getTime() !== truncateDateToMilliseconds(cursor.createdAt).getTime()) {
    throw new V2CatalogInputError(
      'Swift Studio Session cursor timestamp must use millisecond precision',
    )
  }
  validateSwiftStudioSessionId(cursor.id)
}

function validateSwiftStudioSessionTransition(input: TransitionSwiftStudioSessionV2): void {
  validateNamespaceId(input.namespaceId)
  validateSwiftStudioSessionId(input.id)
  if (input.status === 'ready') {
    validateSwiftStudioSessionPreparationOwnerToken(input.preparationOwnerToken)
    if (!EXACT_VERSION.test(input.exportDigest)) {
      throw new V2CatalogInputError('Swift Studio Session export digest is invalid')
    }
    if (input.exportSizeBytes < 0n || input.exportSizeBytes > POSTGRES_BIGINT_MAX) {
      throw new V2CatalogInputError('Swift Studio Session export size is invalid')
    }
  } else if (input.status === 'failed') {
    validateSwiftStudioSessionPreparationOwnerToken(input.preparationOwnerToken)
    validateSwiftStudioSessionFailure(input.failure)
  }
}

function validateSwiftStudioSessionFailure(failure: CatalogSwiftStudioSessionFailureV2): void {
  if (!SAFE_EVALUATION_NAME.test(failure.phase) || !SAFE_EVALUATION_NAME.test(failure.code)) {
    throw new V2CatalogInputError('Swift Studio Session failure phase or code is invalid')
  }
  if (
    failure.message.length === 0 ||
    Buffer.byteLength(failure.message) > 2_048 ||
    hasControlCharacter(failure.message) ||
    CREDENTIAL_VALUE.test(failure.message)
  ) {
    throw new V2CatalogInputError('Swift Studio Session failure message is invalid')
  }
}

function sameSwiftStudioSessionCreate(
  row: CatalogSwiftStudioSessionRowV2,
  input: CreateSwiftStudioSessionV2,
): boolean {
  return (
    row.namespaceId === input.namespaceId &&
    row.createDigest === input.createDigest &&
    row.datasetVersion === input.datasetVersion &&
    row.converter === input.converter &&
    row.converterVersion === input.converterVersion &&
    sameJsonValue(row.normalizedOptions as unknown as Prisma.JsonValue, input.normalizedOptions) &&
    row.fidelityDigest === input.fidelityDigest &&
    row.exportOutputCount === input.exportOutputCount &&
    row.provider === input.provider &&
    row.upstreamCommit === input.upstreamCommit &&
    row.imageDigest === input.imageDigest &&
    row.runtimeCapabilityDigest === input.runtimeCapabilityDigest
  )
}

function sameSwiftStudioSessionTransitionBody(
  row: CatalogSwiftStudioSessionRowV2,
  input: TransitionSwiftStudioSessionV2,
): boolean {
  if (input.status === 'ready') {
    return row.exportDigest === input.exportDigest && row.exportSizeBytes === input.exportSizeBytes
  }
  if (input.status === 'failed') {
    return (
      row.failure?.phase === input.failure.phase &&
      row.failure.code === input.failure.code &&
      row.failure.message === input.failure.message
    )
  }
  return true
}

function validateCreateModelArtifactImport(input: CreateModelArtifactImportV2): void {
  validateNamespaceId(input.namespaceId)
  if (!EXACT_VERSION.test(input.createDigest)) {
    throw new V2CatalogInputError('Model Artifact import create digest is invalid')
  }
  validateSwiftStudioSessionId(input.studioSessionId)
  if (!EXACT_VERSION.test(input.outputHandleDigest)) {
    throw new V2CatalogInputError('Model Artifact import output handle digest is invalid')
  }
  if (input.artifactKind !== 'lora_adapter') {
    throw new V2CatalogInputError('Model Artifact import kind is invalid')
  }
  validateModelArtifactDisplayName(input.displayName)
  validateModelArtifactBaseModel(
    input.baseModelReference,
    input.baseModelRevision,
    input.baseModelRevision === null ? 'unresolved' : 'declared',
  )
}

function validateModelArtifactDisplayName(value: string): void {
  if (
    Buffer.byteLength(value) < 1 ||
    Buffer.byteLength(value) > 256 ||
    hasControlCharacter(value) ||
    CREDENTIAL_VALUE.test(value) ||
    ABSOLUTE_PATH.test(value)
  ) {
    throw new V2CatalogInputError('Model Artifact display name is invalid')
  }
}

function validateModelArtifactBaseModel(
  reference: string,
  revision: string | null,
  bindingStatus: 'verified' | 'declared' | 'unresolved',
): void {
  if (
    Buffer.byteLength(reference) < 1 ||
    Buffer.byteLength(reference) > 512 ||
    hasControlCharacter(reference) ||
    CREDENTIAL_VALUE.test(reference) ||
    ABSOLUTE_PATH.test(reference) ||
    reference.includes('\\')
  ) {
    throw new V2CatalogInputError('Model Artifact base-model reference is invalid')
  }
  if (
    revision !== null &&
    (!MODEL_REVISION.test(revision) ||
      Buffer.byteLength(revision) > 256 ||
      CREDENTIAL_VALUE.test(revision) ||
      ABSOLUTE_PATH.test(revision))
  ) {
    throw new V2CatalogInputError('Model Artifact base-model revision is invalid')
  }
  if (
    (bindingStatus !== 'verified' &&
      bindingStatus !== 'declared' &&
      bindingStatus !== 'unresolved') ||
    (bindingStatus === 'verified' && revision === null)
  ) {
    throw new V2CatalogInputError('Model Artifact base-model binding is invalid')
  }
}

function validateModelArtifactImportId(value: string): void {
  if (!UUID.test(value)) throw new V2CatalogInputError('Model Artifact import ID is invalid')
}

function validateModelArtifactId(value: string): void {
  if (!UUID.test(value)) throw new V2CatalogInputError('Model Artifact ID is invalid')
}

function parseModelArtifactImportStatus(value: string): CatalogModelArtifactImportStatusV2 {
  if (
    value === 'requested' ||
    value === 'staging' ||
    value === 'finalizing' ||
    value === 'completed' ||
    value === 'failed'
  ) {
    return value
  }
  throw new V2CatalogConsistencyError('Stored Model Artifact import status is invalid')
}

function parseModelArtifactDatasetLineageStatus(
  value: string,
): CatalogModelArtifactRowV2['datasetLineageStatus'] {
  if (value === 'verified' || value === 'external_or_unverified' || value === 'not_applicable') {
    return value
  }
  throw new V2CatalogConsistencyError('Stored Model Artifact Dataset lineage status is invalid')
}

function parseModelArtifactBaseModelBindingStatus(
  value: string,
): CatalogModelArtifactRowV2['baseModelBindingStatus'] {
  if (value === 'verified' || value === 'declared' || value === 'unresolved') return value
  throw new V2CatalogConsistencyError('Stored Model Artifact base-model binding is invalid')
}

function validateModelArtifactImportTransition(input: TransitionModelArtifactImportV2): void {
  validateNamespaceId(input.namespaceId)
  validateModelArtifactImportId(input.id)
  if (input.status === 'staging') {
    if (!MODEL_ARTIFACT_PROVIDER_IMPORT_ID.test(input.providerImportId)) {
      throw new V2CatalogInputError('Model Artifact Provider import ID is invalid')
    }
    if (!EXACT_VERSION.test(input.outputSnapshotDigest)) {
      throw new V2CatalogInputError('Model Artifact output snapshot digest is invalid')
    }
    return
  }
  if (input.status === 'failed') {
    validateModelArtifactImportFailure(input.failure)
    return
  }
  if (
    !MODEL_ARTIFACT_STAGING_KEY.test(input.stagingObjectKey) ||
    input.stagingObjectKey !== `staging/swift-artifact/v1/${input.id}/archive.tar.zst`
  ) {
    throw new V2CatalogInputError('Model Artifact staging object key is invalid')
  }
  validateModelArtifactArchiveMetadata(
    input.archiveDigest,
    input.archiveSizeBytes,
    input.manifestDigest,
  )
  validateModelArtifactLineage(
    input.datasetLineageStatus,
    input.datasetVersion,
    input.datasetExportDigest,
  )
  validateModelArtifactManifest(input.manifest)
  if (
    input.manifest.archive_digest !== input.archiveDigest ||
    BigInt(input.manifest.archive_size_bytes) !== input.archiveSizeBytes ||
    !sameModelArtifactManifestLineage(
      input.manifest.dataset_lineage,
      input.datasetLineageStatus,
      input.datasetVersion,
      input.datasetExportDigest,
    ) ||
    input.manifest.base_model.binding_status !== input.baseModelBindingStatus
  ) {
    throw new V2CatalogInputError('Model Artifact finalization manifest is inconsistent')
  }
}

function validateModelArtifactArchiveMetadata(
  archiveDigest: string,
  archiveSizeBytes: bigint,
  manifestDigest: string,
): void {
  if (
    !EXACT_VERSION.test(archiveDigest) ||
    archiveSizeBytes < 0n ||
    archiveSizeBytes > BigInt(Number.MAX_SAFE_INTEGER) ||
    !EXACT_VERSION.test(manifestDigest)
  ) {
    throw new V2CatalogInputError('Model Artifact archive metadata is invalid')
  }
}

function validateModelArtifactLineage(
  status: CatalogModelArtifactRowV2['datasetLineageStatus'],
  datasetVersion: string | null,
  datasetExportDigest: string | null,
): void {
  if (status !== 'verified' && status !== 'external_or_unverified' && status !== 'not_applicable') {
    throw new V2CatalogInputError('Model Artifact Dataset lineage status is invalid')
  }
  const hasDataset =
    datasetVersion !== null &&
    datasetExportDigest !== null &&
    EXACT_VERSION.test(datasetVersion) &&
    EXACT_VERSION.test(datasetExportDigest)
  if ((datasetVersion === null) !== (datasetExportDigest === null)) {
    throw new V2CatalogInputError('Model Artifact Dataset lineage shape is invalid')
  }
  if ((status === 'verified') !== hasDataset) {
    throw new V2CatalogInputError('Only verified Model Artifacts bind an exact Dataset export')
  }
}

function validateModelArtifactImportFailure(failure: CatalogModelArtifactImportFailureV2): void {
  if (!SAFE_EVALUATION_NAME.test(failure.phase) || !SAFE_EVALUATION_NAME.test(failure.code)) {
    throw new V2CatalogInputError('Model Artifact import failure phase or code is invalid')
  }
  if (
    Buffer.byteLength(failure.message) < 1 ||
    Buffer.byteLength(failure.message) > 2_048 ||
    hasControlCharacter(failure.message) ||
    CREDENTIAL_VALUE.test(failure.message)
  ) {
    throw new V2CatalogInputError('Model Artifact import failure message is invalid')
  }
}

function parseStoredModelArtifactImportFailure(
  value: Prisma.JsonValue | null,
): CatalogModelArtifactImportFailureV2 | null {
  if (value === null) return null
  if (
    !isPlainJsonObject(value) ||
    !hasExactObjectKeys(value, ['phase', 'code', 'message']) ||
    typeof value.phase !== 'string' ||
    typeof value.code !== 'string' ||
    typeof value.message !== 'string'
  ) {
    throw new V2CatalogConsistencyError('Stored Model Artifact import failure is invalid')
  }
  const failure = { phase: value.phase, code: value.code, message: value.message }
  try {
    validateModelArtifactImportFailure(failure)
  } catch (cause) {
    throw new V2CatalogConsistencyError('Stored Model Artifact import failure is invalid', {
      cause,
    })
  }
  return Object.freeze(failure)
}

function validateStoredModelArtifactImportShape(row: CatalogModelArtifactImportRowV2): void {
  const hasStaging = row.stagingAt !== null
  if (
    hasStaging !== (row.providerImportId !== null && row.outputSnapshotDigest !== null) ||
    (row.providerImportId !== null &&
      !MODEL_ARTIFACT_PROVIDER_IMPORT_ID.test(row.providerImportId)) ||
    (row.outputSnapshotDigest !== null && !EXACT_VERSION.test(row.outputSnapshotDigest))
  ) {
    throw new V2CatalogInputError('Model Artifact import staging shape is invalid')
  }
  const finalFields = [
    row.finalizingAt,
    row.stagingObjectKey,
    row.archiveDigest,
    row.archiveSizeBytes,
    row.manifestDigest,
    row.manifest,
    row.datasetLineageStatus,
    row.baseModelBindingStatus,
  ]
  const hasFinalization = finalFields.every((value) => value !== null)
  if (hasFinalization !== finalFields.some((value) => value !== null)) {
    throw new V2CatalogInputError('Model Artifact import finalization shape is invalid')
  }
  if (hasFinalization) {
    if (
      row.stagingObjectKey === null ||
      row.archiveDigest === null ||
      row.archiveSizeBytes === null ||
      row.manifestDigest === null ||
      row.manifest === null ||
      row.datasetLineageStatus === null ||
      row.baseModelBindingStatus === null
    ) {
      throw new V2CatalogInputError('Model Artifact import finalization metadata is incomplete')
    }
    validateModelArtifactArchiveMetadata(
      row.archiveDigest,
      row.archiveSizeBytes,
      row.manifestDigest,
    )
    if (row.stagingObjectKey !== `staging/swift-artifact/v1/${row.id}/archive.tar.zst`) {
      throw new V2CatalogInputError('Model Artifact import staging object key is inconsistent')
    }
    validateModelArtifactLineage(
      row.datasetLineageStatus,
      row.datasetVersion,
      row.datasetExportDigest,
    )
    validateModelArtifactBaseModel(
      row.baseModelReference,
      row.baseModelRevision,
      row.baseModelBindingStatus,
    )
  }
  if (
    (row.status === 'requested' &&
      (hasStaging ||
        hasFinalization ||
        row.artifactId !== null ||
        row.failure !== null ||
        row.completedAt !== null ||
        row.failedAt !== null)) ||
    (row.status === 'staging' &&
      (!hasStaging ||
        hasFinalization ||
        row.artifactId !== null ||
        row.failure !== null ||
        row.completedAt !== null ||
        row.failedAt !== null)) ||
    (row.status === 'finalizing' &&
      (!hasStaging ||
        !hasFinalization ||
        row.artifactId !== null ||
        row.failure !== null ||
        row.completedAt !== null ||
        row.failedAt !== null)) ||
    (row.status === 'completed' &&
      (!hasFinalization ||
        row.artifactId === null ||
        row.failure !== null ||
        row.completedAt === null ||
        row.failedAt !== null)) ||
    (row.status === 'failed' &&
      (row.artifactId !== null ||
        row.failure === null ||
        row.completedAt !== null ||
        row.failedAt === null)) ||
    (row.stagingCleanedAt !== null && row.status !== 'completed' && row.status !== 'failed')
  ) {
    throw new V2CatalogInputError('Model Artifact import lifecycle is invalid')
  }
}

function validateFinalizeModelArtifactImport(input: FinalizeModelArtifactImportV2): void {
  validateNamespaceId(input.namespaceId)
  validateModelArtifactImportId(input.id)
  if (!MODEL_ARTIFACT_OBJECT_LOCATOR.test(input.objectLocator)) {
    throw new V2CatalogInputError('Model Artifact object locator is invalid')
  }
}

function validateModelArtifactObjectLocator(locator: string, archiveDigest: string): void {
  if (
    !MODEL_ARTIFACT_OBJECT_LOCATOR.test(locator) ||
    locator !== `objects/v2/model-artifact-v1/${archiveDigest.slice(0, 2)}/${archiveDigest}.tar.zst`
  ) {
    throw new V2CatalogInputError('Model Artifact object locator does not match its archive')
  }
}

function validateModelArtifactListFilter(filter: CatalogModelArtifactListFilterV2): void {
  if (filter.datasetVersion !== null && !EXACT_VERSION.test(filter.datasetVersion)) {
    throw new V2CatalogInputError('Model Artifact Dataset filter is invalid')
  }
  if (filter.artifactKind !== null && filter.artifactKind !== 'lora_adapter') {
    throw new V2CatalogInputError('Model Artifact kind filter is invalid')
  }
}

function validateModelArtifactCursor(cursor: CatalogModelArtifactCursorV2): void {
  if (
    !(cursor.createdAt instanceof Date) ||
    !Number.isFinite(cursor.createdAt.getTime()) ||
    cursor.createdAt.getTime() !== truncateDateToMilliseconds(cursor.createdAt).getTime()
  ) {
    throw new V2CatalogInputError('Model Artifact cursor timestamp must use millisecond precision')
  }
  validateModelArtifactId(cursor.id)
}

function validateCreateModelDeployment(input: CreateModelDeploymentV2): void {
  validateNamespaceId(input.namespaceId)
  validateModelDeploymentId(input.artifactId)
  if (!EXACT_VERSION.test(input.createDigest)) {
    throw new V2CatalogInputError('Model Deployment create digest is invalid')
  }
  if (input.provider !== 'openai_compatible' || input.authMode !== 'none') {
    throw new V2CatalogInputError('Model Deployment provider profile is invalid')
  }
  validateEvaluationText(input.displayName, 256, 'Model Deployment display name')
  validateEvaluationText(input.servedModelName, 512, 'Model Deployment served model name')
  if (
    Buffer.byteLength(input.endpointBaseUrl) > 2_048 ||
    hasControlCharacter(input.endpointBaseUrl) ||
    input.endpointBaseUrl.includes('@') ||
    CREDENTIAL_VALUE.test(input.endpointBaseUrl) ||
    normalizeCatalogModelDeploymentEndpoint(input.endpointBaseUrl) !== input.endpointBaseUrl
  ) {
    throw new V2CatalogInputError('Model Deployment endpoint base URL is invalid')
  }
}

function normalizeCatalogModelDeploymentEndpoint(value: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return null
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.hostname === '' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    return null
  }
  const pathname = parsed.pathname.replace(/\/+$/u, '')
  parsed.pathname = pathname === '' ? '/' : pathname
  const normalized = parsed.toString().replace(/\/$/u, '')
  return normalized === parsed.origin ? parsed.origin : normalized
}

function validateModelDeploymentId(value: string): void {
  if (!UUID.test(value)) throw new V2CatalogInputError('Model Deployment ID is invalid')
}

function parseModelDeploymentProvider(value: string): CatalogModelDeploymentRowV2['provider'] {
  if (value === 'openai_compatible') return value
  throw new V2CatalogConsistencyError('Stored Model Deployment provider is invalid')
}

function parseModelDeploymentAuthMode(value: string): CatalogModelDeploymentRowV2['authMode'] {
  if (value === 'none') return value
  throw new V2CatalogConsistencyError('Stored Model Deployment auth mode is invalid')
}

function parseModelDeploymentStatus(value: string): CatalogModelDeploymentRowV2['status'] {
  if (value === 'active' || value === 'disabled') return value
  throw new V2CatalogConsistencyError('Stored Model Deployment status is invalid')
}

function parseModelDeploymentHealthStatus(
  value: string,
): CatalogModelDeploymentRowV2['healthStatus'] {
  if (value === 'unknown' || value === 'healthy' || value === 'unhealthy') return value
  throw new V2CatalogConsistencyError('Stored Model Deployment health status is invalid')
}

function validateModelDeploymentListFilter(filter: CatalogModelDeploymentListFilterV2): void {
  if (filter.artifactId !== null) validateModelDeploymentId(filter.artifactId)
  if (filter.status !== null && filter.status !== 'active' && filter.status !== 'disabled') {
    throw new V2CatalogInputError('Model Deployment status filter is invalid')
  }
}

function validateModelDeploymentCursor(cursor: CatalogModelDeploymentCursorV2): void {
  if (
    !(cursor.createdAt instanceof Date) ||
    !Number.isFinite(cursor.createdAt.getTime()) ||
    cursor.createdAt.getTime() !== truncateDateToMilliseconds(cursor.createdAt).getTime()
  ) {
    throw new V2CatalogInputError(
      'Model Deployment cursor timestamp must use millisecond precision',
    )
  }
  validateModelDeploymentId(cursor.id)
}

function validateModelDeploymentHealth(health: CatalogModelDeploymentHealthV2): void {
  if (health.status !== 'healthy' && health.status !== 'unhealthy') {
    throw new V2CatalogInputError('Model Deployment health observation is invalid')
  }
  if ((health.status === 'unhealthy') !== (health.error !== null)) {
    throw new V2CatalogInputError('Model Deployment health error shape is invalid')
  }
  if (health.error !== null) {
    validateEvaluationText(health.error, 2_048, 'Model Deployment health error')
  }
}

function sameModelDeploymentCreate(
  row: CatalogModelDeploymentRowV2,
  input: CreateModelDeploymentV2,
): boolean {
  return (
    row.namespaceId === input.namespaceId &&
    row.createDigest === input.createDigest &&
    row.artifactId === input.artifactId &&
    row.provider === input.provider &&
    row.displayName === input.displayName &&
    row.servedModelName === input.servedModelName &&
    row.endpointBaseUrl === input.endpointBaseUrl &&
    row.authMode === input.authMode
  )
}

function sameModelArtifactImportCreate(
  row: CatalogModelArtifactImportRowV2,
  input: CreateModelArtifactImportV2,
): boolean {
  return (
    row.namespaceId === input.namespaceId &&
    row.createDigest === input.createDigest &&
    row.studioSessionId === input.studioSessionId &&
    row.outputHandleDigest === input.outputHandleDigest &&
    row.artifactKind === input.artifactKind &&
    row.displayName === input.displayName &&
    row.baseModelReference === input.baseModelReference &&
    row.baseModelRevision === input.baseModelRevision
  )
}

function sameModelArtifactImportTransitionBody(
  row: CatalogModelArtifactImportRowV2,
  input: TransitionModelArtifactImportV2,
): boolean {
  if (input.status === 'staging') {
    return (
      row.providerImportId === input.providerImportId &&
      row.outputSnapshotDigest === input.outputSnapshotDigest
    )
  }
  if (input.status === 'failed') {
    return (
      row.failure?.phase === input.failure.phase &&
      row.failure.code === input.failure.code &&
      row.failure.message === input.failure.message
    )
  }
  return (
    row.stagingObjectKey === input.stagingObjectKey &&
    row.archiveDigest === input.archiveDigest &&
    row.archiveSizeBytes === input.archiveSizeBytes &&
    row.manifestDigest === input.manifestDigest &&
    row.datasetLineageStatus === input.datasetLineageStatus &&
    row.datasetVersion === input.datasetVersion &&
    row.datasetExportDigest === input.datasetExportDigest &&
    row.baseModelBindingStatus === input.baseModelBindingStatus &&
    row.manifest !== null &&
    sameJsonValue(
      row.manifest as unknown as Prisma.JsonValue,
      input.manifest as unknown as CatalogJsonValueV2,
    )
  )
}

function sameModelArtifactFinalizeBody(
  artifact: CatalogModelArtifactRowV2,
  artifactImport: CatalogModelArtifactImportRowV2,
  objectLocator: string,
): boolean {
  return (
    artifact.namespaceId === artifactImport.namespaceId &&
    artifact.displayName === artifactImport.displayName &&
    artifact.artifactKind === artifactImport.artifactKind &&
    artifact.archiveDigest === artifactImport.archiveDigest &&
    artifact.archiveSizeBytes === artifactImport.archiveSizeBytes &&
    artifact.objectLocator === objectLocator &&
    artifact.manifestDigest === artifactImport.manifestDigest &&
    artifact.sourceSessionId === artifactImport.studioSessionId &&
    artifact.sourceImportId === artifactImport.id &&
    artifact.datasetLineageStatus === artifactImport.datasetLineageStatus &&
    artifact.datasetVersion === artifactImport.datasetVersion &&
    artifact.datasetExportDigest === artifactImport.datasetExportDigest &&
    artifact.baseModelReference === artifactImport.baseModelReference &&
    artifact.baseModelRevision === artifactImport.baseModelRevision &&
    artifact.baseModelBindingStatus === artifactImport.baseModelBindingStatus &&
    artifactImport.manifest !== null &&
    sameJsonValue(
      artifact.manifest as unknown as Prisma.JsonValue,
      artifactImport.manifest as unknown as CatalogJsonValueV2,
    )
  )
}

function parseStoredModelArtifactManifest(value: Prisma.JsonValue): CatalogModelArtifactManifestV2 {
  try {
    validateModelArtifactManifest(value)
  } catch (cause) {
    throw new V2CatalogConsistencyError('Stored Model Artifact manifest is invalid', { cause })
  }
  return value as CatalogModelArtifactManifestV2
}

function validateModelArtifactManifest(
  value: Prisma.JsonValue | CatalogModelArtifactManifestV2,
): asserts value is CatalogModelArtifactManifestV2 {
  if (
    !isPlainJsonObject(value) ||
    !hasExactObjectKeys(value, [
      'manifest_version',
      'artifact_kind',
      'artifact_format',
      'archive_format',
      'archive_digest',
      'archive_size_bytes',
      'output_snapshot_digest',
      'files',
      'source',
      'dataset_lineage',
      'base_model',
      'training_summary',
      'created_at',
      'created_by',
    ])
  ) {
    throw new V2CatalogInputError('Model Artifact manifest root is invalid')
  }
  let encoded: string
  try {
    encoded = JSON.stringify(value)
  } catch (cause) {
    throw new V2CatalogInputError('Model Artifact manifest is not serializable', { cause })
  }
  if (
    Buffer.byteLength(encoded) > MAX_MODEL_ARTIFACT_MANIFEST_BYTES ||
    containsForbiddenManifestString(value)
  ) {
    throw new V2CatalogInputError('Model Artifact manifest exceeds its sanitized bound')
  }
  if (
    value.manifest_version !== 'model-artifact-manifest-v1' ||
    value.artifact_kind !== 'lora_adapter' ||
    value.artifact_format !== 'swift-lora-adapter-v1' ||
    value.archive_format !== 'deterministic-tar-zst-v1' ||
    typeof value.archive_digest !== 'string' ||
    !EXACT_VERSION.test(value.archive_digest) ||
    typeof value.archive_size_bytes !== 'number' ||
    !Number.isSafeInteger(value.archive_size_bytes) ||
    value.archive_size_bytes < 0 ||
    typeof value.output_snapshot_digest !== 'string' ||
    !EXACT_VERSION.test(value.output_snapshot_digest) ||
    value.created_by !== 'databench' ||
    typeof value.created_at !== 'string' ||
    !isRfc3339UtcMilliseconds(value.created_at)
  ) {
    throw new V2CatalogInputError('Model Artifact manifest identity is invalid')
  }
  validateModelArtifactManifestFiles(value.files)
  if (
    !isPlainJsonObject(value.source) ||
    !hasExactObjectKeys(value.source, ['studio_session_id', 'upstream_commit', 'image_digest']) ||
    typeof value.source.studio_session_id !== 'string' ||
    !UUID.test(value.source.studio_session_id) ||
    typeof value.source.upstream_commit !== 'string' ||
    !GIT_COMMIT.test(value.source.upstream_commit) ||
    typeof value.source.image_digest !== 'string' ||
    !EXACT_VERSION.test(value.source.image_digest)
  ) {
    throw new V2CatalogInputError('Model Artifact manifest source is invalid')
  }
  validateModelArtifactManifestLineage(value.dataset_lineage)
  validateModelArtifactManifestBaseModel(value.base_model)
  validateModelArtifactTrainingSummary(value.training_summary)
}

function validateModelArtifactManifestFiles(value: Prisma.JsonValue | undefined): void {
  if (!Array.isArray(value) || value.length < 2 || value.length > MAX_MODEL_ARTIFACT_FILES) {
    throw new V2CatalogInputError('Model Artifact manifest file list is invalid')
  }
  const paths: string[] = []
  for (const file of value) {
    if (
      !isPlainJsonObject(file) ||
      !hasExactObjectKeys(file, ['path', 'digest', 'size_bytes']) ||
      typeof file.path !== 'string' ||
      !ALLOWED_ADAPTER_FILE.test(file.path) ||
      typeof file.digest !== 'string' ||
      !EXACT_VERSION.test(file.digest) ||
      typeof file.size_bytes !== 'number' ||
      !Number.isSafeInteger(file.size_bytes) ||
      file.size_bytes < 0
    ) {
      throw new V2CatalogInputError('Model Artifact manifest file entry is invalid')
    }
    paths.push(file.path)
  }
  if (
    new Set(paths).size !== paths.length ||
    paths.some(
      (path, index) =>
        index > 0 && Buffer.compare(Buffer.from(paths[index - 1] ?? ''), Buffer.from(path)) >= 0,
    ) ||
    !paths.includes('adapter_config.json')
  ) {
    throw new V2CatalogInputError('Model Artifact manifest file ordering is invalid')
  }
  const hasSingle = paths.includes('adapter_model.safetensors')
  const hasIndex = paths.includes('adapter_model.safetensors.index.json')
  const hasShards = paths.some((path) => /^adapter_model-\d{5}-of-\d{5}\.safetensors$/u.test(path))
  if (hasSingle === (hasIndex && hasShards) || hasIndex !== hasShards) {
    throw new V2CatalogInputError('Model Artifact safetensors layout is invalid')
  }
}

function validateModelArtifactManifestLineage(value: Prisma.JsonValue | undefined): void {
  if (
    !isPlainJsonObject(value) ||
    !hasExactObjectKeys(value, ['status', 'dataset_version', 'dataset_export_digest']) ||
    typeof value.status !== 'string' ||
    (value.dataset_version !== null && typeof value.dataset_version !== 'string') ||
    (value.dataset_export_digest !== null && typeof value.dataset_export_digest !== 'string')
  ) {
    throw new V2CatalogInputError('Model Artifact manifest Dataset lineage is invalid')
  }
  validateModelArtifactLineage(
    parseModelArtifactDatasetLineageStatus(value.status),
    value.dataset_version,
    value.dataset_export_digest,
  )
}

function validateModelArtifactManifestBaseModel(value: Prisma.JsonValue | undefined): void {
  if (
    !isPlainJsonObject(value) ||
    !hasExactObjectKeys(value, ['reference', 'revision', 'binding_status']) ||
    typeof value.reference !== 'string' ||
    (value.revision !== null && typeof value.revision !== 'string') ||
    typeof value.binding_status !== 'string'
  ) {
    throw new V2CatalogInputError('Model Artifact manifest base model is invalid')
  }
  validateModelArtifactBaseModel(
    value.reference,
    value.revision,
    parseModelArtifactBaseModelBindingStatus(value.binding_status),
  )
}

function validateModelArtifactTrainingSummary(value: Prisma.JsonValue | undefined): void {
  const keys = [
    'train_stage',
    'tuner_type',
    'lora_rank',
    'lora_alpha',
    'lora_dropout',
    'num_train_epochs',
    'max_steps',
    'learning_rate',
    'max_length',
    'dtype',
    'seed',
    'redacted_fields_count',
  ]
  if (!isPlainJsonObject(value) || !hasExactObjectKeys(value, keys)) {
    throw new V2CatalogInputError('Model Artifact training summary is invalid')
  }
  const optionalToken = (token: Prisma.JsonValue | undefined): boolean =>
    token === null || (typeof token === 'string' && SAFE_EVALUATION_NAME.test(token))
  const optionalFinite = (number: Prisma.JsonValue | undefined): boolean =>
    number === null || (typeof number === 'number' && Number.isFinite(number))
  const optionalInteger = (number: Prisma.JsonValue | undefined): boolean =>
    number === null || (typeof number === 'number' && Number.isSafeInteger(number) && number > 0)
  if (
    !optionalToken(value.train_stage) ||
    value.tuner_type !== 'lora' ||
    !optionalInteger(value.lora_rank) ||
    (typeof value.lora_rank === 'number' && value.lora_rank > 65_536) ||
    !optionalFinite(value.lora_alpha) ||
    (typeof value.lora_alpha === 'number' &&
      (value.lora_alpha < 0 || value.lora_alpha > 1_000_000)) ||
    !optionalFinite(value.lora_dropout) ||
    (typeof value.lora_dropout === 'number' &&
      (value.lora_dropout < 0 || value.lora_dropout > 1)) ||
    !optionalFinite(value.num_train_epochs) ||
    (typeof value.num_train_epochs === 'number' &&
      (value.num_train_epochs <= 0 || value.num_train_epochs > 1_000_000)) ||
    !optionalInteger(value.max_steps) ||
    !optionalFinite(value.learning_rate) ||
    (typeof value.learning_rate === 'number' &&
      (value.learning_rate <= 0 || value.learning_rate > 1)) ||
    !optionalInteger(value.max_length) ||
    !optionalToken(value.dtype) ||
    (value.seed !== null &&
      (typeof value.seed !== 'number' || !Number.isSafeInteger(value.seed))) ||
    typeof value.redacted_fields_count !== 'number' ||
    !Number.isSafeInteger(value.redacted_fields_count) ||
    value.redacted_fields_count < 0 ||
    value.redacted_fields_count > 100_000
  ) {
    throw new V2CatalogInputError('Model Artifact training summary value is invalid')
  }
}

function isPlainJsonObject(
  value: Prisma.JsonValue | CatalogModelArtifactManifestV2 | undefined,
): value is Record<string, Prisma.JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactObjectKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort()
  const wanted = [...expected].sort()
  return keys.length === wanted.length && keys.every((key, index) => key === wanted[index])
}

function containsForbiddenManifestString(value: Prisma.JsonValue | undefined): boolean {
  if (typeof value === 'string') {
    return hasControlCharacter(value) || CREDENTIAL_VALUE.test(value) || ABSOLUTE_PATH.test(value)
  }
  if (Array.isArray(value)) return value.some((item) => containsForbiddenManifestString(item))
  if (value !== null && typeof value === 'object') {
    return Object.values(value).some((item) => containsForbiddenManifestString(item))
  }
  return false
}

function isRfc3339UtcMilliseconds(value: string): boolean {
  const time = Date.parse(value)
  return Number.isFinite(time) && new Date(time).toISOString() === value
}

function sameModelArtifactManifestLineage(
  manifest: CatalogModelArtifactManifestV2['dataset_lineage'],
  status: CatalogModelArtifactRowV2['datasetLineageStatus'],
  datasetVersion: string | null,
  datasetExportDigest: string | null,
): boolean {
  return (
    manifest.status === status &&
    manifest.dataset_version === datasetVersion &&
    manifest.dataset_export_digest === datasetExportDigest
  )
}

function validateCreateEvaluationRun(input: CreateEvaluationRunV2): void {
  validateNamespaceId(input.namespaceId)
  if (input.provider !== 'evalscope') {
    throw new V2CatalogInputError('Evaluation run provider is invalid')
  }
  if (!PROVIDER_TASK_ID.test(input.providerTaskId)) {
    throw new V2CatalogInputError('Evaluation provider task ID is invalid')
  }
  if (!EXACT_VERSION.test(input.createRequestDigest)) {
    throw new V2CatalogInputError('Evaluation create request digest is invalid')
  }
  const deploymentFields = [
    input.modelDeploymentId,
    input.modelArtifactId,
    input.modelDeploymentDigest,
  ]
  const hasDeployment = deploymentFields.every((value) => value !== null)
  if (hasDeployment !== deploymentFields.some((value) => value !== null)) {
    throw new V2CatalogInputError('Evaluation Model Deployment binding is incomplete')
  }
  if (
    (input.createProfile === 'evaluation-run-create-v2' ||
      input.createProfile === 'evaluation-run-create-v4') !== hasDeployment ||
    (input.createProfile !== 'evaluation-run-create-v1' &&
      input.createProfile !== 'evaluation-run-create-v2' &&
      input.createProfile !== 'evaluation-run-create-v3' &&
      input.createProfile !== 'evaluation-run-create-v4')
  ) {
    throw new V2CatalogInputError('Evaluation create profile does not match its Deployment binding')
  }
  if (hasDeployment) {
    if (
      input.modelDeploymentId === null ||
      input.modelArtifactId === null ||
      input.modelDeploymentDigest === null ||
      !UUID.test(input.modelDeploymentId) ||
      !UUID.test(input.modelArtifactId) ||
      !EXACT_VERSION.test(input.modelDeploymentDigest) ||
      input.modelName === null
    ) {
      throw new V2CatalogInputError('Evaluation Model Deployment identity is invalid')
    }
  }
  if (!EXACT_VERSION.test(input.datasetVersion)) {
    throw new V2CatalogInputError('Evaluation Dataset version is invalid')
  }
  if (
    input.sourceRef !== null &&
    (!SAFE_REF_NAME.test(input.sourceRef) ||
      EXACT_VERSION.test(input.sourceRef) ||
      input.sourceRef === '.' ||
      input.sourceRef === '..')
  ) {
    throw new V2CatalogInputError('Evaluation source Ref is invalid')
  }
  if (!SAFE_EVALUATION_NAME.test(input.converter)) {
    throw new V2CatalogInputError('Evaluation converter is invalid')
  }
  if (!SAFE_EVALUATION_VERSION.test(input.converterVersion)) {
    throw new V2CatalogInputError('Evaluation converter version is invalid')
  }
  const optionsJson = JSON.stringify(input.converterOptions)
  if (Buffer.byteLength(optionsJson) > MAX_EVALUATION_OPTIONS_BYTES) {
    throw new V2CatalogInputError('Evaluation converter options exceed the catalog bound')
  }
  if (!EXACT_VERSION.test(input.fidelityDigest)) {
    throw new V2CatalogInputError('Evaluation fidelity digest is invalid')
  }
  if (!SAFE_EVALUATION_NAME.test(input.benchmark)) {
    throw new V2CatalogInputError('Evaluation benchmark is invalid')
  }
  if (input.modelName !== null) validateEvaluationText(input.modelName, 512, 'model name')
  if (input.evalscopeCommit !== null && !GIT_COMMIT.test(input.evalscopeCommit)) {
    throw new V2CatalogInputError('EvalScope commit is invalid')
  }
  const scoringFields = [input.scoringConfig, input.primaryMetricId, input.primaryOutputKey]
  const hasScoring = scoringFields.every((value) => value !== null)
  const metricProfile =
    input.createProfile === 'evaluation-run-create-v3' ||
    input.createProfile === 'evaluation-run-create-v4'
  if (
    hasScoring !== scoringFields.some((value) => value !== null) ||
    metricProfile !== hasScoring
  ) {
    throw new V2CatalogInputError('Evaluation scoring identity is incomplete')
  }
  if (input.scoringConfig !== null) {
    if (
      input.primaryMetricId === null ||
      input.primaryOutputKey === null ||
      !SAFE_EVALUATION_NAME.test(input.primaryMetricId)
    ) {
      throw new V2CatalogInputError('Evaluation primary Metric is invalid')
    }
    validateEvaluationText(input.primaryOutputKey, 128, 'primary Metric output')
    const scoringJson = JSON.stringify(input.scoringConfig)
    if (
      Buffer.byteLength(scoringJson) > MAX_EVALUATION_OPTIONS_BYTES ||
      input.scoringConfig.primary_metric_id !== input.primaryMetricId ||
      input.scoringConfig.primary_output_key !== input.primaryOutputKey ||
      input.scoringConfig.benchmark !== input.benchmark ||
      input.scoringConfig.evalscope_commit !== input.evalscopeCommit
    ) {
      throw new V2CatalogInputError('Evaluation scoring config is invalid')
    }
  }
}

function validateNamespaceId(value: string): void {
  if (!UUID.test(value)) throw new V2CatalogInputError('Evaluation namespace ID is invalid')
}

function validateEvaluationRunId(value: string): void {
  if (!UUID.test(value)) throw new V2CatalogInputError('Evaluation run ID is invalid')
}

function validateEvaluationRunListFilter(filter: CatalogEvaluationRunListFilterV2): void {
  if (filter.datasetVersion !== null && !EXACT_VERSION.test(filter.datasetVersion)) {
    throw new V2CatalogInputError('Evaluation run Dataset filter is invalid')
  }
  if (filter.modelDeploymentId !== null && !UUID.test(filter.modelDeploymentId)) {
    throw new V2CatalogInputError('Evaluation run Model Deployment filter is invalid')
  }
  if (filter.status !== null) parseEvaluationRunStatus(filter.status)
}

function validateEvaluationRunCursor(cursor: CatalogEvaluationRunCursorV2): void {
  if (!(cursor.createdAt instanceof Date) || !Number.isFinite(cursor.createdAt.getTime())) {
    throw new V2CatalogInputError('Evaluation run cursor timestamp is invalid')
  }
  if (cursor.createdAt.getTime() !== truncateDateToMilliseconds(cursor.createdAt).getTime()) {
    throw new V2CatalogInputError('Evaluation run cursor timestamp must use millisecond precision')
  }
  validateEvaluationRunId(cursor.id)
}

function validateEvaluationRunTransition(input: TransitionEvaluationRunV2): void {
  validateNamespaceId(input.namespaceId)
  validateEvaluationRunId(input.id)
  if (input.status === 'completed') {
    validateEvaluationMetrics(input.metrics)
    validateProviderReportIds(input.providerReportIds)
  } else if (input.status === 'failed' || input.status === 'cancelled') {
    validateEvaluationError(input.error)
  }
}

function validateEvaluationArchiveIdentity(input: PrepareEvaluationRunArchiveV2): void {
  validateNamespaceId(input.namespaceId)
  validateEvaluationRunId(input.id)
}

function validateEvaluationArchiveAttempt(input: MarkEvaluationRunArchiveUploadingV2): void {
  validateEvaluationArchiveIdentity(input)
  if (
    !Number.isSafeInteger(input.archiveAttempt) ||
    input.archiveAttempt < 1 ||
    input.archiveAttempt > 2_147_483_647
  ) {
    throw new V2CatalogInputError('Evaluation archive attempt is invalid')
  }
}

function validateFinalizeEvaluationArchive(input: FinalizeEvaluationRunArchiveV2): void {
  validateEvaluationArchiveAttempt(input)
  if (!EXACT_VERSION.test(input.resultArtifactDigest)) {
    throw new V2CatalogInputError('Evaluation result artifact digest is invalid')
  }
  if (input.resultArtifactSizeBytes <= 0n || input.resultArtifactSizeBytes > POSTGRES_BIGINT_MAX) {
    throw new V2CatalogInputError('Evaluation result artifact size is invalid')
  }
  const expectedKey = `objects/v2/evaluation-result-v1/${input.resultArtifactDigest.slice(0, 2)}/${input.resultArtifactDigest}.tar.zst`
  if (input.resultArtifactKey !== expectedKey) {
    throw new V2CatalogInputError('Evaluation result artifact key is invalid')
  }
}

function validateEvaluationMetrics(metrics: readonly CatalogEvaluationMetricV2[]): void {
  if (metrics.length > MAX_EVALUATION_METRICS) {
    throw new V2CatalogInputError('Evaluation metrics exceed the item bound')
  }
  if (Buffer.byteLength(JSON.stringify(metrics)) > MAX_EVALUATION_METRICS_BYTES) {
    throw new V2CatalogInputError('Evaluation metrics exceed the byte bound')
  }
  for (const metric of metrics) {
    validateEvaluationText(metric.dataset, 512, 'metric dataset')
    if (metric.subset !== null) validateEvaluationText(metric.subset, 512, 'metric subset')
    if ((metric.metricId === null) !== (metric.outputKey === null)) {
      throw new V2CatalogInputError('Evaluation Metric identity is incomplete')
    }
    if (metric.metricId !== null) {
      if (!SAFE_EVALUATION_NAME.test(metric.metricId)) {
        throw new V2CatalogInputError('Evaluation Metric ID is invalid')
      }
      validateEvaluationText(metric.outputKey as string, 128, 'metric output key')
    }
    validateEvaluationText(metric.metric, 512, 'metric name')
    if (metric.score !== null && !Number.isFinite(metric.score)) {
      throw new V2CatalogInputError('Evaluation metric score must be finite')
    }
    if (
      metric.sampleCount !== null &&
      (!Number.isSafeInteger(metric.sampleCount) || metric.sampleCount < 0)
    ) {
      throw new V2CatalogInputError('Evaluation metric sample count is invalid')
    }
    if (
      metric.categories.length > 64 ||
      new Set(metric.categories).size !== metric.categories.length
    ) {
      throw new V2CatalogInputError('Evaluation metric categories are invalid')
    }
    for (const category of metric.categories) {
      validateEvaluationText(category, 128, 'metric category')
    }
  }
}

function validateProviderReportIds(ids: readonly string[]): void {
  if (ids.length > MAX_PROVIDER_REPORT_IDS || new Set(ids).size !== ids.length) {
    throw new V2CatalogInputError('Provider report IDs exceed bounds or are not unique')
  }
  for (const id of ids) {
    if (!PROVIDER_REPORT_ID.test(id) || Buffer.byteLength(id) > 512 || CREDENTIAL_VALUE.test(id)) {
      throw new V2CatalogInputError('Provider report ID is invalid')
    }
  }
}

function validateEvaluationError(error: CatalogEvaluationRunErrorV2): void {
  if (!SAFE_EVALUATION_NAME.test(error.phase) || !SAFE_EVALUATION_NAME.test(error.code)) {
    throw new V2CatalogInputError('Evaluation error phase or code is invalid')
  }
  validateEvaluationText(error.message, 2_048, 'error message')
}

function validateEvaluationText(value: string, maxBytes: number, label: string): void {
  if (
    value.length === 0 ||
    Buffer.byteLength(value) > maxBytes ||
    hasControlCharacter(value) ||
    CREDENTIAL_VALUE.test(value)
  ) {
    throw new V2CatalogInputError(`Evaluation ${label} is invalid`)
  }
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index)
    if (codeUnit <= 0x1f || codeUnit === 0x7f) return true
  }
  return false
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
  if ((input.resultRefNamespaceId === null) !== (input.resultRefName === null)) {
    throw new V2CatalogInputError('Transform job result ref namespace and name must be paired')
  }
  if (
    input.resultRefName !== null &&
    (!SAFE_REF_NAME.test(input.resultRefName) ||
      EXACT_VERSION.test(input.resultRefName) ||
      input.resultRefName === '.' ||
      input.resultRefName === '..')
  ) {
    throw new V2CatalogInputError('Transform job result ref name is invalid')
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
    resultRefNamespaceId: string | null
    resultRefName: string | null
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
    row.inputCount !== input.inputCount ||
    (input.resultRefName !== null &&
      row.resultRefNamespaceId !== null &&
      (row.resultRefNamespaceId !== input.resultRefNamespaceId ||
        row.resultRefName !== input.resultRefName))
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

function parseStoredTransformJobResultRef(
  namespaceId: string | null,
  name: string | null,
  statusInput: string | null,
  version: string | null,
): CatalogTransformJobRowV2['resultRef'] {
  if (namespaceId === null && name === null && statusInput === null && version === null) return null
  if (namespaceId === null || name === null || statusInput === null) {
    throw new V2CatalogConsistencyError('Stored transform job result ref shape is invalid')
  }
  if (!SAFE_REF_NAME.test(name) || EXACT_VERSION.test(name) || name === '.' || name === '..') {
    throw new V2CatalogConsistencyError('Stored transform job result ref name is invalid')
  }
  const status = parseTransformJobResultRefStatus(statusInput)
  if ((status === 'pending') !== (version === null)) {
    throw new V2CatalogConsistencyError('Stored transform job result ref version is invalid')
  }
  if (version !== null && !EXACT_VERSION.test(version)) {
    throw new V2CatalogConsistencyError('Stored transform job result ref version is invalid')
  }
  return { namespaceId, name, status, version }
}

function parseTransformJobResultRefStatus(value: string): CatalogTransformJobResultRefStatusV2 {
  if (value === 'pending' || value === 'updated' || value === 'conflict') return value
  throw new V2CatalogConsistencyError('Stored transform job result ref status is invalid')
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

async function adoptTransformJobResultRefInTransaction(
  tx: Prisma.TransactionClient,
  namespaceId: string,
  name: string,
  outputVersion: string,
): Promise<{ readonly status: 'updated' | 'conflict'; readonly version: string }> {
  const inserted = await tx.$queryRaw<TransformJobResultRefSqlRow[]>(Prisma.sql`
    INSERT INTO "refs_v2" (
      "namespace_id", "name", "version", "message", "updated_at"
    )
    VALUES (
      ${namespaceId}::uuid, ${name}, ${outputVersion}, NULL, clock_timestamp()
    )
    ON CONFLICT DO NOTHING
    RETURNING "version", "deleted_at"
  `)
  if (inserted.length === 1 && inserted[0]?.version === outputVersion) {
    return { status: 'updated', version: outputVersion }
  }
  if (inserted.length !== 0) {
    throw new V2CatalogConsistencyError('Transform job result ref insert returned invalid rows')
  }

  const existing = await tx.$queryRaw<TransformJobResultRefSqlRow[]>(Prisma.sql`
    SELECT "version", "deleted_at"
    FROM "refs_v2"
    WHERE "namespace_id" = ${namespaceId}::uuid AND "name" = ${name}
    FOR UPDATE
  `)
  const row = existing[0]
  if (!row || existing.length !== 1) {
    throw new V2CatalogConsistencyError(
      'Transform job result ref conflicted but the winning row could not be read',
    )
  }
  if (row.deleted_at === null && row.version === outputVersion) {
    return { status: 'updated', version: outputVersion }
  }
  return { status: 'conflict', version: row.version }
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
