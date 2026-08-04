import { Prisma, type PrismaClient } from '@prisma/client'
import {
  V2CatalogConsistencyError,
  V2CatalogInputError,
  V2CatalogModelAliasConflictError,
  V2CatalogModelDeploymentAdoptionConflictError,
  V2CatalogModelMetadataConflictError,
  V2CatalogModelRegistrationConflictError,
} from './errors.js'
import type {
  ActivateCatalogModelVersionDeploymentV2,
  AppendModelSourceEvidenceV2,
  ArchiveCatalogModelV2,
  CatalogJsonValueV2,
  CatalogModelAliasRowV2,
  CatalogModelCursorV2,
  CatalogModelDeploymentAdoptionResultV2,
  CatalogModelDeploymentAdoptionRowV2,
  CatalogModelListFilterV2,
  CatalogModelListItemV2,
  CatalogModelPageV2,
  CatalogModelRegistrationClaimRowV2,
  CatalogModelRegistrationResultV2,
  CatalogModelRowV2,
  CatalogModelSourceEvidenceRowV2,
  CatalogModelVersionCursorV2,
  CatalogModelVersionDeploymentCapabilitiesV2,
  CatalogModelVersionDeploymentCursorV2,
  CatalogModelVersionDeploymentLifecycleV2,
  CatalogModelVersionDeploymentPageV2,
  CatalogModelVersionDeploymentRowV2,
  CatalogModelVersionListItemV2,
  CatalogModelVersionPageV2,
  CatalogModelVersionRowV2,
  CatalogModelVersionSourceV2,
  CompareAndSetModelAliasV2,
  CreateModelDeploymentAdoptionV2,
  CreateModelRegistrationV2,
  CreateModelVersionDeploymentV2,
  UpdateCatalogModelMetadataV2,
} from './types.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const HEX_64 = /^[0-9a-f]{64}$/
const MODEL_KEY = /^[a-z][a-z0-9-]{0,127}$/
const SAFE_TOKEN = /^[a-z][a-z0-9._-]{0,127}$/
const CREDENTIAL_REF = /^[a-z0-9][a-z0-9._-]{0,127}$/
const MAX_SAFE_BIGINT = 9_007_199_254_740_991n

type TransactionClient = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0]

interface ModelVersionDeploymentSqlRow {
  readonly id: string
  readonly namespaceId: string
  readonly deploymentProfile: string
  readonly createDigest: string
  readonly artifactId: string | null
  readonly modelVersionId: string | null
  readonly provider: string
  readonly displayName: string
  readonly servedModelName: string
  readonly endpointBaseUrl: string
  readonly connectivityScope: string | null
  readonly authMode: string
  readonly credentialRef: string | null
  readonly declaredCapabilities: Prisma.JsonValue | null
  readonly status: string
  readonly policyGeneration: bigint | null
  readonly credentialGeneration: bigint | null
  readonly healthStatus: string
  readonly healthCheckedAt: Date | null
  readonly healthError: string | null
  readonly createdAt: Date
  readonly activatedAt: Date | null
  readonly disabledAt: Date | null
  readonly updatedAt: Date
}

const MODEL_VERSION_DEPLOYMENT_COLUMNS = Prisma.sql`
  "id" AS "id",
  "namespace_id" AS "namespaceId",
  "deployment_profile" AS "deploymentProfile",
  "create_digest" AS "createDigest",
  "artifact_id" AS "artifactId",
  "model_version_id" AS "modelVersionId",
  "provider" AS "provider",
  "display_name" AS "displayName",
  "served_model_name" AS "servedModelName",
  "endpoint_base_url" AS "endpointBaseUrl",
  "connectivity_scope" AS "connectivityScope",
  "auth_mode" AS "authMode",
  "credential_ref" AS "credentialRef",
  "declared_capabilities_json" AS "declaredCapabilities",
  "status" AS "status",
  "policy_generation" AS "policyGeneration",
  "credential_generation" AS "credentialGeneration",
  "health_status" AS "healthStatus",
  "health_checked_at" AS "healthCheckedAt",
  "health_error" AS "healthError",
  "created_at" AS "createdAt",
  "activated_at" AS "activatedAt",
  "disabled_at" AS "disabledAt",
  "updated_at" AS "updatedAt"
`

export async function registerModelVersionV2(
  client: PrismaClient,
  input: CreateModelRegistrationV2,
): Promise<CatalogModelRegistrationResultV2> {
  validateRegistration(input)
  return await client.$transaction(
    async (transaction) => {
      await lockRegistrationClaim(transaction, input.namespaceId, input.registrationDigest)
      const existingClaim = await transaction.v2ModelRegistrationClaim.findFirst({
        where: {
          namespaceId: input.namespaceId,
          registrationDigest: input.registrationDigest,
        },
      })
      if (existingClaim) {
        if (
          existingClaim.planProfile !== input.planProfile ||
          !sameJsonValue(existingClaim.normalizedRequest, input.normalizedRequest)
        ) {
          throw new V2CatalogModelRegistrationConflictError(
            'request_mismatch',
            input.registrationDigest,
          )
        }
        return await loadRegistrationResult(transaction, existingClaim, true)
      }

      await lockModel(transaction, input.namespaceId, input.version.modelId)
      const model = await createOrReadRegistrationModel(transaction, input)
      const version = await createOrReadRegistrationVersion(transaction, input, model)
      const source = await createOrReadVersionSource(transaction, input, version)
      if (input.initialEvidence !== undefined && input.initialEvidence !== null) {
        await appendModelSourceEvidenceWithClient(transaction, input.initialEvidence)
      }
      const deployment =
        input.deployment === null
          ? null
          : await createOrReadModelVersionDeploymentWithClient(transaction, input.deployment)
      const alias =
        input.alias === null
          ? null
          : await compareAndSetAliasInTransaction(transaction, {
              namespaceId: input.namespaceId,
              modelId: model.id,
              alias: input.alias.alias,
              expectedVersionId: input.alias.expectedVersionId,
              newVersionId: version.id,
            })

      await transaction.v2ModelRegistrationClaim.create({
        data: {
          namespaceId: input.namespaceId,
          registrationDigest: input.registrationDigest,
          planProfile: input.planProfile,
          normalizedRequest: input.normalizedRequest as Prisma.InputJsonObject,
          modelId: model.id,
          modelVersionId: version.id,
          deploymentId: deployment?.id ?? null,
          deploymentDigest: deployment?.createDigest ?? null,
          aliasName: alias?.alias ?? null,
        },
      })
      const claim = await transaction.v2ModelRegistrationClaim.findFirst({
        where: {
          namespaceId: input.namespaceId,
          registrationDigest: input.registrationDigest,
        },
      })
      if (!claim) {
        throw new V2CatalogConsistencyError(
          'Model registration claim was not readable after insert',
        )
      }
      return {
        model,
        version,
        source,
        deployment,
        alias,
        claim: modelRegistrationClaimRow(claim),
        replayed: false,
      }
    },
    { timeout: 30_000 },
  )
}

export async function replayModelRegistrationV2(
  client: PrismaClient,
  namespaceId: string,
  registrationDigest: string,
  planProfile: CreateModelRegistrationV2['planProfile'],
  normalizedRequest: { readonly [key: string]: CatalogJsonValueV2 },
): Promise<CatalogModelRegistrationResultV2 | null> {
  validateUuid(namespaceId, 'namespace ID')
  validateDigest(registrationDigest, 'registration digest')
  if (!isJsonObject(normalizedRequest as Prisma.JsonValue)) {
    throw new V2CatalogInputError('Normalized Model registration request must be an object')
  }
  const claim = await client.v2ModelRegistrationClaim.findFirst({
    where: { namespaceId, registrationDigest },
  })
  if (!claim) return null
  if (
    claim.planProfile !== planProfile ||
    !sameJsonValue(claim.normalizedRequest, normalizedRequest)
  ) {
    throw new V2CatalogModelRegistrationConflictError('request_mismatch', registrationDigest)
  }
  return await loadRegistrationResult(client, claim, true)
}

export async function createOrReadModelVersionDeploymentV2(
  client: PrismaClient,
  input: CreateModelVersionDeploymentV2,
): Promise<CatalogModelVersionDeploymentRowV2> {
  validateModelVersionDeploymentCreate(input)
  return await client.$transaction(async (transaction) =>
    createOrReadModelVersionDeploymentWithClient(transaction, input),
  )
}

export async function getModelVersionDeploymentV2(
  client: PrismaClient,
  namespaceId: string,
  deploymentId: string,
  modelVersionId?: string,
): Promise<CatalogModelVersionDeploymentRowV2 | null> {
  validateUuid(namespaceId, 'namespace ID')
  validateUuid(deploymentId, 'Model Deployment ID')
  if (modelVersionId !== undefined) validateUuid(modelVersionId, 'Model Version ID')
  const row = await client.v2ModelDeployment.findFirst({
    where: {
      namespaceId,
      id: deploymentId,
      deploymentProfile: 'model-version-v1',
      ...(modelVersionId === undefined ? {} : { modelVersionId }),
    },
  })
  return row === null ? null : modelVersionDeploymentRow(row)
}

