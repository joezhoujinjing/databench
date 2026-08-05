import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import {
  type CreateModelRegistrationV2,
  createPrismaClient,
  V2Catalog,
  V2CatalogConsistencyError,
  V2CatalogDeterminismConflictError,
  V2CatalogImmutableConflictError,
  V2CatalogInputError,
  V2CatalogLineageCycleError,
  V2CatalogModelAliasAdmissionError,
  V2CatalogModelAliasConflictError,
  V2CatalogModelDeploymentAdmissionError,
  V2CatalogModelMetadataConflictError,
  V2CatalogRefConflictError,
  V2CatalogRefStateConflictError,
  type V2CatalogSwiftStudioSessionConflictError,
  V2CatalogTargetNotCommittedError,
  V2CatalogTransformJobLeaseError,
} from '../src/index.js'

interface CatalogV2Fixture {
  readonly fixtureVersion: number
  readonly namespaceScope: 'default'
  readonly identityProfile: string
  readonly recordSchemaVersion: string
  readonly layoutVersion: string
  readonly columns: readonly string[]
  readonly claim: {
    readonly entityKind: 'record'
    readonly claimKeyDigest: string
    readonly claimProfile: 'databench-identity-claim-v1'
    readonly requestProfile: 'databench-identity-request-v1'
    readonly creationProfile: 'source-root-v1'
    readonly entityId: string
    readonly requestDigest: string
  }
  readonly versions: Readonly<Record<string, string>>
  readonly revisions: Readonly<
    Record<
      string,
      {
        readonly recordId: string
        readonly recordDigest: string
      }
    >
  >
  readonly run: {
    readonly id: string
    readonly cacheKey: string
    readonly op: string
    readonly opVersion: string
    readonly params: {
      readonly stable: boolean
      readonly threshold: number
    }
    readonly inputVersions: readonly string[]
    readonly outputVersion: string
  }
}

