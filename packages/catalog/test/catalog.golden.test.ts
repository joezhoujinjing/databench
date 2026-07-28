import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import {
  createPrismaClient,
  V2Catalog,
  V2CatalogConsistencyError,
  V2CatalogDeterminismConflictError,
  V2CatalogImmutableConflictError,
  V2CatalogInputError,
  V2CatalogLineageCycleError,
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
  await prisma.v2SwiftStudioSession.deleteMany()
  await prisma.v2EvaluationRun.deleteMany()
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

function evaluationRunInput(namespaceId: string, providerTaskId: string) {
  return {
    namespaceId,
    provider: 'evalscope' as const,
    providerTaskId,
    createRequestDigest: '8'.repeat(64),
    datasetVersion: fixtureVersion('alpha'),
    sourceRef: 'main',
    converter: 'evalscope-general-qa',
    converterVersion: '1.0.0',
    converterOptions: { target_source: 'none' },
    fidelityDigest: '9'.repeat(64),
    benchmark: 'general_qa',
    modelName: 'Qwen/Qwen3-8B',
    evalscopeCommit: 'a'.repeat(40),
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
      { datasetVersion: prepared.datasetVersion, status: 'completed' },
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
      SET "preparation_expires_at" = clock_timestamp() - INTERVAL '1 millisecond'
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
      SET "preparation_expires_at" = clock_timestamp() - INTERVAL '1 millisecond'
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
})