export async function listModelVersionDeploymentsV2(
  client: PrismaClient,
  namespaceId: string,
  modelVersionId: string,
  lifecycle: CatalogModelVersionDeploymentLifecycleV2 | null,
  before: CatalogModelVersionDeploymentCursorV2 | null,
  limit: number,
): Promise<CatalogModelVersionDeploymentPageV2> {
  validateUuid(namespaceId, 'namespace ID')
  validateUuid(modelVersionId, 'Model Version ID')
  if (lifecycle !== null && !['registered', 'active', 'disabled'].includes(lifecycle)) {
    throw new V2CatalogInputError('Model Version Deployment lifecycle filter is invalid')
  }
  if (before !== null) {
    validateMillisecondDate(before.createdAt, 'Model Version Deployment cursor timestamp')
    validateUuid(before.id, 'Model Version Deployment cursor ID')
  }
  validatePageLimit(limit)
  const rows = await client.$queryRaw<ModelVersionDeploymentSqlRow[]>(Prisma.sql`
    SELECT ${MODEL_VERSION_DEPLOYMENT_COLUMNS}
    FROM "model_deployments_v2"
    WHERE
      "namespace_id" = ${namespaceId}::uuid AND
      "deployment_profile" = 'model-version-v1' AND
      "model_version_id" = ${modelVersionId}::uuid AND
      (${lifecycle}::text IS NULL OR "status" = ${lifecycle}) AND
      ${
        before === null
          ? Prisma.sql`TRUE`
          : Prisma.sql`(
              date_trunc('milliseconds', "created_at") < ${before.createdAt} OR
              (
                date_trunc('milliseconds', "created_at") = ${before.createdAt} AND
                "id"::text COLLATE "C" < ${before.id}
              )
            )`
      }
    ORDER BY date_trunc('milliseconds', "created_at") DESC, "id"::text COLLATE "C" DESC
    LIMIT ${limit + 1}
  `)
  const hasMore = rows.length > limit
  const pageRows = rows.slice(0, limit).map(modelVersionDeploymentRow)
  const last = hasMore ? pageRows.at(-1) : undefined
  return Object.freeze({
    rows: Object.freeze(pageRows),
    nextCursor:
      last === undefined
        ? null
        : Object.freeze({ createdAt: truncateMilliseconds(last.createdAt), id: last.id }),
  })
}

export async function activateModelVersionDeploymentV2(
  client: PrismaClient,
  input: ActivateCatalogModelVersionDeploymentV2,
): Promise<CatalogModelVersionDeploymentRowV2 | null> {
  validateUuid(input.namespaceId, 'namespace ID')
  validateUuid(input.modelVersionId, 'Model Version ID')
  validateUuid(input.deploymentId, 'Model Deployment ID')
  validatePositiveGeneration(input.policyGeneration, 'policy generation')
  if (input.credentialGeneration !== null) {
    validatePositiveGeneration(input.credentialGeneration, 'credential generation')
  }
  return await client.$transaction(async (transaction) => {
    const current = await transaction.v2ModelDeployment.findFirst({
      where: {
        namespaceId: input.namespaceId,
        id: input.deploymentId,
        modelVersionId: input.modelVersionId,
        deploymentProfile: 'model-version-v1',
      },
    })
    if (current === null) return null
    const parsed = modelVersionDeploymentRow(current)
    if (parsed.lifecycle === 'disabled') return parsed
    const updated = await transaction.$queryRaw<ModelVersionDeploymentSqlRow[]>(Prisma.sql`
      UPDATE "model_deployments_v2"
      SET
        "status" = 'active',
        "policy_generation" = ${input.policyGeneration},
        "credential_generation" = ${input.credentialGeneration},
        "activated_at" = COALESCE("activated_at", clock_timestamp()),
        "updated_at" = clock_timestamp()
      WHERE
        "namespace_id" = ${input.namespaceId}::uuid AND
        "id" = ${input.deploymentId}::uuid AND
        "model_version_id" = ${input.modelVersionId}::uuid AND
        "deployment_profile" = 'model-version-v1' AND
        "status" <> 'disabled'
      RETURNING ${MODEL_VERSION_DEPLOYMENT_COLUMNS}
    `)
    if (updated.length !== 1) {
      throw new V2CatalogConsistencyError('Model Version Deployment activation lost its row')
    }
    return modelVersionDeploymentRow(updated[0] as ModelVersionDeploymentSqlRow)
  })
}

export async function disableModelVersionDeploymentV2(
  client: PrismaClient,
  namespaceId: string,
  modelVersionId: string,
  deploymentId: string,
): Promise<CatalogModelVersionDeploymentRowV2 | null> {
  validateUuid(namespaceId, 'namespace ID')
  validateUuid(modelVersionId, 'Model Version ID')
  validateUuid(deploymentId, 'Model Deployment ID')
  return await client.$transaction(async (transaction) => {
    const current = await transaction.v2ModelDeployment.findFirst({
      where: {
        namespaceId,
        id: deploymentId,
        modelVersionId,
        deploymentProfile: 'model-version-v1',
      },
    })
    if (current === null) return null
    if (current.status === 'disabled') return modelVersionDeploymentRow(current)
    const updated = await transaction.$queryRaw<ModelVersionDeploymentSqlRow[]>(Prisma.sql`
      UPDATE "model_deployments_v2"
      SET
        "status" = 'disabled',
        "disabled_at" = clock_timestamp(),
        "updated_at" = clock_timestamp()
      WHERE
        "namespace_id" = ${namespaceId}::uuid AND
        "id" = ${deploymentId}::uuid AND
        "model_version_id" = ${modelVersionId}::uuid AND
        "deployment_profile" = 'model-version-v1' AND
        "status" <> 'disabled'
      RETURNING ${MODEL_VERSION_DEPLOYMENT_COLUMNS}
    `)
    if (updated.length !== 1) {
      throw new V2CatalogConsistencyError('Model Version Deployment disable lost its row')
    }
    return modelVersionDeploymentRow(updated[0] as ModelVersionDeploymentSqlRow)
  })
}

export async function updateModelVersionDeploymentHealthV2(
  client: PrismaClient,
  namespaceId: string,
  modelVersionId: string,
  deploymentId: string,
  health: {
    readonly status: 'healthy' | 'unhealthy'
    readonly error: string | null
  },
): Promise<CatalogModelVersionDeploymentRowV2 | null> {
  validateUuid(namespaceId, 'namespace ID')
  validateUuid(modelVersionId, 'Model Version ID')
  validateUuid(deploymentId, 'Model Deployment ID')
  validateModelVersionDeploymentHealth(health)
  const updated = await client.$queryRaw<ModelVersionDeploymentSqlRow[]>(Prisma.sql`
    UPDATE "model_deployments_v2"
    SET
      "health_status" = ${health.status},
      "health_checked_at" = clock_timestamp(),
      "health_error" = ${health.error},
      "updated_at" = clock_timestamp()
    WHERE
      "namespace_id" = ${namespaceId}::uuid AND
      "id" = ${deploymentId}::uuid AND
      "model_version_id" = ${modelVersionId}::uuid AND
      "deployment_profile" = 'model-version-v1'
    RETURNING ${MODEL_VERSION_DEPLOYMENT_COLUMNS}
  `)
  if (updated.length === 0) return null
  if (updated.length !== 1) {
    throw new V2CatalogConsistencyError('Model Version Deployment health updated multiple rows')
  }
  return modelVersionDeploymentRow(updated[0] as ModelVersionDeploymentSqlRow)
}

export async function getModelV2(
  client: PrismaClient,
  namespaceId: string,
  modelId: string,
): Promise<CatalogModelRowV2 | null> {
  validateUuid(namespaceId, 'namespace ID')
  validateUuid(modelId, 'Model ID')
  const row = await client.v2Model.findFirst({ where: { namespaceId, id: modelId } })
  return row ? modelRow(row) : null
}

export async function getModelVersionV2(
  client: PrismaClient,
  namespaceId: string,
  versionId: string,
): Promise<{
  readonly version: CatalogModelVersionRowV2
  readonly source: CatalogModelVersionSourceV2
} | null> {
  validateUuid(namespaceId, 'namespace ID')
  validateUuid(versionId, 'Model Version ID')
  const row = await client.v2ModelVersion.findFirst({
    where: { namespaceId, id: versionId },
  })
  if (!row) return null
  return {
    version: modelVersionRow(row),
    source: await readVersionSource(client, modelVersionRow(row)),
  }
}

