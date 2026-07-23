import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3'
import { createPrismaClient, V2Catalog } from '@databench/catalog'
import { V2Dataset } from '@databench/engine'
import { defineV2Transform, SubsetV2ParamsSchema, V2TransformRegistry } from '@databench/ops'
import type { DatasetLayoutIdentityV2, DatasetManifestV2 } from '@databench/schema'
import {
  type ConditionalCreateInput,
  type ConditionalCreateResult,
  type ConditionalObjectStoreV2,
  FileBackedV2Store,
  type ObjectDownloadInputV2,
  type ObjectHeadV2,
  type PreparedArtifactV2,
  S3ConditionalObjectStoreV2,
  type S3ConditionalObjectStoreV2Config,
  type AuditResultV2 as StoreAuditResultV2,
  type V2OperationContext,
  type V2Store,
} from '@databench/store'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { V2Workspace } from '../src/v2/workspace.js'

const runIntegration = process.env.RUN_MINIO_STORE_TESTS === 'true'
const RECORD_ID = `rec_${'9'.repeat(64)}`
const SECOND_RECORD_ID = `rec_${'8'.repeat(64)}`
const REF_NAME = 'gv9-main'
const bucket = `databench-v2-workspace-${randomUUID()}`

describe.runIf(runIntegration)('V2Workspace against real MinIO and Postgres', () => {
  const prisma = createPrismaClient()
  const catalog = new V2Catalog({ prisma })
  let temporaryRoot: string
  let client: S3Client
  let objects: CountingObjectStore
  let workspace: V2Workspace
  let bucketCreated = false

  beforeAll(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'databench-v2-workspace-gv9-'))
    await clearV2Catalog()
    client = createS3Client()
    await client.send(new CreateBucketCommand({ Bucket: bucket }))
    bucketCreated = true
    objects = new CountingObjectStore(new S3ConditionalObjectStoreV2({ ...s3Config(), client }))
    workspace = createWorkspace('primary')
  })

  afterAll(async () => {
    await clearV2Catalog()
    await catalog.close()
    await prisma.$disconnect()
    if (bucketCreated) {
      await deleteAllObjects(client)
      await client.send(new DeleteBucketCommand({ Bucket: bucket }))
    }
    client?.destroy()
    if (temporaryRoot) await rm(temporaryRoot, { force: true, recursive: true })
  })

  test('ingest → persist → describe → read/cache → audit → conflict → recovery → ref', async () => {
    const ingested = await workspace.addJsonl(jsonl(record()), {
      ref: REF_NAME,
      expected_ref_version: null,
      message: 'GV9 real integration',
    })
    expect(ingested.ref_update).toEqual({
      status: 'updated',
      ref_name: REF_NAME,
      previous_version: null,
      current_version: ingested.dataset_version,
    })

    const described = await workspace.describeDataset(REF_NAME)
    expect(described.dataset_version).toBe(ingested.dataset_version)
    expect(described.ref_name).toBe(REF_NAME)
    expect(described.manifest).toEqual(ingested.manifest)

    const beforeColdRead = objects.artifactDownloads
    const loaded = await workspace.get(described.dataset_version)
    expect(loaded.version).toBe(described.dataset_version)
    expect(loaded.length).toBe(1)
    expect(objects.artifactDownloads).toBe(beforeColdRead + 1)

    const page = await workspace.getRecordPage(described.dataset_version, 0, 20)
    const view = await workspace.getRecordView(described.dataset_version, RECORD_ID)
    expect(page.items.map((item) => item.record_id)).toEqual([RECORD_ID])
    expect(view?.record.id).toBe(RECORD_ID)
    expect(objects.artifactDownloads).toBe(beforeColdRead + 1)

    const audit = await workspace.audit(described.dataset_version)
    expect(audit).toMatchObject({
      dataset_version: described.dataset_version,
      artifact_digest: ingested.manifest.artifact_digest,
      checks: {
        manifest: 'ok',
        artifact_digest: 'ok',
        parquet_schema: 'ok',
        record_digests: 'ok',
        dataset_version: 'ok',
      },
    })
    expect(objects.artifactDownloads).toBe(beforeColdRead + 2)

    const conflictingDataset = V2Dataset.fromRecords([secondRecord()])
    await expect(
      workspace.addRecords([secondRecord()], {
        ref: REF_NAME,
        expected_ref_version: '0'.repeat(64),
        message: 'must conflict',
      }),
    ).rejects.toMatchObject({
      name: 'RefConflictErrorV2',
      detail: {
        current_version: described.dataset_version,
        new_version: conflictingDataset.version,
        new_dataset_committed: true,
      },
    })
    await expect(workspace.getRef(REF_NAME)).resolves.toMatchObject({
      version: described.dataset_version,
    })
    await expect(workspace.get(conflictingDataset.version)).resolves.toMatchObject({
      version: conflictingDataset.version,
    })

    const ref = await workspace.getRef(REF_NAME)
    const refs = await workspace.listRefs({ cursor: null, limit: 1 })
    expect(refs.items).toEqual([ref])
    expect(refs.next_cursor).toBeNull()
    await expect(
      workspace.putRef(REF_NAME, {
        new_version: described.dataset_version,
        expected_version: described.dataset_version,
        message: 'GV9 CAS confirmed',
      }),
    ).resolves.toMatchObject({ message: 'GV9 CAS confirmed' })

    const firstWriter = createWorkspace('writer-one')
    const secondWriter = createWorkspace('writer-two')
    const firstRaceRecord = canonicalRecord(`rec_${'7'.repeat(64)}`, 'First concurrent writer.')
    const secondRaceRecord = canonicalRecord(`rec_${'6'.repeat(64)}`, 'Second concurrent writer.')
    const firstRaceVersion = V2Dataset.fromRecords([firstRaceRecord]).version
    const secondRaceVersion = V2Dataset.fromRecords([secondRaceRecord]).version
    const race = await Promise.allSettled([
      firstWriter.addRecords([firstRaceRecord], {
        ref: REF_NAME,
        expected_ref_version: described.dataset_version,
        message: 'writer one',
      }),
      secondWriter.addRecords([secondRaceRecord], {
        ref: REF_NAME,
        expected_ref_version: described.dataset_version,
        message: 'writer two',
      }),
    ])
    const winners = race.filter((result) => result.status === 'fulfilled')
    const losers = race.filter((result) => result.status === 'rejected')
    expect(winners).toHaveLength(1)
    expect(losers).toHaveLength(1)
    expect(losers[0]).toMatchObject({
      reason: {
        name: 'RefConflictErrorV2',
        detail: { new_dataset_committed: true },
      },
    })
    const winningVersion = (
      winners[0] as PromiseFulfilledResult<{
        dataset_version: string
      }>
    ).value.dataset_version
    expect([firstRaceVersion, secondRaceVersion]).toContain(winningVersion)
    await expect(workspace.getRef(REF_NAME)).resolves.toMatchObject({ version: winningVersion })
    await expect(workspace.get(firstRaceVersion)).resolves.toMatchObject({
      version: firstRaceVersion,
    })
    await expect(workspace.get(secondRaceVersion)).resolves.toMatchObject({
      version: secondRaceVersion,
    })

    // Simulate manifest committed but Catalog registration lost. A fresh
    // Workspace must verify the existing artifact/manifest before registering.
    await clearV2Catalog()
    const recoveryWorkspace = createWorkspace('recovery')
    const beforeRecovery = objects.artifactDownloads
    const recovered = await recoveryWorkspace.addJsonl(jsonl(record()), {
      ref: null,
      expected_ref_version: null,
      message: null,
    })
    expect(recovered.dataset_version).toBe(ingested.dataset_version)
    expect(objects.artifactDownloads).toBe(beforeRecovery + 1)
    await expect(recoveryWorkspace.get(recovered.dataset_version)).resolves.toMatchObject({
      version: recovered.dataset_version,
    })
  })

  test('transform miss/hit, cross-Workspace races, exact parents, lineage, and cleanup', async () => {
    const first = canonicalRecord(
      `rec_${'4'.repeat(64)}`,
      'First V10 transform integration record.',
    )
    const second = canonicalRecord(
      `rec_${'5'.repeat(64)}`,
      'Second V10 transform integration record.',
    )
    const input = await workspace.addRecords([first, second], noRefOptions())
    const observed = createObservedWorkspace('v10-observed')
    const subsetRequest = {
      inputs: [input.dataset_version],
      params: { record_ids: [first.id] },
      ...noRefOptions(),
    }

    const downloadsBeforeMissRead = objects.artifactDownloads
    const miss = await observed.workspace.runTransform('subset', subsetRequest)
    expect(miss).toMatchObject({
      cache_hit: false,
      run: {
        run_id: `run_${miss.run.cache_key}`,
        input_dataset_versions: [input.dataset_version],
      },
    })
    expect(objects.artifactDownloads).toBe(downloadsBeforeMissRead + 1)
    const downloadsBeforeOutputRead = objects.artifactDownloads
    const missOutput = await observed.workspace.get(miss.run.output_dataset_version)
    expect([...missOutput.records()].map(({ record }) => record.id)).toEqual([first.id])
    expect(objects.artifactDownloads).toBe(downloadsBeforeOutputRead + 1)
    expect(await prisma.v2Run.count({ where: { cacheKey: miss.run.cache_key } })).toBe(1)
    expect(observed.store.prepared).toHaveLength(1)
    expectUniqueCleanup(observed.store)

    const preparedAfterMiss = observed.store.prepared.length
    const hit = await observed.workspace.runTransform('subset', subsetRequest)
    expect(hit).toEqual({ ...miss, cache_hit: true })
    expect(observed.store.prepared).toHaveLength(preparedAfterMiss)
    expect(await prisma.v2Run.count({ where: { cacheKey: miss.run.cache_key } })).toBe(1)
    expectUniqueCleanup(observed.store)

    const sameOutputBarrier = createTwoPartyBarrier()
    const sameOutputLeft = createObservedWorkspace(
      'v10-same-output-left',
      integrationRaceRegistry('integration-same-output', 0, sameOutputBarrier),
    )
    const sameOutputRight = createObservedWorkspace(
      'v10-same-output-right',
      integrationRaceRegistry('integration-same-output', 0, sameOutputBarrier),
    )
    const sameOutputRequest = {
      inputs: [input.dataset_version],
      params: {
        record_ids: [first.id, second.id].sort(),
      },
      ...noRefOptions(),
    }
    const sameOutputRace = await Promise.all([
      sameOutputLeft.workspace.runTransform('integration-same-output', sameOutputRequest),
      sameOutputRight.workspace.runTransform('integration-same-output', sameOutputRequest),
    ])
    const [sameOutputFirst, sameOutputSecond] = sameOutputRace
    if (!sameOutputFirst || !sameOutputSecond) {
      throw new Error('the identical-output race did not return both Workspace results')
    }
    expect(sameOutputSecond.run.output_dataset_version).toBe(
      sameOutputFirst.run.output_dataset_version,
    )
    expect(sameOutputSecond.run.cache_key).toBe(sameOutputFirst.run.cache_key)
    expect(sameOutputRace.every(({ cache_hit }) => cache_hit === false)).toBe(true)
    expect(await prisma.v2Run.count({ where: { cacheKey: sameOutputFirst.run.cache_key } })).toBe(1)
    expect(sameOutputLeft.store.prepared).toHaveLength(1)
    expect(sameOutputRight.store.prepared).toHaveLength(1)
    expectUniqueCleanup(sameOutputLeft.store)
    expectUniqueCleanup(sameOutputRight.store)

    const raceFirst = canonicalRecord(`rec_${'2'.repeat(64)}`, 'First determinism-race output.')
    const raceSecond = canonicalRecord(`rec_${'3'.repeat(64)}`, 'Second determinism-race output.')
    const raceInput = await workspace.addRecords([raceFirst, raceSecond], noRefOptions())
    const raceRef = 'v10-determinism-race'
    await observed.workspace.putRef(raceRef, {
      new_version: raceInput.dataset_version,
      expected_version: null,
      message: 'before V10 determinism race',
    })
    const determinismBarrier = createTwoPartyBarrier()
    const determinismLeft = createObservedWorkspace(
      'v10-determinism-left',
      integrationRaceRegistry('integration-determinism-race', 0, determinismBarrier),
    )
    const determinismRight = createObservedWorkspace(
      'v10-determinism-right',
      integrationRaceRegistry('integration-determinism-race', 1, determinismBarrier),
    )
    const determinismRequest = {
      inputs: [raceInput.dataset_version],
      params: {
        record_ids: [raceFirst.id, raceSecond.id].sort(),
      },
      ref: raceRef,
      expected_ref_version: raceInput.dataset_version,
      message: 'only the catalog winner may move this ref',
    }
    const determinismRace = await Promise.allSettled([
      determinismLeft.workspace.runTransform('integration-determinism-race', determinismRequest),
      determinismRight.workspace.runTransform('integration-determinism-race', determinismRequest),
    ])
    const determinismWinners = determinismRace.filter(
      (
        result,
      ): result is PromiseFulfilledResult<Awaited<ReturnType<V2Workspace['runTransform']>>> =>
        result.status === 'fulfilled',
    )
    const determinismLosers = determinismRace.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    )
    expect(determinismWinners).toHaveLength(1)
    expect(determinismLosers).toHaveLength(1)
    const winningTransform = determinismWinners[0]
    const losingTransform = determinismLosers[0]
    if (!winningTransform || !losingTransform) {
      throw new Error('the determinism race did not produce exactly one winner and one loser')
    }
    expect(losingTransform.reason).toMatchObject({
      name: 'DeterminismConflictErrorV2',
      code: 'determinism_conflict',
      detail: {
        existing_output_version: winningTransform.value.run.output_dataset_version,
        attempted_dataset_committed: true,
      },
    })
    const losingVersion = (
      losingTransform.reason as {
        detail: { attempted_output_version: string }
      }
    ).detail.attempted_output_version
    expect(losingVersion).not.toBe(winningTransform.value.run.output_dataset_version)
    await expect(observed.workspace.getRef(raceRef)).resolves.toMatchObject({
      version: winningTransform.value.run.output_dataset_version,
    })
    await expect(catalog.getSnapshot(losingVersion)).resolves.toBeNull()
    expect(determinismLeft.store.prepared).toHaveLength(1)
    expect(determinismRight.store.prepared).toHaveLength(1)
    expectUniqueCleanup(determinismLeft.store)
    expectUniqueCleanup(determinismRight.store)

    const promptRecordId = `rec_${'1'.repeat(64)}`
    const promptParent = canonicalRecord(promptRecordId, 'Original prompt text.')
    const promptRewrite = canonicalRecord(promptRecordId, 'Rewritten prompt text.')
    const parentDataset = await workspace.addRecords([promptParent], noRefOptions())
    const rewriteDataset = await workspace.addRecords([promptRewrite], noRefOptions())
    const rewritten = await observed.workspace.runTransform('prompt-rewrite', {
      inputs: [parentDataset.dataset_version, rewriteDataset.dataset_version],
      params: {},
      ...noRefOptions(),
    })
    const rewrittenDataset = await observed.workspace.get(rewritten.run.output_dataset_version)
    const childRevision = [...rewrittenDataset.records()][0]
    const parentRevision = [...(await workspace.get(parentDataset.dataset_version)).records()][0]
    if (!childRevision || !parentRevision) {
      throw new Error('prompt rewrite integration fixtures produced an empty dataset')
    }
    expect(childRevision.record.id).not.toBe(parentRevision.record.id)
    expect(childRevision.record.lineage).toMatchObject({
      parent_refs: [
        {
          id: parentRevision.record.id,
          record_digest: parentRevision.record_digest,
        },
      ],
      run_id: rewritten.run.run_id,
    })
    await expect(
      catalog.getRecordParents(childRevision.record.id, childRevision.record_digest),
    ).resolves.toEqual([
      {
        position: 0,
        parentRecordId: parentRevision.record.id,
        parentRecordDigest: parentRevision.record_digest,
      },
    ])

    const lineage = await observed.workspace.lineage(rewritten.run.output_dataset_version, {
      max_depth: 4,
      max_nodes: 10,
      cursor: null,
    })
    expect(lineage.edges).toContainEqual({
      run_id: rewritten.run.run_id,
      input_dataset_versions: [parentDataset.dataset_version, rewriteDataset.dataset_version],
      output_dataset_version: rewritten.run.output_dataset_version,
    })
    expect(lineage.nodes.map(({ dataset_version }) => dataset_version)).toContain(
      parentDataset.dataset_version,
    )
    expect(observed.store.prepared).toHaveLength(2)
    expectUniqueCleanup(observed.store)
  })

  function createWorkspace(tempName: string): V2Workspace {
    return new V2Workspace({
      catalog,
      store: new FileBackedV2Store({
        objectStore: objects,
        tempRoot: join(temporaryRoot, tempName),
        safetyMarginBytes: 0,
        prepareConcurrency: 1,
        readConcurrency: 1,
      }),
      cursorSecret: 'gv9-integration-cursor-secret',
    })
  }

  function createObservedWorkspace(
    tempName: string,
    transformRegistry?: V2TransformRegistry,
  ): { readonly workspace: V2Workspace; readonly store: ObservedV2Store } {
    const store = new ObservedV2Store(
      new FileBackedV2Store({
        objectStore: objects,
        tempRoot: join(temporaryRoot, tempName),
        safetyMarginBytes: 0,
        prepareConcurrency: 1,
        readConcurrency: 1,
      }),
    )
    return {
      workspace: new V2Workspace({
        catalog,
        store,
        cursorSecret: 'gv10-integration-cursor-secret',
        ...(transformRegistry === undefined ? {} : { transformRegistry }),
      }),
      store,
    }
  }

  async function clearV2Catalog(): Promise<void> {
    await prisma.v2RecordParentEdge.deleteMany()
    await prisma.v2RecordRevisionLocation.deleteMany()
    await prisma.v2RunInput.deleteMany()
    await prisma.v2Run.deleteMany()
    await prisma.v2Ref.deleteMany()
    await prisma.v2DatasetLayout.deleteMany()
    await prisma.v2IdentityClaim.deleteMany()
    await prisma.v2DatasetSnapshot.deleteMany()
    await prisma.v2IdentityNamespace.deleteMany()
  }

  async function deleteAllObjects(admin: S3Client): Promise<void> {
    let continuationToken: string | undefined
    do {
      const page = await admin.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          ...(continuationToken === undefined ? {} : { ContinuationToken: continuationToken }),
        }),
      )
      const keys = (page.Contents ?? [])
        .map((entry) => entry.Key)
        .filter((key): key is string => key !== undefined)
        .map((Key) => ({ Key }))
      if (keys.length > 0) {
        await admin.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys } }))
      }
      continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined
    } while (continuationToken !== undefined)
  }
})

