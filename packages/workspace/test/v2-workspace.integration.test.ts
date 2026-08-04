import { createHash, randomUUID } from 'node:crypto'
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
import { hashArtifactBytes } from '@databench/hashing'
import { defineV2Transform, SubsetV2ParamsSchema, V2TransformRegistry } from '@databench/ops'
import type { DatasetLayoutIdentityV2, DatasetManifestV2 } from '@databench/schema'
import {
  type ConditionalCreateInput,
  type ConditionalCreateResult,
  type ConditionalObjectStoreV2,
  FileBackedV2Store,
  ModelArtifactStoreV1,
  type ObjectDownloadInputV2,
  type ObjectHeadV2,
  type PreparedArtifactV2,
  S3ConditionalObjectStoreV2,
  type S3ConditionalObjectStoreV2Config,
  type AuditResultV2 as StoreAuditResultV2,
  type V2OperationContext,
  type V2Store,
  V2TempStore,
  WORKER_STAGING_JSONL_MEDIA_TYPE,
  type WorkerStagingHeadV1,
  type WorkerStagingObjectStoreV1,
  type WorkerStagingPresignInputV1,
  WorkerStagingStoreV1,
} from '@databench/store'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import {
  WorkerCanonicalJobFinalizerV1,
  WorkerWorkspaceInputProjectorV1,
} from '../src/internal/worker/canonical-finalizer.js'
import { compileBasicCleanWorkerParametersV1 } from '../src/internal/worker/data-juicer.js'
import { WorkerStagingJobPreparerV1 } from '../src/internal/worker/staging.js'
import type { V2ModelDeploymentHealthClient } from '../src/v2/model-deployment.js'
import type { V2ModelRepositoryRuntime } from '../src/v2/model-repository.js'
import {
  SwiftStudioProviderConflictError,
  type SwiftStudioProviderV2,
} from '../src/v2/swift-studio-provider.js'
import { V2Workspace, type V2WorkspaceSwiftStudioCatalog } from '../src/v2/workspace.js'

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
    expect(ref?.num_records).toBe(1)
    expect(refs.items[0]?.num_records).toBe(1)
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
      op: rewritten.run.op,
      op_version: rewritten.run.op_version,
      normalized_params: rewritten.run.normalized_params,
      created_at: rewritten.run.created_at,
      input_dataset_versions: [parentDataset.dataset_version, rewriteDataset.dataset_version],
      output_dataset_version: rewritten.run.output_dataset_version,
    })
    expect(lineage.nodes.map(({ dataset_version }) => dataset_version)).toContain(
      parentDataset.dataset_version,
    )
    expect(observed.store.prepared).toHaveLength(2)
    expectUniqueCleanup(observed.store)
  })

  test('finalizes exact Worker staging into a readable canonical Dataset, Run, and lineage', async () => {
    const first = canonicalRecord(
      `rec_${'a'.repeat(64)}`,
      'First retained Worker integration record with enough stable text.',
    )
    const second = canonicalRecord(
      `rec_${'b'.repeat(64)}`,
      'Second discarded Worker integration record with enough stable text.',
    )
    const inputResult = await workspace.addRecords([first, second], noRefOptions())
    const input = await workspace.get(inputResult.dataset_version)
    const cacheKey = 'c'.repeat(64)
    await catalog.createOrReadTransformJob({
      id: `job_${cacheKey}`,
      cacheKey,
      op: 'basic-clean',
      opVersion: '1',
      params: {},
      inputVersion: input.version,
      capabilityName: 'data_juicer.batch',
      capabilityVersion: '1',
      inputCount: BigInt(input.length),
      resultRefNamespaceId: null,
      resultRefName: null,
    })
    const claimed = await catalog.claimNextTransformJob({
      leaseOwner: 'workspace.integration',
      leaseDurationMs: 30_000,
    })
    if (!claimed?.leaseToken) throw new Error('Worker integration job was not claimed')

    const staging = new WorkerStagingStoreV1({
      objectStore: new S3ConditionalObjectStoreV2({ ...s3Config(), client }),
      tempRoot: join(temporaryRoot, 'worker-finalizer-staging'),
      maxBytes: 1024 * 1024,
      signedUrlTtlMs: 60_000,
    })
    const preparer = new WorkerStagingJobPreparerV1({
      catalog,
      staging,
      projector: new WorkerWorkspaceInputProjectorV1(workspace),
      parameters: compileBasicCleanWorkerParametersV1,
      maxOutputBytes: 1024 * 1024,
    })
    const prepared = await preparer.prepare({
      job: claimed,
      executionId: `${claimed.id}.${claimed.attempt}`,
      signal: new AbortController().signal,
      deadlineUnixMs: Date.now() + 30_000,
    })
    const target = prepared.outputs[0]
    const retained = [...input.records()][0]
    if (!target || !retained) throw new Error('Worker integration staging was not prepared')
    const outputBytes = new TextEncoder().encode(
      `${JSON.stringify({
        record_id: retained.record.id,
        record_digest: retained.record_digest,
      })}\n`,
    )
    const uploaded = await fetch(target.writeUrl, {
      method: 'PUT',
      headers: { 'content-type': WORKER_STAGING_JSONL_MEDIA_TYPE },
      body: outputBytes,
    })
    expect(uploaded.ok).toBe(true)
    const lease = { id: claimed.id, attempt: claimed.attempt, leaseToken: claimed.leaseToken }
    await expect(catalog.markTransformJobRunning(lease)).resolves.toMatchObject({
      status: 'running',
    })
    await expect(catalog.markTransformJobFinalizing(lease)).resolves.toMatchObject({
      status: 'finalizing',
    })

    await new WorkerCanonicalJobFinalizerV1(workspace, staging).finalize({
      job: claimed,
      lease,
      outputs: [
        {
          name: 'output',
          size: outputBytes.byteLength,
          digest: createHash('sha256').update(outputBytes).digest('hex'),
          recordCount: 1,
        },
      ],
      signal: new AbortController().signal,
    })

    const completed = await catalog.getTransformJob(claimed.id)
    expect(completed).toMatchObject({
      status: 'completed',
      outputCount: 1n,
      cacheHit: false,
      inputKey: null,
      outputKey: null,
      leaseToken: null,
    })
    if (!completed?.outputVersion) throw new Error('Worker finalizer did not publish an output')
    const output = await workspace.get(completed.outputVersion)
    expect(output.length).toBe(1)
    expect(output.get(retained.record.id)).toMatchObject({
      record_digest: retained.record_digest,
      record_json: retained.record_json,
    })
    await expect(workspace.audit(completed.outputVersion)).resolves.toMatchObject({
      checks: {
        manifest: 'ok',
        artifact_digest: 'ok',
        parquet_schema: 'ok',
        record_digests: 'ok',
        dataset_version: 'ok',
      },
    })
    const run = await catalog.findRun(cacheKey)
    expect(run).toMatchObject({
      id: `run_${cacheKey}`,
      inputVersions: [input.version],
      outputVersion: completed.outputVersion,
    })
    if (!run) throw new Error('completed Worker run was not registered')
    const lineage = await workspace.lineage(completed.outputVersion, {
      max_depth: 2,
      max_nodes: 10,
      cursor: null,
    })
    expect(lineage.edges).toContainEqual({
      run_id: `run_${cacheKey}`,
      op: 'basic-clean',
      op_version: '1',
      normalized_params: claimed.params,
      created_at: run.createdAt.toISOString(),
      input_dataset_versions: [input.version],
      output_dataset_version: completed.outputVersion,
    })
    await expect(
      staging.statExact({ jobId: claimed.id, attempt: claimed.attempt, logicalName: 'input' }),
    ).resolves.toBeNull()
    await expect(
      staging.statExact({ jobId: claimed.id, attempt: claimed.attempt, logicalName: 'output' }),
    ).resolves.toBeNull()
  })

  test('inspects and streams an exact persisted version through a fresh Workspace', async () => {
    const source = trainerRecord(
      `rec_${'3'.repeat(64)}`,
      `cand_${'2'.repeat(64)}`,
      'Export this persisted training row.',
    )
    const published = await workspace.addRecords([source], noRefOptions())
    const fresh = createWorkspace('v11-export')
    const inspected = await fresh.inspectExport(published.dataset_version, {
      converter: 'trl-sft',
      options: {},
    })

    expect(inspected).toMatchObject({
      dataset_version: published.dataset_version,
      converter: 'trl-sft',
      converter_version: '1.0.0',
      output_count: 1,
    })
    const exported = await fresh.export(published.dataset_version, {
      converter: 'trl-sft',
      options: {},
      accepted_fidelity_digest: inspected.fidelity_digest,
    })
    expect(exported.plan).toEqual(inspected)
    const output = await collectUtf8(exported.bytes)
    const row = JSON.parse(output) as {
      prompt: Array<{ content: string; role: string }>
      completion: Array<{ content: string; role: string }>
    }
    expect(row.prompt.at(-1)).toEqual({
      content: 'Export this persisted training row.',
      role: 'user',
    })
    expect(row.completion).toEqual([{ content: 'Persisted export completed.', role: 'assistant' }])

    const evalScopePlan = await fresh.inspectExport(published.dataset_version, {
      converter: 'evalscope-general-qa',
      options: { target_source: 'selected-candidate' },
    })
    const evalScopeExport = await fresh.export(published.dataset_version, {
      converter: 'evalscope-general-qa',
      options: { target_source: 'selected-candidate' },
      accepted_fidelity_digest: evalScopePlan.fidelity_digest,
    })
    const evalScopeRow = JSON.parse(await collectUtf8(evalScopeExport.bytes)) as {
      messages: Array<{ content: string; role: string }>
      response: string
      _databench: {
        dataset_version: string
        record_id: string
        record_digest: string
        candidate_id: string
      }
    }
    expect(evalScopeRow).toMatchObject({
      messages: [
        { content: 'Answer precisely.', role: 'system' },
        { content: 'Export this persisted training row.', role: 'user' },
      ],
      response: 'Persisted export completed.',
      _databench: {
        dataset_version: published.dataset_version,
        record_id: `rec_${'3'.repeat(64)}`,
        record_digest: expect.stringMatching(/^[0-9a-f]{64}$/),
        candidate_id: `cand_${'2'.repeat(64)}`,
      },
    })
  })

  test('binds an exact Dataset to one replayable Swift Studio Session', async () => {
    const sessionSourceWorkspace = createWorkspace('swift-session-source')
    const source = trainerRecord(
      `rec_${'4'.repeat(64)}`,
      `cand_${'5'.repeat(64)}`,
      'Prepare this exact Dataset for Swift Studio.',
    )
    const published = await sessionSourceWorkspace.addRecords([source], {
      ref: 'swift-session-source',
      expected_ref_version: null,
      message: 'Swift Studio exact source',
    })
    const providerCreates: Array<Parameters<SwiftStudioProviderV2['createSession']>[0]> = []
    const providerCloses: Array<{ providerSessionId: string; requestId: string }> = []
    const provider: SwiftStudioProviderV2 = {
      async createSession(input) {
        providerCreates.push(input)
        return {
          providerSessionId: `sws_${Buffer.from(input.requestId, 'hex').toString('base64url')}`,
          status: 'ready',
          datasetVersion: input.datasetVersion,
          converter: 'ms-swift',
          converterVersion: '1.0.0',
          exportDigest: input.expected.digest,
          exportSizeBytes: input.expected.sizeBytes,
          outputCount: input.expected.lineCount,
          providerGeneration: 'integration-test',
          replayed: false,
        }
      },
      async getCurrentSession() {
        return null
      },
      async closeSession(providerSessionId, requestId) {
        providerCloses.push({ providerSessionId, requestId })
        return {
          providerSessionId,
          status: 'closed',
          providerGeneration: 'integration-test',
          replayed: false,
        }
      },
    }
    const studio = new V2Workspace({
      catalog,
      store: new FileBackedV2Store({
        objectStore: objects,
        tempRoot: join(temporaryRoot, 'swift-session'),
        safetyMarginBytes: 0,
        prepareConcurrency: 1,
        readConcurrency: 1,
      }),
      cursorSecret: 'swift-studio-integration-cursor-secret',
      swiftStudio: {
        catalog,
        provider,
        datasetExportBaseUrl: 'http://api:8000',
        upstreamCommit: 'f48847d23dbcd72ceb15fdbc5a1482cc7eb0359d',
        imageDigest: '57f2448c3e06985d1989465703f8e4883aee71da40b79be3bdfb70e6dda1f74d',
        runtimeCapabilityDigest: '441a53584131400a9ba462bd262e931ca584f411d721b009ee122f165da3828f',
        preparationAbandonGraceMs: 0,
      },
    })
    const inspected = await studio.inspectExport(published.dataset_version, {
      converter: 'ms-swift',
      options: {},
    })
    const request = {
      dataset_version: published.dataset_version,
      display_ref: 'swift-session-source',
      converter: 'ms-swift' as const,
      options: {},
      accepted_fidelity_digest: inspected.fidelity_digest,
    }
    const created = await studio.createSwiftStudioSession(request)
    expect(created).toMatchObject({
      status: 'ready',
      dataset_version: published.dataset_version,
      display_ref: 'swift-session-source',
      output_count: 1,
      studio_path: '/swift-studio/',
      export_digest: providerCreates[0]?.expected.digest,
      export_size_bytes: providerCreates[0]?.expected.sizeBytes,
    })
    expect(providerCreates).toHaveLength(1)
    expect(providerCreates[0]).toMatchObject({
      datasetVersion: published.dataset_version,
      exportUrl: `http://api:8000/v2/datasets/${published.dataset_version}:export`,
      expected: { digestAlgorithm: 'blake3', lineCount: 1 },
    })

    await expect(studio.createSwiftStudioSession(request)).resolves.toEqual(created)
    expect(providerCreates).toHaveLength(1)

    const another = await workspace.addRecords(
      [
        trainerRecord(
          `rec_${'6'.repeat(64)}`,
          `cand_${'7'.repeat(64)}`,
          'A different active Studio Dataset.',
        ),
      ],
      noRefOptions(),
    )
    const anotherPlan = await studio.inspectExport(another.dataset_version, {
      converter: 'ms-swift',
      options: {},
    })
    await expect(
      studio.createSwiftStudioSession({
        dataset_version: another.dataset_version,
        display_ref: null,
        converter: 'ms-swift',
        options: {},
        accepted_fidelity_digest: anotherPlan.fidelity_digest,
      }),
    ).rejects.toMatchObject({
      name: 'SwiftStudioSessionStateConflictErrorV2',
      detail: { reason: 'active_session_exists', session_id: created.id },
    })

    const listed = await studio.listSwiftStudioSessions({ cursor: null, limit: 20 })
    expect(listed.items[0]).toEqual(created)
    await expect(studio.getSwiftStudioSession(created.id)).resolves.toEqual(created)
    const closed = await studio.closeSwiftStudioSession(created.id)
    expect(closed).toMatchObject({ id: created.id, status: 'closed', studio_path: null })
    expect(providerCloses).toEqual([
      {
        providerSessionId: `sws_${Buffer.from(created.create_digest, 'hex').toString('base64url')}`,
        requestId: created.create_digest,
      },
    ])
  })

  test('fails an unprepared Provider Session and releases the singleton slot', async () => {
    const first = await workspace.addRecords(
      [
        trainerRecord(
          `rec_${'a'.repeat(64)}`,
          `cand_${'b'.repeat(64)}`,
          'The first Provider preparation fails.',
        ),
      ],
      noRefOptions(),
    )
    const second = await workspace.addRecords(
      [
        trainerRecord(
          `rec_${'c'.repeat(64)}`,
          `cand_${'d'.repeat(64)}`,
          'The singleton slot must be reusable.',
        ),
      ],
      noRefOptions(),
    )
    let createAttempts = 0
    const provider: SwiftStudioProviderV2 = {
      async createSession(input) {
        createAttempts += 1
        if (createAttempts === 1) throw new Error('simulated Provider preparation failure')
        return readyProviderSession(input)
      },
      async getCurrentSession() {
        return null
      },
      async closeSession(providerSessionId) {
        return closedProviderSession(providerSessionId)
      },
    }
    const studio = createSwiftStudioWorkspace('swift-session-failure', provider)

    const firstRequest = await swiftStudioRequest(studio, first.dataset_version)
    await expect(studio.createSwiftStudioSession(firstRequest)).rejects.toThrow(
      'simulated Provider preparation failure',
    )
    const failedPage = await studio.listSwiftStudioSessions({
      dataset_version: first.dataset_version,
      cursor: null,
      limit: 20,
    })
    expect(failedPage.items).toHaveLength(1)
    expect(failedPage.items[0]).toMatchObject({
      status: 'failed',
      failure: {
        phase: 'provider',
        code: 'prepare_unconfirmed',
        message: 'Provider did not retain the Studio Session preparation',
      },
      studio_path: null,
    })

    const secondRequest = await swiftStudioRequest(studio, second.dataset_version)
    const ready = await studio.createSwiftStudioSession(secondRequest)
    expect(ready).toMatchObject({ status: 'ready', dataset_version: second.dataset_version })
    await expect(studio.closeSwiftStudioSession(ready.id)).resolves.toMatchObject({
      status: 'closed',
    })
  })

  test('reconciles a lost Provider create response to the exact ready Session', async () => {
    const published = await workspace.addRecords(
      [
        trainerRecord(
          `rec_${'e'.repeat(64)}`,
          `cand_${'f'.repeat(64)}`,
          'Reconcile the exact Provider locator after response loss.',
        ),
      ],
      noRefOptions(),
    )
    let current: Awaited<ReturnType<SwiftStudioProviderV2['getCurrentSession']>> = null
    const provider: SwiftStudioProviderV2 = {
      async createSession(input) {
        current = readyProviderSession(input)
        throw new Error('simulated Provider response loss')
      },
      async getCurrentSession() {
        return current
      },
      async closeSession(providerSessionId) {
        current = null
        return closedProviderSession(providerSessionId)
      },
    }
    const studio = createSwiftStudioWorkspace('swift-session-reconcile', provider)
    const request = await swiftStudioRequest(studio, published.dataset_version)

    const ready = await studio.createSwiftStudioSession(request)
    expect(ready).toMatchObject({
      status: 'ready',
      dataset_version: published.dataset_version,
      export_digest: current?.exportDigest,
      export_size_bytes: current?.exportSizeBytes,
    })
    await studio.closeSwiftStudioSession(ready.id)
  })

  test('keeps a busy Provider Session ready until native tasks can stop', async () => {
    const published = await workspace.addRecords(
      [
        trainerRecord(
          `rec_${'1'.repeat(64)}`,
          `cand_${'3'.repeat(64)}`,
          'Keep the native Studio available while a task is active.',
        ),
      ],
      noRefOptions(),
    )
    let current: Awaited<ReturnType<SwiftStudioProviderV2['getCurrentSession']>> = null
    let closeAttempts = 0
    const provider: SwiftStudioProviderV2 = {
      async createSession(input) {
        current = readyProviderSession(input)
        return current
      },
      async getCurrentSession() {
        return current
      },
      async closeSession(providerSessionId) {
        closeAttempts += 1
        if (closeAttempts === 1) {
          throw new SwiftStudioProviderConflictError(
            'session_has_active_tasks',
            'Studio Session still has an active native task',
          )
        }
        current = null
        return closedProviderSession(providerSessionId)
      },
    }
    const studio = createSwiftStudioWorkspace('swift-session-busy-close', provider)
    const request = await swiftStudioRequest(studio, published.dataset_version)
    const ready = await studio.createSwiftStudioSession(request)

    await expect(studio.closeSwiftStudioSession(ready.id)).rejects.toMatchObject({
      name: 'SwiftStudioSessionStateConflictErrorV2',
      detail: {
        reason: 'provider_session_busy',
        session_id: ready.id,
        status: 'ready',
        requested_status: 'closing',
      },
    })
    await expect(studio.getSwiftStudioSession(ready.id)).resolves.toMatchObject({
      status: 'ready',
      studio_path: '/swift-studio/',
    })
    await expect(studio.closeSwiftStudioSession(ready.id)).resolves.toMatchObject({
      status: 'closed',
      studio_path: null,
    })
  })

  test('gives one concurrent create replay exclusive Provider preparation ownership', async () => {
    const published = await workspace.addRecords(
      [
        trainerRecord(
          `rec_${'2'.repeat(64)}`,
          `cand_${'4'.repeat(64)}`,
          'Only one concurrent request may prepare this Session.',
        ),
      ],
      noRefOptions(),
    )
    let providerCreates = 0
    let releaseProvider: (() => void) | undefined
    let announceProvider: (() => void) | undefined
    const providerStarted = new Promise<void>((resolve) => {
      announceProvider = resolve
    })
    const providerReleased = new Promise<void>((resolve) => {
      releaseProvider = resolve
    })
    const provider: SwiftStudioProviderV2 = {
      async createSession(input) {
        providerCreates += 1
        announceProvider?.()
        await providerReleased
        return readyProviderSession(input)
      },
      async getCurrentSession() {
        return null
      },
      async closeSession(providerSessionId) {
        return closedProviderSession(providerSessionId)
      },
    }
    const studio = createSwiftStudioWorkspace('swift-session-owner', provider)
    const request = await swiftStudioRequest(studio, published.dataset_version)

    const owner = studio.createSwiftStudioSession(request)
    await providerStarted
    const replay = await studio.createSwiftStudioSession(request)
    expect(replay).toMatchObject({ status: 'preparing' })
    expect(providerCreates).toBe(1)
    releaseProvider?.()
    const ready = await owner
    expect(ready).toMatchObject({ status: 'ready' })
    expect(providerCreates).toBe(1)
    await studio.closeSwiftStudioSession(ready.id)
  })

  test('converges an admitted Session to failed even when the caller aborts admission', async () => {
    const published = await workspace.addRecords(
      [
        trainerRecord(
          `rec_${'5'.repeat(64)}`,
          `cand_${'6'.repeat(64)}`,
          'Abort only after the Catalog admission commits.',
        ),
      ],
      noRefOptions(),
    )
    let releaseAdmission: (() => void) | undefined
    let announceAdmission: (() => void) | undefined
    const admissionCommitted = new Promise<void>((resolve) => {
      announceAdmission = resolve
    })
    const admissionReleased = new Promise<void>((resolve) => {
      releaseAdmission = resolve
    })
    const baseCatalog = swiftStudioCatalog()
    const delayedCatalog = swiftStudioCatalog({
      async createOrReadSwiftStudioSession(input) {
        const result = await baseCatalog.createOrReadSwiftStudioSession(input)
        announceAdmission?.()
        await admissionReleased
        return result
      },
    })
    let providerCreates = 0
    const provider: SwiftStudioProviderV2 = {
      async createSession(input) {
        providerCreates += 1
        return readyProviderSession(input)
      },
      async getCurrentSession() {
        return null
      },
      async closeSession(providerSessionId) {
        return closedProviderSession(providerSessionId)
      },
    }
    const studio = createSwiftStudioWorkspace(
      'swift-session-admission-abort',
      provider,
      delayedCatalog,
    )
    const request = await swiftStudioRequest(studio, published.dataset_version)
    const controller = new AbortController()
    const creating = studio.createSwiftStudioSession(request, { signal: controller.signal })
    await admissionCommitted
    controller.abort(new Error('simulated caller disconnect'))
    releaseAdmission?.()

    await expect(creating).rejects.toThrow('simulated caller disconnect')
    const page = await studio.listSwiftStudioSessions({
      dataset_version: published.dataset_version,
      cursor: null,
      limit: 20,
    })
    expect(page.items[0]).toMatchObject({ status: 'failed' })
    expect(providerCreates).toBe(0)
  })

  test('marks an ambiguous Provider failure abandoned and reconciles it when absence is confirmed', async () => {
    const published = await workspace.addRecords(
      [
        trainerRecord(
          `rec_${'7'.repeat(64)}`,
          `cand_${'8'.repeat(64)}`,
          'Recover an ambiguous Provider failure without orphaning the singleton.',
        ),
      ],
      noRefOptions(),
    )
    let currentReads = 0
    const provider: SwiftStudioProviderV2 = {
      async createSession() {
        throw new Error('simulated ambiguous Provider failure')
      },
      async getCurrentSession() {
        currentReads += 1
        if (currentReads === 1) throw new Error('simulated reconcile partition')
        return null
      },
      async closeSession(providerSessionId) {
        return closedProviderSession(providerSessionId)
      },
    }
    const studio = createSwiftStudioWorkspace('swift-session-abandoned', provider)
    const request = await swiftStudioRequest(studio, published.dataset_version)

    await expect(studio.createSwiftStudioSession(request)).rejects.toThrow(
      'simulated ambiguous Provider failure',
    )
    const page = await studio.listSwiftStudioSessions({ cursor: null, limit: 20 })
    expect(page.items[0]).toMatchObject({
      status: 'failed',
      failure: { code: 'prepare_unconfirmed' },
    })
  })

  test('reclaims an abandoned Session during different-Dataset admission', async () => {
    const first = await workspace.addRecords(
      [
        trainerRecord(
          `rec_${'b'.repeat(64)}`,
          `cand_${'c'.repeat(64)}`,
          'Leave the first Provider preparation ambiguous.',
        ),
      ],
      noRefOptions(),
    )
    const second = await workspace.addRecords(
      [
        trainerRecord(
          `rec_${'d'.repeat(64)}`,
          `cand_${'e'.repeat(64)}`,
          'Admit a different exact Dataset after recovery.',
        ),
      ],
      noRefOptions(),
    )
    let createCalls = 0
    let currentReads = 0
    const provider: SwiftStudioProviderV2 = {
      async createSession(input) {
        createCalls += 1
        if (createCalls === 1) throw new Error('simulated ambiguous Provider failure')
        return readyProviderSession(input)
      },
      async getCurrentSession() {
        currentReads += 1
        if (currentReads === 1) throw new Error('simulated reconciliation partition')
        return null
      },
      async closeSession(providerSessionId) {
        return closedProviderSession(providerSessionId)
      },
    }
    const studio = createSwiftStudioWorkspace('swift-session-admission-recovery', provider)
    const firstRequest = await swiftStudioRequest(studio, first.dataset_version)
    await expect(studio.createSwiftStudioSession(firstRequest)).rejects.toThrow(
      'simulated ambiguous Provider failure',
    )

    const secondRequest = await swiftStudioRequest(studio, second.dataset_version)
    const ready = await studio.createSwiftStudioSession(secondRequest)
    expect(ready).toMatchObject({
      dataset_version: second.dataset_version,
      status: 'ready',
    })
    expect(createCalls).toBe(2)
    const firstPage = await studio.listSwiftStudioSessions({
      dataset_version: first.dataset_version,
      cursor: null,
      limit: 20,
    })
    expect(firstPage.items[0]).toMatchObject({ status: 'failed' })
    await expect(studio.closeSwiftStudioSession(ready.id)).resolves.toMatchObject({
      status: 'closed',
    })
  })

  test('does not close an exact Provider Session when ready transition recovery takes ownership', async () => {
    const published = await workspace.addRecords(
      [
        trainerRecord(
          `rec_${'f'.repeat(64)}`,
          `cand_${'0'.repeat(64)}`,
          'Fence ready transition recovery without closing the Provider.',
        ),
      ],
      noRefOptions(),
    )
    const baseCatalog = swiftStudioCatalog()
    let readyAttempts = 0
    const transitionFailureCatalog = swiftStudioCatalog({
      async transitionSwiftStudioSession(input) {
        if (input.status === 'ready' && readyAttempts < 2) {
          readyAttempts += 1
          throw new Error('simulated ready transition outage')
        }
        return await baseCatalog.transitionSwiftStudioSession(input)
      },
    })
    let current: Awaited<ReturnType<SwiftStudioProviderV2['createSession']>> | null = null
    let closeCalls = 0
    const provider: SwiftStudioProviderV2 = {
      async createSession(input) {
        current = readyProviderSession(input)
        return current
      },
      async getCurrentSession() {
        return current
      },
      async closeSession(providerSessionId) {
        closeCalls += 1
        current = null
        return closedProviderSession(providerSessionId)
      },
    }
    const studio = createSwiftStudioWorkspace(
      'swift-session-ready-fence',
      provider,
      transitionFailureCatalog,
    )
    const request = await swiftStudioRequest(studio, published.dataset_version)
    await expect(studio.createSwiftStudioSession(request)).rejects.toThrow(
      'V2 Catalog operation is unavailable',
    )
    const page = await studio.listSwiftStudioSessions({ cursor: null, limit: 20 })
    expect(page.items[0]).toMatchObject({ status: 'ready' })
    expect(closeCalls).toBe(0)
    expect(readyAttempts).toBe(2)
    await expect(studio.closeSwiftStudioSession(page.items[0]?.id ?? '')).resolves.toMatchObject({
      status: 'closed',
    })
  })

  test('keeps a mismatched Provider export fenced until exact cleanup succeeds', async () => {
    const published = await workspace.addRecords(
      [
        trainerRecord(
          `rec_${'1'.repeat(64)}`,
          `cand_${'3'.repeat(64)}`,
          'Reject a Provider export with the wrong digest.',
        ),
      ],
      noRefOptions(),
    )
    let current: Awaited<ReturnType<SwiftStudioProviderV2['createSession']>> | null = null
    let closeCalls = 0
    const provider: SwiftStudioProviderV2 = {
      async createSession(input) {
        current = { ...readyProviderSession(input), exportDigest: '0'.repeat(64) }
        return current
      },
      async getCurrentSession() {
        return current
      },
      async closeSession(providerSessionId) {
        closeCalls += 1
        if (closeCalls === 1) throw new Error('simulated cleanup outage')
        current = null
        return closedProviderSession(providerSessionId)
      },
    }
    const studio = createSwiftStudioWorkspace('swift-session-mismatch-fence', provider)
    const request = await swiftStudioRequest(studio, published.dataset_version)
    await expect(studio.createSwiftStudioSession(request)).rejects.toThrow(
      'Swift Studio Provider prepared another export',
    )
    const page = await studio.listSwiftStudioSessions({ cursor: null, limit: 20 })
    expect(page.items[0]).toMatchObject({
      status: 'failed',
      failure: { code: 'export_mismatch' },
    })
    expect(closeCalls).toBe(2)
  })

  test('reads back a committed failed transition response loss', async () => {
    const published = await workspace.addRecords(
      [
        trainerRecord(
          `rec_${'2'.repeat(64)}`,
          `cand_${'4'.repeat(64)}`,
          'Confirm a failed Catalog terminal after response loss.',
        ),
      ],
      noRefOptions(),
    )
    const baseCatalog = swiftStudioCatalog()
    let loseFailedResponse = true
    const responseLossCatalog = swiftStudioCatalog({
      async transitionSwiftStudioSession(input) {
        const result = await baseCatalog.transitionSwiftStudioSession(input)
        if (input.status === 'failed' && loseFailedResponse) {
          loseFailedResponse = false
          throw new Error('simulated failed transition response loss')
        }
        return result
      },
    })
    const provider: SwiftStudioProviderV2 = {
      async createSession() {
        throw new Error('simulated definitive Provider failure')
      },
      async getCurrentSession() {
        return null
      },
      async closeSession(providerSessionId) {
        return closedProviderSession(providerSessionId)
      },
    }
    const studio = createSwiftStudioWorkspace(
      'swift-session-failed-readback',
      provider,
      responseLossCatalog,
    )
    const request = await swiftStudioRequest(studio, published.dataset_version)
    await expect(studio.createSwiftStudioSession(request)).rejects.toThrow(
      'simulated definitive Provider failure',
    )
    const page = await studio.listSwiftStudioSessions({ cursor: null, limit: 20 })
    expect(page.items[0]).toMatchObject({ status: 'failed' })
  })

  test('promotes an exact late Provider result after an ambiguous create response', async () => {
    const published = await workspace.addRecords(
      [
        trainerRecord(
          `rec_${'5'.repeat(64)}`,
          `cand_${'6'.repeat(64)}`,
          'Recover the exact Provider result after a transient partition.',
        ),
      ],
      noRefOptions(),
    )
    let current: Awaited<ReturnType<SwiftStudioProviderV2['createSession']>> | null = null
    let currentReads = 0
    const provider: SwiftStudioProviderV2 = {
      async createSession(input) {
        current = readyProviderSession(input)
        throw new Error('simulated lost Provider create response')
      },
      async getCurrentSession() {
        currentReads += 1
        if (currentReads === 1) throw new Error('simulated current-session partition')
        return current
      },
      async closeSession(providerSessionId) {
        current = null
        return closedProviderSession(providerSessionId)
      },
    }
    const studio = createSwiftStudioWorkspace('swift-session-late-ready', provider)
    const request = await swiftStudioRequest(studio, published.dataset_version)
    await expect(studio.createSwiftStudioSession(request)).rejects.toThrow(
      'simulated lost Provider create response',
    )
    const page = await studio.listSwiftStudioSessions({ cursor: null, limit: 20 })
    expect(page.items[0]).toMatchObject({ status: 'ready' })
    await expect(studio.closeSwiftStudioSession(page.items[0]?.id ?? '')).resolves.toMatchObject({
      status: 'closed',
    })
  })

  test('does not fail an ambiguous null read before the Provider result arrives', async () => {
    const published = await workspace.addRecords(
      [
        trainerRecord(
          `rec_${'7'.repeat(64)}`,
          `cand_${'8'.repeat(64)}`,
          'Keep the Catalog fenced across a null-before-late-ready race.',
        ),
      ],
      noRefOptions(),
    )
    let pending: Awaited<ReturnType<SwiftStudioProviderV2['createSession']>> | null = null
    let current: Awaited<ReturnType<SwiftStudioProviderV2['createSession']>> | null = null
    const provider: SwiftStudioProviderV2 = {
      async createSession(input) {
        pending = readyProviderSession(input)
        throw new Error('simulated create response race')
      },
      async getCurrentSession() {
        return current
      },
      async closeSession(providerSessionId) {
        current = null
        return closedProviderSession(providerSessionId)
      },
    }
    const studio = createSwiftStudioWorkspace('swift-session-null-late-ready', provider)
    const request = await swiftStudioRequest(studio, published.dataset_version)
    await expect(studio.createSwiftStudioSession(request)).rejects.toThrow(
      'simulated create response race',
    )
    current = pending
    const page = await studio.listSwiftStudioSessions({ cursor: null, limit: 20 })
    expect(page.items[0]).toMatchObject({ status: 'ready' })
    await expect(studio.closeSwiftStudioSession(page.items[0]?.id ?? '')).resolves.toMatchObject({
      status: 'closed',
    })
  })

  test('keeps a foreign Provider locator fenced until operator repair confirms absence', async () => {
    const first = await workspace.addRecords(
      [
        trainerRecord(
          `rec_${'a'.repeat(64)}`,
          `cand_${'c'.repeat(64)}`,
          'Do not release a foreign active Provider locator.',
        ),
      ],
      noRefOptions(),
    )
    const second = await workspace.addRecords(
      [
        trainerRecord(
          `rec_${'b'.repeat(64)}`,
          `cand_${'d'.repeat(64)}`,
          'A different Dataset must remain blocked by the foreign locator.',
        ),
      ],
      noRefOptions(),
    )
    let createCalls = 0
    let closeCalls = 0
    let current: Awaited<ReturnType<SwiftStudioProviderV2['createSession']>> | null = null
    const provider: SwiftStudioProviderV2 = {
      async createSession(input) {
        createCalls += 1
        current =
          createCalls === 1
            ? {
                ...readyProviderSession(input),
                providerSessionId: `sws_${'A'.repeat(43)}`,
              }
            : readyProviderSession(input)
        return current
      },
      async getCurrentSession() {
        return current
      },
      async closeSession(providerSessionId) {
        closeCalls += 1
        current = null
        return closedProviderSession(providerSessionId)
      },
    }
    const studio = createSwiftStudioWorkspace('swift-session-foreign-locator', provider)
    const firstRequest = await swiftStudioRequest(studio, first.dataset_version)
    await expect(studio.createSwiftStudioSession(firstRequest)).rejects.toThrow(
      'Swift Studio Provider prepared another export',
    )
    const preparing = await studio.listSwiftStudioSessions({
      dataset_version: first.dataset_version,
      cursor: null,
      limit: 20,
    })
    expect(preparing.items[0]).toMatchObject({ status: 'preparing' })
    expect(closeCalls).toBe(0)

    const secondRequest = await swiftStudioRequest(studio, second.dataset_version)
    await expect(studio.createSwiftStudioSession(secondRequest)).rejects.toMatchObject({
      name: 'SwiftStudioSessionStateConflictErrorV2',
      detail: { reason: 'active_session_exists' },
    })
    expect(createCalls).toBe(1)

    current = null
    const repaired = await studio.listSwiftStudioSessions({
      dataset_version: first.dataset_version,
      cursor: null,
      limit: 20,
    })
    expect(repaired.items[0]).toMatchObject({
      status: 'failed',
      failure: { code: 'prepare_unconfirmed' },
    })
    expect(closeCalls).toBe(0)
    const ready = await studio.createSwiftStudioSession(secondRequest)
    expect(ready).toMatchObject({ status: 'ready', dataset_version: second.dataset_version })
    expect(createCalls).toBe(2)
    await expect(studio.closeSwiftStudioSession(ready.id)).resolves.toMatchObject({
      status: 'closed',
    })
  })

  test('reads back ready transition response loss and ignores caller abort after Provider close', async () => {
    const published = await workspace.addRecords(
      [
        trainerRecord(
          `rec_${'9'.repeat(64)}`,
          `cand_${'a'.repeat(64)}`,
          'Converge terminal state independently from the HTTP caller.',
        ),
      ],
      noRefOptions(),
    )
    const baseCatalog = swiftStudioCatalog()
    let loseReadyResponse = true
    const responseLossCatalog = swiftStudioCatalog({
      async transitionSwiftStudioSession(input) {
        const result = await baseCatalog.transitionSwiftStudioSession(input)
        if (input.status === 'ready' && loseReadyResponse) {
          loseReadyResponse = false
          throw new Error('simulated ready transition response loss')
        }
        return result
      },
    })
    const controller = new AbortController()
    const provider: SwiftStudioProviderV2 = {
      async createSession(input) {
        return readyProviderSession(input)
      },
      async getCurrentSession() {
        return null
      },
      async closeSession(providerSessionId) {
        controller.abort(new Error('simulated disconnect after Provider close'))
        return closedProviderSession(providerSessionId)
      },
    }
    const studio = createSwiftStudioWorkspace(
      'swift-session-terminal-response-loss',
      provider,
      responseLossCatalog,
    )
    const request = await swiftStudioRequest(studio, published.dataset_version)
    const ready = await studio.createSwiftStudioSession(request)
    expect(ready).toMatchObject({ status: 'ready' })

    await expect(
      studio.closeSwiftStudioSession(ready.id, { signal: controller.signal }),
    ).resolves.toMatchObject({ status: 'closed' })
  })

  test('imports, publishes, cleans, downloads, and retains a LoRA Artifact after Session close', async () => {
    const published = await workspace.addRecords(
      [
        trainerRecord(
          `rec_${'d'.repeat(64)}`,
          `cand_${'e'.repeat(64)}`,
          'Publish an immutable Adapter through real MinIO staging.',
        ),
      ],
      noRefOptions(),
    )
    const archive = new TextEncoder().encode('deterministic-tar-zst-integration-fixture')
    const archiveDigest = hashArtifactBytes(archive)
    const outputSnapshotDigest = '6'.repeat(64)
    const outputHandle = `swo_${'A'.repeat(43)}`
    const adapterConfig = new TextEncoder().encode('{"peft_type":"LORA"}')
    const adapterWeights = new TextEncoder().encode('SAFETENSORS-INTEGRATION')
    let current: Awaited<ReturnType<SwiftStudioProviderV2['createSession']>> | null = null
    const imports = new Map<
      string,
      Awaited<ReturnType<SwiftStudioProviderV2['startArtifactImport']>>
    >()
    const provider: SwiftStudioProviderV2 = {
      async createSession(input) {
        current = readyProviderSession(input)
        return current
      },
      async getCurrentSession() {
        return current
      },
      async closeSession(providerSessionId) {
        current = null
        return closedProviderSession(providerSessionId)
      },
      async listOutputs(providerSessionId) {
        return {
          provider_session_id: providerSessionId,
          provider_generation: 'integration-test',
          items: [
            {
              handle: outputHandle,
              output_snapshot_digest: outputSnapshotDigest,
              display_name: 'checkpoint-3',
              candidate_kinds: ['lora_adapter'],
              size_bytes: adapterConfig.byteLength + adapterWeights.byteLength,
              modified_at: '2026-07-28T00:00:00.000Z',
              importable: true,
              reason: null,
              provider_generation: 'integration-test',
            },
          ],
        }
      },
      async startArtifactImport(input) {
        const uploaded = await fetch(input.staging_upload_url, {
          method: 'PUT',
          headers: {
            'Content-Length': String(archive.byteLength),
            'Content-Type': 'application/zstd',
          },
          body: Buffer.from(archive),
        })
        if (!uploaded.ok) throw new Error(`signed staging upload failed: ${uploaded.status}`)
        const providerImportId = `swai_${Buffer.from(input.request_id, 'hex').toString('base64url')}`
        const staged = {
          provider_import_id: providerImportId,
          request_id: input.request_id,
          provider_session_id: input.provider_session_id,
          provider_generation: 'integration-test',
          status: 'staged' as const,
          output_snapshot_digest: outputSnapshotDigest,
          staging_object_key: input.staging_object_key,
          archive_digest: archiveDigest,
          archive_size_bytes: archive.byteLength,
          provider_metadata: {
            provider_metadata_version: 'swift-lora-snapshot-v1' as const,
            artifact_kind: 'lora_adapter' as const,
            artifact_format: 'swift-lora-adapter-v1' as const,
            archive_format: 'deterministic-tar-zst-v1' as const,
            source: {
              provider_generation: 'integration-test',
              provider_session_id: input.provider_session_id,
            },
            adapter: { peft_type: 'LORA', rank: 8 },
            base_model: {
              reference: input.base_model.reference,
              revision: input.base_model.revision,
              binding_status: 'verified' as const,
            },
            training_summary: {
              train_stage: 'sft',
              tuner_type: 'lora' as const,
              lora_rank: 8,
              lora_alpha: null,
              lora_dropout: null,
              num_train_epochs: 1,
              max_steps: null,
              learning_rate: null,
              max_length: null,
              dtype: null,
              seed: null,
              redacted_fields_count: 0,
            },
            dataset_lineage: {
              status: 'verified' as const,
              dataset_version: published.dataset_version,
              dataset_export_digest: current?.exportDigest ?? null,
            },
            archive_digest_algorithm: 'blake3' as const,
            archive_digest: archiveDigest,
            archive_size_bytes: archive.byteLength,
            output_snapshot_digest: outputSnapshotDigest,
            files: [
              {
                path: 'adapter_config.json',
                digest_algorithm: 'blake3' as const,
                digest: hashArtifactBytes(adapterConfig),
                size_bytes: adapterConfig.byteLength,
              },
              {
                path: 'adapter_model.safetensors',
                digest_algorithm: 'blake3' as const,
                digest: hashArtifactBytes(adapterWeights),
                size_bytes: adapterWeights.byteLength,
              },
            ],
          },
          failure: null,
          replayed: false,
        }
        imports.set(providerImportId, staged)
        return staged
      },
      async getArtifactImport(providerImportId) {
        return imports.get(providerImportId) ?? null
      },
    }
    const studio = createSwiftStudioWorkspace('model-artifact-lifecycle', provider)
    const request = await swiftStudioRequest(studio, published.dataset_version)
    const session = await studio.createSwiftStudioSession(request)
    const output = (await studio.listSwiftStudioOutputs(session.id)).items[0]
    if (output?.handle === null || output?.handle === undefined) {
      throw new Error('integration output did not expose an opaque handle')
    }

    objects.failStagingDelete = true
    const imported = await studio.createModelArtifactImport({
      studio_session_id: session.id,
      output_handle: output.handle,
      artifact_kind: 'lora_adapter',
      display_name: 'integration-lora',
      base_model: { reference: 'Qwen/Qwen3-0.6B', revision: '0123456789abcdef' },
    })
    expect(imported).toMatchObject({ status: 'completed', archive_digest: archiveDigest })
    expect(
      await prisma.v2ModelArtifactImport.findUnique({ where: { id: imported.id } }),
    ).toMatchObject({ stagingCleanedAt: null })

    objects.failStagingDelete = false
    await expect(studio.getModelArtifactImport(imported.id)).resolves.toMatchObject({
      status: 'completed',
    })
    expect(
      await prisma.v2ModelArtifactImport.findUnique({ where: { id: imported.id } }),
    ).toMatchObject({ stagingCleanedAt: expect.any(Date) })

    const artifactId = imported.artifact_id
    if (artifactId === null) throw new Error('completed import did not publish an Artifact')
    const download = await studio.downloadModelArtifact(artifactId)
    const chunks: Uint8Array[] = []
    for await (const chunk of download.bytes) chunks.push(chunk)
    expect(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))).toEqual(Buffer.from(archive))
    await expect(studio.closeSwiftStudioSession(session.id)).resolves.toMatchObject({
      status: 'closed',
    })
    await expect(studio.listModelArtifacts({ cursor: null, limit: 20 })).resolves.toMatchObject({
      items: [
        {
          id: artifactId,
          archive_digest: archiveDigest,
          dataset_lineage: { status: 'verified', dataset_version: published.dataset_version },
        },
      ],
    })
    await expect(
      studio.listModelArtifacts({
        registration_status: 'unregistered',
        cursor: null,
        limit: 20,
      }),
    ).resolves.toMatchObject({ items: [expect.objectContaining({ id: artifactId })] })
    await expect(studio.getModelArtifact(artifactId)).resolves.toMatchObject({ id: artifactId })

    const checkedUrls: string[] = []
    const deploymentWorkspace = createSwiftStudioWorkspace(
      'model-deployment-lifecycle',
      provider,
      swiftStudioCatalog(),
      {
        async observe(request) {
          checkedUrls.push(`${request.endpointBaseUrl.replace(/\/+$/u, '')}/models`)
          return { status: 'healthy', error: null }
        },
      },
    )
    const deployment = await deploymentWorkspace.createModelDeployment({
      artifact_id: artifactId,
      display_name: 'integration-lora endpoint',
      provider: 'openai_compatible',
      served_model_name: 'integration-lora-v1',
      endpoint_base_url: 'http://model.internal:8000/v1',
      auth_mode: 'none',
    })
    expect(deployment).toMatchObject({
      artifact_id: artifactId,
      health_status: 'unknown',
      status: 'active',
    })
    expect(deployment).not.toHaveProperty('endpoint_base_url')
    expect(deployment).not.toHaveProperty('create_digest')
    await expect(deploymentWorkspace.checkModelDeployment(deployment.id)).resolves.toMatchObject({
      health_status: 'healthy',
    })
    expect(checkedUrls).toEqual(['http://model.internal:8000/v1/models'])

    const registrationRequest = {
      target: {
        kind: 'create_model' as const,
        key: 'integration-artifact-model',
        display_name: 'Integration Artifact Model',
        description: 'MR2 Artifact registration lifecycle',
        task_family: 'chat',
        tags: ['integration', 'lora'],
      },
      version_label: 'lora-r1',
      source: { kind: 'databench_artifact' as const, artifact_id: artifactId },
      alias: { alias: 'candidate' as const, expected_version_id: null },
    }
    const registrationPlan = await deploymentWorkspace.inspectModelRegistration(registrationRequest)
    const registered = await deploymentWorkspace.commitModelRegistration({
      request: registrationRequest,
      expected_registration_digest: registrationPlan.registration_digest,
    })
    expect(registered).toMatchObject({
      replayed: false,
      model_id: registrationPlan.model_id,
      alias: 'candidate',
    })
    await expect(
      deploymentWorkspace.listModels({
        search: 'Integration Artifact',
        source_kind: 'databench_artifact',
        archive: 'active',
        cursor: null,
        limit: 20,
      }),
    ).resolves.toMatchObject({
      items: [
        expect.objectContaining({
          model: expect.objectContaining({ id: registered.model_id }),
          candidate: expect.objectContaining({ version_id: registered.model_version_id }),
        }),
      ],
    })
    await expect(
      deploymentWorkspace.listModelVersions(registered.model_id, { cursor: null, limit: 20 }),
    ).resolves.toMatchObject({
      items: [
        expect.objectContaining({
          id: registered.model_version_id,
          source: expect.objectContaining({
            kind: 'databench_artifact',
            artifact_id: artifactId,
          }),
        }),
      ],
    })
    await expect(deploymentWorkspace.listModelAliases(registered.model_id)).resolves.toMatchObject({
      items: [{ alias: 'candidate', version_id: registered.model_version_id }],
    })
    await expect(
      deploymentWorkspace.listModelArtifacts({
        registration_status: 'registered',
        cursor: null,
        limit: 20,
      }),
    ).resolves.toMatchObject({ items: [expect.objectContaining({ id: artifactId })] })
    await expect(
      deploymentWorkspace.listModelArtifacts({
        registration_status: 'unregistered',
        cursor: null,
        limit: 20,
      }),
    ).resolves.toMatchObject({ items: [] })
    const storedDeployment = await prisma.v2ModelDeployment.findUnique({
      where: { id: deployment.id },
    })
    if (storedDeployment === null) throw new Error('integration Deployment row was not persisted')
    const adoptionRequest = {
      expected_artifact_id: artifactId,
      expected_deployment_digest: storedDeployment.createDigest,
    }
    const adopted = await deploymentWorkspace.adoptModelDeployment(
      registered.model_version_id,
      deployment.id,
      adoptionRequest,
    )
    const replayedAdoption = await deploymentWorkspace.adoptModelDeployment(
      registered.model_version_id,
      deployment.id,
      adoptionRequest,
    )
    expect(adopted).toMatchObject({
      replayed: false,
      model_id: registered.model_id,
      model_version_id: registered.model_version_id,
      deployment_id: deployment.id,
      artifact_id: artifactId,
    })
    expect(replayedAdoption).toEqual({ ...adopted, replayed: true })

    const evaluationPlan = await deploymentWorkspace.inspectExport(published.dataset_version, {
      converter: 'evalscope-general-qa',
      options: { target_source: 'none' },
    })
    const run = await deploymentWorkspace.createEvaluationRun({
      provider: 'evalscope',
      provider_task_id: `task-model-deployment-${randomUUID()}`,
      dataset_version: published.dataset_version,
      source_ref: null,
      converter: 'evalscope-general-qa',
      converter_options: { target_source: 'none' },
      accepted_fidelity_digest: evaluationPlan.fidelity_digest,
      model_name: null,
      model_deployment_id: deployment.id,
      evalscope_commit: 'b2a62f05fd81e89ec2cf4f83b9a79ce0a5535d60',
    })
    expect(run).toMatchObject({
      create_profile: 'evaluation-run-create-v2',
      dataset_version: published.dataset_version,
      model_artifact_id: artifactId,
      model_deployment_id: deployment.id,
      model_name: 'integration-lora-v1',
    })
    const metricScoring = {
      schema_version: 1 as const,
      mode: 'explicit' as const,
      evalscope_commit: 'b2a62f05fd81e89ec2cf4f83b9a79ce0a5535d60',
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
    const manualMetricRun = await deploymentWorkspace.createEvaluationRun({
      provider: 'evalscope',
      provider_task_id: `task-manual-metric-${randomUUID()}`,
      dataset_version: published.dataset_version,
      source_ref: null,
      converter: 'evalscope-general-qa',
      converter_options: { target_source: 'none' },
      accepted_fidelity_digest: evaluationPlan.fidelity_digest,
      model_name: 'integration-manual-model',
      model_deployment_id: null,
      evalscope_commit: metricScoring.evalscope_commit,
      scoring_config: metricScoring,
    })
    expect(manualMetricRun).toMatchObject({
      create_profile: 'evaluation-run-create-v3',
      scoring_config: metricScoring,
      primary_metric_id: 'exact_match',
      primary_output_key: 'exact_match',
    })
    await deploymentWorkspace.startEvaluationRun(manualMetricRun.id, {})
    await expect(
      deploymentWorkspace.completeEvaluationRun(manualMetricRun.id, {
        metrics: [
          {
            dataset: 'general_qa',
            subset: 'databench',
            metric_id: 'exact_match',
            output_key: 'exact_match',
            metric: 'exact_match',
            score: 1,
            sample_count: 1,
            categories: [],
          },
        ],
        provider_report_ids: ['manual-metric-integration-report'],
        scoring_config: metricScoring,
        primary_metric_id: 'exact_match',
        primary_output_key: 'exact_match',
      }),
    ).resolves.toMatchObject({
      create_profile: 'evaluation-run-create-v3',
      status: 'completed',
      metrics: [expect.objectContaining({ metric_id: 'exact_match' })],
    })
    const metricRun = await deploymentWorkspace.createEvaluationRun({
      provider: 'evalscope',
      provider_task_id: `task-model-deployment-metric-${randomUUID()}`,
      dataset_version: published.dataset_version,
      source_ref: null,
      converter: 'evalscope-general-qa',
      converter_options: { target_source: 'none' },
      accepted_fidelity_digest: evaluationPlan.fidelity_digest,
      model_name: null,
      model_deployment_id: deployment.id,
      evalscope_commit: metricScoring.evalscope_commit,
      scoring_config: metricScoring,
    })
    expect(metricRun).toMatchObject({
      create_profile: 'evaluation-run-create-v4',
      scoring_config: metricScoring,
      primary_metric_id: 'exact_match',
      primary_output_key: 'exact_match',
    })
    await deploymentWorkspace.startEvaluationRun(metricRun.id, {})
    await expect(
      deploymentWorkspace.completeEvaluationRun(metricRun.id, {
        metrics: [
          {
            dataset: 'general_qa',
            subset: 'databench',
            metric_id: 'exact_match',
            output_key: 'exact_match',
            metric: 'exact_match',
            score: 1,
            sample_count: 1,
            categories: [],
          },
        ],
        provider_report_ids: ['metric-integration-report'],
        scoring_config: metricScoring,
        primary_metric_id: 'exact_match',
        primary_output_key: 'exact_match',
      }),
    ).resolves.toMatchObject({
      status: 'completed',
      metrics: [expect.objectContaining({ metric_id: 'exact_match' })],
    })
    await expect(
      deploymentWorkspace.listEvaluationRuns({
        model_deployment_id: deployment.id,
        cursor: null,
        limit: 20,
      }),
    ).resolves.toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ id: run.id }),
        expect.objectContaining({ id: metricRun.id }),
      ]),
    })
  })

  test('production open composes Catalog, S3, and file-backed Store end to end', async () => {
    const runtime = await V2Workspace.open({
      root: join(temporaryRoot, 'production-factory'),
      cursorSecret: 'v12-production-runtime-cursor-secret',
      ...(process.env.DATABASE_URL === undefined ? {} : { databaseUrl: process.env.DATABASE_URL }),
      storeConfig: { ...s3Config(), kind: 's3' },
    })
    try {
      const ingested = await runtime.addJsonl(
        jsonl(canonicalRecord(`rec_${'7'.repeat(64)}`, 'Exercise the V12 production factory.')),
        Promise.resolve(noRefOptions()),
      )
      await expect(runtime.describeDataset(ingested.dataset_version)).resolves.toMatchObject({
        dataset_version: ingested.dataset_version,
        manifest: ingested.manifest,
      })
      expect(runtime.postTrainingV2Capability().enabled).toBe(true)
    } finally {
      await Promise.all([runtime.close(), runtime.close()])
    }
  })

  test('commits and exactly replays a declared Repository Model registration in PostgreSQL', async () => {
    const registryWorkspace = createWorkspace('model-registry')
    const request = {
      target: {
        kind: 'create_model' as const,
        key: 'integration-repository-model',
        display_name: 'Integration Repository Model',
        description: 'MR1 PostgreSQL registration path',
        task_family: 'chat',
        tags: ['integration'],
      },
      version_label: 'r1',
      source: {
        kind: 'repository_reference' as const,
        provider: 'hugging_face' as const,
        repository_id: 'Qwen/Qwen2.5-7B',
        revision: 'abc123',
        revision_kind: 'commit' as const,
        base_model: null,
      },
    }
    const plan = await registryWorkspace.inspectModelRegistration(request)
    const created = await registryWorkspace.commitModelRegistration({
      request,
      expected_registration_digest: plan.registration_digest,
    })
    const replayed = await registryWorkspace.commitModelRegistration({
      request,
      expected_registration_digest: plan.registration_digest,
    })
    expect(created).toMatchObject({ replayed: false, model_id: plan.model_id })
    expect(replayed).toEqual({ ...created, replayed: true })
    expect(await prisma.v2Model.count({ where: { key: 'integration-repository-model' } })).toBe(1)
    expect(await prisma.v2ModelVersion.count({ where: { id: created.model_version_id } })).toBe(1)
    expect(
      await prisma.v2ModelRegistrationClaim.count({
        where: { registrationDigest: plan.registration_digest },
      }),
    ).toBe(1)
  })

  test('persists connected Repository evidence, replays without provider I/O, and projects drift', async () => {
    let resolveCount = 0
    let drifted = false
    const repositoryRuntime: V2ModelRepositoryRuntime = {
      mode: 'connected',
      async resolve() {
        resolveCount += 1
        return {
          evidence_kind: 'provider_resolution',
          adapter: 'modelscope',
          adapter_version: '1',
          observed_revision: drifted ? 'different-revision' : 'abc123',
          observed_at: new Date(1_775_301_600_000 + resolveCount * 1_000).toISOString(),
          result: drifted ? 'revision_mismatch' : 'verified',
          response_digest: (drifted ? 'd' : 'c').repeat(64),
          license: 'apache-2.0',
          cache_status: 'not_cached',
        }
      },
    }
    const registryWorkspace = createWorkspace('model-registry-evidence', repositoryRuntime)
    const request = {
      target: {
        kind: 'create_model' as const,
        key: 'integration-modelscope-model',
        display_name: 'Integration ModelScope Model',
        description: 'MR3 connected evidence path',
        task_family: 'chat',
        tags: ['integration'],
      },
      version_label: 'r1',
      source: {
        kind: 'repository_reference' as const,
        provider: 'modelscope' as const,
        repository_id: 'Qwen/Qwen3-0.6B',
        revision: 'abc123',
        revision_kind: 'commit' as const,
        base_model: null,
      },
    }
    const plan = await registryWorkspace.inspectModelRegistration(request)
    expect(plan.classification).toMatchObject({
      source_mutability: 'immutable',
      verification_level: 'provider_verified',
      evidence_digest: expect.stringMatching(/^[0-9a-f]{64}$/),
    })
    const created = await registryWorkspace.commitModelRegistration({
      request,
      expected_registration_digest: plan.registration_digest,
    })
    const replayed = await registryWorkspace.commitModelRegistration({
      request,
      expected_registration_digest: plan.registration_digest,
    })
    expect(resolveCount).toBe(2)
    expect(replayed).toEqual({ ...created, replayed: true })
    const beforeDrift = await registryWorkspace.getModelVersion(created.model_version_id)
    expect(beforeDrift).toMatchObject({
      source_fingerprint: created.source_fingerprint,
      classification: {
        source_mutability: 'immutable',
        verification_level: 'provider_verified',
      },
      repository_observation: {
        availability: 'available',
        license: 'apache-2.0',
        cache_status: 'not_cached',
        evidence_count: 1,
        materialization: { state: 'not_materialized', handoff: 'future_import_job' },
      },
    })
    expect(
      await prisma.v2ModelSourceEvidence.count({
        where: { modelVersionId: created.model_version_id },
      }),
    ).toBe(1)

    await Promise.all([
      registryWorkspace.refreshModelSourceEvidence(created.model_version_id),
      registryWorkspace.refreshModelSourceEvidence(created.model_version_id),
    ])
    expect(
      await prisma.v2ModelSourceEvidence.count({
        where: { modelVersionId: created.model_version_id },
      }),
    ).toBe(1)

    drifted = true
    const afterDrift = await registryWorkspace.refreshModelSourceEvidence(created.model_version_id)
    expect(afterDrift).toMatchObject({
      source_fingerprint: created.source_fingerprint,
      classification: {
        source_mutability: 'unknown',
        verification_level: 'operator_attested',
      },
      repository_observation: {
        availability: 'invalid',
        evidence_count: 2,
        latest_evidence: { result: 'revision_mismatch' },
      },
    })
  })

  function createWorkspace(
    tempName: string,
    modelRepository?: V2ModelRepositoryRuntime,
  ): V2Workspace {
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
      ...(modelRepository === undefined ? {} : { modelRepository }),
    })
  }

  function createSwiftStudioWorkspace(
    tempName: string,
    provider: SwiftStudioProviderV2,
    swiftCatalog: V2WorkspaceSwiftStudioCatalog = swiftStudioCatalog(),
    modelDeploymentHealthClient?: V2ModelDeploymentHealthClient,
  ): V2Workspace {
    return new V2Workspace({
      catalog,
      store: new FileBackedV2Store({
        objectStore: objects,
        tempRoot: join(temporaryRoot, tempName),
        safetyMarginBytes: 0,
        prepareConcurrency: 1,
        readConcurrency: 1,
      }),
      cursorSecret: 'swift-studio-integration-cursor-secret',
      ...(modelDeploymentHealthClient === undefined ? {} : { modelDeploymentHealthClient }),
      swiftStudio: {
        catalog: swiftCatalog,
        provider,
        datasetExportBaseUrl: 'http://api:8000',
        upstreamCommit: 'f48847d23dbcd72ceb15fdbc5a1482cc7eb0359d',
        imageDigest: '57f2448c3e06985d1989465703f8e4883aee71da40b79be3bdfb70e6dda1f74d',
        runtimeCapabilityDigest: '441a53584131400a9ba462bd262e931ca584f411d721b009ee122f165da3828f',
        modelArtifactStore: new ModelArtifactStoreV1({
          objectStore: objects,
          tempStore: new V2TempStore({
            tempRoot: join(temporaryRoot, `${tempName}-model-artifacts`),
          }),
          signedUrlTtlMs: 60_000,
        }),
        preparationAbandonGraceMs: 0,
      },
    })
  }

  function swiftStudioCatalog(
    overrides: Partial<V2WorkspaceSwiftStudioCatalog> = {},
  ): V2WorkspaceSwiftStudioCatalog {
    return {
      createOrReadSwiftStudioSession: (input) => catalog.createOrReadSwiftStudioSession(input),
      abandonSwiftStudioSessionPreparation: (namespaceId, id, preparationOwnerToken) =>
        catalog.abandonSwiftStudioSessionPreparation(namespaceId, id, preparationOwnerToken),
      renewSwiftStudioSessionPreparation: (namespaceId, id, preparationOwnerToken) =>
        catalog.renewSwiftStudioSessionPreparation(namespaceId, id, preparationOwnerToken),
      claimSwiftStudioSessionPreparation: (
        namespaceId,
        id,
        observedPreparationOwnerToken,
        preparationAbandonGraceMs,
      ) =>
        catalog.claimSwiftStudioSessionPreparation(
          namespaceId,
          id,
          observedPreparationOwnerToken,
          preparationAbandonGraceMs,
        ),
      getSwiftStudioSession: (namespaceId, id) => catalog.getSwiftStudioSession(namespaceId, id),
      listSwiftStudioSessions: (namespaceId, filter, before, limit) =>
        catalog.listSwiftStudioSessions(namespaceId, filter, before, limit),
      transitionSwiftStudioSession: (input) => catalog.transitionSwiftStudioSession(input),
      reopenBusySwiftStudioSession: (namespaceId, id) =>
        catalog.reopenBusySwiftStudioSession(namespaceId, id),
      createOrReadModelArtifactImport: (input) => catalog.createOrReadModelArtifactImport(input),
      getModelArtifactImport: (namespaceId, id) => catalog.getModelArtifactImport(namespaceId, id),
      markModelArtifactImportStagingCleaned: (namespaceId, id) =>
        catalog.markModelArtifactImportStagingCleaned(namespaceId, id),
      transitionModelArtifactImport: (input) => catalog.transitionModelArtifactImport(input),
      finalizeModelArtifactImport: (input) => catalog.finalizeModelArtifactImport(input),
      getModelArtifact: (namespaceId, id) => catalog.getModelArtifact(namespaceId, id),
      listModelArtifacts: (namespaceId, filter, before, limit) =>
        catalog.listModelArtifacts(namespaceId, filter, before, limit),
      ...overrides,
    }
  }

  async function swiftStudioRequest(studio: V2Workspace, datasetVersion: string) {
    const inspected = await studio.inspectExport(datasetVersion, {
      converter: 'ms-swift',
      options: {},
    })
    return {
      dataset_version: datasetVersion,
      display_ref: null,
      converter: 'ms-swift' as const,
      options: {},
      accepted_fidelity_digest: inspected.fidelity_digest,
    }
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

class CountingObjectStore implements ConditionalObjectStoreV2, WorkerStagingObjectStoreV1 {
  artifactDownloads = 0
  failStagingDelete = false

  constructor(private readonly delegate: ConditionalObjectStoreV2 & WorkerStagingObjectStoreV1) {}

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

  async headStaging(
    key: string,
    context: V2OperationContext = {},
  ): Promise<Readonly<WorkerStagingHeadV1> | null> {
    return await this.delegate.headStaging(key, context)
  }

  async presignStaging(input: WorkerStagingPresignInputV1): Promise<string> {
    return await this.delegate.presignStaging(input)
  }

  async deleteStaging(key: string, context: V2OperationContext = {}): Promise<void> {
    if (this.failStagingDelete) throw new Error('simulated staging delete failure')
    await this.delegate.deleteStaging(key, context)
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
      inputRoles: ['base'],
      paramsSchema: SubsetV2ParamsSchema,
      paramsExample: { record_ids: [] },
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

function readyProviderSession(
  input: Parameters<SwiftStudioProviderV2['createSession']>[0],
): Awaited<ReturnType<SwiftStudioProviderV2['createSession']>> {
  return {
    providerSessionId: `sws_${Buffer.from(input.requestId, 'hex').toString('base64url')}`,
    status: 'ready',
    datasetVersion: input.datasetVersion,
    converter: 'ms-swift',
    converterVersion: '1.0.0',
    exportDigest: input.expected.digest,
    exportSizeBytes: input.expected.sizeBytes,
    outputCount: input.expected.lineCount,
    providerGeneration: 'integration-test',
    replayed: false,
  }
}

function closedProviderSession(
  providerSessionId: string,
): Awaited<ReturnType<SwiftStudioProviderV2['closeSession']>> {
  return {
    providerSessionId,
    status: 'closed',
    providerGeneration: 'integration-test',
    replayed: false,
  }
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
    contents: [
      {
        role: 'system',
        parts: [
          {
            type: 'text',
            text: 'Answer precisely.',
            thought: false,
            thought_signature: null,
            part_metadata: {},
          },
        ],
        loss_weight: 0,
      },
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

function trainerRecord(id: string, candidateId: string, text: string) {
  return {
    ...canonicalRecord(id, text),
    candidates: [
      {
        id: candidateId,
        contents: [
          {
            role: 'ai',
            parts: [
              {
                type: 'text',
                text: 'Persisted export completed.',
                thought: false,
                thought_signature: null,
                part_metadata: {},
              },
            ],
            loss_weight: null,
          },
        ],
        finish_reason: null,
        rank: null,
        selected: true,
        signals: [],
        generator: null,
        token_count: null,
        avg_logprobs: null,
      },
    ],
  }
}

async function collectUtf8(source: AsyncIterable<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder()
  let output = ''
  for await (const chunk of source) output += decoder.decode(chunk, { stream: true })
  return output + decoder.decode()
}