export async function listModelsV2(
  client: PrismaClient,
  namespaceId: string,
  filter: CatalogModelListFilterV2,
  before: CatalogModelCursorV2 | null,
  limit: number,
): Promise<CatalogModelPageV2> {
  validateUuid(namespaceId, 'namespace ID')
  validateModelListFilter(filter)
  if (before !== null) validateModelCursor(before)
  validatePageLimit(limit)
  const archivePredicate =
    filter.archive === 'active'
      ? Prisma.sql`"archived_at" IS NULL`
      : filter.archive === 'archived'
        ? Prisma.sql`"archived_at" IS NOT NULL`
        : Prisma.sql`TRUE`
  const sourcePredicate =
    filter.sourceKind === null
      ? Prisma.sql`TRUE`
      : Prisma.sql`EXISTS (
          SELECT 1 FROM "model_versions_v2" AS "filtered_version"
          WHERE
            "filtered_version"."namespace_id" = "models_v2"."namespace_id" AND
            "filtered_version"."model_id" = "models_v2"."id" AND
            "filtered_version"."source_kind" = ${filter.sourceKind}
        )`
  const searchPredicate =
    filter.search.length === 0
      ? Prisma.sql`TRUE`
      : Prisma.sql`(
          strpos(lower("key"), lower(${filter.search})) > 0 OR
          strpos(lower("display_name"), lower(${filter.search})) > 0 OR
          strpos(lower("description"), lower(${filter.search})) > 0 OR
          strpos(lower(COALESCE("task_family", '')), lower(${filter.search})) > 0 OR
          strpos(lower("tags_json"::text), lower(${filter.search})) > 0
        )`
  const cursorPredicate =
    before === null
      ? Prisma.sql`TRUE`
      : Prisma.sql`(
          date_trunc('milliseconds', "updated_at") < ${before.updatedAt} OR
          (
            date_trunc('milliseconds', "updated_at") = ${before.updatedAt} AND
            "id"::text COLLATE "C" > ${before.id}
          )
        )`
  const locators = await client.$queryRaw<
    Array<{ readonly id: string; readonly updatedAt: Date }>
  >(Prisma.sql`
    SELECT
      "id",
      date_trunc('milliseconds', "updated_at") AS "updatedAt"
    FROM "models_v2"
    WHERE
      "namespace_id" = ${namespaceId}::uuid AND
      ${archivePredicate} AND
      ${sourcePredicate} AND
      ${searchPredicate} AND
      ${cursorPredicate}
    ORDER BY date_trunc('milliseconds', "updated_at") DESC, "id"::text COLLATE "C" ASC
    LIMIT ${limit + 1}
  `)
  const hasMore = locators.length > limit
  const pageLocators = locators.slice(0, limit)
  const modelIds = pageLocators.map((row) => row.id)
  if (modelIds.length === 0) return Object.freeze({ rows: Object.freeze([]), nextCursor: null })

  const [storedModels, versionCounts, candidateAliases, adoptionCounts] = await Promise.all([
    client.v2Model.findMany({ where: { namespaceId, id: { in: modelIds } } }),
    client.v2ModelVersion.groupBy({
      by: ['modelId'],
      where: { namespaceId, modelId: { in: modelIds } },
      _count: { _all: true },
    }),
    client.v2ModelAlias.findMany({
      where: { namespaceId, modelId: { in: modelIds }, alias: 'candidate' },
    }),
    client.$queryRaw<
      Array<{
        readonly modelId: string
        readonly deploymentCount: number
        readonly healthyDeploymentCount: number
      }>
    >(Prisma.sql`
      SELECT
        "adoption"."model_id" AS "modelId",
        COUNT(*)::integer AS "deploymentCount",
        COUNT(*) FILTER (
          WHERE "deployment"."status" = 'active' AND "deployment"."health_status" = 'healthy'
        )::integer AS "healthyDeploymentCount"
      FROM "model_version_deployment_adoptions_v2" AS "adoption"
      JOIN "model_deployments_v2" AS "deployment"
        ON "deployment"."namespace_id" = "adoption"."namespace_id" AND
           "deployment"."id" = "adoption"."deployment_id"
      WHERE
        "adoption"."namespace_id" = ${namespaceId}::uuid AND
        "adoption"."model_id" IN (${Prisma.join(modelIds.map((id) => Prisma.sql`${id}::uuid`))})
      GROUP BY "adoption"."model_id"
    `),
  ])
  const candidateVersionIds = candidateAliases.map((alias) => alias.versionId)
  const candidateVersions =
    candidateVersionIds.length === 0
      ? []
      : await client.v2ModelVersion.findMany({
          where: { namespaceId, id: { in: candidateVersionIds } },
        })
  const candidateRows = candidateVersions.map(modelVersionRow)
  const [candidateSources, candidateEvidenceRows] = await Promise.all([
    readVersionSources(client, candidateRows),
    candidateVersionIds.length === 0
      ? Promise.resolve([])
      : client.v2ModelSourceEvidence.findMany({
          where: { namespaceId, modelVersionId: { in: candidateVersionIds } },
          orderBy: [{ observedAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
          take: 3_000,
        }),
  ])
  const candidateEvidence = new Map<string, CatalogModelSourceEvidenceRowV2[]>()
  for (const storedEvidence of candidateEvidenceRows) {
    const parsedEvidence = modelSourceEvidenceRow(storedEvidence)
    const rows = candidateEvidence.get(parsedEvidence.modelVersionId) ?? []
    rows.push(parsedEvidence)
    candidateEvidence.set(parsedEvidence.modelVersionId, rows)
  }
  const modelById = new Map(storedModels.map((row) => [row.id, modelRow(row)]))
  const countByModel = new Map(versionCounts.map((row) => [row.modelId, row._count._all]))
  const aliasByModel = new Map(candidateAliases.map((row) => [row.modelId, modelAliasRow(row)]))
  const candidateById = new Map(candidateRows.map((row) => [row.id, row]))
  const adoptionByModel = new Map(adoptionCounts.map((row) => [row.modelId, row]))
  const items: CatalogModelListItemV2[] = pageLocators.map((locator) => {
    const model = modelById.get(locator.id)
    if (!model) throw new V2CatalogConsistencyError('Model list locator could not be loaded')
    const alias = aliasByModel.get(model.id)
    const candidateVersion = alias === undefined ? undefined : candidateById.get(alias.versionId)
    if (alias !== undefined && candidateVersion === undefined) {
      throw new V2CatalogConsistencyError('Model candidate Alias Version could not be loaded')
    }
    const candidate =
      alias === undefined || candidateVersion === undefined
        ? null
        : {
            alias,
            version: candidateVersion,
            source: requiredVersionSource(candidateSources, candidateVersion.id),
            evidence: Object.freeze(candidateEvidence.get(candidateVersion.id) ?? []),
          }
    const deploymentCounts = adoptionByModel.get(model.id)
    return Object.freeze({
      model,
      candidate,
      versionCount: countByModel.get(model.id) ?? 0,
      adoptedDeploymentCount: deploymentCounts?.deploymentCount ?? 0,
      healthyAdoptedDeploymentCount: deploymentCounts?.healthyDeploymentCount ?? 0,
    })
  })
  const last = hasMore ? pageLocators.at(-1) : undefined
  return Object.freeze({
    rows: Object.freeze(items),
    nextCursor:
      last === undefined ? null : Object.freeze({ updatedAt: last.updatedAt, id: last.id }),
  })
}

export async function listModelVersionsV2(
  client: PrismaClient,
  namespaceId: string,
  modelId: string,
  before: CatalogModelVersionCursorV2 | null,
  limit: number,
): Promise<CatalogModelVersionPageV2> {
  validateUuid(namespaceId, 'namespace ID')
  validateUuid(modelId, 'Model ID')
  if (before !== null) validateModelVersionCursor(before)
  validatePageLimit(limit)
  const locators = await client.$queryRaw<
    Array<{ readonly id: string; readonly createdAt: Date }>
  >(Prisma.sql`
    SELECT
      "id",
      date_trunc('milliseconds', "created_at") AS "createdAt"
    FROM "model_versions_v2"
    WHERE
      "namespace_id" = ${namespaceId}::uuid AND
      "model_id" = ${modelId}::uuid AND
      ${
        before === null
          ? Prisma.sql`TRUE`
          : Prisma.sql`(
              date_trunc('milliseconds', "created_at") < ${before.createdAt} OR
              (
                date_trunc('milliseconds', "created_at") = ${before.createdAt} AND
                "id"::text COLLATE "C" < ${before.id}
              )
            )`
      }
    ORDER BY date_trunc('milliseconds', "created_at") DESC, "id"::text COLLATE "C" DESC
    LIMIT ${limit + 1}
  `)
  const hasMore = locators.length > limit
  const pageLocators = locators.slice(0, limit)
  const storedVersions =
    pageLocators.length === 0
      ? []
      : await client.v2ModelVersion.findMany({
          where: { namespaceId, modelId, id: { in: pageLocators.map((row) => row.id) } },
        })
  const storedById = new Map(storedVersions.map((row) => [row.id, modelVersionRow(row)]))
  const versions = pageLocators.map((locator) => {
    const version = storedById.get(locator.id)
    if (!version)
      throw new V2CatalogConsistencyError('Model Version list locator could not be loaded')
    return { ...version, createdAt: locator.createdAt }
  })
  const sources = await readVersionSources(client, versions)
  const evidenceRows =
    versions.length === 0
      ? []
      : await client.v2ModelSourceEvidence.findMany({
          where: { namespaceId, modelVersionId: { in: versions.map((version) => version.id) } },
          orderBy: [{ observedAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
          take: 10_000,
        })
  const evidenceByVersion = new Map<string, CatalogModelSourceEvidenceRowV2[]>()
  for (const row of evidenceRows) {
    const evidence = modelSourceEvidenceRow(row)
    const entries = evidenceByVersion.get(evidence.modelVersionId) ?? []
    entries.push(evidence)
    evidenceByVersion.set(evidence.modelVersionId, entries)
  }
  const items: CatalogModelVersionListItemV2[] = versions.map((version) =>
    Object.freeze({
      version,
      source: requiredVersionSource(sources, version.id),
      evidence: Object.freeze(evidenceByVersion.get(version.id) ?? []),
    }),
  )
  const last = hasMore ? pageLocators.at(-1) : undefined
  return Object.freeze({
    rows: Object.freeze(items),
    nextCursor:
      last === undefined ? null : Object.freeze({ createdAt: last.createdAt, id: last.id }),
  })
}

export async function listModelAliasesV2(
  client: PrismaClient,
  namespaceId: string,
  modelId: string,
): Promise<readonly CatalogModelAliasRowV2[]> {
  validateUuid(namespaceId, 'namespace ID')
  validateUuid(modelId, 'Model ID')
  const rows = await client.v2ModelAlias.findMany({
    where: { namespaceId, modelId },
    orderBy: { alias: 'asc' },
    take: 3,
  })
  return Object.freeze(rows.map(modelAliasRow))
}

export async function updateModelMetadataV2(
  client: PrismaClient,
  input: UpdateCatalogModelMetadataV2,
): Promise<CatalogModelRowV2 | null> {
  validateMetadataUpdate(input)
  return await client.$transaction(async (transaction) => {
    await lockModel(transaction, input.namespaceId, input.modelId)
    const current = await transaction.v2Model.findFirst({
      where: { namespaceId: input.namespaceId, id: input.modelId },
    })
    if (!current) return null
    if (current.metadataRevision !== input.expectedMetadataRevision) {
      throw new V2CatalogModelMetadataConflictError(
        input.modelId,
        input.expectedMetadataRevision,
        current.metadataRevision,
      )
    }
    const updated = await transaction.v2Model.update({
      where: { id: input.modelId },
      data: {
        displayName: input.displayName,
        description: input.description,
        taskFamily: input.taskFamily,
        tags: input.tags as Prisma.InputJsonArray,
        metadataRevision: { increment: 1 },
      },
    })
    return modelRow(updated)
  })
}

export async function archiveModelV2(
  client: PrismaClient,
  input: ArchiveCatalogModelV2,
): Promise<CatalogModelRowV2 | null> {
  validateUuid(input.namespaceId, 'namespace ID')
  validateUuid(input.modelId, 'Model ID')
  validateSafeBigint(input.expectedMetadataRevision, 'expected metadata revision')
  return await client.$transaction(async (transaction) => {
    await lockModel(transaction, input.namespaceId, input.modelId)
    const current = await transaction.v2Model.findFirst({
      where: { namespaceId: input.namespaceId, id: input.modelId },
    })
    if (!current) return null
    if (current.archivedAt !== null) return modelRow(current)
    if (current.metadataRevision !== input.expectedMetadataRevision) {
      throw new V2CatalogModelMetadataConflictError(
        input.modelId,
        input.expectedMetadataRevision,
        current.metadataRevision,
      )
    }
    const archived = await transaction.v2Model.update({
      where: { id: input.modelId },
      data: { archivedAt: new Date(), metadataRevision: { increment: 1 } },
    })
    return modelRow(archived)
  })
}

export async function compareAndSetModelAliasV2(
  client: PrismaClient,
  input: CompareAndSetModelAliasV2,
): Promise<CatalogModelAliasRowV2> {
  validateAliasInput(input)
  return await client.$transaction(async (transaction) => {
    await lockModel(transaction, input.namespaceId, input.modelId)
    return await compareAndSetAliasInTransaction(transaction, input)
  })
}

export async function appendModelSourceEvidenceV2(
  client: PrismaClient,
  input: AppendModelSourceEvidenceV2,
): Promise<CatalogModelSourceEvidenceRowV2> {
  return await appendModelSourceEvidenceWithClient(client, input)
}

type ModelSourceEvidenceClient = Pick<PrismaClient, 'v2ModelSourceEvidence'>

async function appendModelSourceEvidenceWithClient(
  client: ModelSourceEvidenceClient,
  input: AppendModelSourceEvidenceV2,
): Promise<CatalogModelSourceEvidenceRowV2> {
  validateEvidence(input)
  await client.v2ModelSourceEvidence.createMany({
    data: [input],
    skipDuplicates: true,
  })
  const row = await client.v2ModelSourceEvidence.findFirst({
    where: {
      namespaceId: input.namespaceId,
      modelVersionId: input.modelVersionId,
      evidenceDigest: input.evidenceDigest,
    },
  })
  if (!row) throw new V2CatalogConsistencyError('Model source evidence was not readable')
  const result = modelSourceEvidenceRow(row)
  if (!sameEvidence(result, input)) {
    throw new V2CatalogConsistencyError('Model source evidence digest resolved to another body')
  }
  return result
}

export async function listModelSourceEvidenceV2(
  client: PrismaClient,
  namespaceId: string,
  modelVersionId: string,
): Promise<readonly CatalogModelSourceEvidenceRowV2[]> {
  validateUuid(namespaceId, 'namespace ID')
  validateUuid(modelVersionId, 'Model Version ID')
  const rows = await client.v2ModelSourceEvidence.findMany({
    where: { namespaceId, modelVersionId },
    orderBy: [{ observedAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    take: 1_000,
  })
  return Object.freeze(rows.map(modelSourceEvidenceRow))
}

export async function createOrReadModelDeploymentAdoptionV2(
  client: PrismaClient,
  input: CreateModelDeploymentAdoptionV2,
): Promise<CatalogModelDeploymentAdoptionResultV2> {
  validateModelDeploymentAdoption(input)
  return await client.$transaction(async (transaction) => {
    await lockModelDeploymentAdoption(transaction, input.namespaceId, input.deploymentId)
    const existing = await transaction.v2ModelVersionDeploymentAdoption.findUnique({
      where: {
        namespaceId_deploymentId: {
          namespaceId: input.namespaceId,
          deploymentId: input.deploymentId,
        },
      },
    })
    if (existing) {
      const row = modelDeploymentAdoptionRow(existing)
      if (!sameModelDeploymentAdoption(row, input)) {
        throw new V2CatalogModelDeploymentAdoptionConflictError(
          input.deploymentId,
          row.modelVersionId,
          input.modelVersionId,
        )
      }
      return Object.freeze({ row, replayed: true })
    }
    const created = await transaction.v2ModelVersionDeploymentAdoption.create({ data: input })
    return Object.freeze({ row: modelDeploymentAdoptionRow(created), replayed: false })
  })
}

export async function listModelDeploymentAdoptionsV2(
  client: PrismaClient,
  namespaceId: string,
  modelVersionId: string,
): Promise<readonly CatalogModelDeploymentAdoptionRowV2[]> {
  validateUuid(namespaceId, 'namespace ID')
  validateUuid(modelVersionId, 'Model Version ID')
  const rows = await client.v2ModelVersionDeploymentAdoption.findMany({
    where: { namespaceId, modelVersionId },
    orderBy: [{ adoptedAt: 'asc' }, { deploymentId: 'asc' }],
    take: 1_000,
  })
  return Object.freeze(rows.map(modelDeploymentAdoptionRow))
}

async function createOrReadRegistrationModel(
  transaction: TransactionClient,
  input: CreateModelRegistrationV2,
): Promise<CatalogModelRowV2> {
  if (input.target.kind === 'existing_model') {
    const existing = await transaction.v2Model.findFirst({
      where: { namespaceId: input.namespaceId, id: input.target.modelId },
    })
    if (!existing) {
      throw new V2CatalogModelRegistrationConflictError(
        'model_target_not_found',
        input.registrationDigest,
      )
    }
    return modelRow(existing)
  }

  const requested = input.target.model
  await transaction.v2Model.createMany({
    data: [
      {
        id: requested.id,
        namespaceId: requested.namespaceId,
        key: requested.key,
        createProfile: requested.createProfile,
        createDigest: requested.createDigest,
        displayName: requested.displayName,
        description: requested.description,
        taskFamily: requested.taskFamily,
        tags: requested.tags as Prisma.InputJsonArray,
      },
    ],
    skipDuplicates: true,
  })
  const row = await transaction.v2Model.findFirst({
    where: { namespaceId: input.namespaceId, id: requested.id },
  })
  if (!row || !sameModelCreate(modelRow(row), requested)) {
    throw new V2CatalogModelRegistrationConflictError(
      'model_key_conflict',
      input.registrationDigest,
    )
  }
  return modelRow(row)
}

async function createOrReadRegistrationVersion(
  transaction: TransactionClient,
  input: CreateModelRegistrationV2,
  model: CatalogModelRowV2,
): Promise<CatalogModelVersionRowV2> {
  const requested = input.version
  if (
    requested.namespaceId !== input.namespaceId ||
    requested.modelId !== model.id ||
    requested.sourceKind !== input.source.kind
  ) {
    throw new V2CatalogInputError('Model registration Version binding is inconsistent')
  }
  await transaction.v2ModelVersion.createMany({ data: [requested], skipDuplicates: true })
  const row = await transaction.v2ModelVersion.findFirst({
    where: { namespaceId: input.namespaceId, id: requested.id },
  })
  if (!row) {
    const labelConflict = await transaction.v2ModelVersion.findFirst({
      where: {
        namespaceId: input.namespaceId,
        modelId: model.id,
        versionLabel: requested.versionLabel,
      },
    })
    throw new V2CatalogModelRegistrationConflictError(
      labelConflict ? 'version_label_conflict' : 'source_fingerprint_conflict',
      input.registrationDigest,
    )
  }
  const result = modelVersionRow(row)
  if (!sameVersionCreate(result, requested)) {
    throw new V2CatalogModelRegistrationConflictError(
      result.versionLabel === requested.versionLabel
        ? 'version_label_conflict'
        : 'source_fingerprint_conflict',
      input.registrationDigest,
    )
  }
  return result
}

async function createOrReadVersionSource(
  transaction: TransactionClient,
  input: CreateModelRegistrationV2,
  version: CatalogModelVersionRowV2,
): Promise<CatalogModelVersionSourceV2> {
  const source = input.source
  if (source.kind === 'databench_artifact') {
    const artifact = await transaction.v2ModelArtifact.findFirst({
      where: { namespaceId: input.namespaceId, id: source.artifactId },
    })
    if (
      !artifact ||
      artifact.artifactKind !== source.artifactKind ||
      artifact.artifactFormat !== source.artifactFormat ||
      artifact.archiveDigest !== source.archiveDigest ||
      artifact.manifestDigest !== source.manifestDigest
    ) {
      throw new V2CatalogInputError('Model Artifact source does not match immutable Catalog data')
    }
    await transaction.v2ModelVersionArtifactSource.createMany({
      data: [
        {
          namespaceId: input.namespaceId,
          modelVersionId: version.id,
          artifactId: source.artifactId,
          artifactKind: source.artifactKind,
          artifactFormat: source.artifactFormat,
          archiveDigest: source.archiveDigest,
          manifestDigest: source.manifestDigest,
        },
      ],
      skipDuplicates: true,
    })
  } else if (source.kind === 'repository_reference') {
    await transaction.v2ModelVersionRepositorySource.createMany({
      data: [
        {
          namespaceId: input.namespaceId,
          modelVersionId: version.id,
          provider: source.provider,
          repositoryId: source.repositoryId,
          revision: source.revision,
          revisionKind: source.revisionKind,
        },
      ],
      skipDuplicates: true,
    })
  } else {
    await transaction.v2ModelVersionServiceSource.createMany({
      data: [
        {
          namespaceId: input.namespaceId,
          modelVersionId: version.id,
          provider: source.provider,
          externalModelRef: source.externalModelRef,
          externalVersionRef: source.externalVersionRef,
          declaredReferenceKind: source.declaredReferenceKind,
        },
      ],
      skipDuplicates: true,
    })
  }
  const stored = await readVersionSource(transaction, version)
  if (!sameSource(stored, source)) {
    throw new V2CatalogConsistencyError('Model Version source row conflicts with its create body')
  }
  return stored
}

async function createOrReadModelVersionDeploymentWithClient(
  transaction: TransactionClient,
  input: CreateModelVersionDeploymentV2,
): Promise<CatalogModelVersionDeploymentRowV2> {
  validateModelVersionDeploymentCreate(input)
  await transaction.v2ModelDeployment.createMany({
    data: [
      {
        id: input.id,
        namespaceId: input.namespaceId,
        deploymentProfile: input.deploymentProfile,
        createDigest: input.createDigest,
        artifactId: input.artifactId,
        modelVersionId: input.modelVersionId,
        provider: input.provider,
        displayName: input.displayName,
        servedModelName: input.servedModelName,
        endpointBaseUrl: input.endpointBaseUrl,
        connectivityScope: input.connectivityScope,
        authMode: input.authProfile,
        credentialRef: input.credentialRef,
        declaredCapabilities: capabilitiesJson(input.declaredCapabilities),
        status: 'registered',
      },
    ],
    skipDuplicates: true,
  })
  const stored = await transaction.v2ModelDeployment.findFirst({
    where: { namespaceId: input.namespaceId, id: input.id },
  })
  if (stored === null) {
    throw new V2CatalogModelRegistrationConflictError(
      'source_fingerprint_conflict',
      input.createDigest,
    )
  }
  const row = modelVersionDeploymentRow(stored)
  if (!sameModelVersionDeploymentCreate(row, input)) {
    throw new V2CatalogModelRegistrationConflictError(
      'source_fingerprint_conflict',
      input.createDigest,
    )
  }
  return row
}

async function compareAndSetAliasInTransaction(
  transaction: TransactionClient,
  input: CompareAndSetModelAliasV2,
): Promise<CatalogModelAliasRowV2> {
  validateAliasInput(input)
  if (input.expectedVersionId === null) {
    await transaction.v2ModelAlias.createMany({
      data: [
        {
          namespaceId: input.namespaceId,
          modelId: input.modelId,
          alias: input.alias,
          versionId: input.newVersionId,
        },
      ],
      skipDuplicates: true,
    })
  } else {
    const updated = await transaction.v2ModelAlias.updateMany({
      where: {
        namespaceId: input.namespaceId,
        modelId: input.modelId,
        alias: input.alias,
        versionId: input.expectedVersionId,
      },
      data: { versionId: input.newVersionId },
    })
    if (updated.count !== 1) {
      const current = await transaction.v2ModelAlias.findFirst({
        where: { namespaceId: input.namespaceId, modelId: input.modelId, alias: input.alias },
      })
      throw new V2CatalogModelAliasConflictError(
        input.modelId,
        input.alias,
        input.expectedVersionId,
        current?.versionId ?? null,
        input.newVersionId,
      )
    }
  }
  const row = await transaction.v2ModelAlias.findFirst({
    where: { namespaceId: input.namespaceId, modelId: input.modelId, alias: input.alias },
  })
  if (!row || row.versionId !== input.newVersionId) {
    throw new V2CatalogModelAliasConflictError(
      input.modelId,
      input.alias,
      input.expectedVersionId,
      row?.versionId ?? null,
      input.newVersionId,
    )
  }
  return modelAliasRow(row)
}

async function loadRegistrationResult(
  transaction: TransactionClient,
  claim: {
    readonly namespaceId: string
    readonly registrationDigest: string
    readonly planProfile: string
    readonly normalizedRequest: Prisma.JsonValue
    readonly modelId: string
    readonly modelVersionId: string
    readonly deploymentId: string | null
    readonly deploymentDigest: string | null
    readonly aliasName: string | null
    readonly createdAt: Date
  },
  replayed: boolean,
): Promise<CatalogModelRegistrationResultV2> {
  const [model, version, deployment, alias] = await Promise.all([
    transaction.v2Model.findFirst({
      where: { namespaceId: claim.namespaceId, id: claim.modelId },
    }),
    transaction.v2ModelVersion.findFirst({
      where: { namespaceId: claim.namespaceId, id: claim.modelVersionId },
    }),
    claim.deploymentId === null
      ? Promise.resolve(null)
      : transaction.v2ModelDeployment.findFirst({
          where: {
            namespaceId: claim.namespaceId,
            id: claim.deploymentId,
            createDigest: claim.deploymentDigest ?? '',
            deploymentProfile: 'model-version-v1',
          },
        }),
    claim.aliasName === null
      ? Promise.resolve(null)
      : transaction.v2ModelAlias.findFirst({
          where: {
            namespaceId: claim.namespaceId,
            modelId: claim.modelId,
            alias: claim.aliasName,
          },
        }),
  ])
  if (
    !model ||
    !version ||
    (claim.deploymentId !== null && !deployment) ||
    (claim.aliasName !== null && !alias)
  ) {
    throw new V2CatalogConsistencyError('Model registration claim result locator is incomplete')
  }
  const versionResult = modelVersionRow(version)
  return {
    model: modelRow(model),
    version: versionResult,
    source: await readVersionSource(transaction, versionResult),
    deployment: deployment === null ? null : modelVersionDeploymentRow(deployment),
    alias: alias ? modelAliasRow(alias) : null,
    claim: modelRegistrationClaimRow(claim),
    replayed,
  }
}

async function readVersionSource(
  client: Pick<
    TransactionClient,
    | 'v2ModelVersionArtifactSource'
    | 'v2ModelVersionRepositorySource'
    | 'v2ModelVersionServiceSource'
  >,
  version: CatalogModelVersionRowV2,
): Promise<CatalogModelVersionSourceV2> {
  if (version.sourceKind === 'databench_artifact') {
    const row = await client.v2ModelVersionArtifactSource.findFirst({
      where: { namespaceId: version.namespaceId, modelVersionId: version.id },
    })
    if (row) {
      return {
        kind: 'databench_artifact',
        artifactId: row.artifactId,
        artifactKind: row.artifactKind,
        artifactFormat: row.artifactFormat,
        archiveDigest: row.archiveDigest,
        manifestDigest: row.manifestDigest,
      }
    }
  } else if (version.sourceKind === 'repository_reference') {
    const row = await client.v2ModelVersionRepositorySource.findFirst({
      where: { namespaceId: version.namespaceId, modelVersionId: version.id },
    })
    if (row) {
      return {
        kind: 'repository_reference',
        provider: row.provider as 'hugging_face' | 'modelscope' | 'operator_managed',
        repositoryId: row.repositoryId,
        revision: row.revision,
        revisionKind: row.revisionKind as 'commit' | 'digest' | 'tag' | 'opaque',
      }
    }
  } else {
    const row = await client.v2ModelVersionServiceSource.findFirst({
      where: { namespaceId: version.namespaceId, modelVersionId: version.id },
    })
    if (row) {
      return {
        kind: 'existing_service',
        provider: row.provider as 'openai_compatible',
        externalModelRef: row.externalModelRef,
        externalVersionRef: row.externalVersionRef,
        declaredReferenceKind: row.declaredReferenceKind as
          | 'immutable_version'
          | 'mutable_alias'
          | 'opaque',
      }
    }
  }
  throw new V2CatalogConsistencyError('Model Version does not have its exact source row')
}

async function readVersionSources(
  client: Pick<
    TransactionClient,
    | 'v2ModelVersionArtifactSource'
    | 'v2ModelVersionRepositorySource'
    | 'v2ModelVersionServiceSource'
  >,
  versions: readonly CatalogModelVersionRowV2[],
): Promise<ReadonlyMap<string, CatalogModelVersionSourceV2>> {
  if (versions.length === 0) return new Map()
  const namespaceId = versions[0]?.namespaceId
  if (
    namespaceId === undefined ||
    versions.some((version) => version.namespaceId !== namespaceId)
  ) {
    throw new V2CatalogInputError('Model Version source batch must use one namespace')
  }
  const ids = versions.map((version) => version.id)
  const [artifacts, repositories, services] = await Promise.all([
    client.v2ModelVersionArtifactSource.findMany({
      where: { namespaceId, modelVersionId: { in: ids } },
    }),
    client.v2ModelVersionRepositorySource.findMany({
      where: { namespaceId, modelVersionId: { in: ids } },
    }),
    client.v2ModelVersionServiceSource.findMany({
      where: { namespaceId, modelVersionId: { in: ids } },
    }),
  ])
  const sources = new Map<string, CatalogModelVersionSourceV2>()
  for (const row of artifacts) {
    sources.set(row.modelVersionId, {
      kind: 'databench_artifact',
      artifactId: row.artifactId,
      artifactKind: row.artifactKind,
      artifactFormat: row.artifactFormat,
      archiveDigest: row.archiveDigest,
      manifestDigest: row.manifestDigest,
    })
  }
  for (const row of repositories) {
    sources.set(row.modelVersionId, {
      kind: 'repository_reference',
      provider: row.provider as 'hugging_face' | 'modelscope' | 'operator_managed',
      repositoryId: row.repositoryId,
      revision: row.revision,
      revisionKind: row.revisionKind as 'commit' | 'digest' | 'tag' | 'opaque',
    })
  }
  for (const row of services) {
    sources.set(row.modelVersionId, {
      kind: 'existing_service',
      provider: row.provider as 'openai_compatible',
      externalModelRef: row.externalModelRef,
      externalVersionRef: row.externalVersionRef,
      declaredReferenceKind: row.declaredReferenceKind as
        | 'immutable_version'
        | 'mutable_alias'
        | 'opaque',
    })
  }
  for (const version of versions) requiredVersionSource(sources, version.id)
  return sources
}

function requiredVersionSource(
  sources: ReadonlyMap<string, CatalogModelVersionSourceV2>,
  versionId: string,
): CatalogModelVersionSourceV2 {
  const source = sources.get(versionId)
  if (!source) throw new V2CatalogConsistencyError('Model Version source batch is incomplete')
  return source
}

async function lockModel(
  transaction: TransactionClient,
  namespaceId: string,
  modelId: string,
): Promise<void> {
  await transaction.$queryRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(hashtext(${namespaceId}), hashtext(${modelId}))::text AS "locked"
  `)
}

async function lockRegistrationClaim(
  transaction: TransactionClient,
  namespaceId: string,
  registrationDigest: string,
): Promise<void> {
  await transaction.$queryRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(
      hashtext(${namespaceId}),
      hashtext(${registrationDigest})
    )::text AS "locked"
  `)
}

async function lockModelDeploymentAdoption(
  transaction: TransactionClient,
  namespaceId: string,
  deploymentId: string,
): Promise<void> {
  await transaction.$queryRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(
      hashtext(${namespaceId}),
      hashtext(${deploymentId})
    )::text AS "locked"
  `)
}

function modelRow(row: {
  readonly id: string
  readonly namespaceId: string
  readonly key: string
  readonly createProfile: string
  readonly createDigest: string
  readonly displayName: string
  readonly description: string
  readonly taskFamily: string | null
  readonly tags: Prisma.JsonValue
  readonly metadataRevision: bigint
  readonly archivedAt: Date | null
  readonly createdAt: Date
  readonly updatedAt: Date
}): CatalogModelRowV2 {
  if (!Array.isArray(row.tags) || row.tags.some((tag) => typeof tag !== 'string')) {
    throw new V2CatalogConsistencyError('Model tags are not a string array')
  }
  const tags = row.tags as string[]
  return {
    id: row.id,
    namespaceId: row.namespaceId,
    key: row.key,
    createProfile: row.createProfile as 'model-create-v1',
    createDigest: row.createDigest,
    displayName: row.displayName,
    description: row.description,
    taskFamily: row.taskFamily,
    tags: Object.freeze([...tags]),
    metadataRevision: row.metadataRevision,
    archivedAt: row.archivedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function modelVersionRow(row: {
  readonly id: string
  readonly namespaceId: string
  readonly modelId: string
  readonly versionLabel: string
  readonly sourceKind: string
  readonly createProfile: string
  readonly createDigest: string
  readonly sourceFingerprint: string
  readonly baseModelReference: string | null
  readonly baseModelRevision: string | null
  readonly baseModelBindingStatus: string | null
  readonly createdAt: Date
}): CatalogModelVersionRowV2 {
  return {
    id: row.id,
    namespaceId: row.namespaceId,
    modelId: row.modelId,
    versionLabel: row.versionLabel,
    sourceKind: row.sourceKind as CatalogModelVersionRowV2['sourceKind'],
    createProfile: row.createProfile as CatalogModelVersionRowV2['createProfile'],
    createDigest: row.createDigest,
    sourceFingerprint: row.sourceFingerprint,
    baseModelReference: row.baseModelReference,
    baseModelRevision: row.baseModelRevision,
    baseModelBindingStatus:
      row.baseModelBindingStatus as CatalogModelVersionRowV2['baseModelBindingStatus'],
    createdAt: row.createdAt,
  }
}

function modelAliasRow(row: {
  readonly namespaceId: string
  readonly modelId: string
  readonly alias: string
  readonly versionId: string
  readonly createdAt: Date
  readonly updatedAt: Date
}): CatalogModelAliasRowV2 {
  return {
    namespaceId: row.namespaceId,
    modelId: row.modelId,
    alias: row.alias as CatalogModelAliasRowV2['alias'],
    versionId: row.versionId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function modelRegistrationClaimRow(row: {
  readonly namespaceId: string
  readonly registrationDigest: string
  readonly planProfile: string
  readonly normalizedRequest: Prisma.JsonValue
  readonly modelId: string
  readonly modelVersionId: string
  readonly deploymentId: string | null
  readonly deploymentDigest: string | null
  readonly aliasName: string | null
  readonly createdAt: Date
}): CatalogModelRegistrationClaimRowV2 {
  if (!isJsonObject(row.normalizedRequest)) {
    throw new V2CatalogConsistencyError('Model registration normalized request is not an object')
  }
  return {
    namespaceId: row.namespaceId,
    registrationDigest: row.registrationDigest,
    planProfile: row.planProfile as CatalogModelRegistrationClaimRowV2['planProfile'],
    normalizedRequest: row.normalizedRequest as unknown as {
      readonly [key: string]: CatalogJsonValueV2
    },
    modelId: row.modelId,
    modelVersionId: row.modelVersionId,
    deploymentId: row.deploymentId,
    deploymentDigest: row.deploymentDigest,
    aliasName: row.aliasName as CatalogModelRegistrationClaimRowV2['aliasName'],
    createdAt: row.createdAt,
  }
}

function modelVersionDeploymentRow(
  row:
    | ModelVersionDeploymentSqlRow
    | {
        readonly id: string
        readonly namespaceId: string
        readonly deploymentProfile: string
        readonly createDigest: string
        readonly artifactId: string | null
        readonly modelVersionId: string | null
        readonly provider: string
        readonly displayName: string
        readonly servedModelName: string
        readonly endpointBaseUrl: string
        readonly connectivityScope: string | null
        readonly authMode: string
        readonly credentialRef: string | null
        readonly declaredCapabilities: Prisma.JsonValue | null
        readonly status: string
        readonly policyGeneration: bigint | null
        readonly credentialGeneration: bigint | null
        readonly healthStatus: string
        readonly healthCheckedAt: Date | null
        readonly healthError: string | null
        readonly createdAt: Date
        readonly activatedAt: Date | null
        readonly disabledAt: Date | null
        readonly updatedAt: Date
      },
): CatalogModelVersionDeploymentRowV2 {
  if (
    row.deploymentProfile !== 'model-version-v1' ||
    row.modelVersionId === null ||
    row.connectivityScope === null
  ) {
    throw new V2CatalogConsistencyError('Stored Model Version Deployment profile is invalid')
  }
  const result: CatalogModelVersionDeploymentRowV2 = {
    id: row.id,
    namespaceId: row.namespaceId,
    deploymentProfile: 'model-version-v1',
    createDigest: row.createDigest,
    artifactId: row.artifactId,
    modelVersionId: row.modelVersionId,
    provider: parseModelVersionDeploymentProvider(row.provider),
    displayName: row.displayName,
    servedModelName: row.servedModelName,
    endpointBaseUrl: row.endpointBaseUrl,
    connectivityScope: parseModelVersionDeploymentScope(row.connectivityScope),
    authProfile: parseModelVersionDeploymentAuth(row.authMode),
    credentialRef: row.credentialRef,
    declaredCapabilities: parseModelVersionDeploymentCapabilities(row.declaredCapabilities),
    lifecycle: parseModelVersionDeploymentLifecycle(row.status),
    policyGeneration: row.policyGeneration,
    credentialGeneration: row.credentialGeneration,
    healthStatus: parseModelVersionDeploymentHealthStatus(row.healthStatus),
    healthCheckedAt: row.healthCheckedAt,
    healthError: row.healthError,
    createdAt: row.createdAt,
    activatedAt: row.activatedAt,
    disabledAt: row.disabledAt,
    updatedAt: row.updatedAt,
  }
  try {
    validateModelVersionDeploymentCreate(result)
    validateModelVersionDeploymentStoredState(result)
  } catch (cause) {
    throw new V2CatalogConsistencyError('Stored Model Version Deployment is invalid', { cause })
  }
  return Object.freeze(result)
}

function parseModelVersionDeploymentCapabilities(
  value: Prisma.JsonValue | null,
): CatalogModelVersionDeploymentCapabilitiesV2 {
  if (
    value === null ||
    Array.isArray(value) ||
    typeof value !== 'object' ||
    Object.keys(value).length !== 2 ||
    !Array.isArray(value.interfaces) ||
    !('context_limit' in value)
  ) {
    throw new V2CatalogConsistencyError('Stored Deployment capabilities are invalid')
  }
  const interfaces = value.interfaces
  const contextLimit = value.context_limit
  if (
    interfaces.some(
      (entry) =>
        typeof entry !== 'string' ||
        !['chat_completions', 'embeddings', 'vision', 'tools'].includes(entry),
    ) ||
    (contextLimit !== null &&
      (typeof contextLimit !== 'number' ||
        !Number.isSafeInteger(contextLimit) ||
        contextLimit < 1 ||
        contextLimit > 10_000_000))
  ) {
    throw new V2CatalogConsistencyError('Stored Deployment capabilities are invalid')
  }
  return Object.freeze({
    interfaces: Object.freeze(
      interfaces as CatalogModelVersionDeploymentCapabilitiesV2['interfaces'],
    ),
    contextLimit,
  })
}

function parseModelVersionDeploymentProvider(
  value: string,
): CatalogModelVersionDeploymentRowV2['provider'] {
  if (value !== 'openai_compatible') {
    throw new V2CatalogConsistencyError('Stored Deployment provider is invalid')
  }
  return value
}

function parseModelVersionDeploymentScope(
  value: string,
): CatalogModelVersionDeploymentRowV2['connectivityScope'] {
  if (value !== 'private_network' && value !== 'public_network') {
    throw new V2CatalogConsistencyError('Stored Deployment connectivity scope is invalid')
  }
  return value
}

function parseModelVersionDeploymentAuth(
  value: string,
): CatalogModelVersionDeploymentRowV2['authProfile'] {
  if (value !== 'none' && value !== 'bearer_ref') {
    throw new V2CatalogConsistencyError('Stored Deployment auth profile is invalid')
  }
  return value
}

function parseModelVersionDeploymentLifecycle(
  value: string,
): CatalogModelVersionDeploymentLifecycleV2 {
  if (value !== 'registered' && value !== 'active' && value !== 'disabled') {
    throw new V2CatalogConsistencyError('Stored Deployment lifecycle is invalid')
  }
  return value
}

function parseModelVersionDeploymentHealthStatus(
  value: string,
): CatalogModelVersionDeploymentRowV2['healthStatus'] {
  if (value !== 'unknown' && value !== 'healthy' && value !== 'unhealthy') {
    throw new V2CatalogConsistencyError('Stored Deployment health status is invalid')
  }
  return value
}

function modelSourceEvidenceRow(row: {
  readonly id: string
  readonly namespaceId: string
  readonly modelVersionId: string
  readonly evidenceProfile: string
  readonly evidenceDigest: string
  readonly evidenceKind: string
  readonly adapter: string
  readonly adapterVersion: string
  readonly observedRevision: string | null
  readonly observedAt: Date
  readonly result: string
  readonly responseDigest: string | null
  readonly license: string | null
  readonly cacheStatus: string
  readonly createdAt: Date
}): CatalogModelSourceEvidenceRowV2 {
  return {
    id: row.id,
    namespaceId: row.namespaceId,
    modelVersionId: row.modelVersionId,
    evidenceProfile: row.evidenceProfile as 'model-source-evidence-v1',
    evidenceDigest: row.evidenceDigest,
    evidenceKind: row.evidenceKind as CatalogModelSourceEvidenceRowV2['evidenceKind'],
    adapter: row.adapter,
    adapterVersion: row.adapterVersion,
    observedRevision: row.observedRevision,
    observedAt: row.observedAt,
    result: row.result as CatalogModelSourceEvidenceRowV2['result'],
    responseDigest: row.responseDigest,
    license: row.license,
    cacheStatus: row.cacheStatus as CatalogModelSourceEvidenceRowV2['cacheStatus'],
    createdAt: row.createdAt,
  }
}

function modelDeploymentAdoptionRow(row: {
  readonly namespaceId: string
  readonly deploymentId: string
  readonly modelId: string
  readonly modelVersionId: string
  readonly artifactId: string
  readonly deploymentDigest: string
  readonly adoptionProfile: string
  readonly adoptionDigest: string
  readonly adoptedAt: Date
}): CatalogModelDeploymentAdoptionRowV2 {
  return {
    namespaceId: row.namespaceId,
    deploymentId: row.deploymentId,
    modelId: row.modelId,
    modelVersionId: row.modelVersionId,
    artifactId: row.artifactId,
    deploymentDigest: row.deploymentDigest,
    adoptionProfile: row.adoptionProfile as 'model-deployment-adoption-v1',
    adoptionDigest: row.adoptionDigest,
    adoptedAt: row.adoptedAt,
  }
}

function sameModelCreate(
  stored: CatalogModelRowV2,
  expected: CreateModelRegistrationV2['target'] extends infer Target
    ? Target extends { readonly kind: 'create_model'; readonly model: infer Model }
      ? Model
      : never
    : never,
): boolean {
  return (
    stored.id === expected.id &&
    stored.namespaceId === expected.namespaceId &&
    stored.key === expected.key &&
    stored.createProfile === expected.createProfile &&
    stored.createDigest === expected.createDigest &&
    stored.displayName === expected.displayName &&
    stored.description === expected.description &&
    stored.taskFamily === expected.taskFamily &&
    sameStringArray(stored.tags, expected.tags)
  )
}

function sameVersionCreate(
  stored: CatalogModelVersionRowV2,
  expected: CreateModelRegistrationV2['version'],
): boolean {
  return (
    stored.id === expected.id &&
    stored.namespaceId === expected.namespaceId &&
    stored.modelId === expected.modelId &&
    stored.versionLabel === expected.versionLabel &&
    stored.sourceKind === expected.sourceKind &&
    stored.createProfile === expected.createProfile &&
    stored.createDigest === expected.createDigest &&
    stored.sourceFingerprint === expected.sourceFingerprint &&
    stored.baseModelReference === expected.baseModelReference &&
    stored.baseModelRevision === expected.baseModelRevision &&
    stored.baseModelBindingStatus === expected.baseModelBindingStatus
  )
}

function sameSource(
  stored: CatalogModelVersionSourceV2,
  expected: CatalogModelVersionSourceV2,
): boolean {
  return sameJsonValue(stored as unknown as Prisma.JsonValue, expected as CatalogJsonValueV2)
}

function sameEvidence(
  stored: CatalogModelSourceEvidenceRowV2,
  expected: AppendModelSourceEvidenceV2,
): boolean {
  return (
    stored.id === expected.id &&
    stored.namespaceId === expected.namespaceId &&
    stored.modelVersionId === expected.modelVersionId &&
    stored.evidenceProfile === expected.evidenceProfile &&
    stored.evidenceDigest === expected.evidenceDigest &&
    stored.evidenceKind === expected.evidenceKind &&
    stored.adapter === expected.adapter &&
    stored.adapterVersion === expected.adapterVersion &&
    stored.observedRevision === expected.observedRevision &&
    stored.result === expected.result &&
    stored.responseDigest === expected.responseDigest &&
    stored.license === expected.license &&
    stored.cacheStatus === expected.cacheStatus
  )
}

function sameModelDeploymentAdoption(
  stored: CatalogModelDeploymentAdoptionRowV2,
  expected: CreateModelDeploymentAdoptionV2,
): boolean {
  return (
    stored.namespaceId === expected.namespaceId &&
    stored.deploymentId === expected.deploymentId &&
    stored.modelId === expected.modelId &&
    stored.modelVersionId === expected.modelVersionId &&
    stored.artifactId === expected.artifactId &&
    stored.deploymentDigest === expected.deploymentDigest &&
    stored.adoptionProfile === expected.adoptionProfile &&
    stored.adoptionDigest === expected.adoptionDigest
  )
}

function sameModelVersionDeploymentCreate(
  stored: CatalogModelVersionDeploymentRowV2,
  expected: CreateModelVersionDeploymentV2,
): boolean {
  return (
    stored.id === expected.id &&
    stored.namespaceId === expected.namespaceId &&
    stored.deploymentProfile === expected.deploymentProfile &&
    stored.createDigest === expected.createDigest &&
    stored.artifactId === expected.artifactId &&
    stored.modelVersionId === expected.modelVersionId &&
    stored.provider === expected.provider &&
    stored.displayName === expected.displayName &&
    stored.servedModelName === expected.servedModelName &&
    stored.endpointBaseUrl === expected.endpointBaseUrl &&
    stored.connectivityScope === expected.connectivityScope &&
    stored.authProfile === expected.authProfile &&
    stored.credentialRef === expected.credentialRef &&
    sameStringArray(
      stored.declaredCapabilities.interfaces,
      expected.declaredCapabilities.interfaces,
    ) &&
    stored.declaredCapabilities.contextLimit === expected.declaredCapabilities.contextLimit
  )
}

function sameJsonValue(stored: Prisma.JsonValue, expected: CatalogJsonValueV2): boolean {
  if (stored === null || expected === null) return stored === expected
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
  if (typeof stored === 'object') {
    if (typeof expected !== 'object' || Array.isArray(expected)) return false
    const storedObject = stored as Prisma.JsonObject
    const expectedObject = expected as { readonly [key: string]: CatalogJsonValueV2 }
    const storedKeys = Object.keys(stored)
    const expectedKeys = Object.keys(expected)
    return (
      storedKeys.length === expectedKeys.length &&
      storedKeys.every((key) => {
        const expectedValue = expectedObject[key]
        return (
          expectedValue !== undefined && sameJsonValue(storedObject[key] ?? null, expectedValue)
        )
      })
    )
  }
  return stored === expected
}

function isJsonObject(value: Prisma.JsonValue): value is Prisma.JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function validateRegistration(input: CreateModelRegistrationV2): void {
  validateUuid(input.namespaceId, 'namespace ID')
  validateDigest(input.registrationDigest, 'registration digest')
  validateUuid(input.version.id, 'Model Version ID')
  validateUuid(input.version.modelId, 'Model ID')
  validateDigest(input.version.createDigest, 'Model Version create digest')
  validateDigest(input.version.sourceFingerprint, 'source fingerprint')
  if (input.target.kind === 'create_model') {
    validateUuid(input.target.model.id, 'Model ID')
    validateDigest(input.target.model.createDigest, 'Model create digest')
    if (
      input.target.model.namespaceId !== input.namespaceId ||
      !MODEL_KEY.test(input.target.model.key)
    ) {
      throw new V2CatalogInputError('Model create target is invalid')
    }
  } else {
    validateUuid(input.target.modelId, 'Model ID')
  }
  if (input.version.namespaceId !== input.namespaceId) {
    throw new V2CatalogInputError('Model Version namespace does not match registration namespace')
  }
  const expectedProfiles =
    input.source.kind === 'databench_artifact'
      ? {
          plan: 'model-registration-plan-artifact-v1',
          version: 'model-version-create-artifact-v1',
        }
      : input.source.kind === 'repository_reference'
        ? {
            plan: 'model-registration-plan-repository-v1',
            version: 'model-version-create-repository-v1',
          }
        : {
            plan: 'model-registration-plan-service-v1',
            version: 'model-version-create-service-v1',
          }
  if (
    input.version.sourceKind !== input.source.kind ||
    input.planProfile !== expectedProfiles.plan ||
    input.version.createProfile !== expectedProfiles.version
  ) {
    throw new V2CatalogInputError('Model registration source profiles are inconsistent')
  }
  if (!isJsonObject(input.normalizedRequest as Prisma.JsonValue)) {
    throw new V2CatalogInputError('Normalized Model registration request must be an object')
  }
  if (input.initialEvidence !== undefined && input.initialEvidence !== null) {
    validateEvidence(input.initialEvidence)
    if (
      input.initialEvidence.namespaceId !== input.namespaceId ||
      input.initialEvidence.modelVersionId !== input.version.id
    ) {
      throw new V2CatalogInputError(
        'Initial Model source evidence does not match the registered Version',
      )
    }
  }
  if (input.deployment !== null) {
    validateModelVersionDeploymentCreate(input.deployment)
    if (
      input.deployment.namespaceId !== input.namespaceId ||
      input.deployment.modelVersionId !== input.version.id ||
      (input.source.kind === 'databench_artifact'
        ? input.deployment.artifactId !== input.source.artifactId
        : input.deployment.artifactId !== null)
    ) {
      throw new V2CatalogInputError(
        'Model registration Deployment does not match its Version source',
      )
    }
  }
  if (input.source.kind === 'existing_service' && input.deployment === null) {
    throw new V2CatalogInputError(
      'Existing Service registration requires exactly one registered Deployment',
    )
  }
}

function validateModelVersionDeploymentCreate(input: CreateModelVersionDeploymentV2): void {
  validateUuid(input.id, 'Model Deployment ID')
  validateUuid(input.namespaceId, 'namespace ID')
  validateUuid(input.modelVersionId, 'Model Version ID')
  if (input.artifactId !== null) validateUuid(input.artifactId, 'Model Artifact ID')
  validateDigest(input.createDigest, 'Model Deployment create digest')
  if (
    input.deploymentProfile !== 'model-version-v1' ||
    input.provider !== 'openai_compatible' ||
    !['private_network', 'public_network'].includes(input.connectivityScope) ||
    !['none', 'bearer_ref'].includes(input.authProfile) ||
    (input.authProfile === 'bearer_ref') !== (input.credentialRef !== null)
  ) {
    throw new V2CatalogInputError('Model Version Deployment profile is invalid')
  }
  validateDeploymentText(input.displayName, 256, 'Deployment display name')
  validateDeploymentText(input.servedModelName, 512, 'Deployment served model name')
  if (normalizeDeploymentEndpoint(input.endpointBaseUrl) !== input.endpointBaseUrl) {
    throw new V2CatalogInputError('Model Version Deployment endpoint is invalid')
  }
  if (
    input.credentialRef !== null &&
    (!CREDENTIAL_REF.test(input.credentialRef) || input.credentialRef.includes('..'))
  ) {
    throw new V2CatalogInputError('Model Version Deployment credential ref is invalid')
  }
  validateDeploymentCapabilities(input.declaredCapabilities)
}

function validateModelVersionDeploymentStoredState(row: CatalogModelVersionDeploymentRowV2): void {
  if (
    !Number.isFinite(row.createdAt.getTime()) ||
    !Number.isFinite(row.updatedAt.getTime()) ||
    row.updatedAt < row.createdAt ||
    (row.activatedAt !== null &&
      (!Number.isFinite(row.activatedAt.getTime()) || row.activatedAt < row.createdAt)) ||
    (row.disabledAt !== null &&
      (!Number.isFinite(row.disabledAt.getTime()) ||
        row.disabledAt < (row.activatedAt ?? row.createdAt))) ||
    (row.lifecycle === 'disabled') !== (row.disabledAt !== null) ||
    (row.lifecycle === 'registered' && row.activatedAt !== null) ||
    (row.lifecycle === 'active' && row.activatedAt === null) ||
    (row.lifecycle === 'registered' &&
      (row.policyGeneration !== null || row.credentialGeneration !== null)) ||
    (row.lifecycle === 'active' && row.policyGeneration === null) ||
    (row.authProfile === 'none' && row.credentialGeneration !== null) ||
    (row.lifecycle === 'active' &&
      row.authProfile === 'bearer_ref' &&
      row.credentialGeneration === null) ||
    (row.healthStatus === 'unknown') !== (row.healthCheckedAt === null) ||
    (row.healthStatus === 'unhealthy') !== (row.healthError !== null)
  ) {
    throw new V2CatalogInputError('Model Version Deployment stored lifecycle is invalid')
  }
  if (row.policyGeneration !== null) {
    validatePositiveGeneration(row.policyGeneration, 'policy generation')
  }
  if (row.credentialGeneration !== null) {
    validatePositiveGeneration(row.credentialGeneration, 'credential generation')
  }
}

function validateModelVersionDeploymentHealth(health: {
  readonly status: 'healthy' | 'unhealthy'
  readonly error: string | null
}): void {
  const errorCodes = [
    'timeout',
    'network_error',
    'http_error',
    'invalid_response',
    'served_model_missing',
    'policy_rejected',
    'credential_rejected',
    'configuration_changed',
    'unhealthy',
  ]
  if (
    !['healthy', 'unhealthy'].includes(health.status) ||
    (health.status === 'unhealthy') !== (health.error !== null) ||
    (health.error !== null && !errorCodes.includes(health.error))
  ) {
    throw new V2CatalogInputError('Model Version Deployment health observation is invalid')
  }
}

function validateDeploymentCapabilities(
  capabilities: CatalogModelVersionDeploymentCapabilitiesV2,
): void {
  const sorted = [...capabilities.interfaces].sort()
  if (
    capabilities.interfaces.length < 1 ||
    capabilities.interfaces.length > 4 ||
    new Set(capabilities.interfaces).size !== capabilities.interfaces.length ||
    !sameStringArray(capabilities.interfaces, sorted) ||
    capabilities.interfaces.some(
      (entry) => !['chat_completions', 'embeddings', 'vision', 'tools'].includes(entry),
    ) ||
    (capabilities.contextLimit !== null &&
      (!Number.isSafeInteger(capabilities.contextLimit) ||
        capabilities.contextLimit < 1 ||
        capabilities.contextLimit > 10_000_000))
  ) {
    throw new V2CatalogInputError('Model Version Deployment capabilities are invalid')
  }
}

function validateDeploymentText(value: string, maxBytes: number, label: string): void {
  const bytes = new TextEncoder().encode(value).byteLength
  if (bytes < 1 || bytes > maxBytes || hasDeploymentControlCharacter(value)) {
    throw new V2CatalogInputError(`${label} is invalid`)
  }
}

function normalizeDeploymentEndpoint(value: string): string | null {
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
    parsed.hash !== '' ||
    hasDeploymentEndpointForbiddenCharacter(value)
  ) {
    return null
  }
  const pathname = parsed.pathname.replace(/\/+$/u, '')
  parsed.pathname = pathname === '' ? '/' : pathname
  const normalized = parsed.toString().replace(/\/$/u, '')
  return normalized === parsed.origin ? parsed.origin : normalized
}

function hasDeploymentControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return true
  }
  return false
}

function hasDeploymentEndpointForbiddenCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)
    if (
      character === '\\' ||
      (codePoint !== undefined && (codePoint <= 0x20 || codePoint === 0x7f))
    ) {
      return true
    }
  }
  return false
}

function capabilitiesJson(
  capabilities: CatalogModelVersionDeploymentCapabilitiesV2,
): Prisma.InputJsonObject {
  return {
    interfaces: [...capabilities.interfaces],
    context_limit: capabilities.contextLimit,
  }
}

function validatePositiveGeneration(value: bigint, label: string): void {
  if (value < 1n || value > MAX_SAFE_BIGINT) {
    throw new V2CatalogInputError(`${label} is invalid`)
  }
}

function truncateMilliseconds(value: Date): Date {
  return new Date(value.getTime())
}

function validateMetadataUpdate(input: UpdateCatalogModelMetadataV2): void {
  validateUuid(input.namespaceId, 'namespace ID')
  validateUuid(input.modelId, 'Model ID')
  if (
    input.expectedMetadataRevision < 0n ||
    input.expectedMetadataRevision > MAX_SAFE_BIGINT ||
    input.tags.length > 32
  ) {
    throw new V2CatalogInputError('Model metadata update is invalid')
  }
}

function validateModelListFilter(filter: CatalogModelListFilterV2): void {
  if (
    typeof filter.search !== 'string' ||
    new TextEncoder().encode(filter.search).byteLength > 256 ||
    !['active', 'archived', 'all'].includes(filter.archive) ||
    (filter.sourceKind !== null &&
      !['databench_artifact', 'repository_reference', 'existing_service'].includes(
        filter.sourceKind,
      ))
  ) {
    throw new V2CatalogInputError('Model list filter is invalid')
  }
}

function validateModelCursor(cursor: CatalogModelCursorV2): void {
  validateMillisecondDate(cursor.updatedAt, 'Model cursor timestamp')
  validateUuid(cursor.id, 'Model cursor ID')
}

function validateModelVersionCursor(cursor: CatalogModelVersionCursorV2): void {
  validateMillisecondDate(cursor.createdAt, 'Model Version cursor timestamp')
  validateUuid(cursor.id, 'Model Version cursor ID')
}

function validatePageLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new V2CatalogInputError('Model page limit is invalid')
  }
}

function validateMillisecondDate(value: Date, label: string): void {
  if (
    !(value instanceof Date) ||
    !Number.isFinite(value.getTime()) ||
    value.toISOString() !== new Date(value.getTime()).toISOString()
  ) {
    throw new V2CatalogInputError(`${label} is invalid`)
  }
}

function validateAliasInput(input: CompareAndSetModelAliasV2): void {
  validateUuid(input.namespaceId, 'namespace ID')
  validateUuid(input.modelId, 'Model ID')
  validateUuid(input.newVersionId, 'new Model Version ID')
  if (input.expectedVersionId !== null) validateUuid(input.expectedVersionId, 'expected Version ID')
  if (!['candidate', 'staging', 'production'].includes(input.alias)) {
    throw new V2CatalogInputError('Model alias is invalid')
  }
}

function validateEvidence(input: AppendModelSourceEvidenceV2): void {
  validateUuid(input.id, 'evidence ID')
  validateUuid(input.namespaceId, 'namespace ID')
  validateUuid(input.modelVersionId, 'Model Version ID')
  validateDigest(input.evidenceDigest, 'evidence digest')
  if (input.responseDigest !== null) validateDigest(input.responseDigest, 'response digest')
  validateMillisecondDate(input.observedAt, 'Model source evidence observation time')
  if (
    input.evidenceProfile !== 'model-source-evidence-v1' ||
    !['provider_resolution', 'operator_attestation'].includes(input.evidenceKind) ||
    !['verified', 'not_found', 'unavailable', 'invalid', 'revision_mismatch'].includes(
      input.result,
    ) ||
    !SAFE_TOKEN.test(input.adapter) ||
    !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(input.adapterVersion) ||
    (input.observedRevision !== null &&
      (input.observedRevision.length === 0 ||
        new TextEncoder().encode(input.observedRevision).byteLength > 256)) ||
    !['cached', 'not_cached', 'unknown'].includes(input.cacheStatus) ||
    (input.license !== null &&
      (input.license.length === 0 || new TextEncoder().encode(input.license).byteLength > 256))
  ) {
    throw new V2CatalogInputError('Model source evidence adapter is invalid')
  }
  if (
    (input.result === 'verified' || input.result === 'revision_mismatch') &&
    (input.observedRevision === null || input.responseDigest === null)
  ) {
    throw new V2CatalogInputError('Model source revision evidence is incomplete')
  }
}

function validateModelDeploymentAdoption(input: CreateModelDeploymentAdoptionV2): void {
  validateUuid(input.namespaceId, 'namespace ID')
  validateUuid(input.deploymentId, 'Model Deployment ID')
  validateUuid(input.modelId, 'Model ID')
  validateUuid(input.modelVersionId, 'Model Version ID')
  validateUuid(input.artifactId, 'Model Artifact ID')
  validateDigest(input.deploymentDigest, 'Model Deployment digest')
  validateDigest(input.adoptionDigest, 'Model Deployment adoption digest')
  if (input.adoptionProfile !== 'model-deployment-adoption-v1') {
    throw new V2CatalogInputError('Model Deployment adoption profile is invalid')
  }
}

function validateSafeBigint(value: bigint, label: string): void {
  if (value < 0n || value > MAX_SAFE_BIGINT) {
    throw new V2CatalogInputError(`${label} is invalid`)
  }
}

function validateUuid(value: string, label: string): void {
  if (!UUID.test(value)) throw new V2CatalogInputError(`${label} is invalid`)
}

function validateDigest(value: string, label: string): void {
  if (!HEX_64.test(value)) throw new V2CatalogInputError(`${label} is invalid`)
}