class CountingObjectStore implements ConditionalObjectStoreV2 {
  artifactDownloads = 0

  constructor(private readonly delegate: ConditionalObjectStoreV2) {}

  async conditionalCreate(input: ConditionalCreateInput): Promise<ConditionalCreateResult> {
    return await this.delegate.conditionalCreate(input)
  }

  async head(
    key: string,
    context: V2OperationContext = {},
  ): Promise<Readonly<ObjectHeadV2> | null> {
    return await this.delegate.head(key, context)
  }

  async download(input: ObjectDownloadInputV2): Promise<'downloaded' | 'not_found'> {
    if (input.key.endsWith('.parquet')) this.artifactDownloads += 1
    return await this.delegate.download(input)
  }

  async ping(context: V2OperationContext = {}): Promise<void> {
    await this.delegate.ping(context)
  }
}

class ObservedV2Store implements V2Store {
  readonly readDatasetLimits
  readonly prepared: PreparedArtifactV2[] = []
  readonly discardCounts = new Map<PreparedArtifactV2, number>()

  constructor(private readonly delegate: V2Store) {
    this.readDatasetLimits = delegate.readDatasetLimits
  }

  async prepare(dataset: V2Dataset, context: V2OperationContext = {}): Promise<PreparedArtifactV2> {
    const prepared = await this.delegate.prepare(dataset, context)
    this.prepared.push(prepared)
    return prepared
  }

