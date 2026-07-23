import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import {
  Catalog,
  createPrismaClient,
  V2Catalog,
  V2CatalogDeterminismConflictError,
  V2CatalogImmutableConflictError,
  V2CatalogLineageCycleError,
  V2CatalogRefConflictError,
  V2CatalogTargetNotCommittedError,
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
let catalog: Catalog
let v2Catalog: V2Catalog

beforeAll(() => {
  prisma = createPrismaClient()
  catalog = new Catalog({ prisma })
  v2Catalog = new V2Catalog({ prisma })
})

beforeEach(async () => {
  await prisma.v2RecordParentEdge.deleteMany()
  await prisma.v2RecordRevisionLocation.deleteMany()
  await prisma.v2RunInput.deleteMany()
  await prisma.v2Run.deleteMany()
  await prisma.v2Ref.deleteMany()
  await prisma.v2DatasetLayout.deleteMany()
  await prisma.v2IdentityClaim.deleteMany()
  await prisma.v2DatasetSnapshot.deleteMany()
  await prisma.v2IdentityNamespace.deleteMany()
  await prisma.vocabularyRefRecord.deleteMany()
  await prisma.vocabularyRecord.deleteMany()
  await prisma.refRecord.deleteMany()
  await prisma.runRecord.deleteMany()
  await prisma.datasetRecord.deleteMany()
})

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

describe('Catalog', () => {
  test('registerDataset is first-write-wins', async () => {
    await catalog.registerDataset('version-a', 'first', 2, { sft: 2 })
    const first = await catalog.getDataset('version-a')

    await catalog.registerDataset('version-a', 'second', 9, { rl: 9 })
    const second = await catalog.getDataset('version-a')

    expect(second).toEqual(first)
    expect(second).toMatchObject({
      version: 'version-a',
      name: 'first',
      num_rows: 2,
      kinds: { sft: 2 },
    })
  })

  test('recordRun replaces rows by cache key and runsProducing is deterministic', async () => {
    await catalog.recordRun('cache-b', 'dedup', '1', { keep: 'first' }, ['input-a'], 'out-1')
    await catalog.recordRun('cache-b', 'sample_n', '1', { n: 1, seed: 0 }, ['input-b'], 'out-2')
    await catalog.recordRun('cache-a', 'enrich_length', '1', {}, ['input-a'], 'out-2')

    const sameCreatedAt = new Date('2026-01-01T00:00:00.000Z')
    await prisma.runRecord.updateMany({
      where: { outputVersion: 'out-2' },
      data: { createdAt: sameCreatedAt },
    })

    expect(await catalog.findRun('cache-b')).toBe('out-2')
    expect(await catalog.findRun('missing')).toBeNull()
    expect(await catalog.runsProducing('out-1')).toEqual([])
    expect(await catalog.runsProducing('out-2')).toMatchObject([
      {
        cache_key: 'cache-a',
        op: 'enrich_length',
        op_version: '1',
        params: {},
        inputs: ['input-a'],
        output_version: 'out-2',
      },
      {
        cache_key: 'cache-b',
        op: 'sample_n',
        op_version: '1',
        params: { n: 1, seed: 0 },
        inputs: ['input-b'],
        output_version: 'out-2',
      },
    ])
  })

  test('setRef moves pointers and listRefs is sorted by name', async () => {
    await catalog.setRef('z-ref', 'version-1', 'old')
    await catalog.setRef('a-ref', 'version-0')
    await catalog.setRef('z-ref', 'version-2', 'new')

    expect(await catalog.getRef('z-ref')).toBe('version-2')
    expect(await catalog.getRef('missing')).toBeNull()
    expect(await catalog.listRefs()).toEqual({
      'a-ref': 'version-0',
      'z-ref': 'version-2',
    })

    const row = await prisma.refRecord.findUniqueOrThrow({ where: { name: 'z-ref' } })
    expect(row.message).toBe('new')
  })

  test('resolve prefers known dataset versions, then refs, then returns unknown strings', async () => {
    await catalog.registerDataset('same', 'dataset', 1, { sft: 1 })
    await catalog.setRef('same', 'ref-version')
    await catalog.setRef('named', 'resolved-version')

    expect(await catalog.resolve('same')).toBe('same')
    expect(await catalog.resolve('named')).toBe('resolved-version')
    expect(await catalog.resolve('unknown-version')).toBe('unknown-version')
  })

  test('vocabulary refs track latest content id and per-ref status', async () => {
    await catalog.registerVocabulary('vocab-a', 'brand', 'brand', 2)
    await catalog.registerVocabulary('vocab-b', 'brand', 'brand', 3)
    await catalog.setVocabularyRef('brand', 'vocab-a', 'draft')
    await catalog.setVocabularyRef('brand-copy', 'vocab-a', 'curated')
    await catalog.setVocabularyRef('brand', 'vocab-b', 'curated')

    expect(await catalog.getVocabularyRef('brand')).toBe('vocab-b')
    expect(await catalog.getVocabularyRefRow('brand')).toEqual({
      vocab_id: 'vocab-b',
      status: 'curated',
    })
    expect(await catalog.listVocabularies()).toEqual([
      {
        id: 'vocab-b',
        name: 'brand',
        dimension: 'brand',
        num_terms: 3,
        status: 'curated',
      },
      {
        id: 'vocab-a',
        name: 'brand-copy',
        dimension: 'brand',
        num_terms: 2,
        status: 'curated',
      },
    ])
  })
})

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

    const migration = readFileSync(
      new URL('../../../prisma/migrations/0003_v2_catalog/migration.sql', import.meta.url),
      'utf8',
    )
    expect(migration).not.toMatch(
      /\b(?:ALTER TABLE|DROP TABLE|UPDATE "|DELETE FROM|TRUNCATE|INSERT INTO)\b/i,
    )
    for (const v1Table of ['datasets', 'runs', 'refs', 'vocabularies', 'vocab_refs']) {
      expect(migration).not.toContain(`"${v1Table}"`)
    }
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
    expect(await v2Catalog.runsProducing(v2Fixture.run.outputVersion)).toHaveLength(1)

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

  test('v2 writes do not alter existing v1 catalog rows', async () => {
    await catalog.registerDataset('v1-sentinel', 'before-v2', 7, { sft: 7 })
    const before = await catalog.getDataset('v1-sentinel')

    await v2Catalog.registerCommittedLayout(
      registration('alpha', [withParents(fixtureRevision('shared'))]),
    )
    await v2Catalog.getOrCreateNamespace(v2Fixture.namespaceScope)

    expect(await catalog.getDataset('v1-sentinel')).toEqual(before)
    expect(await prisma.datasetRecord.count({ where: { version: 'v1-sentinel' } })).toBe(1)
  })
})