const v2Fixture = JSON.parse(
  readFileSync(
    new URL(
      './golden/fixtures/v2/catalog-concurrency-and-record-lineage.fixture.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as CatalogV2Fixture

let prisma: ReturnType<typeof createPrismaClient>
let v2Catalog: V2Catalog

beforeAll(() => {
  prisma = createPrismaClient()
  v2Catalog = new V2Catalog({ prisma })
})

beforeEach(async () => {
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "model_version_deployment_adoptions_v2",
      "model_source_evidence_v2",
      "model_registration_claims_v2",
      "model_aliases_v2",
      "model_version_artifact_sources_v2",
      "model_version_repository_sources_v2",
      "model_version_service_sources_v2",
      "model_versions_v2",
      "models_v2"
    CASCADE
  `)
  await prisma.v2EvaluationRun.deleteMany()
  await prisma.v2ModelDeployment.deleteMany()
  await prisma.v2ModelArtifact.deleteMany()
  await prisma.v2ModelArtifactImport.deleteMany()
  await prisma.v2SwiftStudioSession.deleteMany()
  await prisma.v2RecordParentEdge.deleteMany()
  await prisma.v2RecordRevisionLocation.deleteMany()
  await prisma.v2TransformJob.deleteMany()
  await prisma.v2RunInput.deleteMany()
  await prisma.v2Run.deleteMany()
  await prisma.v2Ref.deleteMany()
  await prisma.v2DatasetLayout.deleteMany()
  await prisma.v2IdentityClaim.deleteMany()
  await prisma.v2DatasetSnapshot.deleteMany()
  await prisma.v2IdentityNamespace.deleteMany()
})

function transformJobInput(cacheKey: string, inputVersion = fixtureVersion('alpha')) {
  return {
    id: `job_${cacheKey}`,
    cacheKey,
    op: 'basic-clean',
    opVersion: '1',
    params: {},
    inputVersion,
    capabilityName: 'data_juicer.batch',
    capabilityVersion: '1',
    inputCount: 1n,
    resultRefNamespaceId: null,
    resultRefName: null,
  }
}

const MODEL_REGISTRY_MODEL_ID = '10000000-0000-8000-8000-000000000001'
const MODEL_REGISTRY_VERSION_ID = '20000000-0000-8000-8000-000000000001'

function modelRegistrationInput(
  namespaceId: string,
  overrides: {
    readonly registrationDigest?: string
    readonly normalizedRequest?: CreateModelRegistrationV2['normalizedRequest']
    readonly target?: CreateModelRegistrationV2['target']
    readonly version?: Partial<CreateModelRegistrationV2['version']>
    readonly source?: CreateModelRegistrationV2['source']
    readonly initialEvidence?: CreateModelRegistrationV2['initialEvidence']
    readonly deployment?: CreateModelRegistrationV2['deployment']
    readonly alias?: CreateModelRegistrationV2['alias']
  } = {},
): CreateModelRegistrationV2 {
  const source =
    overrides.source ??
    ({
      kind: 'repository_reference',
      provider: 'hugging_face',
      repositoryId: 'Qwen/Qwen2.5-7B',
      revision: 'abc123',
      revisionKind: 'commit',
    } as const)
  const version = {
    id: MODEL_REGISTRY_VERSION_ID,
    namespaceId,
    modelId: MODEL_REGISTRY_MODEL_ID,
    versionLabel: 'r1',
    sourceKind: source.kind,
    createProfile: 'model-version-create-repository-v1' as const,
    createDigest: '2'.repeat(64),
    sourceFingerprint: '3'.repeat(64),
    baseModelReference: null,
    baseModelRevision: null,
    baseModelBindingStatus: null,
    ...overrides.version,
  }
  return {
    namespaceId,
    registrationDigest: overrides.registrationDigest ?? '1'.repeat(64),
    planProfile: 'model-registration-plan-repository-v1',
    normalizedRequest:
      overrides.normalizedRequest ??
      ({ target: 'create', version_label: version.versionLabel, revision: 'abc123' } as const),
    target:
      overrides.target ??
      ({
        kind: 'create_model',
        model: {
          id: MODEL_REGISTRY_MODEL_ID,
          namespaceId,
          key: 'qwen-registry',
          createProfile: 'model-create-v1',
          createDigest: '4'.repeat(64),
          displayName: 'Qwen Registry',
          description: 'Catalog registration fixture',
          taskFamily: 'chat',
          tags: ['fixture'],
        },
      } as const),
    version,
    source,
    ...(overrides.initialEvidence === undefined
      ? {}
      : { initialEvidence: overrides.initialEvidence }),
    deployment: overrides.deployment ?? null,
    alias: overrides.alias ?? null,
  }
}

function artifactModelRegistrationInput(
  namespaceId: string,
  artifact: Awaited<ReturnType<typeof finalizedModelArtifact>>['artifact'],
  input: {
    readonly modelId?: string
    readonly versionId?: string
    readonly modelKey?: string
    readonly versionLabel?: string
    readonly registrationDigest?: string
    readonly modelCreateDigest?: string
    readonly versionCreateDigest?: string
    readonly sourceFingerprint?: string
  } = {},
): CreateModelRegistrationV2 {
  const modelId = input.modelId ?? MODEL_REGISTRY_MODEL_ID
  const versionId = input.versionId ?? MODEL_REGISTRY_VERSION_ID
  const versionLabel = input.versionLabel ?? 'r1'
  return {
    namespaceId,
    registrationDigest: input.registrationDigest ?? '1'.repeat(64),
    planProfile: 'model-registration-plan-artifact-v1',
    normalizedRequest: {
      target: 'create',
      version_label: versionLabel,
      artifact_id: artifact.id,
    },
    target: {
      kind: 'create_model',
      model: {
        id: modelId,
        namespaceId,
        key: input.modelKey ?? 'artifact-registry',
        createProfile: 'model-create-v1',
        createDigest: input.modelCreateDigest ?? '4'.repeat(64),
        displayName: 'Artifact Registry',
        description: 'Artifact-backed Catalog registration fixture',
        taskFamily: 'chat',
        tags: ['artifact', 'fixture'],
      },
    },
    version: {
      id: versionId,
      namespaceId,
      modelId,
      versionLabel,
      sourceKind: 'databench_artifact',
      createProfile: 'model-version-create-artifact-v1',
      createDigest: input.versionCreateDigest ?? '2'.repeat(64),
      sourceFingerprint: input.sourceFingerprint ?? '3'.repeat(64),
      baseModelReference: artifact.baseModelReference,
      baseModelRevision: artifact.baseModelRevision,
      baseModelBindingStatus: artifact.baseModelBindingStatus,
    },
    source: {
      kind: 'databench_artifact',
      artifactId: artifact.id,
      artifactKind: artifact.artifactKind,
      artifactFormat: artifact.artifactFormat,
      archiveDigest: artifact.archiveDigest,
      manifestDigest: artifact.manifestDigest,
    },
    deployment: null,
    alias: { alias: 'candidate', expectedVersionId: null },
  }
}

function evaluationRunInput(namespaceId: string, providerTaskId: string) {
  return {
    namespaceId,
    provider: 'evalscope' as const,
    providerTaskId,
    createProfile: 'evaluation-run-create-v1' as const,
    createRequestDigest: '8'.repeat(64),
    datasetVersion: fixtureVersion('alpha'),
    sourceRef: 'main',
    converter: 'evalscope-general-qa',
    converterVersion: '1.0.0',
    converterOptions: { target_source: 'none' },
    fidelityDigest: '9'.repeat(64),
    benchmark: 'general_qa',
    modelName: 'Qwen/Qwen3-8B',
    modelDeploymentId: null,
    modelArtifactId: null,
    modelDeploymentDigest: null,
    modelId: null,
    modelVersionId: null,
    sourceMutabilitySnapshot: null,
    verificationLevelSnapshot: null,
    sourceEvidenceDigest: null,
    evalscopeCommit: 'a'.repeat(40),
    scoringConfig: null,
    primaryMetricId: null,
    primaryOutputKey: null,
  }
}

function versionDeploymentEvaluationRunInput(
  namespaceId: string,
  binding: {
    readonly modelId: string
    readonly modelVersionId: string
    readonly deploymentId: string
    readonly deploymentDigest: string
    readonly artifactId: string | null
    readonly servedModelName: string
    readonly sourceMutability: 'immutable' | 'mutable' | 'unknown'
    readonly verificationLevel:
      | 'content_verified'
      | 'provider_verified'
      | 'operator_attested'
      | 'unverified'
    readonly evidenceDigest: string | null
  },
  providerTaskId: string,
) {
  return {
    ...evaluationRunInput(namespaceId, providerTaskId),
    createProfile: 'evaluation-run-create-v5' as const,
    createRequestDigest: '6'.repeat(64),
    modelName: binding.servedModelName,
    modelDeploymentId: binding.deploymentId,
    modelArtifactId: binding.artifactId,
    modelDeploymentDigest: binding.deploymentDigest,
    modelId: binding.modelId,
    modelVersionId: binding.modelVersionId,
    sourceMutabilitySnapshot: binding.sourceMutability,
    verificationLevelSnapshot: binding.verificationLevel,
    sourceEvidenceDigest: binding.evidenceDigest,
  }
}

function swiftStudioSessionInput(
  namespaceId: string,
  createDigest = 'a'.repeat(64),
  providerSessionId = 'session-fixed-1',
) {
  return {
    namespaceId,
    createDigest,
    datasetVersion: fixtureVersion('alpha'),
    displayRef: 'main',
    converter: 'ms-swift' as const,
    converterVersion: '1.0.0' as const,
    normalizedOptions: {},
    fidelityDigest: 'b'.repeat(64),
    exportOutputCount: 32n,
    provider: 'swift-studio' as const,
    providerSessionId,
    upstreamCommit: 'c'.repeat(40),
    imageDigest: 'd'.repeat(64),
    runtimeCapabilityDigest: 'e'.repeat(64),
  }
}

function modelArtifactManifest(studioSessionId: string) {
  return {
    manifest_version: 'model-artifact-manifest-v1' as const,
    artifact_kind: 'lora_adapter' as const,
    artifact_format: 'swift-lora-adapter-v1' as const,
    archive_format: 'deterministic-tar-zst-v1' as const,
    archive_digest: '4'.repeat(64),
    archive_size_bytes: 1_024,
    output_snapshot_digest: '3'.repeat(64),
    files: [
      { path: 'adapter_config.json', digest: '1'.repeat(64), size_bytes: 128 },
      { path: 'adapter_model.safetensors', digest: '2'.repeat(64), size_bytes: 896 },
    ],
    source: {
      studio_session_id: studioSessionId,
      upstream_commit: 'c'.repeat(40),
      image_digest: 'd'.repeat(64),
    },
    dataset_lineage: {
      status: 'verified' as const,
      dataset_version: fixtureVersion('alpha'),
      dataset_export_digest: 'f'.repeat(64),
    },
    base_model: {
      reference: 'Qwen/Qwen3-0.6B',
      revision: '0123456789abcdef',
      binding_status: 'verified' as const,
    },
    training_summary: {
      train_stage: 'sft',
      tuner_type: 'lora' as const,
      lora_rank: 8,
      lora_alpha: 16,
      lora_dropout: 0.05,
      num_train_epochs: null,
      max_steps: 5,
      learning_rate: 0.0001,
      max_length: 128,
      dtype: 'bfloat16',
      seed: 42,
      redacted_fields_count: 3,
    },
    created_at: '2026-07-29T00:00:00.000Z',
    created_by: 'databench' as const,
  }
}

async function finalizedModelArtifact() {
  const namespaceId = await v2Catalog.getOrCreateNamespace(v2Fixture.namespaceScope)
  await v2Catalog.registerCommittedLayout(
    registration('alpha', [withParents(fixtureRevision('inputAlpha'))]),
  )
  const { row: preparing } = await v2Catalog.createOrReadSwiftStudioSession(
    swiftStudioSessionInput(namespaceId),
  )
  const session = await v2Catalog.transitionSwiftStudioSession({
    namespaceId,
    id: preparing.id,
    preparationOwnerToken: preparing.preparationOwnerToken,
    status: 'ready',
    exportDigest: 'f'.repeat(64),
    exportSizeBytes: 4_096n,
  })
  if (session === null) throw new Error('Studio Session did not become ready')
  const { row: artifactImport } = await v2Catalog.createOrReadModelArtifactImport({
    namespaceId,
    createDigest: '0'.repeat(64),
    studioSessionId: session.id,
    outputHandleDigest: '1'.repeat(64),
    artifactKind: 'lora_adapter',
    displayName: 'deployable-lora',
    baseModelReference: 'Qwen/Qwen3-0.6B',
    baseModelRevision: '0123456789abcdef',
  })
  await v2Catalog.transitionModelArtifactImport({
    namespaceId,
    id: artifactImport.id,
    status: 'staging',
    providerImportId: `swai_${'D'.repeat(32)}`,
    outputSnapshotDigest: '3'.repeat(64),
  })
  await v2Catalog.transitionModelArtifactImport({
    namespaceId,
    id: artifactImport.id,
    status: 'finalizing',
    stagingObjectKey: `staging/swift-artifact/v1/${artifactImport.id}/archive.tar.zst`,
    archiveDigest: '4'.repeat(64),
    archiveSizeBytes: 1_024n,
    manifestDigest: '5'.repeat(64),
    manifest: modelArtifactManifest(session.id),
    datasetLineageStatus: 'verified',
    datasetVersion: fixtureVersion('alpha'),
    datasetExportDigest: 'f'.repeat(64),
    baseModelBindingStatus: 'verified',
  })
  const completed = await v2Catalog.finalizeModelArtifactImport({
    namespaceId,
    id: artifactImport.id,
    objectLocator: `objects/v2/model-artifact-v1/44/${'4'.repeat(64)}.tar.zst`,
  })
  if (completed === null) throw new Error('Model Artifact did not finalize')
  return { namespaceId, artifact: completed.artifact }
}

function modelDeploymentInput(namespaceId: string, artifactId: string, digest = '6'.repeat(64)) {
  return {
    namespaceId,
    createDigest: digest,
    artifactId,
    provider: 'openai_compatible' as const,
    displayName: 'deployable-lora',
    servedModelName: 'deployable-lora-v1',
    endpointBaseUrl: 'http://model.internal:8000/v1',
    authMode: 'none' as const,
  }
}

function deploymentEvaluationRunInput(
  namespaceId: string,
  deployment: {
    readonly id: string
    readonly artifactId: string
    readonly createDigest: string
    readonly servedModelName: string
  },
  providerTaskId: string,
) {
  return {
    ...evaluationRunInput(namespaceId, providerTaskId),
    createProfile: 'evaluation-run-create-v2' as const,
    createRequestDigest: '7'.repeat(64),
    modelName: deployment.servedModelName,
    modelDeploymentId: deployment.id,
    modelArtifactId: deployment.artifactId,
    modelDeploymentDigest: deployment.createDigest,
  }
}

async function claimFinalizingJob(
  cacheKey: string,
  resultRef: { readonly namespaceId: string; readonly name: string } | null = null,
) {
  await v2Catalog.createOrReadTransformJob({
    ...transformJobInput(cacheKey),
    resultRefNamespaceId: resultRef?.namespaceId ?? null,
    resultRefName: resultRef?.name ?? null,
  })
  const claimed = await v2Catalog.claimNextTransformJob({
    leaseOwner: 'dispatcher.test',
    leaseDurationMs: 30_000,
  })
  if (!claimed?.leaseToken) throw new Error('claim did not return a lease token')
  const lease = { id: claimed.id, attempt: claimed.attempt, leaseToken: claimed.leaseToken }
  const prefix = `staging/worker/v1/${lease.id}/${lease.attempt}`
  await expect(
    v2Catalog.setTransformJobStagingKeys({
      ...lease,
      inputKey: `${prefix}/input.jsonl`,
      outputKey: `${prefix}/output.jsonl`,
    }),
  ).resolves.toBe(true)
  await expect(v2Catalog.markTransformJobRunning(lease)).resolves.toMatchObject({
    status: 'running',
  })
  await expect(v2Catalog.markTransformJobFinalizing(lease)).resolves.toMatchObject({
    status: 'finalizing',
  })
  return lease
}

type FixtureRevision = CatalogV2Fixture['revisions'][string]

interface RegistrationRevision extends FixtureRevision {
  readonly parents: readonly FixtureRevision[]
}

function fixtureVersion(name: string): string {
  const version = v2Fixture.versions[name]
  if (version === undefined) {
    throw new Error(`missing fixture version: ${name}`)
  }
  return version
}

function fixtureRevision(name: string): FixtureRevision {
  const revision = v2Fixture.revisions[name]
  if (revision === undefined) {
    throw new Error(`missing fixture revision: ${name}`)
  }
  return revision
}

function registration(
  versionName: string,
  revisions: readonly RegistrationRevision[],
  overrides: {
    readonly identityProfile?: string
    readonly artifactDigest?: string
  } = {},
) {
  const version = fixtureVersion(versionName)
  return {
    snapshot: {
      version,
      identityProfile: overrides.identityProfile ?? v2Fixture.identityProfile,
      recordSchemaVersion: v2Fixture.recordSchemaVersion,
      numRecords: BigInt(revisions.length),
    },
    layout: {
      datasetVersion: version,
      layoutVersion: v2Fixture.layoutVersion,
      artifactDigest: overrides.artifactDigest ?? version,
      artifactSizeBytes: BigInt(4096 + revisions.length),
      manifestKey: `objects/v2/record-json-v1/${version.slice(0, 2)}/${version}/manifest.json`,
      columns: [...v2Fixture.columns],
    },
    revisions,
  }
}

function withParents(
  revision: FixtureRevision,
  parents: readonly FixtureRevision[] = [],
): RegistrationRevision {
  return { ...revision, parents }
}

afterAll(async () => {
  await prisma.$disconnect()
})

function deferred<T>() {
  let resolvePromise: ((value: T | PromiseLike<T>) => void) | undefined
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve
  })
  if (!resolvePromise) throw new Error('failed to create deferred promise')
  return { promise, resolve: resolvePromise }
}

async function waitForAdvisoryWaiters(expected: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const rows = await prisma.$queryRaw<Array<{ readonly count: bigint }>>`
      SELECT COUNT(*)::bigint AS "count"
      FROM pg_locks
      WHERE
        "locktype" = 'advisory' AND
        NOT "granted" AND
        "classid" = hashtext('databench-v2-lineage-registration')::oid AND
        "objid" = hashtext(current_schema())::oid AND
        "database" = (
          SELECT "oid"
          FROM pg_database
          WHERE "datname" = current_database()
        )
    `
    if ((rows[0]?.count ?? 0n) >= BigInt(expected)) return
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
  throw new Error(`expected at least ${expected} waiting advisory locks`)
}

describe('V2Catalog', () => {
  test('keeps Prisma model and raw SQL schemas aligned with explicit connection options', async () => {
    const configuredUrl = process.env.DATABASE_URL
    if (!configuredUrl) throw new Error('catalog tests require DATABASE_URL')

    const selectedSchema = new URL(configuredUrl).searchParams.get('schema')
    expect(selectedSchema).toBe('databench_test_catalog')

    const hostileUrl = new URL(configuredUrl)
    hostileUrl.searchParams.set('options', '-c search_path=public')
    const isolatedClient = createPrismaClient({ databaseUrl: hostileUrl.toString() })
    try {
      const rows = await isolatedClient.$queryRaw<Array<{ schema: string }>>`
        SELECT current_schema() AS "schema"
      `
      expect(rows).toEqual([{ schema: selectedSchema }])
    } finally {
      await isolatedClient.$disconnect()
    }

    const publicUrl = new URL(configuredUrl)
    publicUrl.searchParams.set('schema', 'public')
    publicUrl.searchParams.set('options', '-c search_path=databench_test_catalog')
    const publicClient = createPrismaClient({ databaseUrl: publicUrl.toString() })
    try {
      const rows = await publicClient.$queryRaw<Array<{ schema: string }>>`
        SELECT current_schema() AS "schema"
      `
      expect(rows).toEqual([{ schema: 'public' }])
    } finally {
      await publicClient.$disconnect()
    }

    const uppercaseUrl = new URL(configuredUrl)
    uppercaseUrl.searchParams.set('schema', 'Databench_Test_Catalog')
    expect(() => createPrismaClient({ databaseUrl: uppercaseUrl.toString() })).toThrow(
      'DATABASE_URL schema must be a lowercase PostgreSQL identifier',
    )
  })

  test('loads the committed V7 fixture', () => {
    expect(v2Fixture).toMatchObject({
      fixtureVersion: 1,
      namespaceScope: 'default',
      identityProfile: 'databench-v2-jcs-1',
      recordSchemaVersion: '2.0.0',
      layoutVersion: 'record-json-v1',
      columns: ['record_id', 'record_digest', 'record_json'],
    })
  })

  test('namespace and claim creation remain stable under concurrency', async () => {
    const namespaceIds = await Promise.all(
      Array.from({ length: 16 }, () => v2Catalog.getOrCreateNamespace(v2Fixture.namespaceScope)),
    )
    expect(new Set(namespaceIds).size).toBe(1)

    const namespaceId = namespaceIds[0]
    expect(namespaceId).toEqual(expect.any(String))
    if (namespaceId === undefined) {
      throw new Error('namespace concurrency returned no namespace')
    }

    const claimInput = { namespaceId, ...v2Fixture.claim }
    const results = await Promise.all(
      Array.from({ length: 16 }, () => v2Catalog.insertOrReadIdentityClaim(claimInput)),
    )

    expect(results.filter(({ status }) => status === 'created')).toHaveLength(1)
    expect(results.filter(({ status }) => status === 'existing_claim')).toHaveLength(15)
    for (const result of results) {
      expect(result.row).toMatchObject(claimInput)
      expect(result.row.createdAt).toBeInstanceOf(Date)
    }

    const existingEntity = await v2Catalog.insertOrReadIdentityClaim({
      ...claimInput,
      claimKeyDigest: 'b'.repeat(64),
      requestDigest: 'c'.repeat(64),
    })
    expect(existingEntity.status).toBe('existing_entity')
    expect(existingEntity.row).toMatchObject(claimInput)

    const existingClaim = await v2Catalog.insertOrReadIdentityClaim({
      ...claimInput,
      entityId: `rec_${'c'.repeat(64)}`,
      requestDigest: 'd'.repeat(64),
    })
    expect(existingClaim.status).toBe('existing_claim')
    expect(existingClaim.row).toMatchObject(claimInput)

    const concurrentEntityId = `rec_${'d'.repeat(64)}`
    const entityRace = await Promise.all(
      ['e', 'f'].map((digit) =>
        v2Catalog.insertOrReadIdentityClaim({
          ...claimInput,
          entityId: concurrentEntityId,
          claimKeyDigest: digit.repeat(64),
          requestDigest: digit.repeat(64),
        }),
      ),
    )
    expect(entityRace.filter(({ status }) => status === 'created')).toHaveLength(1)
    expect(entityRace.filter(({ status }) => status === 'existing_entity')).toHaveLength(1)

    const bothUniqueConstraints = await v2Catalog.insertOrReadIdentityClaim({
      ...claimInput,
      entityId: concurrentEntityId,
      requestDigest: '0'.repeat(64),
    })
    expect(bothUniqueConstraints.status).toBe('existing_claim')
    expect(bothUniqueConstraints.row).toMatchObject(claimInput)
    expect(await prisma.v2IdentityClaim.count()).toBe(2)
  })

  test('registers immutable snapshot/layout metadata and detects conflicting retries', async () => {
    const revision = withParents(fixtureRevision('shared'))
    const input = registration('alpha', [revision])

    await v2Catalog.registerCommittedLayout(input)
    await v2Catalog.registerCommittedLayout(input)

    expect(await v2Catalog.getSnapshot(input.snapshot.version)).toMatchObject(input.snapshot)
    expect(
      await v2Catalog.getLayout(input.snapshot.version, input.layout.layoutVersion),
    ).toMatchObject(input.layout)

    await expect(
      v2Catalog.registerCommittedLayout(
        registration('alpha', [revision], { identityProfile: 'different-profile' }),
      ),
    ).rejects.toBeInstanceOf(V2CatalogImmutableConflictError)

    await expect(
      v2Catalog.registerCommittedLayout(
        registration('alpha', [revision], { artifactDigest: '9'.repeat(64) }),
      ),
    ).rejects.toBeInstanceOf(V2CatalogImmutableConflictError)

    expect(await v2Catalog.getSnapshot(input.snapshot.version)).toMatchObject(input.snapshot)
    expect(
      await v2Catalog.getLayout(input.snapshot.version, input.layout.layoutVersion),
    ).toMatchObject(input.layout)
  })

  test('allows one revision to appear concurrently in two snapshots', async () => {
    const shared = withParents(fixtureRevision('shared'))
    const alpha = registration('alpha', [shared])
    const beta = registration('beta', [shared])

    await Promise.all([
      v2Catalog.registerCommittedLayout(alpha),
      v2Catalog.registerCommittedLayout(beta),
    ])

    const representative = await v2Catalog.locateRecordRevision(
      shared.recordId,
      shared.recordDigest,
    )
    expect([alpha.snapshot.version, beta.snapshot.version]).toContain(representative)
    expect(await v2Catalog.getSnapshot(alpha.snapshot.version)).not.toBeNull()
    expect(await v2Catalog.getSnapshot(beta.snapshot.version)).not.toBeNull()
    expect(await prisma.v2RecordRevisionLocation.count()).toBe(1)
  })

  test('registers a large parentless snapshot with batched catalog operations', async () => {
    const revisions = Array.from({ length: 5_000 }, (_, index) =>
      withParents({
        recordId: `rec_${index.toString(16).padStart(64, '0')}`,
        recordDigest: (index + 10_000).toString(16).padStart(64, '0'),
      }),
    )
    const input = registration('alpha', revisions)

    await v2Catalog.registerCommittedLayout(input)

    expect(await prisma.v2RecordRevisionLocation.count()).toBe(revisions.length)
    expect(await prisma.v2RecordParentEdge.count()).toBe(0)
    expect(await v2Catalog.getSnapshot(input.snapshot.version)).toMatchObject({
      numRecords: BigInt(revisions.length),
    })
  })

  test('preserves unresolved exact parents and resolves them when the parent arrives later', async () => {
    const child = fixtureRevision('unresolvedChild')
    const parent = fixtureRevision('unresolvedParent')

    await v2Catalog.registerCommittedLayout(registration('alpha', [withParents(child, [parent])]))

    expect(await v2Catalog.locateRecordRevision(parent.recordId, parent.recordDigest)).toBeNull()
    expect(await v2Catalog.getRecordParents(child.recordId, child.recordDigest)).toEqual([
      {
        position: 0,
        parentRecordId: parent.recordId,
        parentRecordDigest: parent.recordDigest,
      },
    ])

    await v2Catalog.registerCommittedLayout(registration('beta', [withParents(parent)]))
    expect(await v2Catalog.locateRecordRevision(parent.recordId, parent.recordDigest)).toBe(
      fixtureVersion('beta'),
    )
    expect(await v2Catalog.getRecordParents(child.recordId, child.recordDigest)).toEqual([
      {
        position: 0,
        parentRecordId: parent.recordId,
        parentRecordDigest: parent.recordDigest,
      },
    ])
  })

  test('rejects a cross-snapshot lineage cycle and rolls back the entire registration', async () => {
    const cycleA = fixtureRevision('cycleA')
    const cycleB = fixtureRevision('cycleB')

    await v2Catalog.registerCommittedLayout(registration('alpha', [withParents(cycleA, [cycleB])]))
    await expect(
      v2Catalog.registerCommittedLayout(registration('beta', [withParents(cycleB, [cycleA])])),
    ).rejects.toBeInstanceOf(V2CatalogLineageCycleError)

    expect(await v2Catalog.getSnapshot(fixtureVersion('beta'))).toBeNull()
    expect(await v2Catalog.locateRecordRevision(cycleB.recordId, cycleB.recordDigest)).toBeNull()
    expect(await v2Catalog.getRecordParents(cycleA.recordId, cycleA.recordDigest)).toHaveLength(1)
  })

  test('treats the complete ordered parent set as immutable metadata', async () => {
    const child = fixtureRevision('outputDelta')
    const firstParent = fixtureRevision('inputAlpha')
    const secondParent = fixtureRevision('inputBeta')
    await v2Catalog.registerCommittedLayout(
      registration('delta', [withParents(child, [firstParent, secondParent])]),
    )

    await expect(
      v2Catalog.registerCommittedLayout(
        registration('delta', [withParents(child, [secondParent, firstParent])]),
      ),
    ).rejects.toMatchObject({ kind: 'record_parents' })
    expect(await v2Catalog.getRecordParents(child.recordId, child.recordDigest)).toEqual([
      {
        position: 0,
        parentRecordId: firstParent.recordId,
        parentRecordDigest: firstParent.recordDigest,
      },
      {
        position: 1,
        parentRecordId: secondParent.recordId,
        parentRecordDigest: secondParent.recordDigest,
      },
    ])

    const prefixChild = fixtureRevision('shared')
    const appendedParent = fixtureRevision('unresolvedParent')
    await v2Catalog.registerCommittedLayout(registration('alpha', [withParents(prefixChild)]))
    await expect(
      v2Catalog.registerCommittedLayout(
        registration('beta', [withParents(prefixChild, [appendedParent])]),
      ),
    ).rejects.toMatchObject({ kind: 'record_parents' })
    expect(await v2Catalog.getSnapshot(fixtureVersion('beta'))).toBeNull()
    expect(
      await v2Catalog.getRecordParents(prefixChild.recordId, prefixChild.recordDigest),
    ).toEqual([])
  })

  test('serializes concurrent inverse lineage edges so only one side can commit', async () => {
    const left = fixtureRevision('concurrentLeft')
    const right = fixtureRevision('concurrentRight')
    const results = await Promise.allSettled([
      v2Catalog.registerCommittedLayout(registration('alpha', [withParents(left, [right])])),
      v2Catalog.registerCommittedLayout(registration('beta', [withParents(right, [left])])),
    ])

    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find(({ status }) => status === 'rejected')
    expect(rejected).toMatchObject({ status: 'rejected' })
    if (rejected?.status === 'rejected') {
      expect(rejected.reason).toBeInstanceOf(V2CatalogLineageCycleError)
    }

    expect(await prisma.v2RecordParentEdge.count()).toBe(1)
    expect(await prisma.v2RecordRevisionLocation.count()).toBe(1)
  })

  test('registers immutable runs atomically and never overwrites a cache conflict', async () => {
    await v2Catalog.registerCommittedLayout(
      registration('alpha', [withParents(fixtureRevision('inputAlpha'))]),
    )
    await v2Catalog.registerCommittedLayout(
      registration('beta', [withParents(fixtureRevision('inputBeta'))]),
    )

    const output = registration('gamma', [withParents(fixtureRevision('output'))])
    await v2Catalog.registerTransformResult({ ...output, run: v2Fixture.run })
    await v2Catalog.registerTransformResult({ ...output, run: v2Fixture.run })

    expect(await v2Catalog.findRun(v2Fixture.run.cacheKey)).toMatchObject(v2Fixture.run)
    const snapshotSequence = await v2Catalog.lineageSnapshotSequence()
    expect(
      (
        await v2Catalog.listRunsProducing(
          v2Fixture.run.outputVersion,
          null,
          1_000,
          snapshotSequence,
        )
      ).rows,
    ).toHaveLength(1)

    await expect(
      v2Catalog.registerTransformResult({
        ...output,
        run: { ...v2Fixture.run, params: { changed: true } },
      }),
    ).rejects.toBeInstanceOf(V2CatalogDeterminismConflictError)
    await expect(
      v2Catalog.registerTransformResult({
        ...output,
        run: { ...v2Fixture.run, inputVersions: [...v2Fixture.run.inputVersions].reverse() },
      }),
    ).rejects.toBeInstanceOf(V2CatalogDeterminismConflictError)
    expect(await v2Catalog.findRun(v2Fixture.run.cacheKey)).toMatchObject(v2Fixture.run)

    const prefixCacheKey = '0'.repeat(64)
    const prefixRun = {
      ...v2Fixture.run,
      id: `run_${prefixCacheKey}`,
      cacheKey: prefixCacheKey,
      inputVersions: [v2Fixture.run.inputVersions[0] as string],
    }
    await v2Catalog.registerTransformResult({ ...output, run: prefixRun })
    await expect(
      v2Catalog.registerTransformResult({
        ...output,
        run: { ...prefixRun, inputVersions: [...v2Fixture.run.inputVersions] },
      }),
    ).rejects.toBeInstanceOf(V2CatalogDeterminismConflictError)
    expect(await v2Catalog.findRun(prefixCacheKey)).toMatchObject(prefixRun)

    const negativeZeroCacheKey = '1'.repeat(64)
    const negativeZeroRun = {
      ...v2Fixture.run,
      id: `run_${negativeZeroCacheKey}`,
      cacheKey: negativeZeroCacheKey,
      params: { nested: { values: [-0] }, zero: -0 },
    }
    await v2Catalog.registerTransformResult({ ...output, run: negativeZeroRun })
    await v2Catalog.registerTransformResult({
      ...output,
      run: { ...negativeZeroRun, params: { nested: { values: [0] }, zero: 0 } },
    })
    expect(await v2Catalog.findRun(negativeZeroCacheKey)).toMatchObject({
      ...negativeZeroRun,
      params: { nested: { values: [0] }, zero: 0 },
    })

    const conflictingOutput = registration('delta', [withParents(fixtureRevision('outputDelta'))])
    await expect(
      v2Catalog.registerTransformResult({
        ...conflictingOutput,
        run: { ...v2Fixture.run, outputVersion: conflictingOutput.snapshot.version },
      }),
    ).rejects.toBeInstanceOf(V2CatalogDeterminismConflictError)
    expect(await v2Catalog.getSnapshot(conflictingOutput.snapshot.version)).toBeNull()
  })

  test('treats concurrent identical transform misses as one immutable run', async () => {
    await v2Catalog.registerCommittedLayout(
      registration('alpha', [withParents(fixtureRevision('inputAlpha'))]),
    )
    await v2Catalog.registerCommittedLayout(
      registration('beta', [withParents(fixtureRevision('inputBeta'))]),
    )
    const output = registration('gamma', [withParents(fixtureRevision('output'))])
    const registrationInput = { ...output, run: v2Fixture.run }

    const results = await Promise.allSettled([
      v2Catalog.registerTransformResult(registrationInput),
      v2Catalog.registerTransformResult(registrationInput),
    ])

    expect(results).toEqual([
      expect.objectContaining({ status: 'fulfilled' }),
      expect.objectContaining({ status: 'fulfilled' }),
    ])
    expect(await prisma.v2Run.count()).toBe(1)
    expect(await prisma.v2RunInput.count()).toBe(v2Fixture.run.inputVersions.length)
    expect(await v2Catalog.findRun(v2Fixture.run.cacheKey)).toMatchObject(v2Fixture.run)
  })

  test('allows only one output to win a concurrent transform determinism race', async () => {
    await v2Catalog.registerCommittedLayout(
      registration('alpha', [withParents(fixtureRevision('inputAlpha'))]),
    )
    await v2Catalog.registerCommittedLayout(
      registration('beta', [withParents(fixtureRevision('inputBeta'))]),
    )
    const firstOutput = registration('gamma', [withParents(fixtureRevision('output'))])
    const secondOutput = registration('delta', [withParents(fixtureRevision('outputDelta'))])
    const results = await Promise.allSettled([
      v2Catalog.registerTransformResult({ ...firstOutput, run: v2Fixture.run }),
      v2Catalog.registerTransformResult({
        ...secondOutput,
        run: { ...v2Fixture.run, outputVersion: secondOutput.snapshot.version },
      }),
    ])

    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
    const failure = results.find(({ status }) => status === 'rejected')
    expect(failure).toMatchObject({ status: 'rejected' })
    if (failure?.status === 'rejected') {
      expect(failure.reason).toBeInstanceOf(V2CatalogDeterminismConflictError)
    }

    const winningRun = await v2Catalog.findRun(v2Fixture.run.cacheKey)
    if (!winningRun) throw new Error('the transform race committed no run')
    const winningVersion = winningRun.outputVersion
    const losingVersion =
      winningVersion === firstOutput.snapshot.version
        ? secondOutput.snapshot.version
        : firstOutput.snapshot.version
    expect(await v2Catalog.getSnapshot(winningVersion)).not.toBeNull()
    expect(await v2Catalog.getLayout(winningVersion, v2Fixture.layoutVersion)).not.toBeNull()
    expect(await v2Catalog.getSnapshot(losingVersion)).toBeNull()
    expect(await v2Catalog.getLayout(losingVersion, v2Fixture.layoutVersion)).toBeNull()
    const snapshotSequence = await v2Catalog.lineageSnapshotSequence()
    expect(
      (await v2Catalog.listRunsProducing(losingVersion, null, 1_000, snapshotSequence)).rows,
    ).toEqual([])
  })

  test('rolls back output metadata when an exact transform input is not registered', async () => {
    const output = registration('gamma', [withParents(fixtureRevision('output'))])
    const unknownInput = 'f'.repeat(64)

    await expect(
      v2Catalog.registerTransformResult({
        ...output,
        run: { ...v2Fixture.run, inputVersions: [unknownInput] },
      }),
    ).rejects.toThrow()

    expect(await v2Catalog.findRun(v2Fixture.run.cacheKey)).toBeNull()
    expect(await v2Catalog.getSnapshot(output.snapshot.version)).toBeNull()
    expect(
      await v2Catalog.getLayout(output.snapshot.version, output.layout.layoutVersion),
    ).toBeNull()
    const outputRevision = output.revisions[0]
    if (!outputRevision) throw new Error('the transform output fixture has no revision')
    expect(
      await v2Catalog.locateRecordRevision(outputRevision.recordId, outputRevision.recordDigest),
    ).toBeNull()
  })

  test('paginates producing runs by bounded C-order cache-key seek', async () => {
    await v2Catalog.registerCommittedLayout(
      registration('alpha', [withParents(fixtureRevision('inputAlpha'))]),
    )
    const output = registration('gamma', [withParents(fixtureRevision('output'))])
    const snapshotCacheKeys = ['a'.repeat(64), '0'.repeat(64)]
    for (const cacheKey of snapshotCacheKeys) {
      await v2Catalog.registerTransformResult({
        ...output,
        run: {
          ...v2Fixture.run,
          id: `run_${cacheKey}`,
          cacheKey,
          inputVersions: [fixtureVersion('alpha')],
        },
      })
    }
    const snapshotSequence = await v2Catalog.lineageSnapshotSequence()
    expect(typeof snapshotSequence).toBe('bigint')
    expect(snapshotSequence).toBeGreaterThan(0n)

    const laterCacheKey = '5'.repeat(64)
    await v2Catalog.registerTransformResult({
      ...output,
      run: {
        ...v2Fixture.run,
        id: `run_${laterCacheKey}`,
        cacheKey: laterCacheKey,
        inputVersions: [fixtureVersion('alpha')],
      },
    })
    const first = await v2Catalog.listRunsProducing(
      output.snapshot.version,
      null,
      1,
      snapshotSequence,
    )
    expect(first.rows.map(({ cacheKey }) => cacheKey)).toEqual(['0'.repeat(64)])
    expect(first.nextCacheKey).toBe('0'.repeat(64))
    expect(
      first.rows.every(({ inputVersions }) => inputVersions[0] === fixtureVersion('alpha')),
    ).toBe(true)

    const second = await v2Catalog.listRunsProducing(
      output.snapshot.version,
      first.nextCacheKey,
      1,
      snapshotSequence,
    )
    expect(second.rows.map(({ cacheKey }) => cacheKey)).toEqual(['a'.repeat(64)])
    expect(second.nextCacheKey).toBeNull()
    expect([...first.rows, ...second.rows].map(({ cacheKey }) => cacheKey)).not.toContain(
      laterCacheKey,
    )

    await expect(
      v2Catalog.listRunsProducing(output.snapshot.version, null, 1_001, snapshotSequence),
    ).rejects.toBeInstanceOf(V2CatalogInputError)
    await expect(
      v2Catalog.listRunsProducing(output.snapshot.version.toUpperCase(), null, 1, snapshotSequence),
    ).rejects.toBeInstanceOf(V2CatalogInputError)
    await expect(
      v2Catalog.listRunsProducing(output.snapshot.version, 'not-a-cache-key', 1, snapshotSequence),
    ).rejects.toBeInstanceOf(V2CatalogInputError)
    await expect(
      v2Catalog.listRunsProducing(output.snapshot.version, null, 1, -1n),
    ).rejects.toBeInstanceOf(V2CatalogInputError)
  })

  test('serializes the lineage watermark after an earlier in-flight run registration', async () => {
    await v2Catalog.registerCommittedLayout(
      registration('alpha', [withParents(fixtureRevision('inputAlpha'))]),
    )
    const output = registration('gamma', [withParents(fixtureRevision('output'))])
    const isolated = createPrismaClient()
    const lockAcquired = deferred<void>()
    const releaseLock = deferred<void>()
    let blocker: Promise<unknown> | undefined
    try {
      blocker = isolated.$transaction(
        async (tx) => {
          await tx.$queryRaw`
            SELECT 1 AS "locked"
            FROM pg_advisory_xact_lock(
              hashtext('databench-v2-lineage-registration'),
              hashtext(current_schema())
            )
          `
          lockAcquired.resolve()
          await releaseLock.promise
        },
        { timeout: 30_000 },
      )
      await lockAcquired.promise

      const registrationPromise = v2Catalog.registerTransformResult({
        ...output,
        run: { ...v2Fixture.run, inputVersions: [fixtureVersion('alpha')] },
      })
      await waitForAdvisoryWaiters(1)
      let snapshotSettled = false
      const snapshotPromise = v2Catalog.lineageSnapshotSequence().finally(() => {
        snapshotSettled = true
      })
      await waitForAdvisoryWaiters(2)
      expect(snapshotSettled).toBe(false)

      releaseLock.resolve()
      await blocker
      await registrationPromise
      const snapshotSequence = await snapshotPromise
      const page = await v2Catalog.listRunsProducing(
        output.snapshot.version,
        null,
        10,
        snapshotSequence,
      )
      expect(page.rows.map(({ cacheKey }) => cacheKey)).toEqual([v2Fixture.run.cacheKey])
    } finally {
      releaseLock.resolve()
      await blocker?.catch(() => undefined)
      await isolated.$disconnect()
    }
  })

  test('fails closed when stored exact run inputs are not zero-based and contiguous', async () => {
    await v2Catalog.registerCommittedLayout(
      registration('alpha', [withParents(fixtureRevision('inputAlpha'))]),
    )
    await v2Catalog.registerCommittedLayout(
      registration('gamma', [withParents(fixtureRevision('output'))]),
    )
    const cacheKey = 'e'.repeat(64)
    await prisma.v2Run.create({
      data: {
        id: `run_${cacheKey}`,
        cacheKey,
        op: 'malformed-input-positions',
        opVersion: '1',
        params: {},
        outputVersion: fixtureVersion('gamma'),
      },
    })
    await prisma.v2RunInput.create({
      data: {
        cacheKey,
        position: 1,
        datasetVersion: fixtureVersion('alpha'),
      },
    })

    await expect(v2Catalog.findRun(cacheKey)).rejects.toBeInstanceOf(V2CatalogConsistencyError)
    const snapshotSequence = await v2Catalog.lineageSnapshotSequence()
    await expect(
      v2Catalog.listRunsProducing(fixtureVersion('gamma'), null, 10, snapshotSequence),
    ).rejects.toBeInstanceOf(V2CatalogConsistencyError)
  })

  test('uses compare-and-set refs without lost updates and paginates by seek name', async () => {
    for (const [versionName, revisionName] of [
      ['alpha', 'inputAlpha'],
      ['beta', 'inputBeta'],
      ['gamma', 'output'],
    ] as const) {
      await v2Catalog.registerCommittedLayout(
        registration(versionName, [withParents(fixtureRevision(revisionName))]),
      )
    }

    const namespaceId = await v2Catalog.getOrCreateNamespace(v2Fixture.namespaceScope)
    const alphaVersion = fixtureVersion('alpha')
    const betaVersion = fixtureVersion('beta')
    const gammaVersion = fixtureVersion('gamma')
    await v2Catalog.compareAndSetRef({
      namespaceId,
      name: 'main',
      newVersion: alphaVersion,
      expectedVersion: null,
      message: 'initial',
    })

    expect(await v2Catalog.getRef(namespaceId, 'main')).toMatchObject({
      namespaceId,
      name: 'main',
      version: alphaVersion,
      numRecords: 1n,
      message: 'initial',
    })
    expect(await v2Catalog.resolveRef(namespaceId, 'main')).toBe(alphaVersion)
    expect(await v2Catalog.resolveRef(namespaceId, alphaVersion)).toBe(alphaVersion)

    const createRace = await Promise.allSettled([
      v2Catalog.compareAndSetRef({
        namespaceId,
        name: 'create-race',
        newVersion: alphaVersion,
        expectedVersion: null,
        message: 'alpha',
      }),
      v2Catalog.compareAndSetRef({
        namespaceId,
        name: 'create-race',
        newVersion: betaVersion,
        expectedVersion: null,
        message: 'beta',
      }),
    ])
    expect(createRace.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
    expect(createRace.filter(({ status }) => status === 'rejected')).toHaveLength(1)

    const moves = await Promise.allSettled([
      v2Catalog.compareAndSetRef({
        namespaceId,
        name: 'main',
        newVersion: betaVersion,
        expectedVersion: alphaVersion,
        message: 'beta won',
      }),
      v2Catalog.compareAndSetRef({
        namespaceId,
        name: 'main',
        newVersion: gammaVersion,
        expectedVersion: alphaVersion,
        message: 'gamma won',
      }),
    ])
    expect(moves.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
    const moveFailure = moves.find(({ status }) => status === 'rejected')
    if (moveFailure?.status === 'rejected') {
      expect(moveFailure.reason).toBeInstanceOf(V2CatalogRefConflictError)
    }

    const current = await v2Catalog.getRef(namespaceId, 'main')
    if (!current) throw new Error('expected main ref after a successful concurrent move')
    expect([betaVersion, gammaVersion]).toContain(current?.version)
    const timestampAfterSuccessfulMove = current?.updatedAt
    await expect(
      v2Catalog.compareAndSetRef({
        namespaceId,
        name: 'main',
        newVersion: current.version,
        expectedVersion: alphaVersion,
        message: current.message,
      }),
    ).rejects.toMatchObject({
      currentVersion: current.version,
      expectedVersion: alphaVersion,
      newVersion: current.version,
    })
    expect(await v2Catalog.getRef(namespaceId, 'main')).toMatchObject({
      version: current.version,
      message: current.message,
      updatedAt: timestampAfterSuccessfulMove,
    })

    await v2Catalog.compareAndSetRef({
      namespaceId,
      name: 'a-ref',
      newVersion: alphaVersion,
      expectedVersion: null,
      message: null,
    })
    await v2Catalog.compareAndSetRef({
      namespaceId,
      name: 'z-ref',
      newVersion: gammaVersion,
      expectedVersion: null,
      message: null,
    })

    for (const name of ['a-', 'a.', 'a0', 'a_']) {
      await v2Catalog.compareAndSetRef({
        namespaceId,
        name,
        newVersion: alphaVersion,
        expectedVersion: null,
        message: null,
      })
    }

    const pagedNames: string[] = []
    let afterName: string | null = null
    do {
      const page = await v2Catalog.listRefs(namespaceId, afterName, 3)
      pagedNames.push(...page.rows.map(({ name }) => name))
      afterName = page.nextName
    } while (afterName !== null)
    expect(pagedNames).toEqual(['a-', 'a-ref', 'a.', 'a0', 'a_', 'create-race', 'main', 'z-ref'])
    await expect(
      v2Catalog.listRefs('00000000-0000-4000-8000-000000000000', null, 2),
    ).resolves.toEqual({ rows: [], nextName: null })
  })

  test('returns the row committed by each successful compare-and-set ref operation', async () => {
    for (const [versionName, revisionName] of [
      ['alpha', 'inputAlpha'],
      ['beta', 'inputBeta'],
      ['gamma', 'output'],
    ] as const) {
      await v2Catalog.registerCommittedLayout(
        registration(versionName, [withParents(fixtureRevision(revisionName))]),
      )
    }

    const namespaceId = await v2Catalog.getOrCreateNamespace(v2Fixture.namespaceScope)
    const alphaVersion = fixtureVersion('alpha')
    const betaVersion = fixtureVersion('beta')
    const gammaVersion = fixtureVersion('gamma')
    const created = await v2Catalog.compareAndSetRef({
      namespaceId,
      name: 'returning-row',
      newVersion: alphaVersion,
      expectedVersion: null,
      message: 'created',
    })

    expect(created).toMatchObject({
      namespaceId,
      name: 'returning-row',
      version: alphaVersion,
      numRecords: 1n,
      message: 'created',
      updatedAt: expect.any(Date),
    })

    const moved = await v2Catalog.compareAndSetRef({
      namespaceId,
      name: 'returning-row',
      newVersion: betaVersion,
      expectedVersion: alphaVersion,
      message: 'moved to beta',
    })
    await v2Catalog.compareAndSetRef({
      namespaceId,
      name: 'returning-row',
      newVersion: gammaVersion,
      expectedVersion: betaVersion,
      message: 'moved to gamma',
    })

    expect(moved).toMatchObject({
      namespaceId,
      name: 'returning-row',
      version: betaVersion,
      numRecords: 1n,
      message: 'moved to beta',
      updatedAt: expect.any(Date),
    })
    expect(created).toMatchObject({ version: alphaVersion, message: 'created' })
    expect(await v2Catalog.getRef(namespaceId, 'returning-row')).toMatchObject({
      version: gammaVersion,
      numRecords: 1n,
      message: 'moved to gamma',
    })
  })

  test('moves refs to recoverable trash and restores them without deleting immutable metadata', async () => {
    const input = registration('alpha', [withParents(fixtureRevision('inputAlpha'))])
    await v2Catalog.registerCommittedLayout(input)
    const namespaceId = await v2Catalog.getOrCreateNamespace(v2Fixture.namespaceScope)
    await v2Catalog.compareAndSetRef({
      namespaceId,
      name: 'delete-me',
      newVersion: input.snapshot.version,
      expectedVersion: null,
      message: null,
    })

    await expect(
      v2Catalog.deleteRef({
        namespaceId,
        name: 'delete-me',
        expectedVersion: fixtureVersion('beta'),
      }),
    ).rejects.toMatchObject({
      name: 'V2CatalogRefStateConflictError',
      operation: 'delete',
      currentState: 'active',
    })
    const deleted = await v2Catalog.deleteRef({
      namespaceId,
      name: 'delete-me',
      expectedVersion: input.snapshot.version,
    })
    if (deleted.status === 'missing') throw new Error('seeded ref was not deleted')
    expect(deleted).toMatchObject({
      status: 'deleted',
      row: {
        namespaceId,
        name: 'delete-me',
        version: input.snapshot.version,
        deletedAt: expect.any(Date),
      },
    })
    await expect(
      v2Catalog.deleteRef({
        namespaceId,
        name: 'delete-me',
        expectedVersion: input.snapshot.version,
      }),
    ).resolves.toMatchObject({ status: 'already_deleted', row: deleted.row })

    expect(await v2Catalog.getRef(namespaceId, 'delete-me')).toBeNull()
    expect(await v2Catalog.resolveRef(namespaceId, 'delete-me')).toBe('delete-me')
    expect(await v2Catalog.getDeletedRef(namespaceId, 'delete-me')).toMatchObject({
      version: input.snapshot.version,
      deletedAt: expect.any(Date),
    })
    await expect(v2Catalog.listRefs(namespaceId, null, 10)).resolves.toEqual({
      rows: [],
      nextName: null,
    })
    await expect(v2Catalog.listDeletedRefs(namespaceId, null, 10)).resolves.toMatchObject({
      rows: [{ name: 'delete-me', version: input.snapshot.version }],
      nextName: null,
    })
    expect(await v2Catalog.getSnapshot(input.snapshot.version)).not.toBeNull()
    expect(
      await v2Catalog.getLayout(input.snapshot.version, input.layout.layoutVersion),
    ).not.toBeNull()

    await expect(
      v2Catalog.restoreRef({
        namespaceId,
        name: 'delete-me',
        expectedVersion: fixtureVersion('beta'),
      }),
    ).rejects.toBeInstanceOf(V2CatalogRefStateConflictError)
    const restored = await v2Catalog.restoreRef({
      namespaceId,
      name: 'delete-me',
      expectedVersion: input.snapshot.version,
    })
    if (restored.status === 'missing') throw new Error('deleted ref was not restored')
    expect(restored).toMatchObject({
      status: 'restored',
      row: { name: 'delete-me', version: input.snapshot.version, deletedAt: null },
    })
    await expect(
      v2Catalog.restoreRef({
        namespaceId,
        name: 'delete-me',
        expectedVersion: input.snapshot.version,
      }),
    ).resolves.toMatchObject({ status: 'already_active', row: restored.row })
    expect(await v2Catalog.getDeletedRef(namespaceId, 'delete-me')).toBeNull()
    expect(await v2Catalog.getRef(namespaceId, 'delete-me')).toMatchObject({
      version: input.snapshot.version,
      deletedAt: null,
    })
  })

  test('serializes concurrent ref move and delete so only one CAS transition wins', async () => {
    const alpha = registration('alpha', [withParents(fixtureRevision('inputAlpha'))])
    const beta = registration('beta', [withParents(fixtureRevision('inputBeta'))])
    await v2Catalog.registerCommittedLayout(alpha)
    await v2Catalog.registerCommittedLayout(beta)
    const namespaceId = await v2Catalog.getOrCreateNamespace(v2Fixture.namespaceScope)
    await v2Catalog.compareAndSetRef({
      namespaceId,
      name: 'move-delete-race',
      newVersion: alpha.snapshot.version,
      expectedVersion: null,
      message: null,
    })

    const [deleted, moved] = await Promise.allSettled([
      v2Catalog.deleteRef({
        namespaceId,
        name: 'move-delete-race',
        expectedVersion: alpha.snapshot.version,
      }),
      v2Catalog.compareAndSetRef({
        namespaceId,
        name: 'move-delete-race',
        newVersion: beta.snapshot.version,
        expectedVersion: alpha.snapshot.version,
        message: 'concurrent move',
      }),
    ])

    expect({
      statuses: [deleted.status, moved.status].sort(),
      deleted: deleted.status === 'fulfilled' ? deleted.value : deleted.reason,
      moved: moved.status === 'fulfilled' ? moved.value : moved.reason,
      active: await v2Catalog.getRef(namespaceId, 'move-delete-race'),
      trashed: await v2Catalog.getDeletedRef(namespaceId, 'move-delete-race'),
    }).toMatchObject({ statuses: ['fulfilled', 'rejected'] })
    if (deleted.status === 'fulfilled') {
      expect(deleted.value).toMatchObject({ status: 'deleted' })
      expect(moved.status === 'rejected' ? moved.reason : null).toBeInstanceOf(
        V2CatalogRefConflictError,
      )
      expect(await v2Catalog.getRef(namespaceId, 'move-delete-race')).toBeNull()
      expect(await v2Catalog.getDeletedRef(namespaceId, 'move-delete-race')).toMatchObject({
        version: alpha.snapshot.version,
      })
    } else {
      expect(deleted.reason).toBeInstanceOf(V2CatalogRefStateConflictError)
      expect(moved.status === 'fulfilled' ? moved.value : null).toMatchObject({
        version: beta.snapshot.version,
      })
      expect(await v2Catalog.getRef(namespaceId, 'move-delete-race')).toMatchObject({
        version: beta.snapshot.version,
      })
      expect(await v2Catalog.getDeletedRef(namespaceId, 'move-delete-race')).toBeNull()
    }
  })

  test('rejects refs to snapshots without a committed layout', async () => {
    const namespaceId = await v2Catalog.getOrCreateNamespace(v2Fixture.namespaceScope)
    const version = fixtureVersion('delta')
    await prisma.v2DatasetSnapshot.create({
      data: {
        version,
        identityProfile: v2Fixture.identityProfile,
        recordSchemaVersion: v2Fixture.recordSchemaVersion,
        numRecords: 0n,
      },
    })

    await expect(
      v2Catalog.compareAndSetRef({
        namespaceId,
        name: 'uncommitted',
        newVersion: version,
        expectedVersion: null,
        message: null,
      }),
    ).rejects.toBeInstanceOf(V2CatalogTargetNotCommittedError)
    expect(await v2Catalog.getRef(namespaceId, 'uncommitted')).toBeNull()
  })

  test('database checks and RESTRICT foreign keys remain authoritative', async () => {
    const validVersion = fixtureVersion('alpha')
    await expect(
      prisma.v2DatasetSnapshot.create({
        data: {
          version: validVersion.toUpperCase(),
          identityProfile: v2Fixture.identityProfile,
          recordSchemaVersion: v2Fixture.recordSchemaVersion,
          numRecords: 0n,
        },
      }),
    ).rejects.toThrow()
    await expect(
      prisma.v2DatasetSnapshot.create({
        data: {
          version: validVersion,
          identityProfile: v2Fixture.identityProfile,
          recordSchemaVersion: v2Fixture.recordSchemaVersion,
          numRecords: -1n,
        },
      }),
    ).rejects.toThrow()

    const committed = registration('alpha', [withParents(fixtureRevision('shared'))])
    await v2Catalog.registerCommittedLayout(committed)
    await expect(
      prisma.v2DatasetSnapshot.delete({ where: { version: committed.snapshot.version } }),
    ).rejects.toThrow()

    const namespaceId = await v2Catalog.getOrCreateNamespace(v2Fixture.namespaceScope)
    await v2Catalog.insertOrReadIdentityClaim({ namespaceId, ...v2Fixture.claim })
    await expect(
      prisma.v2Ref.create({
        data: { namespaceId, name: '.', version: committed.snapshot.version },
      }),
    ).rejects.toThrow()
    await expect(
      prisma.v2Run.create({
        data: {
          id: `run_${'f'.repeat(64)}`,
          cacheKey: 'e'.repeat(64),
          op: 'invalid-run-id',
          opVersion: '1',
          params: {},
          outputVersion: committed.snapshot.version,
        },
      }),
    ).rejects.toThrow()

    const cacheKey = 'e'.repeat(64)
    await prisma.v2Run.create({
      data: {
        id: `run_${cacheKey}`,
        cacheKey,
        op: 'valid-for-fk-checks',
        opVersion: '1',
        params: {},
        outputVersion: committed.snapshot.version,
      },
    })
    await expect(
      prisma.v2Run.update({ where: { cacheKey }, data: { lineageSeq: 0n } }),
    ).rejects.toThrow()
    await expect(
      prisma.v2RunInput.create({
        data: {
          cacheKey,
          position: -1,
          datasetVersion: committed.snapshot.version,
        },
      }),
    ).rejects.toThrow()
    await expect(
      prisma.v2RunInput.create({
        data: { cacheKey, position: 0, datasetVersion: 'f'.repeat(64) },
      }),
    ).rejects.toThrow()
    await expect(
      prisma.v2IdentityNamespace.delete({ where: { id: namespaceId } }),
    ).rejects.toThrow()
  })
})

describe('V2Catalog evaluation runs', () => {
  test('requires an exact committed Dataset FK and creates one row under a provider-task race', async () => {
    const namespaceId = await v2Catalog.getOrCreateNamespace(v2Fixture.namespaceScope)
    const input = evaluationRunInput(namespaceId, 'task-race')
    await expect(v2Catalog.createOrReadEvaluationRun(input)).rejects.toThrow()

    await v2Catalog.registerCommittedLayout(
      registration('alpha', [withParents(fixtureRevision('inputAlpha'))]),
    )
    const rows = await Promise.all(
      Array.from({ length: 16 }, () => v2Catalog.createOrReadEvaluationRun(input)),
    )
    expect(new Set(rows.map((row) => row.id)).size).toBe(1)
    expect(rows.every((row) => row.status === 'prepared')).toBe(true)
    expect(await prisma.v2EvaluationRun.count()).toBe(1)
    await expect(
      prisma.v2DatasetSnapshot.delete({ where: { version: input.datasetVersion } }),
    ).rejects.toThrow()
  })

  test('persists complete Metric scoring identity and rejects partial database shapes', async () => {
    await v2Catalog.registerCommittedLayout(
      registration('alpha', [withParents(fixtureRevision('inputAlpha'))]),
    )
    const namespaceId = await v2Catalog.getOrCreateNamespace(v2Fixture.namespaceScope)
    const scoringConfig = {
      schema_version: 1,
      mode: 'explicit',
      evalscope_commit: 'a'.repeat(40),
      benchmark: 'general_qa',
      metrics: [
        {
          id: 'exact_match',
          implementation_digest: 'd'.repeat(64),
          parameters: {},
          output_keys: ['exact_match'],
        },
      ],
      primary_metric_id: 'exact_match',
      primary_output_key: 'exact_match',
    }
    const prepared = await v2Catalog.createOrReadEvaluationRun({
      ...evaluationRunInput(namespaceId, 'task-metric-persistence'),
      createProfile: 'evaluation-run-create-v3',
      scoringConfig,
      primaryMetricId: 'exact_match',
      primaryOutputKey: 'exact_match',
    })
    expect(prepared).toMatchObject({
      createProfile: 'evaluation-run-create-v3',
      scoringConfig,
      primaryMetricId: 'exact_match',
      primaryOutputKey: 'exact_match',
    })
    await expect(
      prisma.v2EvaluationRun.update({
        where: { id: prepared.id },
        data: { primaryMetricId: null },
      }),
    ).rejects.toThrow()
  })

  test('database-enforces version-bound source snapshots and preserves legacy run shapes', async () => {
    const { namespaceId, artifact } = await finalizedModelArtifact()
    const versionDeployment = (
      id: string,
      digest: string,
      modelVersionId: string,
      artifactId: string | null,
      servedModelName: string,
    ) => ({
      id,
      namespaceId,
      deploymentProfile: 'model-version-v1' as const,
      createDigest: digest,
      modelVersionId,
      artifactId,
      provider: 'openai_compatible' as const,
      displayName: servedModelName,
      servedModelName,
      endpointBaseUrl: 'http://model-service:8000/v1',
      connectivityScope: 'private_network' as const,
      authProfile: 'none' as const,
      credentialRef: null,
      declaredCapabilities: {
        interfaces: ['chat_completions' as const],
        contextLimit: 32_768,
      },
    })

    const artifactInput = artifactModelRegistrationInput(namespaceId, artifact)
    const artifactDeployment = versionDeployment(
      '40000000-0000-8000-8000-000000000001',
      'd'.repeat(64),
      artifactInput.version.id,
      artifact.id,
      'artifact-route',
    )
    const artifactRegistration = await v2Catalog.registerModelVersion({
      ...artifactInput,
      deployment: artifactDeployment,
    })

    const repositoryModelId = '10000000-0000-8000-8000-000000000002'
    const repositoryVersionId = '20000000-0000-8000-8000-000000000002'
    const repositoryEvidence = {
      id: '30000000-0000-8000-8000-000000000002',
      namespaceId,
      modelVersionId: repositoryVersionId,
      evidenceProfile: 'model-source-evidence-v1' as const,
      evidenceDigest: 'a'.repeat(64),
      evidenceKind: 'provider_resolution' as const,
      adapter: 'modelscope',
      adapterVersion: '1',
      observedRevision: 'abc123',
      observedAt: new Date('2026-08-04T12:00:00.000Z'),
      result: 'verified' as const,
      responseDigest: 'c'.repeat(64),
      license: 'apache-2.0',
      cacheStatus: 'not_cached' as const,
    }
    const repositoryDeployment = versionDeployment(
      '40000000-0000-8000-8000-000000000002',
      'e'.repeat(64),
      repositoryVersionId,
      null,
      'repository-route',
    )
    const repositoryRegistration = await v2Catalog.registerModelVersion(
      modelRegistrationInput(namespaceId, {
        registrationDigest: '5'.repeat(64),
        normalizedRequest: { source: 'repository-evaluation' },
        target: {
          kind: 'create_model',
          model: {
            id: repositoryModelId,
            namespaceId,
            key: 'repository-evaluation',
            createProfile: 'model-create-v1',
            createDigest: '5'.repeat(64),
            displayName: 'Repository Evaluation',
            description: '',
            taskFamily: 'chat',
            tags: [],
          },
        },
        version: {
          id: repositoryVersionId,
          modelId: repositoryModelId,
          createDigest: '5'.repeat(64),
          sourceFingerprint: '5'.repeat(64),
        },
        source: {
          kind: 'repository_reference',
          provider: 'modelscope',
          repositoryId: 'Qwen/Qwen3-0.6B',
          revision: 'abc123',
          revisionKind: 'commit',
        },
        initialEvidence: repositoryEvidence,
        deployment: repositoryDeployment,
      }),
    )

    const serviceModelId = '10000000-0000-8000-8000-000000000003'
    const serviceVersionId = '20000000-0000-8000-8000-000000000003'
    const serviceDeployment = versionDeployment(
      '40000000-0000-8000-8000-000000000003',
      'f'.repeat(64),
      serviceVersionId,
      null,
      'service-route',
    )
    const serviceRegistration = await v2Catalog.registerModelVersion({
      ...modelRegistrationInput(namespaceId, {
        registrationDigest: '7'.repeat(64),
        normalizedRequest: { source: 'service-evaluation' },
        target: {
          kind: 'create_model',
          model: {
            id: serviceModelId,
            namespaceId,
            key: 'service-evaluation',
            createProfile: 'model-create-v1',
            createDigest: '7'.repeat(64),
            displayName: 'Service Evaluation',
            description: '',
            taskFamily: 'chat',
            tags: [],
          },
        },
        version: {
          id: serviceVersionId,
          modelId: serviceModelId,
          sourceKind: 'existing_service',
          createProfile: 'model-version-create-service-v1',
          createDigest: '7'.repeat(64),
          sourceFingerprint: '7'.repeat(64),
        },
        source: {
          kind: 'existing_service',
          provider: 'openai_compatible',
          externalModelRef: 'service-model',
          externalVersionRef: 'release-1',
          declaredReferenceKind: 'immutable_version',
        },
        deployment: serviceDeployment,
      }),
      planProfile: 'model-registration-plan-service-v1',
    })

    const activeArtifact = await v2Catalog.activateModelVersionDeployment({
      namespaceId,
      modelVersionId: artifactRegistration.version.id,
      deploymentId: artifactRegistration.deployment?.id ?? '',
      policyGeneration: 1n,
      credentialGeneration: null,
    })
    const activeRepository = await v2Catalog.activateModelVersionDeployment({
      namespaceId,
      modelVersionId: repositoryRegistration.version.id,
      deploymentId: repositoryRegistration.deployment?.id ?? '',
      policyGeneration: 1n,
      credentialGeneration: null,
    })
    const activeService = await v2Catalog.activateModelVersionDeployment({
      namespaceId,
      modelVersionId: serviceRegistration.version.id,
      deploymentId: serviceRegistration.deployment?.id ?? '',
      policyGeneration: 1n,
      credentialGeneration: null,
    })
    if (activeArtifact === null || activeRepository === null || activeService === null) {
      throw new Error('Model Version Deployment activation failed')
    }

    const artifactRunInput = versionDeploymentEvaluationRunInput(
      namespaceId,
      {
        modelId: artifactRegistration.model.id,
        modelVersionId: artifactRegistration.version.id,
        deploymentId: activeArtifact.id,
        deploymentDigest: activeArtifact.createDigest,
        artifactId: artifact.id,
        servedModelName: activeArtifact.servedModelName,
        sourceMutability: 'immutable',
        verificationLevel: 'content_verified',
        evidenceDigest: null,
      },
      'task-version-artifact',
    )
    const repositoryRunInput = versionDeploymentEvaluationRunInput(
      namespaceId,
      {
        modelId: repositoryRegistration.model.id,
        modelVersionId: repositoryRegistration.version.id,
        deploymentId: activeRepository.id,
        deploymentDigest: activeRepository.createDigest,
        artifactId: null,
        servedModelName: activeRepository.servedModelName,
        sourceMutability: 'immutable',
        verificationLevel: 'provider_verified',
        evidenceDigest: repositoryEvidence.evidenceDigest,
      },
      'task-version-repository',
    )
    const serviceRunInput = versionDeploymentEvaluationRunInput(
      namespaceId,
      {
        modelId: serviceRegistration.model.id,
        modelVersionId: serviceRegistration.version.id,
        deploymentId: activeService.id,
        deploymentDigest: activeService.createDigest,
        artifactId: null,
        servedModelName: activeService.servedModelName,
        sourceMutability: 'unknown',
        verificationLevel: 'operator_attested',
        evidenceDigest: null,
      },
      'task-version-service',
    )
    const artifactRun = await v2Catalog.createOrReadEvaluationRun(artifactRunInput)
    const repositoryRun = await v2Catalog.createOrReadEvaluationRun(repositoryRunInput)
    const serviceRun = await v2Catalog.createOrReadEvaluationRun(serviceRunInput)
    expect(artifactRun).toMatchObject({
      modelId: artifactRegistration.model.id,
      modelVersionId: artifactRegistration.version.id,
      modelArtifactId: artifact.id,
      sourceMutabilitySnapshot: 'immutable',
      verificationLevelSnapshot: 'content_verified',
      sourceEvidenceDigest: null,
      sourceObservedAt: expect.any(Date),
    })
    expect(repositoryRun).toMatchObject({
      modelArtifactId: null,
      verificationLevelSnapshot: 'provider_verified',
      sourceEvidenceDigest: repositoryEvidence.evidenceDigest,
      sourceObservedAt: expect.any(Date),
    })
    expect(serviceRun).toMatchObject({
      modelArtifactId: null,
      sourceMutabilitySnapshot: 'unknown',
      verificationLevelSnapshot: 'operator_attested',
      sourceObservedAt: expect.any(Date),
    })

    const scoringConfig = {
      schema_version: 1,
      mode: 'explicit',
      evalscope_commit: 'a'.repeat(40),
      benchmark: 'general_qa',
      metrics: [
        {
          id: 'exact_match',
          implementation_digest: 'd'.repeat(64),
          parameters: {},
          output_keys: ['exact_match'],
        },
      ],
      primary_metric_id: 'exact_match',
      primary_output_key: 'exact_match',
    }
    const metricRun = await v2Catalog.createOrReadEvaluationRun({
      ...artifactRunInput,
      providerTaskId: 'task-version-artifact-metrics',
      createProfile: 'evaluation-run-create-v6',
      createRequestDigest: '5'.repeat(64),
      scoringConfig,
      primaryMetricId: 'exact_match',
      primaryOutputKey: 'exact_match',
    })
    expect(metricRun).toMatchObject({
      createProfile: 'evaluation-run-create-v6',
      modelVersionId: artifactRegistration.version.id,
      scoringConfig,
    })

    const legacyDeployment = await v2Catalog.createOrReadModelDeployment(
      modelDeploymentInput(namespaceId, artifact.id, '0'.repeat(64)),
    )
    const legacyInputs = [
      evaluationRunInput(namespaceId, 'task-legacy-v1'),
      deploymentEvaluationRunInput(namespaceId, legacyDeployment, 'task-legacy-v2'),
      {
        ...evaluationRunInput(namespaceId, 'task-legacy-v3'),
        createProfile: 'evaluation-run-create-v3' as const,
        scoringConfig,
        primaryMetricId: 'exact_match',
        primaryOutputKey: 'exact_match',
      },
      {
        ...deploymentEvaluationRunInput(namespaceId, legacyDeployment, 'task-legacy-v4'),
        createProfile: 'evaluation-run-create-v4' as const,
        scoringConfig,
        primaryMetricId: 'exact_match',
        primaryOutputKey: 'exact_match',
      },
    ]
    const legacyRuns = []
    for (const input of legacyInputs) {
      legacyRuns.push(await v2Catalog.createOrReadEvaluationRun(input))
    }
    for (const run of legacyRuns) {
      expect(run).toMatchObject({
        modelId: null,
        modelVersionId: null,
        sourceMutabilitySnapshot: null,
        verificationLevelSnapshot: null,
        sourceEvidenceDigest: null,
        sourceObservedAt: null,
      })
    }

    await expect(
      prisma.v2EvaluationRun.update({
        where: { id: artifactRun.id },
        data: { modelId: repositoryRegistration.model.id },
      }),
    ).rejects.toThrow()
    await expect(
      prisma.v2EvaluationRun.update({
        where: { id: artifactRun.id },
        data: {
          modelId: repositoryRegistration.model.id,
          modelVersionId: repositoryRegistration.version.id,
        },
      }),
    ).rejects.toThrow()
    await expect(
      prisma.v2EvaluationRun.update({
        where: { id: artifactRun.id },
        data: { modelDeploymentDigest: '9'.repeat(64) },
      }),
    ).rejects.toThrow()
    await expect(
      prisma.v2EvaluationRun.update({
        where: { id: artifactRun.id },
        data: { modelArtifactId: '99999999-9999-4999-8999-999999999999' },
      }),
    ).rejects.toThrow()
    await expect(
      prisma.v2EvaluationRun.update({
        where: { id: artifactRun.id },
        data: { modelArtifactId: null },
      }),
    ).rejects.toThrow()
    await expect(
      prisma.v2EvaluationRun.update({
        where: { id: repositoryRun.id },
        data: { modelArtifactId: artifact.id },
      }),
    ).rejects.toThrow()
    await expect(
      prisma.v2EvaluationRun.update({
        where: { id: artifactRun.id },
        data: { sourceMutabilitySnapshot: 'mutable' },
      }),
    ).rejects.toThrow()
    await expect(
      prisma.v2EvaluationRun.update({
        where: { id: artifactRun.id },
        data: { verificationLevelSnapshot: 'operator_attested' },
      }),
    ).rejects.toThrow()
    await expect(
      prisma.v2EvaluationRun.update({
        where: { id: artifactRun.id },
        data: { sourceObservedAt: null },
      }),
    ).rejects.toThrow()

    const artifactEvidence = await v2Catalog.appendModelSourceEvidence({
      id: '30000000-0000-8000-8000-000000000001',
      namespaceId,
      modelVersionId: artifactRegistration.version.id,
      evidenceProfile: 'model-source-evidence-v1',
      evidenceDigest: 'b'.repeat(64),
      evidenceKind: 'operator_attestation',
      adapter: 'databench-artifact',
      adapterVersion: '1',
      observedRevision: artifact.archiveDigest,
      observedAt: new Date('2026-08-04T12:01:00.000Z'),
      result: 'verified',
      responseDigest: 'd'.repeat(64),
      license: null,
      cacheStatus: 'not_cached',
    })
    await expect(
      prisma.v2EvaluationRun.update({
        where: { id: artifactRun.id },
        data: { sourceEvidenceDigest: artifactEvidence.evidenceDigest },
      }),
    ).rejects.toThrow()
    await expect(
      prisma.v2EvaluationRun.update({
        where: { id: repositoryRun.id },
        data: { verificationLevelSnapshot: 'content_verified' },
      }),
    ).rejects.toThrow()
    await expect(
      prisma.v2EvaluationRun.update({
        where: { id: repositoryRun.id },
        data: { sourceEvidenceDigest: artifactEvidence.evidenceDigest },
      }),
    ).rejects.toThrow()

    await v2Catalog.disableModelVersionDeployment(
      namespaceId,
      artifactRegistration.version.id,
      activeArtifact.id,
    )
    await expect(v2Catalog.createOrReadEvaluationRun(artifactRunInput)).resolves.toMatchObject({
      id: artifactRun.id,
      modelVersionId: artifactRegistration.version.id,
    })
    await expect(
      v2Catalog.createOrReadEvaluationRun({
        ...artifactRunInput,
        providerTaskId: 'task-version-artifact-after-disable',
      }),
    ).rejects.toBeInstanceOf(V2CatalogModelDeploymentAdmissionError)
  })

  test('projects one latest complete v6 primary result without aggregating incomparable runs', async () => {
    await v2Catalog.registerCommittedLayout(
      registration('alpha', [withParents(fixtureRevision('inputAlpha'))]),
    )
    await v2Catalog.registerCommittedLayout(
      registration('beta', [withParents(fixtureRevision('inputBeta'))]),
    )
    const namespaceId = await v2Catalog.getOrCreateNamespace(v2Fixture.namespaceScope)
    const deploymentInput = {
      id: '40000000-0000-8000-8000-000000000001',
      namespaceId,
      deploymentProfile: 'model-version-v1' as const,
      createDigest: 'd'.repeat(64),
      modelVersionId: MODEL_REGISTRY_VERSION_ID,
      artifactId: null,
      provider: 'openai_compatible' as const,
      displayName: 'Mutable repository service',
      servedModelName: 'repository-latest',
      endpointBaseUrl: 'http://model-service:8000/v1',
      connectivityScope: 'private_network' as const,
      authProfile: 'none' as const,
      credentialRef: null,
      declaredCapabilities: { interfaces: ['chat_completions' as const], contextLimit: 8_192 },
    }
    const registrationResult = await v2Catalog.registerModelVersion(
      modelRegistrationInput(namespaceId, {
        source: {
          kind: 'repository_reference',
          provider: 'modelscope',
          repositoryId: 'Qwen/Qwen3-0.6B',
          revision: 'latest',
          revisionKind: 'tag',
        },
        deployment: deploymentInput,
      }),
    )
    const active = await v2Catalog.activateModelVersionDeployment({
      namespaceId,
      modelVersionId: registrationResult.version.id,
      deploymentId: deploymentInput.id,
      policyGeneration: 1n,
      credentialGeneration: null,
    })
    if (active === null) throw new Error('comparable Evaluation Deployment was not activated')
    const binding = {
      modelId: registrationResult.model.id,
      modelVersionId: registrationResult.version.id,
      deploymentId: active.id,
      deploymentDigest: active.createDigest,
      artifactId: null,
      servedModelName: active.servedModelName,
      sourceMutability: 'mutable' as const,
      verificationLevel: 'operator_attested' as const,
      evidenceDigest: null,
    }
    const scoringConfig = (
      benchmark: string,
      metricId: string,
      outputKey: string,
      implementationDigest: string,
    ) => ({
      schema_version: 1 as const,
      mode: 'explicit' as const,
      evalscope_commit: 'a'.repeat(40),
      benchmark,
      metrics: [
        {
          id: metricId,
          implementation_digest: implementationDigest,
          parameters: {},
          output_keys: [outputKey],
        },
      ],
      primary_metric_id: metricId,
      primary_output_key: outputKey,
    })
    const complete = async (
      providerTaskId: string,
      datasetVersion: string,
      benchmark: string,
      metricId: string,
      outputKey: string,
      score: number,
      finishedAt: Date,
      digestDigit: string,
    ) => {
      const run = await v2Catalog.createOrReadEvaluationRun({
        ...versionDeploymentEvaluationRunInput(namespaceId, binding, providerTaskId),
        createProfile: 'evaluation-run-create-v6' as const,
        createRequestDigest: digestDigit.repeat(64),
        datasetVersion,
        benchmark,
        scoringConfig: scoringConfig(benchmark, metricId, outputKey, digestDigit.repeat(64)),
        primaryMetricId: metricId,
        primaryOutputKey: outputKey,
      })
      await v2Catalog.transitionEvaluationRun({ namespaceId, id: run.id, status: 'running' })
      await v2Catalog.transitionEvaluationRun({
        namespaceId,
        id: run.id,
        status: 'completed',
        metrics: [
          {
            dataset: benchmark,
            subset: 'databench',
            metricId,
            outputKey,
            metric: metricId,
            score,
            sampleCount: 4,
            categories: [],
          },
        ],
        providerReportIds: [`report-${providerTaskId}`],
      })
      await prisma.v2EvaluationRun.update({ where: { id: run.id }, data: { finishedAt } })
      return run
    }
    await complete(
      'task-comparable-older',
      fixtureVersion('alpha'),
      'general_qa',
      'exact_match',
      'exact_match',
      0.25,
      new Date('2030-08-04T10:00:00.000Z'),
      '5',
    )
    const latest = await complete(
      'task-comparable-latest',
      fixtureVersion('beta'),
      'arc',
      'accuracy',
      'accuracy',
      0.9,
      new Date('2030-08-04T11:00:00.000Z'),
      '6',
    )
    const page = await v2Catalog.listModels(
      namespaceId,
      {
        search: '',
        archive: 'active',
        sourceKind: null,
        sourceMutability: null,
        verificationLevel: null,
        taskFamily: null,
        artifactKind: null,
        artifactId: null,
        alias: null,
        deploymentLifecycle: null,
        deploymentHealth: null,
        tag: null,
      },
      null,
      20,
    )
    expect(page.rows).toHaveLength(1)
    expect(page.rows[0]?.latestComparableEvaluation).toMatchObject({
      runId: latest.id,
      benchmark: 'arc',
      datasetVersion: fixtureVersion('beta'),
      metricId: 'accuracy',
      outputKey: 'accuracy',
      score: 0.9,
      sourceMutability: 'mutable',
      verificationLevel: 'operator_attested',
    })
  })

  test('serializes archive attempts and replays concurrent finalize without changing the locator', async () => {
    await v2Catalog.registerCommittedLayout(
      registration('alpha', [withParents(fixtureRevision('inputAlpha'))]),
    )
    const namespaceId = await v2Catalog.getOrCreateNamespace(v2Fixture.namespaceScope)
    const prepared = await v2Catalog.createOrReadEvaluationRun(
      evaluationRunInput(namespaceId, 'task-archive-race'),
    )
    await v2Catalog.transitionEvaluationRun({ namespaceId, id: prepared.id, status: 'running' })
    await v2Catalog.transitionEvaluationRun({
      namespaceId,
      id: prepared.id,
      status: 'completed',
      metrics: [],
      providerReportIds: ['report-archive'],
    })
    const claims = await Promise.all(
      Array.from({ length: 12 }, () =>
        v2Catalog.prepareEvaluationRunArchive({ namespaceId, id: prepared.id }),
      ),
    )
    expect(claims.every((row) => row?.archiveStatus === 'pending')).toBe(true)
    expect(new Set(claims.map((row) => row?.archiveAttempt))).toEqual(new Set([1]))
    const uploading = await v2Catalog.markEvaluationRunArchiveUploading({
      namespaceId,
      id: prepared.id,
      archiveAttempt: 1,
    })
    expect(uploading).toMatchObject({ archiveStatus: 'uploading', archiveAttempt: 1 })
    const digest = 'd'.repeat(64)
    const locator = {
      namespaceId,
      id: prepared.id,
      archiveAttempt: 1,
      resultArtifactKey: `objects/v2/evaluation-result-v1/dd/${digest}.tar.zst`,
      resultArtifactDigest: digest,
      resultArtifactSizeBytes: 512n,
    }
    const finalized = await Promise.all(
      Array.from({ length: 12 }, () => v2Catalog.finalizeEvaluationRunArchive(locator)),
    )
    expect(finalized.every((row) => row?.archiveStatus === 'available')).toBe(true)
    expect(finalized.every((row) => row?.resultArtifactDigest === digest)).toBe(true)
    expect(
      await v2Catalog.prepareEvaluationRunArchive({ namespaceId, id: prepared.id }),
    ).toMatchObject({
      archiveStatus: 'available',
      archiveAttempt: 1,
    })
  })

  test('lists scoped runs and enforces the execution transition matrix', async () => {
    await v2Catalog.registerCommittedLayout(
      registration('alpha', [withParents(fixtureRevision('inputAlpha'))]),
    )
    const namespaceId = await v2Catalog.getOrCreateNamespace(v2Fixture.namespaceScope)
    const prepared = await v2Catalog.createOrReadEvaluationRun(
      evaluationRunInput(namespaceId, 'task-lifecycle'),
    )
    await expect(
      v2Catalog.transitionEvaluationRun({
        namespaceId,
        id: prepared.id,
        status: 'completed',
        metrics: [],
        providerReportIds: [],
      }),
    ).resolves.toMatchObject({ status: 'prepared' })

    const running = await v2Catalog.transitionEvaluationRun({
      namespaceId,
      id: prepared.id,
      status: 'running',
    })
    expect(running).toMatchObject({ status: 'running' })
    expect(running?.startedAt).toBeInstanceOf(Date)

    const completion = {
      namespaceId,
      id: prepared.id,
      status: 'completed' as const,
      metrics: [
        {
          dataset: 'general_qa',
          subset: 'databench',
          metricId: null,
          outputKey: null,
          metric: 'accuracy',
          score: 1,
          sampleCount: 1,
          categories: [],
        },
      ],
      providerReportIds: ['report-1'],
    }
    await expect(v2Catalog.transitionEvaluationRun(completion)).resolves.toMatchObject({
      status: 'completed',
      providerReportIds: ['report-1'],
      metrics: [{ metric: 'accuracy' }],
    })
    await expect(v2Catalog.transitionEvaluationRun(completion)).resolves.toMatchObject({
      status: 'completed',
    })
    await expect(
      v2Catalog.transitionEvaluationRun({
        namespaceId,
        id: prepared.id,
        status: 'failed',
        error: { phase: 'provider', code: 'late_failure', message: 'late failure' },
      }),
    ).resolves.toMatchObject({ status: 'completed' })

    const page = await v2Catalog.listEvaluationRuns(
      namespaceId,
      {
        datasetVersion: prepared.datasetVersion,
        modelDeploymentId: null,
        modelId: null,
        modelVersionId: null,
        status: 'completed',
      },
      null,
      20,
    )
    expect(page.rows.map((row) => row.id)).toEqual([prepared.id])
    expect(page.nextCursor).toBeNull()
  })

  test('rejects provider report locators and raw JSON shapes outside their bounds', async () => {
    await v2Catalog.registerCommittedLayout(
      registration('alpha', [withParents(fixtureRevision('inputAlpha'))]),
    )
    const namespaceId = await v2Catalog.getOrCreateNamespace(v2Fixture.namespaceScope)
    const prepared = await v2Catalog.createOrReadEvaluationRun(
      evaluationRunInput(namespaceId, 'task-bounds'),
    )
    await v2Catalog.transitionEvaluationRun({ namespaceId, id: prepared.id, status: 'running' })
    await expect(
      v2Catalog.transitionEvaluationRun({
        namespaceId,
        id: prepared.id,
        status: 'completed',
        metrics: [],
        providerReportIds: ['reports/path'],
      }),
    ).rejects.toBeInstanceOf(V2CatalogInputError)
    await expect(
      v2Catalog.transitionEvaluationRun({
        namespaceId,
        id: prepared.id,
        status: 'completed',
        metrics: [],
        providerReportIds: Array.from({ length: 33 }, (_, index) => `report-${index}`),
      }),
    ).rejects.toBeInstanceOf(V2CatalogInputError)
    await v2Catalog.transitionEvaluationRun({
      namespaceId,
      id: prepared.id,
      status: 'completed',
      metrics: [],
      providerReportIds: ['report-valid'],
    })
    const maximumIds = Array.from({ length: 32 }, (_, index) => `r${index}-`.padEnd(512, 'x'))
    const maximumPrepared = await v2Catalog.createOrReadEvaluationRun(
      evaluationRunInput(namespaceId, 'task-maximum-report-ids'),
    )
    await v2Catalog.transitionEvaluationRun({
      namespaceId,
      id: maximumPrepared.id,
      status: 'running',
    })
    await expect(
      v2Catalog.transitionEvaluationRun({
        namespaceId,
        id: maximumPrepared.id,
        status: 'completed',
        metrics: [],
        providerReportIds: maximumIds,
      }),
    ).resolves.toMatchObject({ providerReportIds: maximumIds })
    await expect(
      prisma.v2EvaluationRun.update({
        where: { id: maximumPrepared.id },
        data: {
          metrics: [
            {
              dataset: 'general_qa',
              subset: null,
              metric: 'accuracy',
              score: 1,
              sample_count: 1,
              categories: [],
              prompt: 'must-not-enter-postgres',
            },
          ],
        },
      }),
    ).rejects.toThrow()
    await expect(
      prisma.v2EvaluationRun.update({
        where: { id: maximumPrepared.id },
        data: {
          metrics: [
            {
              dataset: 'Authorization: Bearer-secret-value',
              subset: null,
              metric: 'accuracy',
              score: 1,
              sample_count: 1,
              categories: [],
            },
          ],
        },
      }),
    ).rejects.toThrow()
    for (const providerReportIds of [
      ['reports/path'],
      ['sk-proj-1234567890abcdef'],
      Array.from({ length: 33 }, (_, index) => `report-${index}`),
    ]) {
      await expect(
        prisma.v2EvaluationRun.update({
          where: { id: prepared.id },
          data: { providerReportIds },
        }),
      ).rejects.toThrow()
    }
  })
})

describe('V2Catalog Swift Studio Sessions', () => {
  test('requires exact committed Dataset FKs and merges concurrent create replays', async () => {
    const namespaceId = await v2Catalog.getOrCreateNamespace(v2Fixture.namespaceScope)
    const input = swiftStudioSessionInput(namespaceId)
    await expect(v2Catalog.createOrReadSwiftStudioSession(input)).rejects.toThrow()

    await v2Catalog.registerCommittedLayout(
      registration('alpha', [withParents(fixtureRevision('inputAlpha'))]),
    )
    const rows = await Promise.all(
      Array.from({ length: 16 }, (_, index) =>
        v2Catalog.createOrReadSwiftStudioSession({
          ...input,
          displayRef: index % 2 === 0 ? 'main' : null,
          providerSessionId: `session-race-${index}`,
        }),
      ),
    )
    expect(new Set(rows.map(({ row }) => row.id)).size).toBe(1)
    expect(rows.filter(({ created }) => created)).toHaveLength(1)
    expect(rows.every(({ row }) => row.status === 'preparing')).toBe(true)
    expect(new Set(rows.map(({ row }) => row.preparationOwnerToken)).size).toBe(1)
    const admitted = rows[0]?.row
    expect(admitted).toBeDefined()
    expect(admitted?.preparationOwnerToken).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
    await expect(
      v2Catalog.abandonSwiftStudioSessionPreparation(
        namespaceId,
        admitted?.id ?? '',
        admitted?.preparationOwnerToken ?? '',
      ),
    ).resolves.toBe(true)
    await expect(
      v2Catalog.getSwiftStudioSession(namespaceId, admitted?.id ?? ''),
    ).resolves.toMatchObject({
      id: admitted?.id,
      status: 'preparing',
      preparationAbandonedAt: expect.any(Date),
    })
    expect(await prisma.v2SwiftStudioSession.count()).toBe(1)
    await expect(
      prisma.v2DatasetSnapshot.delete({ where: { version: input.datasetVersion } }),
    ).rejects.toThrow()
  })

  test('enforces one active runtime Session in both the repository and database', async () => {
    await v2Catalog.registerCommittedLayout(
      registration('alpha', [withParents(fixtureRevision('inputAlpha'))]),
    )
    const namespaceId = await v2Catalog.getOrCreateNamespace(v2Fixture.namespaceScope)
    const { row: active } = await v2Catalog.createOrReadSwiftStudioSession(
      swiftStudioSessionInput(namespaceId),
    )
    await expect(
      v2Catalog.createOrReadSwiftStudioSession(
        swiftStudioSessionInput(namespaceId, '1'.repeat(64), 'session-conflict'),
      ),
    ).rejects.toMatchObject({
      reason: 'active_session_exists',
      sessionId: active.id,
      status: 'preparing',
    } satisfies Partial<V2CatalogSwiftStudioSessionConflictError>)

    await expect(
      prisma.v2SwiftStudioSession.create({
        data: {
          ...swiftStudioSessionInput(namespaceId, '2'.repeat(64), 'session-db-conflict'),
          id: '22222222-2222-4222-8222-222222222222',
          status: 'preparing',
          preparationOwnerToken: '22222222-2222-4222-8222-222222222223',
        },
      }),
    ).rejects.toThrow()
  })

  test('enforces idempotent lifecycle bodies, releases the singleton on close, and lists exact bindings', async () => {
    await v2Catalog.registerCommittedLayout(
      registration('alpha', [withParents(fixtureRevision('inputAlpha'))]),
    )
    const namespaceId = await v2Catalog.getOrCreateNamespace(v2Fixture.namespaceScope)
    const { row: prepared } = await v2Catalog.createOrReadSwiftStudioSession(
      swiftStudioSessionInput(namespaceId),
    )
    const readyInput = {
      namespaceId,
      id: prepared.id,
      status: 'ready' as const,
      preparationOwnerToken: prepared.preparationOwnerToken,
      exportDigest: '3'.repeat(64),
      exportSizeBytes: 4_096n,
    }
    await expect(v2Catalog.transitionSwiftStudioSession(readyInput)).resolves.toMatchObject({
      status: 'ready',
      exportDigest: readyInput.exportDigest,
      exportSizeBytes: readyInput.exportSizeBytes,
    })
    await expect(v2Catalog.transitionSwiftStudioSession(readyInput)).resolves.toMatchObject({
      status: 'ready',
    })
    await expect(
      v2Catalog.transitionSwiftStudioSession({ ...readyInput, exportSizeBytes: 4_097n }),
    ).rejects.toMatchObject({ reason: 'terminal_body_mismatch' })
    await expect(
      v2Catalog.transitionSwiftStudioSession({
        namespaceId,
        id: prepared.id,
        status: 'closing',
      }),
    ).resolves.toMatchObject({ status: 'closing' })
    await expect(
      v2Catalog.transitionSwiftStudioSession({
        namespaceId,
        id: prepared.id,
        status: 'closed',
      }),
    ).resolves.toMatchObject({ status: 'closed', closedAt: expect.any(Date) })

    const { row: next } = await v2Catalog.createOrReadSwiftStudioSession(
      swiftStudioSessionInput(namespaceId, '4'.repeat(64), 'session-after-close'),
    )
    expect(next.status).toBe('preparing')
    const page = await v2Catalog.listSwiftStudioSessions(
      namespaceId,
      { datasetVersion: prepared.datasetVersion, status: null },
      null,
      20,
    )
    expect(new Set(page.rows.map((row) => row.id))).toEqual(new Set([prepared.id, next.id]))
    expect(page.nextCursor).toBeNull()
  })

  test('stores only bounded sanitized failure summaries and frees the active slot', async () => {
    await v2Catalog.registerCommittedLayout(
      registration('alpha', [withParents(fixtureRevision('inputAlpha'))]),
    )
    const namespaceId = await v2Catalog.getOrCreateNamespace(v2Fixture.namespaceScope)
    const { row: prepared } = await v2Catalog.createOrReadSwiftStudioSession(
      swiftStudioSessionInput(namespaceId),
    )
    await expect(
      v2Catalog.transitionSwiftStudioSession({
        namespaceId,
        id: prepared.id,
        status: 'failed',
        preparationOwnerToken: prepared.preparationOwnerToken,
        failure: {
          phase: 'dataset_prepare',
          code: 'download_failed',
          message: 'Authorization: Bearer-secret-value',
        },
      }),
    ).rejects.toBeInstanceOf(V2CatalogInputError)
    const failure = {
      phase: 'dataset_prepare',
      code: 'download_failed',
      message: 'Provider download failed',
    }
    await expect(
      v2Catalog.transitionSwiftStudioSession({
        namespaceId,
        id: prepared.id,
        status: 'failed',
        preparationOwnerToken: prepared.preparationOwnerToken,
        failure,
      }),
    ).resolves.toMatchObject({ status: 'failed', failure })
    await expect(
      v2Catalog.transitionSwiftStudioSession({
        namespaceId,
        id: prepared.id,
        status: 'failed',
        preparationOwnerToken: '11111111-1111-4111-8111-111111111111',
        failure,
      }),
    ).resolves.toMatchObject({ status: 'failed', failure })
    await expect(
      v2Catalog.transitionSwiftStudioSession({
        namespaceId,
        id: prepared.id,
        status: 'failed',
        preparationOwnerToken: '11111111-1111-4111-8111-111111111111',
        failure: { ...failure, code: 'different_failure' },
      }),
    ).rejects.toMatchObject({ reason: 'terminal_body_mismatch' })
    await expect(
      v2Catalog.createOrReadSwiftStudioSession(
        swiftStudioSessionInput(namespaceId, '5'.repeat(64), 'session-after-failure'),
      ),
    ).resolves.toMatchObject({ row: { status: 'preparing' }, created: true })
  })

  test('renews and atomically claims abandoned preparation ownership while fencing stale owners', async () => {
    await v2Catalog.registerCommittedLayout(
      registration('alpha', [withParents(fixtureRevision('inputAlpha'))]),
    )
    const namespaceId = await v2Catalog.getOrCreateNamespace(v2Fixture.namespaceScope)
    const { row: prepared } = await v2Catalog.createOrReadSwiftStudioSession(
      swiftStudioSessionInput(namespaceId),
    )
    const staleToken = '11111111-1111-4111-8111-111111111111'

    await expect(
      v2Catalog.abandonSwiftStudioSessionPreparation(namespaceId, prepared.id, staleToken),
    ).resolves.toBe(false)
    await expect(
      v2Catalog.renewSwiftStudioSessionPreparation(namespaceId, prepared.id, staleToken),
    ).resolves.toBe(false)
    await expect(
      v2Catalog.abandonSwiftStudioSessionPreparation(
        namespaceId,
        prepared.id,
        prepared.preparationOwnerToken,
      ),
    ).resolves.toBe(true)
    const abandoned = await v2Catalog.getSwiftStudioSession(namespaceId, prepared.id)
    expect(abandoned?.preparationAbandonedAt).toBeInstanceOf(Date)
    await expect(
      v2Catalog.claimSwiftStudioSessionPreparation(
        namespaceId,
        prepared.id,
        prepared.preparationOwnerToken,
        60_000,
      ),
    ).resolves.toMatchObject({ claimed: false, row: { id: prepared.id } })

    await prisma.$executeRaw`
      UPDATE "swift_studio_sessions_v2"
      SET
        "preparation_abandoned_at" = "created_at",
        "preparation_expires_at" = clock_timestamp() + INTERVAL '1 minute'
      WHERE "id" = ${prepared.id}::uuid
    `
    await expect(
      v2Catalog.renewSwiftStudioSessionPreparation(
        namespaceId,
        prepared.id,
        prepared.preparationOwnerToken,
      ),
    ).resolves.toBe(true)
    const renewed = await v2Catalog.getSwiftStudioSession(namespaceId, prepared.id)
    expect(renewed).toMatchObject({ preparationAbandonedAt: null })
    expect((renewed?.preparationExpiresAt.getTime() ?? 0) - Date.now()).toBeGreaterThan(
      4 * 60 * 60 * 1_000,
    )

    await expect(
      v2Catalog.abandonSwiftStudioSessionPreparation(
        namespaceId,
        prepared.id,
        prepared.preparationOwnerToken,
      ),
    ).resolves.toBe(true)
    const claims = await Promise.all(
      Array.from({ length: 16 }, () =>
        v2Catalog.claimSwiftStudioSessionPreparation(
          namespaceId,
          prepared.id,
          prepared.preparationOwnerToken,
          0,
        ),
      ),
    )
    expect(claims.filter(({ claimed }) => claimed)).toHaveLength(1)
    const claimed = claims.find((result) => result.claimed)?.row
    expect(claimed).not.toBeNull()
    expect(claimed?.preparationOwnerToken).not.toBe(prepared.preparationOwnerToken)
    expect(claimed?.preparationAbandonedAt).toBeNull()
    expect(new Set(claims.map(({ row }) => row?.preparationOwnerToken ?? null))).toEqual(
      new Set([claimed?.preparationOwnerToken]),
    )

    await expect(
      v2Catalog.renewSwiftStudioSessionPreparation(
        namespaceId,
        prepared.id,
        prepared.preparationOwnerToken,
      ),
    ).resolves.toBe(false)
    await expect(
      v2Catalog.transitionSwiftStudioSession({
        namespaceId,
        id: prepared.id,
        status: 'ready',
        preparationOwnerToken: prepared.preparationOwnerToken,
        exportDigest: '6'.repeat(64),
        exportSizeBytes: 8_192n,
      }),
    ).rejects.toMatchObject({ reason: 'invalid_transition' })
    await expect(
      v2Catalog.transitionSwiftStudioSession({
        namespaceId,
        id: prepared.id,
        status: 'failed',
        preparationOwnerToken: prepared.preparationOwnerToken,
        failure: {
          phase: 'dataset_prepare',
          code: 'stale_owner',
          message: 'Stale owner must not terminate preparation',
        },
      }),
    ).rejects.toMatchObject({ reason: 'invalid_transition' })
    const claimedToken = claimed?.preparationOwnerToken
    if (!claimedToken) throw new Error('preparation claim did not return an owner token')
    const readyInput = {
      namespaceId,
      id: prepared.id,
      status: 'ready' as const,
      preparationOwnerToken: claimedToken,
      exportDigest: '6'.repeat(64),
      exportSizeBytes: 8_192n,
    }
    await expect(v2Catalog.transitionSwiftStudioSession(readyInput)).resolves.toMatchObject({
      status: 'ready',
    })
    await expect(
      v2Catalog.transitionSwiftStudioSession({
        ...readyInput,
        preparationOwnerToken: prepared.preparationOwnerToken,
      }),
    ).resolves.toMatchObject({ status: 'ready' })
    await expect(
      v2Catalog.abandonSwiftStudioSessionPreparation(namespaceId, prepared.id, claimedToken),
    ).resolves.toBe(false)
  })

  test('claims expired preparations and rejects malformed ownership inputs', async () => {
    await v2Catalog.registerCommittedLayout(
      registration('alpha', [withParents(fixtureRevision('inputAlpha'))]),
    )
    const namespaceId = await v2Catalog.getOrCreateNamespace(v2Fixture.namespaceScope)
    const { row: prepared } = await v2Catalog.createOrReadSwiftStudioSession(
      swiftStudioSessionInput(namespaceId),
    )
    await prisma.$executeRaw`
      UPDATE "swift_studio_sessions_v2"
      SET "preparation_expires_at" = "created_at"
      WHERE "id" = ${prepared.id}::uuid
    `
    await expect(
      v2Catalog.claimSwiftStudioSessionPreparation(
        namespaceId,
        prepared.id,
        prepared.preparationOwnerToken,
        310_000,
      ),
    ).resolves.toMatchObject({
      claimed: true,
      row: {
        id: prepared.id,
        status: 'preparing',
        preparationAbandonedAt: null,
      },
    })
    await expect(
      v2Catalog.renewSwiftStudioSessionPreparation(namespaceId, prepared.id, 'not-a-uuid'),
    ).rejects.toBeInstanceOf(V2CatalogInputError)
    await expect(
      v2Catalog.abandonSwiftStudioSessionPreparation(namespaceId, prepared.id, 'not-a-uuid'),
    ).rejects.toBeInstanceOf(V2CatalogInputError)
    await expect(
      v2Catalog.claimSwiftStudioSessionPreparation(
        namespaceId,
        prepared.id,
        prepared.preparationOwnerToken,
        -1,
      ),
    ).rejects.toBeInstanceOf(V2CatalogInputError)
  })

  test('linearizes preparation renewal against an expired-owner claim', async () => {
    await v2Catalog.registerCommittedLayout(
      registration('alpha', [withParents(fixtureRevision('inputAlpha'))]),
    )
    const namespaceId = await v2Catalog.getOrCreateNamespace(v2Fixture.namespaceScope)
    const { row: prepared } = await v2Catalog.createOrReadSwiftStudioSession(
      swiftStudioSessionInput(namespaceId),
    )
    await prisma.$executeRaw`
      UPDATE "swift_studio_sessions_v2"
      SET "preparation_expires_at" = "created_at"
      WHERE "id" = ${prepared.id}::uuid
    `
    const [renewed, claim] = await Promise.all([
      v2Catalog.renewSwiftStudioSessionPreparation(
        namespaceId,
        prepared.id,
        prepared.preparationOwnerToken,
      ),
      v2Catalog.claimSwiftStudioSessionPreparation(
        namespaceId,
        prepared.id,
        prepared.preparationOwnerToken,
        0,
      ),
    ])
    expect(Number(renewed) + Number(claim.claimed)).toBe(1)
    const current = await v2Catalog.getSwiftStudioSession(namespaceId, prepared.id)
    expect(current).toMatchObject({ status: 'preparing', preparationAbandonedAt: null })
    expect((current?.preparationExpiresAt.getTime() ?? 0) - Date.now()).toBeGreaterThan(
      4 * 60 * 60 * 1_000,
    )
    expect(current?.preparationOwnerToken === prepared.preparationOwnerToken).toBe(renewed)
  })
})

describe('V2Catalog LoRA Model Artifacts', () => {
  async function readyStudioSession() {
    const namespaceId = await v2Catalog.getOrCreateNamespace(v2Fixture.namespaceScope)
    await v2Catalog.registerCommittedLayout(
      registration('alpha', [withParents(fixtureRevision('inputAlpha'))]),
    )
    const { row: preparing } = await v2Catalog.createOrReadSwiftStudioSession(
      swiftStudioSessionInput(namespaceId),
    )
    const ready = await v2Catalog.transitionSwiftStudioSession({
      namespaceId,
      id: preparing.id,
      preparationOwnerToken: preparing.preparationOwnerToken,
      status: 'ready',
      exportDigest: 'f'.repeat(64),
      exportSizeBytes: 4_096n,
    })
    if (!ready) throw new Error('Studio Session did not become ready')
    return { namespaceId, session: ready }
  }

  test('replays one import identity and atomically finalizes an immutable Artifact', async () => {
    const { namespaceId, session } = await readyStudioSession()
    const create = {
      namespaceId,
      createDigest: '0'.repeat(64),
      studioSessionId: session.id,
      outputHandleDigest: '1'.repeat(64),
      artifactKind: 'lora_adapter' as const,
      displayName: 'customer-service-lora',
      baseModelReference: 'Qwen/Qwen3-0.6B',
      baseModelRevision: '0123456789abcdef',
    }
    const creates = await Promise.all(
      Array.from({ length: 16 }, () => v2Catalog.createOrReadModelArtifactImport(create)),
    )
    expect(new Set(creates.map((result) => result.row.id))).toHaveLength(1)
    expect(creates.filter((result) => result.created)).toHaveLength(1)
    const requested = creates[0]?.row
    if (!requested) throw new Error('Model Artifact import was not created')
    await expect(
      v2Catalog.transitionSwiftStudioSession({
        namespaceId,
        id: session.id,
        status: 'closing',
      }),
    ).rejects.toMatchObject({ reason: 'invalid_transition', status: 'ready' })

    const stagingInput = {
      namespaceId,
      id: requested.id,
      status: 'staging' as const,
      providerImportId: `swai_${'A'.repeat(32)}`,
      outputSnapshotDigest: '3'.repeat(64),
    }
    await expect(v2Catalog.transitionModelArtifactImport(stagingInput)).resolves.toMatchObject({
      status: 'staging',
    })
    await expect(v2Catalog.transitionModelArtifactImport(stagingInput)).resolves.toMatchObject({
      status: 'staging',
    })

    const finalizingInput = {
      namespaceId,
      id: requested.id,
      status: 'finalizing' as const,
      stagingObjectKey: `staging/swift-artifact/v1/${requested.id}/archive.tar.zst`,
      archiveDigest: '4'.repeat(64),
      archiveSizeBytes: 1_024n,
      manifestDigest: '5'.repeat(64),
      manifest: modelArtifactManifest(session.id),
      datasetLineageStatus: 'verified' as const,
      datasetVersion: fixtureVersion('alpha'),
      datasetExportDigest: 'f'.repeat(64),
      baseModelBindingStatus: 'verified' as const,
    }
    await expect(v2Catalog.transitionModelArtifactImport(finalizingInput)).resolves.toMatchObject({
      status: 'finalizing',
      archiveDigest: '4'.repeat(64),
    })
    await expect(v2Catalog.transitionModelArtifactImport(stagingInput)).resolves.toMatchObject({
      status: 'finalizing',
    })
    const objectLocator = `objects/v2/model-artifact-v1/44/${'4'.repeat(64)}.tar.zst`
    const completed = await v2Catalog.finalizeModelArtifactImport({
      namespaceId,
      id: requested.id,
      objectLocator,
    })
    expect(completed).toMatchObject({
      artifactImport: { status: 'completed' },
      artifact: {
        artifactKind: 'lora_adapter',
        artifactFormat: 'swift-lora-adapter-v1',
        archiveFormat: 'deterministic-tar-zst-v1',
        archiveDigest: '4'.repeat(64),
        datasetLineageStatus: 'verified',
        datasetVersion: fixtureVersion('alpha'),
      },
    })
    await expect(
      v2Catalog.finalizeModelArtifactImport({
        namespaceId,
        id: requested.id,
        objectLocator,
      }),
    ).resolves.toMatchObject({
      artifactImport: { id: requested.id, status: 'completed' },
      artifact: { id: completed?.artifact.id },
    })
    const cleaned = await v2Catalog.markModelArtifactImportStagingCleaned(namespaceId, requested.id)
    expect(cleaned).toMatchObject({ status: 'completed' })
    expect(cleaned?.stagingCleanedAt).toBeInstanceOf(Date)
    await expect(
      v2Catalog.markModelArtifactImportStagingCleaned(namespaceId, requested.id),
    ).resolves.toMatchObject({ stagingCleanedAt: cleaned?.stagingCleanedAt })
    await expect(
      v2Catalog.getModelArtifact(namespaceId, completed?.artifact.id ?? ''),
    ).resolves.toMatchObject({ archiveDigest: '4'.repeat(64) })
    await expect(
      v2Catalog.listModelArtifacts(
        namespaceId,
        {
          datasetVersion: fixtureVersion('alpha'),
          artifactKind: 'lora_adapter',
          registrationStatus: 'all',
        },
        null,
        20,
      ),
    ).resolves.toMatchObject({ rows: [{ id: completed?.artifact.id }], nextCursor: null })
    await expect(
      v2Catalog.transitionSwiftStudioSession({
        namespaceId,
        id: session.id,
        status: 'closing',
      }),
    ).resolves.toMatchObject({ status: 'closing' })
    await expect(
      v2Catalog.transitionSwiftStudioSession({
        namespaceId,
        id: session.id,
        status: 'closed',
      }),
    ).resolves.toMatchObject({ status: 'closed' })
    await expect(v2Catalog.createOrReadModelArtifactImport(create)).resolves.toMatchObject({
      created: false,
      row: { id: requested.id, status: 'completed' },
    })
    await expect(
      v2Catalog.createOrReadModelArtifactImport({
        ...create,
        createDigest: 'a'.repeat(64),
        outputHandleDigest: 'b'.repeat(64),
      }),
    ).rejects.toBeInstanceOf(V2CatalogInputError)
  })

  test('keeps failed imports terminal and rejects unverified Dataset inheritance', async () => {
    const { namespaceId, session } = await readyStudioSession()
    const { row } = await v2Catalog.createOrReadModelArtifactImport({
      namespaceId,
      createDigest: '6'.repeat(64),
      studioSessionId: session.id,
      outputHandleDigest: '7'.repeat(64),
      artifactKind: 'lora_adapter',
      displayName: 'failed-lora',
      baseModelReference: 'Qwen/Qwen3-0.6B',
      baseModelRevision: null,
    })
    const failure = {
      namespaceId,
      id: row.id,
      status: 'failed' as const,
      failure: { phase: 'provider', code: 'archive_failed', message: 'archive failed safely' },
    }
    await expect(v2Catalog.transitionModelArtifactImport(failure)).resolves.toMatchObject({
      status: 'failed',
    })
    await expect(
      v2Catalog.markModelArtifactImportStagingCleaned(namespaceId, row.id),
    ).resolves.toMatchObject({ status: 'failed', stagingCleanedAt: expect.any(Date) })
    await expect(v2Catalog.transitionModelArtifactImport(failure)).resolves.toMatchObject({
      status: 'failed',
    })
    await expect(
      v2Catalog.transitionModelArtifactImport({
        ...failure,
        failure: { ...failure.failure, message: 'different terminal body' },
      }),
    ).rejects.toThrow()

    const { row: another } = await v2Catalog.createOrReadModelArtifactImport({
      namespaceId,
      createDigest: '8'.repeat(64),
      studioSessionId: session.id,
      outputHandleDigest: '9'.repeat(64),
      artifactKind: 'lora_adapter',
      displayName: 'unverified-lora',
      baseModelReference: 'Qwen/Qwen3-0.6B',
      baseModelRevision: 'main',
    })
    await v2Catalog.transitionModelArtifactImport({
      namespaceId,
      id: another.id,
      status: 'staging',
      providerImportId: `swai_${'B'.repeat(32)}`,
      outputSnapshotDigest: '3'.repeat(64),
    })
    await expect(
      v2Catalog.transitionModelArtifactImport({
        namespaceId,
        id: another.id,
        status: 'finalizing',
        stagingObjectKey: `staging/swift-artifact/v1/${another.id}/archive.tar.zst`,
        archiveDigest: '4'.repeat(64),
        archiveSizeBytes: 1_024n,
        manifestDigest: '5'.repeat(64),
        manifest: modelArtifactManifest(session.id),
        datasetLineageStatus: 'external_or_unverified',
        datasetVersion: fixtureVersion('alpha'),
        datasetExportDigest: 'f'.repeat(64),
        baseModelBindingStatus: 'verified',
      }),
    ).rejects.toThrow()
  })

  test('preserves distinct provenance rows for imports with identical archive bytes', async () => {
    const { namespaceId, session } = await readyStudioSession()
    const objectLocator = `objects/v2/model-artifact-v1/44/${'4'.repeat(64)}.tar.zst`

    const finalize = async (identityDigit: string, providerLetter: string) => {
      const { row } = await v2Catalog.createOrReadModelArtifactImport({
        namespaceId,
        createDigest: identityDigit.repeat(64),
        studioSessionId: session.id,
        outputHandleDigest: (identityDigit === 'a' ? 'b' : 'd').repeat(64),
        artifactKind: 'lora_adapter',
        displayName: `shared-bytes-${identityDigit}`,
        baseModelReference: 'Qwen/Qwen3-0.6B',
        baseModelRevision: '0123456789abcdef',
      })
      await v2Catalog.transitionModelArtifactImport({
        namespaceId,
        id: row.id,
        status: 'staging',
        providerImportId: `swai_${providerLetter.repeat(32)}`,
        outputSnapshotDigest: '3'.repeat(64),
      })
      await v2Catalog.transitionModelArtifactImport({
        namespaceId,
        id: row.id,
        status: 'finalizing',
        stagingObjectKey: `staging/swift-artifact/v1/${row.id}/archive.tar.zst`,
        archiveDigest: '4'.repeat(64),
        archiveSizeBytes: 1_024n,
        manifestDigest: '5'.repeat(64),
        manifest: modelArtifactManifest(session.id),
        datasetLineageStatus: 'verified',
        datasetVersion: fixtureVersion('alpha'),
        datasetExportDigest: 'f'.repeat(64),
        baseModelBindingStatus: 'verified',
      })
      return await v2Catalog.finalizeModelArtifactImport({
        namespaceId,
        id: row.id,
        objectLocator,
      })
    }

    const first = await finalize('a', 'C')
    const second = await finalize('c', 'D')
    expect(first?.artifactImport.status).toBe('completed')
    expect(second?.artifactImport.status).toBe('completed')
    expect(first?.artifact.archiveDigest).toBe(second?.artifact.archiveDigest)
    expect(first?.artifact.objectLocator).toBe(second?.artifact.objectLocator)
    expect(first?.artifact.id).not.toBe(second?.artifact.id)
    expect(first?.artifact.sourceImportId).not.toBe(second?.artifact.sourceImportId)
  })
})

describe('V2Catalog Model Deployments', () => {
  test('requires an immutable Artifact FK and replays the exact create identity', async () => {
    const namespaceId = await v2Catalog.getOrCreateNamespace(v2Fixture.namespaceScope)
    await expect(
      v2Catalog.createOrReadModelDeployment(
        modelDeploymentInput(namespaceId, '99999999-9999-4999-8999-999999999999'),
      ),
    ).rejects.toThrow()

    const { artifact } = await finalizedModelArtifact()
    const input = modelDeploymentInput(namespaceId, artifact.id)
    const deployments = await Promise.all(
      Array.from({ length: 16 }, () => v2Catalog.createOrReadModelDeployment(input)),
    )
    expect(new Set(deployments.map((deployment) => deployment.id))).toHaveLength(1)
    expect(await prisma.v2ModelDeployment.count()).toBe(1)
    const deployment = deployments[0]
    if (!deployment) throw new Error('Model Deployment was not created')
    await expect(v2Catalog.getModelDeployment(namespaceId, deployment.id)).resolves.toMatchObject({
      id: deployment.id,
      artifactId: artifact.id,
      status: 'active',
      healthStatus: 'unknown',
    })
    await expect(
      v2Catalog.listModelDeployments(
        namespaceId,
        { artifactId: artifact.id, status: 'active' },
        null,
        20,
      ),
    ).resolves.toMatchObject({ rows: [{ id: deployment.id }], nextCursor: null })
    await expect(
      v2Catalog.createOrReadModelDeployment({
        ...input,
        servedModelName: 'different-model',
      }),
    ).rejects.toBeInstanceOf(V2CatalogConsistencyError)
    await expect(prisma.v2ModelArtifact.delete({ where: { id: artifact.id } })).rejects.toThrow()
  })

  test('records bounded health observations and disables idempotently', async () => {
    const { namespaceId, artifact } = await finalizedModelArtifact()
    const deployment = await v2Catalog.createOrReadModelDeployment(
      modelDeploymentInput(namespaceId, artifact.id),
    )
    await expect(
      v2Catalog.updateModelDeploymentHealth(namespaceId, deployment.id, {
        status: 'healthy',
        error: null,
      }),
    ).resolves.toMatchObject({ healthStatus: 'healthy', healthError: null })
    await expect(
      v2Catalog.updateModelDeploymentHealth(namespaceId, deployment.id, {
        status: 'unhealthy',
        error: 'served_model_missing',
      }),
    ).resolves.toMatchObject({
      healthStatus: 'unhealthy',
      healthError: 'served_model_missing',
    })
    await expect(
      v2Catalog.updateModelDeploymentHealth(namespaceId, deployment.id, {
        status: 'healthy',
        error: 'unexpected',
      }),
    ).rejects.toBeInstanceOf(V2CatalogInputError)

    const first = await v2Catalog.disableModelDeployment(namespaceId, deployment.id)
    const second = await v2Catalog.disableModelDeployment(namespaceId, deployment.id)
    expect(first).toMatchObject({ status: 'disabled', disabledAt: expect.any(Date) })
    expect(second).toMatchObject({ status: 'disabled', disabledAt: first?.disabledAt })
  })

  test('rejects new runs after disable but preserves provider-task replay', async () => {
    const { namespaceId, artifact } = await finalizedModelArtifact()
    const deployment = await v2Catalog.createOrReadModelDeployment(
      modelDeploymentInput(namespaceId, artifact.id),
    )
    const firstInput = deploymentEvaluationRunInput(namespaceId, deployment, 'task-before-disable')
    const first = await v2Catalog.createOrReadEvaluationRun(firstInput)
    await v2Catalog.disableModelDeployment(namespaceId, deployment.id)
    await expect(v2Catalog.createOrReadEvaluationRun(firstInput)).resolves.toMatchObject({
      id: first.id,
      modelDeploymentId: deployment.id,
      modelArtifactId: artifact.id,
    })
    await expect(
      v2Catalog.createOrReadEvaluationRun(
        deploymentEvaluationRunInput(namespaceId, deployment, 'task-after-disable'),
      ),
    ).rejects.toBeInstanceOf(V2CatalogModelDeploymentAdmissionError)
  })

  test('serializes disable against deployment-bound run admission', async () => {
    const { namespaceId, artifact } = await finalizedModelArtifact()
    const deployment = await v2Catalog.createOrReadModelDeployment(
      modelDeploymentInput(namespaceId, artifact.id),
    )
    const runInput = deploymentEvaluationRunInput(namespaceId, deployment, 'task-disable-race')
    const [admission, disabled] = await Promise.allSettled([
      v2Catalog.createOrReadEvaluationRun(runInput),
      v2Catalog.disableModelDeployment(namespaceId, deployment.id),
    ])
    expect(disabled.status).toBe('fulfilled')
    await expect(v2Catalog.getModelDeployment(namespaceId, deployment.id)).resolves.toMatchObject({
      status: 'disabled',
    })
    const stored = await prisma.v2EvaluationRun.findFirst({
      where: { providerTaskId: runInput.providerTaskId },
    })
    if (admission.status === 'fulfilled') {
      expect(stored?.id).toBe(admission.value.id)
      await expect(v2Catalog.createOrReadEvaluationRun(runInput)).resolves.toMatchObject({
        id: admission.value.id,
      })
    } else {
      expect(admission.reason).toBeInstanceOf(V2CatalogModelDeploymentAdmissionError)
      expect(stored).toBeNull()
    }
  })
})

describe('V2Catalog transform jobs', () => {
  test('creates one deterministic job for concurrent requests with the same cache key', async () => {
    await v2Catalog.registerCommittedLayout(
      registration('alpha', [withParents(fixtureRevision('inputAlpha'))]),
    )
    const input = transformJobInput('6'.repeat(64))
    const rows = await Promise.all(
      Array.from({ length: 16 }, () => v2Catalog.createOrReadTransformJob(input)),
    )

    expect(new Set(rows.map(({ id }) => id))).toEqual(new Set([input.id]))
    expect(rows.every(({ status }) => status === 'queued')).toBe(true)
    expect(await prisma.v2TransformJob.count()).toBe(1)
  })

  test('lists recent jobs with a stable millisecond timestamp and ID cursor', async () => {
    await v2Catalog.registerCommittedLayout(
      registration('alpha', [withParents(fixtureRevision('inputAlpha'))]),
    )
    await Promise.all(
      ['3', '4', '5'].map((digit) =>
        v2Catalog.createOrReadTransformJob(transformJobInput(digit.repeat(64))),
      ),
    )

    const first = await v2Catalog.listTransformJobs(null, 2)
    expect(first.rows).toHaveLength(2)
    expect(first.nextCursor).not.toBeNull()
    const second = await v2Catalog.listTransformJobs(first.nextCursor, 2)
    expect(second.rows).toHaveLength(1)
    expect(second.nextCursor).toBeNull()
    expect(new Set([...first.rows, ...second.rows].map(({ id }) => id))).toEqual(
      new Set(['3', '4', '5'].map((digit) => `job_${digit.repeat(64)}`)),
    )
  })

  test('claims one global slot and fences stale lease events with the database clock', async () => {
    await v2Catalog.registerCommittedLayout(
      registration('alpha', [withParents(fixtureRevision('inputAlpha'))]),
    )
    await Promise.all([
      v2Catalog.createOrReadTransformJob(transformJobInput('6'.repeat(64))),
      v2Catalog.createOrReadTransformJob(transformJobInput('7'.repeat(64))),
    ])

    const claims = await Promise.all(
      Array.from({ length: 8 }, () =>
        v2Catalog.claimNextTransformJob({ leaseOwner: 'dispatcher.test', leaseDurationMs: 30_000 }),
      ),
    )
    const claimed = claims.filter((row) => row !== null)
    expect(claimed).toHaveLength(1)
    const lease = claimed[0]
    if (!lease?.leaseToken) throw new Error('claim did not return a lease token')
    expect(lease).toMatchObject({ status: 'leased', attempt: 1, leaseOwner: 'dispatcher.test' })

    const current = { id: lease.id, attempt: lease.attempt, leaseToken: lease.leaseToken }
    expect(await v2Catalog.markTransformJobRunning(current)).toMatchObject({ status: 'running' })
    await expect(
      v2Catalog.updateTransformJobProgress({
        ...current,
        progress: { phase: 'processing', completedUnits: 1n, totalUnits: 2n },
      }),
    ).resolves.toBe(true)
    await expect(v2Catalog.renewTransformJobLease(current, 30_000)).resolves.toBe(true)

    const stale = { ...current, leaseToken: new Uint8Array(32).fill(9) }
    await expect(v2Catalog.renewTransformJobLease(stale, 30_000)).resolves.toBe(false)
    await expect(v2Catalog.markTransformJobFinalizing(stale)).resolves.toBeNull()

    await prisma.$executeRaw`
      UPDATE "transform_jobs_v2"
      SET "lease_expires_at" = clock_timestamp() - INTERVAL '1 millisecond'
      WHERE "id" = ${current.id}
    `
    await expect(v2Catalog.renewTransformJobLease(current, 30_000)).resolves.toBe(false)
    await expect(v2Catalog.failExpiredTransformJobLeases()).resolves.toBe(1)
    await expect(v2Catalog.getTransformJob(current.id)).resolves.toMatchObject({
      status: 'failed',
      error: { code: 'lease_expired' },
      leaseToken: current.leaseToken,
    })
    await expect(v2Catalog.markTransformJobRunning(current)).resolves.toBeNull()
  })

  test('keeps cancellation as a cleanup fence and retries only after the exact fence clears', async () => {
    await v2Catalog.registerCommittedLayout(
      registration('alpha', [withParents(fixtureRevision('inputAlpha'))]),
    )
    const queued = await v2Catalog.createOrReadTransformJob(transformJobInput('8'.repeat(64)))
    const claimed = await v2Catalog.claimNextTransformJob({
      leaseOwner: 'dispatcher.test',
      leaseDurationMs: 30_000,
    })
    if (!claimed?.leaseToken) throw new Error('claim did not return a lease token')
    const lease = { id: claimed.id, attempt: claimed.attempt, leaseToken: claimed.leaseToken }
    const inputKey = `staging/worker/v1/${lease.id}/${lease.attempt}/input.jsonl`
    const outputKey = `staging/worker/v1/${lease.id}/${lease.attempt}/output.jsonl`
    const stale = { ...lease, leaseToken: new Uint8Array(32).fill(4) }

    await expect(
      v2Catalog.setTransformJobStagingKeys({ ...stale, inputKey, outputKey }),
    ).resolves.toBe(false)
    await expect(
      v2Catalog.setTransformJobStagingKeys({
        ...lease,
        inputKey: `${inputKey}/../wrong`,
        outputKey,
      }),
    ).rejects.toThrow('exact attempt')
    await expect(
      v2Catalog.setTransformJobStagingKeys({ ...lease, inputKey, outputKey }),
    ).resolves.toBe(true)
    await expect(v2Catalog.getTransformJob(lease.id)).resolves.toMatchObject({
      inputKey,
      outputKey,
    })

    await expect(v2Catalog.requestTransformJobCancellation(queued.id)).resolves.toMatchObject({
      status: 'cancelled',
      leaseToken: lease.leaseToken,
    })
    await expect(
      v2Catalog.claimNextTransformJob({
        leaseOwner: 'dispatcher.test',
        leaseDurationMs: 30_000,
      }),
    ).resolves.toBeNull()
    await expect(v2Catalog.retryTransformJob(queued.id)).resolves.toBeNull()
    await expect(v2Catalog.clearTransformJobStagingKeys(stale)).resolves.toBe(false)
    await expect(v2Catalog.clearTransformJobLeaseFence(stale)).resolves.toBe(false)
    await expect(v2Catalog.clearTransformJobLeaseFence(lease)).resolves.toBe(false)
    await expect(v2Catalog.retryTransformJob(queued.id)).resolves.toBeNull()
    await expect(v2Catalog.clearTransformJobStagingKeys(lease)).resolves.toBe(true)
    await expect(v2Catalog.retryTransformJob(queued.id)).resolves.toBeNull()
    await expect(v2Catalog.clearTransformJobLeaseFence(lease)).resolves.toBe(true)
    await expect(v2Catalog.retryTransformJob(queued.id)).resolves.toMatchObject({
      id: queued.id,
      status: 'queued',
      attempt: 1,
      leaseToken: null,
    })
  })

  test('database rejects staging keys that do not exactly match the current attempt', async () => {
    await v2Catalog.registerCommittedLayout(
      registration('alpha', [withParents(fixtureRevision('inputAlpha'))]),
    )
    const queued = await v2Catalog.createOrReadTransformJob(transformJobInput('b'.repeat(64)))
    const claimed = await v2Catalog.claimNextTransformJob({
      leaseOwner: 'dispatcher.test',
      leaseDurationMs: 30_000,
    })
    if (!claimed?.leaseToken) throw new Error('claim did not return a lease token')

    for (const inputKey of [
      'input.jsonl',
      `staging/worker/v1/${queued.id}/2/input.jsonl`,
      `staging/worker/v1/${queued.id}/1/../input.jsonl`,
    ]) {
      await expect(
        prisma.$executeRaw`
          UPDATE "transform_jobs_v2"
          SET "input_key" = ${inputKey},
              "output_key" = ${`staging/worker/v1/${queued.id}/1/output.jsonl`}
          WHERE "id" = ${queued.id}
        `,
      ).rejects.toThrow()
    }
  })

  test('atomically completes a finalizing job and keeps completion and staging cleanup idempotent', async () => {
    const input = registration('alpha', [withParents(fixtureRevision('inputAlpha'))])
    const output = registration('gamma', [withParents(fixtureRevision('output'))])
    await v2Catalog.registerCommittedLayout(input)
    const cacheKey = 'c'.repeat(64)
    const lease = await claimFinalizingJob(cacheKey)
    const run = {
      id: `run_${cacheKey}`,
      cacheKey,
      op: 'basic-clean',
      opVersion: '1',
      params: {},
      inputVersions: [input.snapshot.version],
      outputVersion: output.snapshot.version,
    }
    const completion = { ...output, run, job: lease, outputCount: 1n }

    const completed = await v2Catalog.completeTransformJob(completion)
    expect(completed).toMatchObject({
      status: 'completed',
      outputCount: 1n,
      outputVersion: output.snapshot.version,
      cacheHit: false,
      leaseToken: null,
    })
    expect(completed.inputKey).not.toBeNull()
    expect(completed.outputKey).not.toBeNull()
    await expect(v2Catalog.completeTransformJob(completion)).resolves.toMatchObject({
      status: 'completed',
      outputVersion: output.snapshot.version,
    })
    await expect(v2Catalog.findRun(cacheKey)).resolves.toMatchObject(run)

    if (!completed.inputKey || !completed.outputKey) {
      throw new Error('completed job did not retain exact staging keys')
    }
    const cleanup = {
      id: completed.id,
      attempt: completed.attempt,
      outputVersion: output.snapshot.version,
      inputKey: completed.inputKey,
      outputKey: completed.outputKey,
    }
    await expect(v2Catalog.clearCompletedTransformJobStagingKeys(cleanup)).resolves.toBe(true)
    await expect(v2Catalog.clearCompletedTransformJobStagingKeys(cleanup)).resolves.toBe(true)
    await expect(v2Catalog.getTransformJob(completed.id)).resolves.toMatchObject({
      inputKey: null,
      outputKey: null,
    })
  })

  test('creates a requested result ref at completion and reports a create-only conflict without overwriting', async () => {
    const input = registration('alpha', [withParents(fixtureRevision('inputAlpha'))])
    const firstOutput = registration('gamma', [withParents(fixtureRevision('output'))])
    const secondOutput = registration('delta', [withParents(fixtureRevision('outputDelta'))])
    await v2Catalog.registerCommittedLayout(input)
    const namespaceId = await v2Catalog.getOrCreateNamespace(v2Fixture.namespaceScope)
    const resultRef = { namespaceId, name: 'clean-result' }

    const firstCacheKey = '1'.repeat(64)
    const firstLease = await claimFinalizingJob(firstCacheKey, resultRef)
    await expect(v2Catalog.getTransformJob(firstLease.id)).resolves.toMatchObject({
      resultRef: { ...resultRef, status: 'pending', version: null },
    })
    await expect(
      v2Catalog.completeTransformJob({
        ...firstOutput,
        run: {
          id: `run_${firstCacheKey}`,
          cacheKey: firstCacheKey,
          op: 'basic-clean',
          opVersion: '1',
          params: {},
          inputVersions: [input.snapshot.version],
          outputVersion: firstOutput.snapshot.version,
        },
        job: firstLease,
        outputCount: 1n,
      }),
    ).resolves.toMatchObject({
      status: 'completed',
      resultRef: {
        ...resultRef,
        status: 'updated',
        version: firstOutput.snapshot.version,
      },
    })
    await expect(v2Catalog.getRef(namespaceId, resultRef.name)).resolves.toMatchObject({
      version: firstOutput.snapshot.version,
    })

    const secondCacheKey = '2'.repeat(64)
    const secondLease = await claimFinalizingJob(secondCacheKey, resultRef)
    await expect(
      v2Catalog.completeTransformJob({
        ...secondOutput,
        run: {
          id: `run_${secondCacheKey}`,
          cacheKey: secondCacheKey,
          op: 'basic-clean',
          opVersion: '1',
          params: {},
          inputVersions: [input.snapshot.version],
          outputVersion: secondOutput.snapshot.version,
        },
        job: secondLease,
        outputCount: 1n,
      }),
    ).resolves.toMatchObject({
      status: 'completed',
      resultRef: {
        ...resultRef,
        status: 'conflict',
        version: firstOutput.snapshot.version,
      },
    })
    await expect(v2Catalog.getRef(namespaceId, resultRef.name)).resolves.toMatchObject({
      version: firstOutput.snapshot.version,
    })
  })

  test('rolls back canonical metadata for stale, expired, and non-finalizing completions', async () => {
    const input = registration('alpha', [withParents(fixtureRevision('inputAlpha'))])
    const output = registration('gamma', [withParents(fixtureRevision('output'))])
    await v2Catalog.registerCommittedLayout(input)
    const cacheKey = 'd'.repeat(64)
    await v2Catalog.createOrReadTransformJob(transformJobInput(cacheKey))
    const claimed = await v2Catalog.claimNextTransformJob({
      leaseOwner: 'dispatcher.test',
      leaseDurationMs: 30_000,
    })
    if (!claimed?.leaseToken) throw new Error('claim did not return a lease token')
    const lease = { id: claimed.id, attempt: claimed.attempt, leaseToken: claimed.leaseToken }
    const prefix = `staging/worker/v1/${lease.id}/${lease.attempt}`
    await v2Catalog.setTransformJobStagingKeys({
      ...lease,
      inputKey: `${prefix}/input.jsonl`,
      outputKey: `${prefix}/output.jsonl`,
    })
    const completion = {
      ...output,
      run: {
        id: `run_${cacheKey}`,
        cacheKey,
        op: 'basic-clean',
        opVersion: '1',
        params: {},
        inputVersions: [input.snapshot.version],
        outputVersion: output.snapshot.version,
      },
      job: lease,
      outputCount: 1n,
    }

    await expect(
      v2Catalog.completeTransformJob({ ...completion, outputCount: 0n }),
    ).rejects.toBeInstanceOf(V2CatalogInputError)
    await expect(v2Catalog.completeTransformJob(completion)).rejects.toBeInstanceOf(
      V2CatalogTransformJobLeaseError,
    )
    await v2Catalog.markTransformJobRunning(lease)
    await v2Catalog.markTransformJobFinalizing(lease)
    await expect(
      v2Catalog.completeTransformJob({
        ...completion,
        job: { ...lease, leaseToken: new Uint8Array(32).fill(4) },
      }),
    ).rejects.toBeInstanceOf(V2CatalogTransformJobLeaseError)
    expect(await v2Catalog.getSnapshot(output.snapshot.version)).toBeNull()
    expect(await v2Catalog.findRun(cacheKey)).toBeNull()

    await prisma.$executeRaw`
      UPDATE "transform_jobs_v2"
      SET "lease_expires_at" = clock_timestamp() - INTERVAL '1 millisecond'
      WHERE "id" = ${lease.id}
    `
    await expect(v2Catalog.completeTransformJob(completion)).rejects.toBeInstanceOf(
      V2CatalogTransformJobLeaseError,
    )
    expect(await v2Catalog.getSnapshot(output.snapshot.version)).toBeNull()
    expect(await v2Catalog.findRun(cacheKey)).toBeNull()
  })

  test('converges on an identical winning run and rejects a different deterministic output', async () => {
    const input = registration('alpha', [withParents(fixtureRevision('inputAlpha'))])
    const firstOutput = registration('gamma', [withParents(fixtureRevision('output'))])
    const differentOutput = registration('delta', [withParents(fixtureRevision('outputDelta'))])
    await v2Catalog.registerCommittedLayout(input)

    const identicalCacheKey = 'e'.repeat(64)
    const identicalLease = await claimFinalizingJob(identicalCacheKey)
    const identicalRun = {
      id: `run_${identicalCacheKey}`,
      cacheKey: identicalCacheKey,
      op: 'basic-clean',
      opVersion: '1',
      params: {},
      inputVersions: [input.snapshot.version],
      outputVersion: firstOutput.snapshot.version,
    }
    await v2Catalog.registerTransformResult({ ...firstOutput, run: identicalRun })
    await expect(
      v2Catalog.completeTransformJob({
        ...firstOutput,
        run: identicalRun,
        job: identicalLease,
        outputCount: 1n,
      }),
    ).resolves.toMatchObject({ status: 'completed', cacheHit: true })

    await prisma.v2TransformJob.deleteMany()
    const conflictingCacheKey = 'f'.repeat(64)
    const conflictingLease = await claimFinalizingJob(conflictingCacheKey)
    const winningRun = {
      ...identicalRun,
      id: `run_${conflictingCacheKey}`,
      cacheKey: conflictingCacheKey,
    }
    await v2Catalog.registerTransformResult({ ...firstOutput, run: winningRun })
    await expect(
      v2Catalog.completeTransformJob({
        ...differentOutput,
        run: { ...winningRun, outputVersion: differentOutput.snapshot.version },
        job: conflictingLease,
        outputCount: 1n,
      }),
    ).rejects.toBeInstanceOf(V2CatalogDeterminismConflictError)
    expect(await v2Catalog.getSnapshot(differentOutput.snapshot.version)).toBeNull()
    await expect(v2Catalog.getTransformJob(conflictingLease.id)).resolves.toMatchObject({
      status: 'finalizing',
      outputVersion: null,
    })
  })

  test('materializes cache-hit jobs only from an existing matching immutable run', async () => {
    const input = registration('alpha', [withParents(fixtureRevision('inputAlpha'))])
    const output = registration('gamma', [withParents(fixtureRevision('output'))])
    await v2Catalog.registerCommittedLayout(input)
    const cacheKey = '9'.repeat(64)
    await v2Catalog.registerTransformResult({
      ...output,
      run: {
        id: `run_${cacheKey}`,
        cacheKey,
        op: 'basic-clean',
        opVersion: '1',
        params: {},
        inputVersions: [input.snapshot.version],
        outputVersion: output.snapshot.version,
      },
    })

    await expect(
      v2Catalog.createOrReadTransformJob(transformJobInput(cacheKey)),
    ).resolves.toMatchObject({
      id: `job_${cacheKey}`,
      status: 'completed',
      outputVersion: output.snapshot.version,
      outputCount: 1n,
      cacheHit: true,
      attempt: 0,
    })

    const namespaceId = await v2Catalog.getOrCreateNamespace(v2Fixture.namespaceScope)
    await expect(
      v2Catalog.createOrReadTransformJob({
        ...transformJobInput(cacheKey),
        resultRefNamespaceId: namespaceId,
        resultRefName: 'cached-clean-result',
      }),
    ).resolves.toMatchObject({
      status: 'completed',
      resultRef: {
        namespaceId,
        name: 'cached-clean-result',
        status: 'updated',
        version: output.snapshot.version,
      },
    })
    await expect(v2Catalog.getRef(namespaceId, 'cached-clean-result')).resolves.toMatchObject({
      version: output.snapshot.version,
    })

    const orphanCacheKey = 'a'.repeat(64)
    await prisma.v2TransformJob.create({
      data: {
        ...transformJobInput(orphanCacheKey),
        params: {},
        status: 'completed',
        outputVersion: input.snapshot.version,
        finishedAt: new Date(),
      },
    })
    await expect(
      v2Catalog.createOrReadTransformJob(transformJobInput(orphanCacheKey)),
    ).rejects.toBeInstanceOf(V2CatalogConsistencyError)
  })

  test('durably replays exact Model registrations and rejects digest/request mismatches', async () => {
    const namespaceId = await v2Catalog.getOrCreateNamespace('default')
    const input = modelRegistrationInput(namespaceId)

    const created = await v2Catalog.registerModelVersion(input)
    const replayed = await v2Catalog.registerModelVersion(input)

    expect(created).toMatchObject({ replayed: false })
    expect(replayed).toMatchObject({
      replayed: true,
      model: { id: created.model.id },
      version: { id: created.version.id },
      source: created.source,
    })
    expect(await prisma.v2Model.count()).toBe(1)
    expect(await prisma.v2ModelVersion.count()).toBe(1)
    expect(await prisma.v2ModelRegistrationClaim.count()).toBe(1)

    await expect(
      v2Catalog.registerModelVersion(
        modelRegistrationInput(namespaceId, {
          normalizedRequest: { target: 'create', version_label: 'changed', revision: 'abc123' },
        }),
      ),
    ).rejects.toMatchObject({
      name: 'V2CatalogModelRegistrationConflictError',
      reason: 'request_mismatch',
    })
    expect(await prisma.v2ModelRegistrationClaim.count()).toBe(1)
  })

  test('atomically registers version-bound Service Deployments, isolates legacy reads, and preserves lifecycle snapshots', async () => {
    const namespaceId = await v2Catalog.getOrCreateNamespace('default')
    const source = {
      kind: 'existing_service' as const,
      provider: 'openai_compatible' as const,
      externalModelRef: 'support-model',
      externalVersionRef: 'release-1',
      declaredReferenceKind: 'immutable_version' as const,
    }
    const registration = (
      suffix: '1' | '2',
      registrationDigit: '1' | '5',
      deploymentDigit: 'd' | 'e',
    ): CreateModelRegistrationV2 => {
      const modelId = `10000000-0000-8000-8000-00000000000${suffix}`
      const versionId = `20000000-0000-8000-8000-00000000000${suffix}`
      const deploymentId = `40000000-0000-8000-8000-00000000000${suffix}`
      return {
        ...modelRegistrationInput(namespaceId, {
          registrationDigest: registrationDigit.repeat(64),
          normalizedRequest: { model: suffix, source: 'same-service' },
          target: {
            kind: 'create_model',
            model: {
              id: modelId,
              namespaceId,
              key: `service-model-${suffix}`,
              createProfile: 'model-create-v1',
              createDigest: registrationDigit.repeat(64),
              displayName: `Service Model ${suffix}`,
              description: '',
              taskFamily: 'chat',
              tags: [],
            },
          },
          version: {
            id: versionId,
            modelId,
            sourceKind: 'existing_service',
            createProfile: 'model-version-create-service-v1',
            createDigest: `${suffix}`.repeat(64),
            sourceFingerprint: '3'.repeat(64),
          },
          source,
          deployment: {
            id: deploymentId,
            namespaceId,
            deploymentProfile: 'model-version-v1',
            createDigest: deploymentDigit.repeat(64),
            modelVersionId: versionId,
            artifactId: null,
            provider: 'openai_compatible',
            displayName: 'Shared endpoint',
            servedModelName: 'support-model',
            endpointBaseUrl: 'http://model-service:8000/v1',
            connectivityScope: 'private_network',
            authProfile: 'none',
            credentialRef: null,
            declaredCapabilities: {
              interfaces: ['chat_completions'],
              contextLimit: 8192,
            },
          },
        }),
        planProfile: 'model-registration-plan-service-v1',
      }
    }
    const firstInput = registration('1', '1', 'd')
    const secondInput = registration('2', '5', 'e')
    const [first, second] = await Promise.all([
      v2Catalog.registerModelVersion(firstInput),
      v2Catalog.registerModelVersion(secondInput),
    ])
    expect(first.deployment).toMatchObject({
      id: firstInput.deployment?.id,
      lifecycle: 'registered',
      artifactId: null,
    })
    expect(second.deployment?.id).not.toBe(first.deployment?.id)
    expect(first.version.sourceFingerprint).toBe(second.version.sourceFingerprint)
    expect(first.claim).toMatchObject({
      deploymentId: first.deployment?.id,
      deploymentDigest: first.deployment?.createDigest,
    })

    await expect(
      v2Catalog.getModelDeployment(namespaceId, first.deployment?.id ?? ''),
    ).resolves.toBeNull()
    await expect(
      v2Catalog.getModelVersionDeployment(namespaceId, first.deployment?.id ?? ''),
    ).resolves.toMatchObject({ deploymentProfile: 'model-version-v1' })
    await expect(
      v2Catalog.listModelVersionDeployments(namespaceId, first.version.id, 'registered', null, 20),
    ).resolves.toMatchObject({ rows: [{ id: first.deployment?.id }], nextCursor: null })

    const healthy = await v2Catalog.updateModelVersionDeploymentHealth(
      namespaceId,
      first.version.id,
      first.deployment?.id ?? '',
      { status: 'healthy', error: null },
    )
    expect(healthy).toMatchObject({ healthStatus: 'healthy' })
    const active = await v2Catalog.activateModelVersionDeployment({
      namespaceId,
      modelVersionId: first.version.id,
      deploymentId: first.deployment?.id ?? '',
      policyGeneration: 7n,
      credentialGeneration: null,
    })
    expect(active).toMatchObject({ lifecycle: 'active', policyGeneration: 7n })
    const disabled = await v2Catalog.disableModelVersionDeployment(
      namespaceId,
      first.version.id,
      first.deployment?.id ?? '',
    )
    expect(disabled).toMatchObject({ lifecycle: 'disabled' })
    await expect(
      v2Catalog.replayModelRegistration(
        namespaceId,
        firstInput.registrationDigest,
        firstInput.planProfile,
        firstInput.normalizedRequest,
      ),
    ).resolves.toMatchObject({
      replayed: true,
      deployment: { id: first.deployment?.id, lifecycle: 'disabled' },
    })
  })

  test('database-enforces exact Artifact binding and null Repository or Service binding for new Deployments', async () => {
    const { namespaceId, artifact } = await finalizedModelArtifact()
    const artifactInput = artifactModelRegistrationInput(namespaceId, artifact)
    const artifactDeployment = {
      id: '40000000-0000-8000-8000-000000000001',
      namespaceId,
      deploymentProfile: 'model-version-v1' as const,
      createDigest: 'd'.repeat(64),
      modelVersionId: artifactInput.version.id,
      artifactId: artifact.id,
      provider: 'openai_compatible' as const,
      displayName: 'Artifact endpoint',
      servedModelName: 'artifact-model',
      endpointBaseUrl: 'http://model-service:8000/v1',
      connectivityScope: 'private_network' as const,
      authProfile: 'none' as const,
      credentialRef: null,
      declaredCapabilities: { interfaces: ['chat_completions' as const], contextLimit: null },
    }
    const registered = await v2Catalog.registerModelVersion({
      ...artifactInput,
      deployment: artifactDeployment,
    })
    expect(registered.deployment).toMatchObject({ artifactId: artifact.id })

    await expect(
      v2Catalog.createOrReadModelVersionDeployment({
        ...artifactDeployment,
        id: '40000000-0000-8000-8000-000000000002',
        createDigest: 'e'.repeat(64),
        artifactId: null,
      }),
    ).rejects.toThrow()

    const repository = await v2Catalog.registerModelVersion(
      modelRegistrationInput(namespaceId, {
        registrationDigest: '5'.repeat(64),
        normalizedRequest: { source: 'repository-two' },
        target: {
          kind: 'create_model',
          model: {
            id: '10000000-0000-8000-8000-000000000002',
            namespaceId,
            key: 'repository-two',
            createProfile: 'model-create-v1',
            createDigest: '5'.repeat(64),
            displayName: 'Repository Two',
            description: '',
            taskFamily: null,
            tags: [],
          },
        },
        version: {
          id: '20000000-0000-8000-8000-000000000002',
          modelId: '10000000-0000-8000-8000-000000000002',
          createDigest: '5'.repeat(64),
          sourceFingerprint: '5'.repeat(64),
        },
      }),
    )
    await expect(
      v2Catalog.createOrReadModelVersionDeployment({
        ...artifactDeployment,
        id: '40000000-0000-8000-8000-000000000003',
        createDigest: 'f'.repeat(64),
        modelVersionId: repository.version.id,
        artifactId: artifact.id,
      }),
    ).rejects.toThrow()
  })

  test('serializes same-digest request collisions before creating any second result', async () => {
    const namespaceId = await v2Catalog.getOrCreateNamespace('default')
    const first = modelRegistrationInput(namespaceId)
    const second = modelRegistrationInput(namespaceId, {
      normalizedRequest: { target: 'create', version_label: 'different', revision: 'abc123' },
    })
    const settled = await Promise.allSettled([
      v2Catalog.registerModelVersion(first),
      v2Catalog.registerModelVersion(second),
    ])
    expect(settled.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
    const rejected = settled.find(({ status }) => status === 'rejected')
    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: { name: 'V2CatalogModelRegistrationConflictError', reason: 'request_mismatch' },
    })
    expect(await prisma.v2Model.count()).toBe(1)
    expect(await prisma.v2ModelVersion.count()).toBe(1)
    expect(await prisma.v2ModelRegistrationClaim.count()).toBe(1)
  })

  test('rolls back Model key, Version label, and source fingerprint conflicts without half rows', async () => {
    const namespaceId = await v2Catalog.getOrCreateNamespace('default')
    const created = await v2Catalog.registerModelVersion(modelRegistrationInput(namespaceId))

    await expect(
      v2Catalog.registerModelVersion(
        modelRegistrationInput(namespaceId, {
          registrationDigest: '5'.repeat(64),
          normalizedRequest: { conflict: 'label' },
          target: { kind: 'existing_model', modelId: created.model.id },
          version: {
            id: '20000000-0000-8000-8000-000000000002',
            createDigest: '5'.repeat(64),
            sourceFingerprint: '6'.repeat(64),
          },
        }),
      ),
    ).rejects.toMatchObject({ reason: 'version_label_conflict' })

    await expect(
      v2Catalog.registerModelVersion(
        modelRegistrationInput(namespaceId, {
          registrationDigest: '6'.repeat(64),
          normalizedRequest: { conflict: 'source' },
          target: { kind: 'existing_model', modelId: created.model.id },
          version: {
            id: '20000000-0000-8000-8000-000000000003',
            versionLabel: 'r2',
            createDigest: '6'.repeat(64),
          },
        }),
      ),
    ).rejects.toMatchObject({ reason: 'source_fingerprint_conflict' })

    const conflictingModelId = '10000000-0000-8000-8000-000000000002'
    const modelConflict = modelRegistrationInput(namespaceId, {
      registrationDigest: '7'.repeat(64),
      normalizedRequest: { conflict: 'model-key' },
      version: {
        id: '20000000-0000-8000-8000-000000000004',
        modelId: conflictingModelId,
        versionLabel: 'r3',
        createDigest: '7'.repeat(64),
        sourceFingerprint: '7'.repeat(64),
      },
    })
    if (modelConflict.target.kind !== 'create_model') throw new Error('expected create target')
    await expect(
      v2Catalog.registerModelVersion({
        ...modelConflict,
        target: {
          kind: 'create_model',
          model: {
            ...modelConflict.target.model,
            id: conflictingModelId,
            createDigest: '7'.repeat(64),
          },
        },
      }),
    ).rejects.toMatchObject({ reason: 'model_key_conflict' })

    expect(await prisma.v2Model.count()).toBe(1)
    expect(await prisma.v2ModelVersion.count()).toBe(1)
    expect(await prisma.v2ModelVersionRepositorySource.count()).toBe(1)
    expect(await prisma.v2ModelRegistrationClaim.count()).toBe(1)
  })

  test('serializes concurrent registrations for one Model and leaves one exact winner', async () => {
    const namespaceId = await v2Catalog.getOrCreateNamespace('default')
    const first = modelRegistrationInput(namespaceId)
    const second = modelRegistrationInput(namespaceId, {
      registrationDigest: '8'.repeat(64),
      normalizedRequest: { concurrent: 'second' },
      version: {
        id: '20000000-0000-8000-8000-000000000002',
        createDigest: '8'.repeat(64),
        sourceFingerprint: '8'.repeat(64),
      },
      source: {
        kind: 'repository_reference',
        provider: 'hugging_face',
        repositoryId: 'Qwen/Qwen2.5-7B',
        revision: 'def456',
        revisionKind: 'commit',
      },
    })
    const settled = await Promise.allSettled([
      v2Catalog.registerModelVersion(first),
      v2Catalog.registerModelVersion(second),
    ])

    expect(settled.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
    expect(settled.filter(({ status }) => status === 'rejected')).toHaveLength(1)
    expect(await prisma.v2Model.count()).toBe(1)
    expect(await prisma.v2ModelVersion.count()).toBe(1)
    expect(await prisma.v2ModelRegistrationClaim.count()).toBe(1)
  })

  test('enforces Model metadata and Alias compare-and-set with the three-column FK', async () => {
    const namespaceId = await v2Catalog.getOrCreateNamespace('default')
    const verifiedEvidence = (
      id: string,
      modelVersionId: string,
      observedRevision: string,
      digestDigit: string,
    ) => ({
      id,
      namespaceId,
      modelVersionId,
      evidenceProfile: 'model-source-evidence-v1' as const,
      evidenceDigest: digestDigit.repeat(64),
      evidenceKind: 'provider_resolution' as const,
      adapter: 'hugging-face',
      adapterVersion: '1',
      observedRevision,
      observedAt: new Date('2026-08-04T12:00:00.000Z'),
      result: 'verified' as const,
      responseDigest: digestDigit.repeat(64),
      license: null,
      cacheStatus: 'not_cached' as const,
    })
    const first = await v2Catalog.registerModelVersion(
      modelRegistrationInput(namespaceId, {
        initialEvidence: verifiedEvidence(
          '30000000-0000-8000-8000-000000000001',
          MODEL_REGISTRY_VERSION_ID,
          'abc123',
          'a',
        ),
        alias: { alias: 'candidate', expectedVersionId: null },
      }),
    )
    await expect(
      v2Catalog.updateModelMetadata({
        namespaceId,
        modelId: first.model.id,
        expectedMetadataRevision: 0n,
        displayName: 'Updated Model',
        description: 'Updated through CAS',
        taskFamily: 'chat',
        tags: ['updated'],
      }),
    ).resolves.toMatchObject({ metadataRevision: 1n, displayName: 'Updated Model' })
    await expect(
      v2Catalog.updateModelMetadata({
        namespaceId,
        modelId: first.model.id,
        expectedMetadataRevision: 0n,
        displayName: 'Stale',
        description: 'Stale',
        taskFamily: null,
        tags: [],
      }),
    ).rejects.toBeInstanceOf(V2CatalogModelMetadataConflictError)

    const second = await v2Catalog.registerModelVersion(
      modelRegistrationInput(namespaceId, {
        registrationDigest: '9'.repeat(64),
        normalizedRequest: { version_label: 'r2' },
        target: { kind: 'existing_model', modelId: first.model.id },
        version: {
          id: '20000000-0000-8000-8000-000000000002',
          versionLabel: 'r2',
          createDigest: '9'.repeat(64),
          sourceFingerprint: '9'.repeat(64),
        },
        source: {
          kind: 'repository_reference',
          provider: 'hugging_face',
          repositoryId: 'Qwen/Qwen2.5-7B',
          revision: 'def456',
          revisionKind: 'commit',
        },
        initialEvidence: verifiedEvidence(
          '30000000-0000-8000-8000-000000000002',
          '20000000-0000-8000-8000-000000000002',
          'def456',
          'b',
        ),
      }),
    )
    await expect(
      v2Catalog.compareAndSetModelAlias({
        namespaceId,
        modelId: first.model.id,
        alias: 'candidate',
        expectedVersionId: null,
        newVersionId: first.version.id,
      }),
    ).rejects.toBeInstanceOf(V2CatalogModelAliasConflictError)
    await expect(
      v2Catalog.compareAndSetModelAlias({
        namespaceId,
        modelId: first.model.id,
        alias: 'candidate',
        expectedVersionId: first.version.id,
        newVersionId: second.version.id,
      }),
    ).resolves.toMatchObject({ versionId: second.version.id })
    await expect(
      v2Catalog.compareAndSetModelAlias({
        namespaceId,
        modelId: first.model.id,
        alias: 'candidate',
        expectedVersionId: first.version.id,
        newVersionId: first.version.id,
      }),
    ).rejects.toBeInstanceOf(V2CatalogModelAliasConflictError)

    await prisma.v2ModelSourceEvidence.createMany({
      data: Array.from({ length: 1_001 }, (_, index) => {
        const ordinal = index + 100
        const digest = ordinal.toString(16).padStart(64, '0')
        return {
          id: `30000000-0000-8000-8000-${ordinal.toString(16).padStart(12, '0')}`,
          namespaceId,
          modelVersionId: first.version.id,
          evidenceProfile: 'model-source-evidence-v1',
          evidenceDigest: digest,
          evidenceKind: 'provider_resolution',
          adapter: 'hugging-face',
          adapterVersion: '1',
          observedRevision: null,
          observedAt: new Date(Date.parse('2026-08-04T12:01:00.000Z') + index),
          result: 'unavailable',
          responseDigest: null,
          license: null,
          cacheStatus: 'not_cached',
        }
      }),
    })
    await v2Catalog.appendModelSourceEvidence({
      id: '30000000-0000-8000-8000-000000009999',
      namespaceId,
      modelVersionId: first.version.id,
      evidenceProfile: 'model-source-evidence-v1',
      evidenceDigest: 'c'.repeat(64),
      evidenceKind: 'provider_resolution',
      adapter: 'hugging-face',
      adapterVersion: '1',
      observedRevision: 'drifted-revision',
      observedAt: new Date('2026-08-04T12:02:00.000Z'),
      result: 'revision_mismatch',
      responseDigest: 'd'.repeat(64),
      license: null,
      cacheStatus: 'not_cached',
    })
    await expect(
      v2Catalog.compareAndSetModelAlias({
        namespaceId,
        modelId: first.model.id,
        alias: 'candidate',
        expectedVersionId: second.version.id,
        newVersionId: first.version.id,
      }),
    ).rejects.toBeInstanceOf(V2CatalogModelAliasAdmissionError)

    const constraints = await prisma.$queryRaw<
      Array<{ readonly name: string; readonly definition: string }>
    >`
      SELECT "conname" AS "name", pg_get_constraintdef("oid") AS "definition"
      FROM "pg_constraint"
      WHERE
        "connamespace" = current_schema()::regnamespace AND
        "conname" = 'model_aliases_v2_version_fkey'
    `
    expect(constraints).toHaveLength(1)
    expect(constraints[0]?.definition).toContain('FOREIGN KEY (namespace_id, model_id, version_id)')
  })

  test('lists Models with stable seek pagination and binds search, archive, and source filters', async () => {
    const namespaceId = await v2Catalog.getOrCreateNamespace('default')
    const registrationFor = (suffix: string, key: string, displayName: string) => {
      const digit = suffix
      return modelRegistrationInput(namespaceId, {
        registrationDigest: digit.repeat(64),
        normalizedRequest: { key, version_label: 'r1' },
        target: {
          kind: 'create_model',
          model: {
            id: `10000000-0000-8000-8000-00000000000${suffix}`,
            namespaceId,
            key,
            createProfile: 'model-create-v1',
            createDigest: digit.repeat(64),
            displayName,
            description: `${displayName} description`,
            taskFamily: 'chat',
            tags: [key],
          },
        },
        version: {
          id: `20000000-0000-8000-8000-00000000000${suffix}`,
          modelId: `10000000-0000-8000-8000-00000000000${suffix}`,
          createDigest: digit.repeat(64),
          sourceFingerprint: digit.repeat(64),
        },
        source: {
          kind: 'repository_reference',
          provider: 'hugging_face',
          repositoryId: `fixture/${key}`,
          revision: digit.repeat(8),
          revisionKind: 'commit',
        },
      })
    }
    const registrations = [
      registrationFor('5', 'alpha-model', 'Alpha Model'),
      registrationFor('6', 'beta-model', 'Beta Model'),
      registrationFor('7', 'gamma-model', 'Gamma Model'),
    ]
    const registered = await Promise.all(
      registrations.map((input) => v2Catalog.registerModelVersion(input)),
    )
    const beta = registered[1]
    if (beta === undefined) throw new Error('beta Model registration is missing')
    await v2Catalog.appendModelSourceEvidence({
      id: '30000000-0000-8000-8000-000000000006',
      namespaceId,
      modelVersionId: beta.version.id,
      evidenceProfile: 'model-source-evidence-v1',
      evidenceDigest: 'a'.repeat(64),
      evidenceKind: 'provider_resolution',
      adapter: 'modelscope',
      adapterVersion: '1',
      observedRevision: '66666666',
      observedAt: new Date('2030-08-04T11:00:00.000Z'),
      result: 'verified',
      responseDigest: 'b'.repeat(64),
      license: null,
      cacheStatus: 'not_cached',
    })
    await v2Catalog.compareAndSetModelAlias({
      namespaceId,
      modelId: beta.model.id,
      alias: 'candidate',
      expectedVersionId: null,
      newVersionId: beta.version.id,
    })
    const betaDeployment = await v2Catalog.createOrReadModelVersionDeployment({
      id: '40000000-0000-8000-8000-000000000006',
      namespaceId,
      deploymentProfile: 'model-version-v1',
      createDigest: 'c'.repeat(64),
      modelVersionId: beta.version.id,
      artifactId: null,
      provider: 'openai_compatible',
      displayName: 'Beta service',
      servedModelName: 'beta-model',
      endpointBaseUrl: 'http://model-service:8000/v1',
      connectivityScope: 'private_network',
      authProfile: 'none',
      credentialRef: null,
      declaredCapabilities: { interfaces: ['chat_completions'], contextLimit: 8_192 },
    })
    await v2Catalog.activateModelVersionDeployment({
      namespaceId,
      modelVersionId: beta.version.id,
      deploymentId: betaDeployment.id,
      policyGeneration: 1n,
      credentialGeneration: null,
    })
    await v2Catalog.updateModelVersionDeploymentHealth(
      namespaceId,
      beta.version.id,
      betaDeployment.id,
      { status: 'healthy', error: null },
    )
    await prisma.$executeRaw`
      UPDATE "models_v2"
      SET "updated_at" = '2030-08-04T12:00:00.123Z'::timestamptz
      WHERE "namespace_id" = ${namespaceId}::uuid
    `

    const modelFilter = {
      sourceMutability: null,
      verificationLevel: null,
      taskFamily: null,
      artifactKind: null,
      artifactId: null,
      alias: null,
      deploymentLifecycle: null,
      deploymentHealth: null,
      tag: null,
    } as const
    const firstPage = await v2Catalog.listModels(
      namespaceId,
      {
        ...modelFilter,
        search: '',
        archive: 'active',
        sourceKind: 'repository_reference',
      },
      null,
      2,
    )
    expect(firstPage.rows.map(({ model }) => model.id)).toEqual([
      '10000000-0000-8000-8000-000000000005',
      '10000000-0000-8000-8000-000000000006',
    ])
    expect(firstPage.nextCursor).toMatchObject({
      id: '10000000-0000-8000-8000-000000000006',
    })
    const secondPage = await v2Catalog.listModels(
      namespaceId,
      {
        ...modelFilter,
        search: '',
        archive: 'active',
        sourceKind: 'repository_reference',
      },
      firstPage.nextCursor,
      2,
    )
    expect(secondPage.rows.map(({ model }) => model.id)).toEqual([
      '10000000-0000-8000-8000-000000000007',
    ])
    await expect(
      v2Catalog.listModels(
        namespaceId,
        {
          ...modelFilter,
          search: 'BETA',
          archive: 'active',
          sourceKind: 'repository_reference',
        },
        null,
        20,
      ),
    ).resolves.toMatchObject({ rows: [{ model: { key: 'beta-model' } }], nextCursor: null })

    const fullyFiltered = {
      search: 'beta',
      archive: 'active' as const,
      sourceKind: 'repository_reference' as const,
      sourceMutability: 'immutable' as const,
      verificationLevel: 'provider_verified' as const,
      taskFamily: 'chat',
      artifactKind: null,
      artifactId: null,
      alias: 'candidate' as const,
      deploymentLifecycle: 'active' as const,
      deploymentHealth: 'healthy' as const,
      tag: 'beta-model',
    }
    await expect(v2Catalog.listModels(namespaceId, fullyFiltered, null, 20)).resolves.toMatchObject(
      {
        rows: [
          {
            model: { id: beta.model.id },
            candidate: { version: { id: beta.version.id } },
            deploymentSummary: { active: 1, healthyActive: 1 },
          },
        ],
        nextCursor: null,
      },
    )
    for (const mismatched of [
      { sourceMutability: 'mutable' as const },
      { verificationLevel: 'operator_attested' as const },
      { taskFamily: 'completion' },
      { alias: 'none' as const },
      { deploymentLifecycle: 'disabled' as const },
      { deploymentHealth: 'unhealthy' as const },
      { tag: 'missing-tag' },
    ]) {
      await expect(
        v2Catalog.listModels(namespaceId, { ...fullyFiltered, ...mismatched }, null, 20),
      ).resolves.toMatchObject({ rows: [], nextCursor: null })
    }

    const archived = await v2Catalog.archiveModel({
      namespaceId,
      modelId: beta.model.id,
      expectedMetadataRevision: 0n,
    })
    expect(archived).toMatchObject({ metadataRevision: 1n })
    await expect(
      v2Catalog.listModels(
        namespaceId,
        {
          ...modelFilter,
          search: '',
          archive: 'archived',
          sourceKind: 'repository_reference',
        },
        null,
        20,
      ),
    ).resolves.toMatchObject({ rows: [{ model: { id: archived?.id } }], nextCursor: null })
    await expect(
      v2Catalog.archiveModel({
        namespaceId,
        modelId: archived?.id ?? '',
        expectedMetadataRevision: 0n,
      }),
    ).resolves.toMatchObject({ metadataRevision: 1n, archivedAt: archived?.archivedAt })
    await expect(
      v2Catalog.restoreModel({
        namespaceId,
        modelId: archived?.id ?? '',
        expectedMetadataRevision: 0n,
      }),
    ).rejects.toBeInstanceOf(V2CatalogModelMetadataConflictError)
    const deploymentBeforeRestore = await v2Catalog.getModelVersionDeployment(
      namespaceId,
      beta.version.id,
      betaDeployment.id,
    )
    const restored = await v2Catalog.restoreModel({
      namespaceId,
      modelId: archived?.id ?? '',
      expectedMetadataRevision: 1n,
    })
    expect(restored).toMatchObject({ metadataRevision: 2n, archivedAt: null })
    await expect(
      v2Catalog.getModelVersionDeployment(namespaceId, beta.version.id, betaDeployment.id),
    ).resolves.toEqual(deploymentBeforeRestore)
  })

  test('adopts an exact legacy Deployment once and keeps the association append-only', async () => {
    const { namespaceId, artifact } = await finalizedModelArtifact()
    await expect(
      v2Catalog.listModelArtifacts(
        namespaceId,
        { datasetVersion: null, artifactKind: null, registrationStatus: 'unregistered' },
        null,
        20,
      ),
    ).resolves.toMatchObject({ rows: [{ id: artifact.id }] })
    const first = await v2Catalog.registerModelVersion(
      artifactModelRegistrationInput(namespaceId, artifact),
    )
    await expect(
      v2Catalog.listModels(
        namespaceId,
        {
          search: '',
          archive: 'active',
          sourceKind: 'databench_artifact',
          sourceMutability: 'immutable',
          verificationLevel: 'content_verified',
          taskFamily: 'chat',
          artifactKind: 'lora_adapter',
          artifactId: artifact.id,
          alias: 'candidate',
          deploymentLifecycle: null,
          deploymentHealth: null,
          tag: 'fixture',
        },
        null,
        20,
      ),
    ).resolves.toMatchObject({
      rows: [{ model: { id: first.model.id }, candidate: { version: { id: first.version.id } } }],
      nextCursor: null,
    })
    await expect(
      v2Catalog.listModels(
        namespaceId,
        {
          search: '',
          archive: 'active',
          sourceKind: 'databench_artifact',
          sourceMutability: 'immutable',
          verificationLevel: 'content_verified',
          taskFamily: 'chat',
          artifactKind: 'lora_adapter',
          artifactId: '99999999-9999-4999-8999-999999999999',
          alias: 'candidate',
          deploymentLifecycle: null,
          deploymentHealth: null,
          tag: 'fixture',
        },
        null,
        20,
      ),
    ).resolves.toMatchObject({ rows: [], nextCursor: null })
    await expect(
      v2Catalog.listModelArtifacts(
        namespaceId,
        { datasetVersion: null, artifactKind: null, registrationStatus: 'registered' },
        null,
        20,
      ),
    ).resolves.toMatchObject({ rows: [{ id: artifact.id }] })
    const deployment = await v2Catalog.createOrReadModelDeployment(
      modelDeploymentInput(namespaceId, artifact.id),
    )
    const adoption = {
      namespaceId,
      deploymentId: deployment.id,
      modelId: first.model.id,
      modelVersionId: first.version.id,
      artifactId: artifact.id,
      deploymentDigest: deployment.createDigest,
      adoptionProfile: 'model-deployment-adoption-v1' as const,
      adoptionDigest: '8'.repeat(64),
    }
    const results = await Promise.all(
      Array.from({ length: 8 }, () => v2Catalog.createOrReadModelDeploymentAdoption(adoption)),
    )
    expect(results.filter(({ replayed }) => !replayed)).toHaveLength(1)
    expect(new Set(results.map(({ row }) => row.modelVersionId))).toEqual(
      new Set([first.version.id]),
    )
    const additionalDeployments = await Promise.all(
      Array.from({ length: 100 }, (_, index) =>
        v2Catalog.createOrReadModelDeployment(
          modelDeploymentInput(
            namespaceId,
            artifact.id,
            (index + 1_000).toString(16).padStart(64, '0'),
          ),
        ),
      ),
    )
    await Promise.all(
      additionalDeployments.map((additionalDeployment, index) =>
        v2Catalog.createOrReadModelDeploymentAdoption({
          ...adoption,
          deploymentId: additionalDeployment.id,
          deploymentDigest: additionalDeployment.createDigest,
          adoptionDigest: (index + 2_000).toString(16).padStart(64, '0'),
        }),
      ),
    )
    const firstAdoptionPage = await v2Catalog.listModelDeploymentAdoptions(
      namespaceId,
      first.version.id,
      null,
      100,
    )
    expect(firstAdoptionPage.rows).toHaveLength(100)
    expect(firstAdoptionPage.nextCursor).not.toBeNull()
    const secondAdoptionPage = await v2Catalog.listModelDeploymentAdoptions(
      namespaceId,
      first.version.id,
      firstAdoptionPage.nextCursor,
      100,
    )
    expect(secondAdoptionPage.rows).toHaveLength(1)
    expect(secondAdoptionPage.nextCursor).toBeNull()
    expect(
      new Set(
        [...firstAdoptionPage.rows, ...secondAdoptionPage.rows].map((row) => row.deploymentId),
      ),
    ).toEqual(new Set([deployment.id, ...additionalDeployments.map(({ id }) => id)]))

    await v2Catalog.archiveModel({
      namespaceId,
      modelId: first.model.id,
      expectedMetadataRevision: 0n,
    })
    await expect(
      v2Catalog.listModels(
        namespaceId,
        {
          search: '',
          archive: 'archived',
          sourceKind: null,
          sourceMutability: null,
          verificationLevel: null,
          taskFamily: null,
          artifactKind: null,
          artifactId: null,
          alias: null,
          deploymentLifecycle: null,
          deploymentHealth: null,
          tag: null,
        },
        null,
        20,
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          model: { id: first.model.id },
          adoptedDeploymentCount: 101,
          activeAdoptedDeploymentCount: 101,
        },
      ],
    })

    const second = await v2Catalog.registerModelVersion(
      artifactModelRegistrationInput(namespaceId, artifact, {
        modelId: '10000000-0000-8000-8000-000000000002',
        versionId: '20000000-0000-8000-8000-000000000002',
        modelKey: 'artifact-registry-two',
        registrationDigest: '9'.repeat(64),
        modelCreateDigest: 'a'.repeat(64),
        versionCreateDigest: 'b'.repeat(64),
        sourceFingerprint: 'c'.repeat(64),
      }),
    )
    await expect(
      v2Catalog.createOrReadModelDeploymentAdoption({
        ...adoption,
        modelId: second.model.id,
        modelVersionId: second.version.id,
        adoptionDigest: 'd'.repeat(64),
      }),
    ).rejects.toMatchObject({
      name: 'V2CatalogModelDeploymentAdoptionConflictError',
      currentModelVersionId: first.version.id,
      requestedModelVersionId: second.version.id,
    })

    await expect(
      prisma.v2ModelVersionDeploymentAdoption.update({
        where: {
          namespaceId_deploymentId: { namespaceId, deploymentId: deployment.id },
        },
        data: { adoptionDigest: 'e'.repeat(64) },
      }),
    ).rejects.toThrow(/append-only/i)
    await expect(
      prisma.v2ModelVersionDeploymentAdoption.delete({
        where: {
          namespaceId_deploymentId: { namespaceId, deploymentId: deployment.id },
        },
      }),
    ).rejects.toThrow(/append-only/i)
  })

  test('keeps source evidence idempotent and database-enforced append-only', async () => {
    const namespaceId = await v2Catalog.getOrCreateNamespace('default')
    const registrationResult = await v2Catalog.registerModelVersion(
      modelRegistrationInput(namespaceId),
    )
    const evidence = {
      id: '30000000-0000-8000-8000-000000000001',
      namespaceId,
      modelVersionId: registrationResult.version.id,
      evidenceProfile: 'model-source-evidence-v1' as const,
      evidenceDigest: 'a'.repeat(64),
      evidenceKind: 'provider_resolution' as const,
      adapter: 'hugging-face',
      adapterVersion: '1',
      observedRevision: 'abc123',
      observedAt: new Date('2026-08-04T12:00:00.000Z'),
      result: 'verified' as const,
      responseDigest: 'b'.repeat(64),
      license: 'apache-2.0',
      cacheStatus: 'not_cached' as const,
    }
    await expect(v2Catalog.appendModelSourceEvidence(evidence)).resolves.toMatchObject(evidence)
    await expect(
      v2Catalog.appendModelSourceEvidence({
        ...evidence,
        observedAt: new Date('2026-08-04T12:01:00.000Z'),
      }),
    ).resolves.toMatchObject(evidence)
    const drift = {
      ...evidence,
      id: '30000000-0000-8000-8000-000000000002',
      evidenceDigest: 'c'.repeat(64),
      observedRevision: 'def456',
      observedAt: new Date('2026-08-04T12:02:00.000Z'),
      result: 'revision_mismatch' as const,
      responseDigest: 'd'.repeat(64),
      license: 'mit',
      cacheStatus: 'cached' as const,
    }
    await expect(v2Catalog.appendModelSourceEvidence(drift)).resolves.toMatchObject(drift)
    await expect(
      v2Catalog.listModelSourceEvidence(namespaceId, registrationResult.version.id),
    ).resolves.toEqual([expect.objectContaining(evidence), expect.objectContaining(drift)])
    await expect(
      prisma.v2ModelSourceEvidence.create({
        data: {
          ...drift,
          id: '30000000-0000-8000-8000-000000000003',
          evidenceDigest: 'e'.repeat(64),
          cacheStatus: 'outside_contract',
        },
      }),
    ).rejects.toThrow()
    await expect(
      prisma.v2ModelSourceEvidence.update({
        where: { id: evidence.id },
        data: { result: 'unavailable' },
      }),
    ).rejects.toThrow(/append-only/i)
    await expect(
      prisma.v2ModelSourceEvidence.delete({ where: { id: evidence.id } }),
    ).rejects.toThrow(/append-only/i)
  })

  test('commits initial evidence atomically and replays the durable claim without rewriting it', async () => {
    const namespaceId = await v2Catalog.getOrCreateNamespace('default')
    const initialEvidence = {
      id: '30000000-0000-8000-8000-000000000001',
      namespaceId,
      modelVersionId: MODEL_REGISTRY_VERSION_ID,
      evidenceProfile: 'model-source-evidence-v1' as const,
      evidenceDigest: 'a'.repeat(64),
      evidenceKind: 'provider_resolution' as const,
      adapter: 'modelscope',
      adapterVersion: '1',
      observedRevision: 'abc123',
      observedAt: new Date('2026-08-04T12:00:00.000Z'),
      result: 'verified' as const,
      responseDigest: 'b'.repeat(64),
      license: 'apache-2.0',
      cacheStatus: 'not_cached' as const,
    }
    const input = modelRegistrationInput(namespaceId, {
      initialEvidence,
      alias: { alias: 'candidate', expectedVersionId: null },
    })
    const created = await v2Catalog.registerModelVersion(input)
    await expect(
      v2Catalog.replayModelRegistration(
        namespaceId,
        input.registrationDigest,
        input.planProfile,
        input.normalizedRequest,
      ),
    ).resolves.toMatchObject({
      replayed: true,
      model: { id: created.model.id },
      version: { id: created.version.id },
    })
    expect(await prisma.v2ModelSourceEvidence.count()).toBe(1)

    const secondVersionId = '20000000-0000-8000-8000-000000000002'
    await expect(
      v2Catalog.registerModelVersion(
        modelRegistrationInput(namespaceId, {
          registrationDigest: '5'.repeat(64),
          normalizedRequest: { target: 'existing', version_label: 'r2', revision: 'def456' },
          target: { kind: 'existing_model', modelId: created.model.id },
          version: {
            id: secondVersionId,
            versionLabel: 'r2',
            createDigest: '5'.repeat(64),
            sourceFingerprint: '6'.repeat(64),
          },
          source: {
            kind: 'repository_reference',
            provider: 'modelscope',
            repositoryId: 'Qwen/Qwen3-0.6B',
            revision: 'def456',
            revisionKind: 'commit',
          },
          initialEvidence: {
            ...initialEvidence,
            id: '30000000-0000-8000-8000-000000000002',
            modelVersionId: secondVersionId,
            evidenceDigest: 'c'.repeat(64),
            observedRevision: 'def456',
            responseDigest: 'd'.repeat(64),
          },
          alias: { alias: 'candidate', expectedVersionId: null },
        }),
      ),
    ).rejects.toBeInstanceOf(V2CatalogModelAliasConflictError)
    expect(await prisma.v2ModelVersion.count()).toBe(1)
    expect(await prisma.v2ModelSourceEvidence.count()).toBe(1)
    expect(await prisma.v2ModelRegistrationClaim.count()).toBe(1)

    await expect(
      v2Catalog.registerModelVersion(
        modelRegistrationInput(namespaceId, {
          registrationDigest: '7'.repeat(64),
          version: {
            id: '20000000-0000-8000-8000-000000000003',
            createDigest: '7'.repeat(64),
            sourceFingerprint: '7'.repeat(64),
          },
          initialEvidence: {
            ...initialEvidence,
            modelVersionId: '20000000-0000-8000-8000-000000000099',
          },
        }),
      ),
    ).rejects.toBeInstanceOf(V2CatalogInputError)
    expect(await prisma.v2ModelVersion.count()).toBe(1)
  })

  test('fails closed on missing, wrong-kind, and multiple Model Version source rows', async () => {
    const namespaceId = await v2Catalog.getOrCreateNamespace('default')
    const registered = await v2Catalog.registerModelVersion(modelRegistrationInput(namespaceId))
    const versionData = (id: string, label: string, digit: string) => ({
      id,
      namespaceId,
      modelId: registered.model.id,
      versionLabel: label,
      sourceKind: 'repository_reference',
      createProfile: 'model-version-create-repository-v1',
      createDigest: digit.repeat(64),
      sourceFingerprint: digit.repeat(64),
      baseModelReference: null,
      baseModelRevision: null,
      baseModelBindingStatus: null,
    })

    await expect(
      prisma.$transaction(async (transaction) => {
        await transaction.v2ModelVersion.create({
          data: versionData('20000000-0000-8000-8000-000000000002', 'missing', '5'),
        })
      }),
    ).rejects.toThrow(/source XOR violation/i)

    await expect(
      prisma.$transaction(async (transaction) => {
        const row = versionData('20000000-0000-8000-8000-000000000003', 'wrong', '6')
        await transaction.v2ModelVersion.create({ data: row })
        await transaction.v2ModelVersionServiceSource.create({
          data: {
            namespaceId,
            modelVersionId: row.id,
            provider: 'openai_compatible',
            externalModelRef: 'qwen',
            externalVersionRef: 'r1',
            declaredReferenceKind: 'immutable_version',
          },
        })
      }),
    ).rejects.toThrow(/source XOR violation/i)

    await expect(
      prisma.$transaction(async (transaction) => {
        const row = versionData('20000000-0000-8000-8000-000000000004', 'multiple', '7')
        await transaction.v2ModelVersion.create({ data: row })
        await transaction.v2ModelVersionRepositorySource.create({
          data: {
            namespaceId,
            modelVersionId: row.id,
            provider: 'hugging_face',
            repositoryId: 'Qwen/Qwen2.5-7B',
            revision: 'abc123',
            revisionKind: 'commit',
          },
        })
        await transaction.v2ModelVersionServiceSource.create({
          data: {
            namespaceId,
            modelVersionId: row.id,
            provider: 'openai_compatible',
            externalModelRef: 'qwen',
            externalVersionRef: 'r1',
            declaredReferenceKind: 'immutable_version',
          },
        })
      }),
    ).rejects.toThrow(/source XOR violation/i)

    expect(await prisma.v2ModelVersion.count()).toBe(1)
    expect(await prisma.v2ModelVersionRepositorySource.count()).toBe(1)
    expect(await prisma.v2ModelVersionServiceSource.count()).toBe(0)
  })
})