  async commit(
    prepared: PreparedArtifactV2,
    context: V2OperationContext = {},
  ): Promise<Readonly<DatasetManifestV2>> {
    return await this.delegate.commit(prepared, context)
  }

  async discard(prepared: PreparedArtifactV2, context: V2OperationContext = {}): Promise<void> {
    this.discardCounts.set(prepared, (this.discardCounts.get(prepared) ?? 0) + 1)
    await this.delegate.discard(prepared, context)
  }

  async exists(
    identity: DatasetLayoutIdentityV2,
    context: V2OperationContext = {},
  ): Promise<boolean> {
    return await this.delegate.exists(identity, context)
  }

  async read(
    identity: DatasetLayoutIdentityV2,
    context: V2OperationContext = {},
  ): Promise<V2Dataset> {
    return await this.delegate.read(identity, context)
  }

  async audit(
    identity: DatasetLayoutIdentityV2,
    context: V2OperationContext = {},
  ): Promise<StoreAuditResultV2> {
    return await this.delegate.audit(identity, context)
  }

  async ping(context: V2OperationContext = {}): Promise<void> {
    await this.delegate.ping(context)
  }
}

interface TwoPartyBarrier {
  arrive(): Promise<void>
}

function createTwoPartyBarrier(): TwoPartyBarrier {
  let arrivals = 0
  let release: (() => void) | undefined
  const opened = new Promise<void>((resolve) => {
    release = resolve
  })
  return {
    async arrive(): Promise<void> {
      arrivals += 1
      if (arrivals === 2) release?.()
      await opened
    },
  }
}

