import { Prisma, type PrismaClient } from '@prisma/client'
import {
  V2CatalogConsistencyError,
  V2CatalogInputError,
  V2CatalogModelAliasConflictError,
  V2CatalogModelMetadataConflictError,
  V2CatalogModelRegistrationConflictError,
} from './errors.js'
import type {
  AppendModelSourceEvidenceV2,
  CatalogJsonValueV2,
  CatalogModelAliasRowV2,
  CatalogModelRegistrationClaimRowV2,
  CatalogModelRegistrationResultV2,
  CatalogModelRowV2,
  CatalogModelSourceEvidenceRowV2,
  CatalogModelVersionRowV2,
  CatalogModelVersionSourceV2,
  CompareAndSetModelAliasV2,
  CreateModelRegistrationV2,
  UpdateCatalogModelMetadataV2,
} from './types.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const HEX_64 = /^[0-9a-f]{64}$/
const MODEL_KEY = /^[a-z][a-z0-9-]{0,127}$/
const SAFE_TOKEN = /^[a-z][a-z0-9._-]{0,127}$/
const MAX_SAFE_BIGINT = 9_007_199_254_740_991n

type TransactionClient = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0]

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
        alias,
        claim: modelRegistrationClaimRow(claim),
        replayed: false,
      }
    },
    { timeout: 30_000 },
  )
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
    orderBy: [{ observedAt: 'asc' }, { id: 'asc' }],
    take: 1_000,
  })
  return Object.freeze(rows.map(modelSourceEvidenceRow))
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
    readonly aliasName: string | null
    readonly createdAt: Date
  },
  replayed: boolean,
): Promise<CatalogModelRegistrationResultV2> {
  const [model, version, alias] = await Promise.all([
    transaction.v2Model.findFirst({
      where: { namespaceId: claim.namespaceId, id: claim.modelId },
    }),
    transaction.v2ModelVersion.findFirst({
      where: { namespaceId: claim.namespaceId, id: claim.modelVersionId },
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
  if (!model || !version || (claim.aliasName !== null && !alias)) {
    throw new V2CatalogConsistencyError('Model registration claim result locator is incomplete')
  }
  const versionResult = modelVersionRow(version)
  return {
    model: modelRow(model),
    version: versionResult,
    source: await readVersionSource(transaction, versionResult),
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
    aliasName: row.aliasName as CatalogModelRegistrationClaimRowV2['aliasName'],
    createdAt: row.createdAt,
  }
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
    createdAt: row.createdAt,
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
    stored.observedAt.getTime() === expected.observedAt.getTime() &&
    stored.result === expected.result &&
    stored.responseDigest === expected.responseDigest
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
  if (
    input.evidenceProfile !== 'model-source-evidence-v1' ||
    !['provider_resolution', 'operator_attestation'].includes(input.evidenceKind) ||
    !['verified', 'not_found', 'unavailable', 'invalid'].includes(input.result) ||
    !SAFE_TOKEN.test(input.adapter) ||
    !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(input.adapterVersion)
  ) {
    throw new V2CatalogInputError('Model source evidence adapter is invalid')
  }
  if (
    input.result === 'verified' &&
    (input.observedRevision === null || input.responseDigest === null)
  ) {
    throw new V2CatalogInputError('Verified Model source evidence is incomplete')
  }
}

function validateUuid(value: string, label: string): void {
  if (!UUID.test(value)) throw new V2CatalogInputError(`${label} is invalid`)
}

function validateDigest(value: string, label: string): void {
  if (!HEX_64.test(value)) throw new V2CatalogInputError(`${label} is invalid`)
}
