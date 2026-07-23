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
import {
  type ConditionalCreateInput,
  type ConditionalCreateResult,
  type ConditionalObjectStoreV2,
  FileBackedV2Store,
  type ObjectDownloadInputV2,
  type ObjectHeadV2,
  S3ConditionalObjectStoreV2,
  type S3ConditionalObjectStoreV2Config,
  type V2OperationContext,
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

function canonicalRecord(id: string, text: string): unknown {
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