function integrationRaceRegistry(
  name: string,
  outputIndex: number,
  barrier: TwoPartyBarrier,
): V2TransformRegistry {
  return new V2TransformRegistry([
    defineV2Transform({
      name,
      version: '1',
      paramsSchema: SubsetV2ParamsSchema,
      identityMode: 'preserve',
      rngSeed: () => null,
      estimateWorkingSet(inputs) {
        const input = inputs[0]
        if (!input || inputs.length !== 1) {
          throw new TypeError(`${name} requires exactly one integration input`)
        }
        return {
          outputUpperBoundBytes: input.canonicalBytes,
          frameEstimateBytes: input.canonicalBytes,
        }
      },
      async run(inputs, _params, context) {
        const input = inputs[0]
        if (!input || inputs.length !== 1) {
          throw new TypeError(`${name} requires exactly one integration input`)
        }
        await barrier.arrive()
        context.signal.throwIfAborted()
        const revision = [...input.records()][outputIndex]
        if (!revision) throw new TypeError(`${name} output index is outside the integration input`)
        return V2Dataset.fromRecords([revision.record], context.limits)
      },
    }),
  ])
}

function expectUniqueCleanup(store: ObservedV2Store): void {
  expect(store.discardCounts.size).toBe(store.prepared.length)
  expect([...store.discardCounts.values()]).toEqual(store.prepared.map(() => 1))
}

function noRefOptions() {
  return {
    ref: null,
    expected_ref_version: null,
    message: null,
  } as const
}

function createS3Client(): S3Client {
  const config = s3Config()
  return new S3Client({
    credentials: {
      accessKeyId: config.accessKeyId ?? 'databench',
      secretAccessKey: config.secretAccessKey ?? 'databench-secret',
    },
    endpoint: config.endpoint,
    forcePathStyle: true,
    maxAttempts: 1,
    region: config.region,
  })
}

function s3Config(): S3ConditionalObjectStoreV2Config {
  return {
    bucket,
    region: process.env.S3_REGION ?? 'us-east-1',
    endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
    accessKeyId: process.env.S3_ACCESS_KEY_ID ?? 'databench',
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? 'databench-secret',
    forcePathStyle: true,
  }
}

async function* jsonl(value: unknown): AsyncIterable<Uint8Array> {
  const bytes = new TextEncoder().encode(`${JSON.stringify(value)}\n`)
  yield bytes.subarray(0, 17)
  yield bytes.subarray(17)
}

function record(): unknown {
  return canonicalRecord(RECORD_ID, 'What is the GV9 status?')
}

function secondRecord(): unknown {
  return canonicalRecord(SECOND_RECORD_ID, 'Prove the ref conflict path.')
}

function canonicalRecord(id: string, text: string) {
  return {
    schema_version: '2.0.0',
    id,
    system_instruction: 'Answer precisely.',
    contents: [
      {
        role: 'user',
        parts: [
          {
            type: 'text',
            text,
            thought: false,
            thought_signature: null,
            part_metadata: {},
          },
        ],
        loss_weight: null,
      },
    ],
    candidates: [],
    preference_relations: [],
    tools: [],
    verification: null,
    source: null,
    lang: 'zh-CN',
    lineage: null,
    tags: ['gv9'],
    extra: { fixture: 'workspace-real-integration' },
  }
}
