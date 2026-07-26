import { type ChildProcessWithoutNullStreams, execFile, spawn } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3'
import { V2Catalog } from '@databench/catalog'
import type { RecordRevisionV2 } from '@databench/schema'
import {
  FileBackedV2Store,
  S3ConditionalObjectStoreV2,
  WORKER_STAGING_JSONL_MEDIA_TYPE,
  WorkerStagingStoreV1,
} from '@databench/store'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import {
  WorkerCanonicalJobFinalizerV1,
  WorkerWorkspaceInputProjectorV1,
} from '../src/internal/worker/canonical-finalizer.js'
import type {
  WorkerJobEvent,
  WorkerProtocolError,
  WorkerRunJobRequest,
  WorkerTransportError,
} from '../src/internal/worker/client.js'
import {
  compileBasicCleanWorkerParametersV1,
  DATA_JUICER_BATCH_CAPABILITY_V1,
  DATA_JUICER_BATCH_PARAMETER_SCHEMA_V1,
} from '../src/internal/worker/data-juicer.js'
import { GrpcWorkerClient } from '../src/internal/worker/grpc-client.js'
import { openWorkerRuntime } from '../src/internal/worker/runtime.js'
import { WorkerStagingJobPreparerV1 } from '../src/internal/worker/staging.js'
import { readWorkerRetainedJsonlV1 } from '../src/v2/batch-transform.js'
import { V2Workspace } from '../src/v2/workspace.js'

const RUN_INTEGRATION = process.env.RUN_WORKER_INTEGRATION_TESTS === '1'
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const WORKER_ROOT = resolve(REPO_ROOT, 'workers/python')
const INPUT = Buffer.from('fixture-copy-cross-language')
let dataJuicerInput = Buffer.alloc(0)
let dataJuicerUploaded = Buffer.alloc(0)
let artifactBaseUrl = ''
const execFileAsync = promisify(execFile)

describe.skipIf(!RUN_INTEGRATION)('Python Worker gRPC transport', () => {
  let workerProcess: ChildProcessWithoutNullStreams
  let client: GrpcWorkerClient
  let artifactServer: Server
  let uploaded: Buffer
  let workerAddress: string
  let workerUv: string

  beforeAll(async () => {
    artifactServer = createServer((request, response) => {
      if (request.method === 'GET' && request.url === '/input') {
        response.writeHead(200, {
          'content-length': INPUT.byteLength,
          'content-type': 'application/octet-stream',
        })
        response.end(INPUT)
        return
      }
      if (request.method === 'PUT' && request.url === '/output') {
        const chunks: Buffer[] = []
        request.on('data', (chunk: Buffer) => chunks.push(chunk))
        request.on('end', () => {
          uploaded = Buffer.concat(chunks)
          response.writeHead(204)
          response.end()
        })
        return
      }
      if (request.method === 'GET' && request.url === '/data-juicer-input') {
        response.writeHead(200, {
          'content-length': dataJuicerInput.byteLength,
          'content-type': WORKER_STAGING_JSONL_MEDIA_TYPE,
        })
        response.end(dataJuicerInput)
        return
      }
      if (request.method === 'PUT' && request.url === '/data-juicer-output') {
        const chunks: Buffer[] = []
        request.on('data', (chunk: Buffer) => chunks.push(chunk))
        request.on('end', () => {
          dataJuicerUploaded = Buffer.concat(chunks)
          response.writeHead(204)
          response.end()
        })
        return
      }
      response.writeHead(404)
      response.end()
    })
    artifactServer.listen(0, '127.0.0.1')
    await once(artifactServer, 'listening')
    const address = artifactServer.address()
    if (!address || typeof address === 'string') throw new Error('artifact server did not bind')
    artifactBaseUrl = `http://127.0.0.1:${address.port}`

    workerUv = process.env.DATABENCH_UV ?? resolve(process.env.HOME ?? '', '.local/bin/uv')
    workerProcess = spawn(
      workerUv,
      [
        'run',
        '--frozen',
        '--directory',
        WORKER_ROOT,
        'databench-worker',
        '--listen',
        '127.0.0.1:0',
      ],
      {
        env: { ...process.env, DATABENCH_WORKER_ENABLE_TEST_CAPABILITIES: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    const addressLine = await readFirstLine(workerProcess)
    const parsed = JSON.parse(addressLine) as { address?: unknown }
    if (typeof parsed.address !== 'string') throw new Error('Worker did not report its address')
    workerAddress = parsed.address
    client = new GrpcWorkerClient({ address: workerAddress, terminalEofTimeoutMs: 1_000 })
  }, 20_000)

  afterAll(async () => {
    client?.close()
    artifactServer?.close()
    if (artifactServer) await once(artifactServer, 'close')
    if (workerProcess && workerProcess.exitCode === null) {
      workerProcess.kill('SIGTERM')
      await once(workerProcess, 'exit')
    }
  })

  test('describes the explicitly enabled test capability', async () => {
    const response = await client.describeCapabilities()
    expect(response.workerVersion).toBe('0.1.0')
    expect(response.capabilities).toEqual([
      {
        name: DATA_JUICER_BATCH_CAPABILITY_V1,
        version: '1',
        mode: 'batch',
        parameterSchemaName: DATA_JUICER_BATCH_PARAMETER_SCHEMA_V1,
        parameterSchemaVersion: '1',
        inputs: [{ name: 'input', mediaType: WORKER_STAGING_JSONL_MEDIA_TYPE }],
        outputs: [{ name: 'output', mediaType: WORKER_STAGING_JSONL_MEDIA_TYPE }],
      },
      {
        name: 'fixture.copy',
        version: '1',
        mode: 'batch',
        parameterSchemaName: 'databench.worker.fixture-copy-parameters',
        parameterSchemaVersion: '1',
        inputs: [{ name: 'input', mediaType: 'application/octet-stream' }],
        outputs: [{ name: 'output', mediaType: 'application/octet-stream' }],
      },
    ])
  })

  test('serves the standard gRPC health contract', async () => {
    const source = [
      'import grpc, sys',
      'from grpc_health.v1 import health_pb2, health_pb2_grpc',
      'channel = grpc.insecure_channel(sys.argv[1])',
      'response = health_pb2_grpc.HealthStub(channel).Check(',
      '    health_pb2.HealthCheckRequest(service="databench.worker.v1.WorkerService"), timeout=2)',
      'assert response.status == health_pb2.HealthCheckResponse.SERVING',
      'channel.close()',
    ].join('\n')
    await expect(
      execFileAsync(
        workerUv,
        ['run', '--frozen', '--directory', WORKER_ROOT, 'python', '-c', source, workerAddress],
        { timeout: 5_000 },
      ),
    ).resolves.toBeDefined()
  })

  test('copies a fixture and ends only after completed plus OK EOF', async () => {
    uploaded = Buffer.alloc(0)
    const events = []
    for await (const event of client.runJob(requestFor('normal', 'complete'))) {
      events.push(event)
    }

    expect(events.map((event) => event.type)).toEqual([
      'accepted',
      'started',
      'progress',
      'completed',
    ])
    expect(uploaded).toEqual(INPUT)
    expect(events.at(-1)).toMatchObject({
      type: 'completed',
      outputs: [
        {
          name: 'output',
          size: INPUT.byteLength,
          digest: createHash('sha256').update(INPUT).digest('hex'),
        },
      ],
    })
  })

  test('withholds completed until the Worker closes the stream with OK EOF', async () => {
    uploaded = Buffer.alloc(0)
    const request = requestFor('terminal-eof-barrier', 'terminal_then_wait_for_cancel')
    const events: WorkerJobEvent[] = []
    const consume = (async () => {
      for await (const event of client.runJob(request)) events.push(event)
    })()

    await waitUntil(() => uploaded.equals(INPUT), 5_000)
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 50))
    expect(events.some((event) => event.type === 'completed')).toBe(false)

    await expect(
      client.cancelJob({
        executionId: request.executionId,
        attempt: request.attempt,
        leaseToken: request.leaseToken,
      }),
    ).resolves.toBe('stopped')
    await consume

    expect(events.at(-1)?.type).toBe('completed')
  })

  test('never exposes a terminal event when the Worker emits another event before EOF', async () => {
    const events: WorkerJobEvent[] = []
    const consume = async () => {
      for await (const event of client.runJob(
        requestFor('terminal-followed-by-event', 'terminal_then_raise'),
      )) {
        events.push(event)
      }
    }

    await expect(consume()).rejects.toEqual(
      expect.objectContaining<Partial<WorkerProtocolError>>({
        name: 'WorkerProtocolError',
        message: 'Worker emitted an event after its terminal event',
      }),
    )
    expect(events.some((event) => event.type === 'completed')).toBe(false)
  })

  test('runs basic-clean@1 through real MinIO signed URLs and exact cleanup', async () => {
    const bucket = `databench-worker-${randomUUID()}`
    const root = await mkdtemp(join(tmpdir(), 'databench-worker-minio-'))
    const config = minioConfig(bucket)
    const admin = new S3Client({
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
      endpoint: config.endpoint,
      forcePathStyle: true,
      maxAttempts: 1,
      region: config.region,
    })
    await admin.send(new CreateBucketCommand({ Bucket: bucket }))
    const objectStore = new S3ConditionalObjectStoreV2(config)
    const catalog = new V2Catalog()
    const workspace = new V2Workspace({
      catalog,
      store: new FileBackedV2Store({
        objectStore,
        tempRoot: join(root, 'canonical'),
        safetyMarginBytes: 0,
      }),
      cursorSecret: 'worker-finalizer-integration-cursor-secret',
    })
    const staging = new WorkerStagingStoreV1({
      objectStore,
      tempRoot: join(root, 'staging'),
      maxBytes: 1024 * 1024,
      signedUrlTtlMs: 60_000,
    })
    const jobId = `job_${'a'.repeat(64)}`
    const ref = { jobId, attempt: 1 }

    try {
      const records = [
        workerRecord(
          '1',
          '   Shared\ttext with enough deterministic characters for the fixed filter.   ',
        ),
        workerRecord('2', 'Shared text with enough deterministic characters for the fixed filter.'),
        workerRecord('3', 'too short'),
        workerRecord(
          '4',
          'A different record with enough deterministic characters for the fixed filter.',
        ),
      ]
      const published = await workspace.addRecords(records, {
        ref: null,
        expected_ref_version: null,
        message: null,
      })
      const dataset = await workspace.get(published.dataset_version)
      await catalog.createOrReadTransformJob({
        id: jobId,
        cacheKey: jobId.slice(4),
        op: 'basic-clean',
        opVersion: '1',
        params: {},
        inputVersion: dataset.version,
        capabilityName: DATA_JUICER_BATCH_CAPABILITY_V1,
        capabilityVersion: '1',
        inputCount: BigInt(dataset.length),
      })
      const job = await catalog.claimNextTransformJob({
        leaseOwner: 'worker.integration',
        leaseDurationMs: 30_000,
      })
      if (!job?.leaseToken) throw new Error('Worker finalizer job was not claimed')
      const preparer = new WorkerStagingJobPreparerV1({
        catalog,
        staging,
        projector: new WorkerWorkspaceInputProjectorV1(workspace),
        parameters: compileBasicCleanWorkerParametersV1,
        maxOutputBytes: 1024 * 1024,
      })
      const prepared = await preparer.prepare({
        job,
        executionId: 'execution-minio-roundtrip',
        signal: new AbortController().signal,
        deadlineUnixMs: Date.now() + 10_000,
      })
      const source = prepared.inputs[0]
      const target = prepared.outputs[0]
      if (!source || !target) throw new Error('staging preparation is incomplete')

      const wrongMethod = await fetch(source.readUrl, { method: 'PUT', body: 'not-allowed' })
      expect(wrongMethod.ok).toBe(false)
      const wrongContentType = await fetch(target.writeUrl, {
        method: 'PUT',
        headers: { 'content-type': 'text/plain' },
        body: 'not-allowed',
      })
      expect(wrongContentType.ok).toBe(false)

      const events = []
      for await (const event of client.runJob({
        executionId: 'execution-minio-roundtrip',
        jobId,
        attempt: job.attempt,
        leaseToken: job.leaseToken,
        capabilityName: DATA_JUICER_BATCH_CAPABILITY_V1,
        capabilityVersion: '1',
        ...prepared,
        deadlineUnixMs: Date.now() + 10_000,
      })) {
        events.push(event)
      }
      const completed = events.at(-1)
      if (completed?.type === 'failed') {
        throw new Error(`Data-Juicer failed: ${completed.code}: ${completed.message}`)
      }
      expect(completed?.type).toBe('completed')
      if (completed?.type !== 'completed') throw new Error('Data-Juicer did not complete')
      const output = completed.outputs[0]
      if (!output) throw new Error('fixture output descriptor is missing')

      const outputBytes = await collect(
        staging.readExact(
          { ...ref, logicalName: 'output' },
          { expectedSize: output.size, expectedDigest: output.digest },
        ),
      )
      const inputBytes = await collect(
        staging.readExact(
          { ...ref, logicalName: 'input' },
          { expectedSize: source.size, expectedDigest: source.digest },
        ),
      )
      const inputRevisions = [...dataset.records()]
      const retained = await readWorkerRetainedJsonlV1(chunks(outputBytes), inputRevisions, {
        terminal: {
          size: output.size,
          digest: output.digest,
          recordCount: output.recordCount,
        },
      })
      expect(retained.map((revision) => revision.record.id)).toEqual(
        expectedBasicClean(inputRevisions).map((revision) => revision.record.id),
      )
      expect(outputBytes).not.toEqual(inputBytes)

      const expiring = new WorkerStagingStoreV1({
        objectStore,
        tempRoot: join(root, 'expiring'),
        maxBytes: 1024 * 1024,
        signedUrlTtlMs: 1,
      })
      const expiringSource = await expiring.signRead(ref, {
        key: `staging/worker/v1/${ref.jobId}/${ref.attempt}/input.jsonl`,
        mediaType: WORKER_STAGING_JSONL_MEDIA_TYPE,
        size: source.size,
        digest: source.digest,
      })
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 1_200))
      expect((await fetch(expiringSource.readUrl)).ok).toBe(false)

      const lease = { id: job.id, attempt: job.attempt, leaseToken: job.leaseToken }
      await expect(catalog.markTransformJobRunning(lease)).resolves.toMatchObject({
        status: 'running',
      })
      await expect(catalog.markTransformJobFinalizing(lease)).resolves.toMatchObject({
        status: 'finalizing',
      })
      await new WorkerCanonicalJobFinalizerV1(workspace, staging).finalize({
        job,
        lease,
        outputs: completed.outputs,
        signal: new AbortController().signal,
      })

      const canonicalJob = await catalog.getTransformJob(job.id)
      expect(canonicalJob).toMatchObject({
        status: 'completed',
        outputCount: BigInt(retained.length),
        inputKey: null,
        outputKey: null,
        leaseToken: null,
      })
      if (!canonicalJob?.outputVersion) throw new Error('canonical Worker output is missing')
      const canonicalOutput = await workspace.get(canonicalJob.outputVersion)
      expect([...canonicalOutput.records()].map((revision) => revision.record.id)).toEqual(
        retained.map((revision) => revision.record.id),
      )
      for (const revision of retained) {
        expect(canonicalOutput.get(revision.record.id)).toMatchObject({
          record_digest: revision.record_digest,
          record_json: revision.record_json,
        })
      }
      await expect(catalog.findRun(job.cacheKey)).resolves.toMatchObject({
        id: `run_${job.cacheKey}`,
        inputVersions: [dataset.version],
        outputVersion: canonicalJob.outputVersion,
      })
      const lineage = await workspace.lineage(canonicalJob.outputVersion, {
        max_depth: 2,
        max_nodes: 10,
        cursor: null,
      })
      expect(lineage.edges).toContainEqual({
        run_id: `run_${job.cacheKey}`,
        input_dataset_versions: [dataset.version],
        output_dataset_version: canonicalJob.outputVersion,
      })
      await expect(staging.statExact({ ...ref, logicalName: 'input' })).resolves.toBeNull()
      await expect(staging.statExact({ ...ref, logicalName: 'output' })).resolves.toBeNull()

      const runtime = await openWorkerRuntime({
        workspace,
        target: workerAddress,
        client,
        storeConfig: { kind: 's3', ...config },
        workspaceRoot: root,
        signedUrlTtlMs: 60_000,
        jobDeadlineMs: 30_000,
        leaseMs: 30_000,
        heartbeatMs: 10_000,
        pollMs: 10,
      })
      try {
        await runtime.start()
        expect(runtime.supportsCapability(DATA_JUICER_BATCH_CAPABILITY_V1, '1')).toBe(true)
        const submitted = await workspace.createBasicCleanJob({ inputs: [dataset.version] })
        const productJob = await waitForTransformJob(workspace, submitted.id, 30_000)
        expect(productJob).toMatchObject({
          status: 'completed',
          input_count: 4,
          output_count: 2,
          output_dataset_version: expect.any(String),
        })
      } finally {
        await runtime.stop()
      }
    } finally {
      await workspace.close()
      await catalog.close()
      await Promise.allSettled([
        staging.deleteExact({ ...ref, logicalName: 'input' }),
        staging.deleteExact({ ...ref, logicalName: 'output' }),
      ])
      await deleteAllObjects(admin, bucket)
      await admin.send(new DeleteBucketCommand({ Bucket: bucket }))
      admin.destroy()
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)

  test('cancels a 10k Data-Juicer gRPC execution and does not upload output', async () => {
    dataJuicerInput = dataJuicerRows(10_000)
    dataJuicerUploaded = Buffer.alloc(0)
    const request: WorkerRunJobRequest = {
      executionId: 'execution-data-juicer-cancel',
      jobId: 'job-data-juicer-cancel',
      attempt: 1,
      leaseToken: randomBytes(32),
      capabilityName: DATA_JUICER_BATCH_CAPABILITY_V1,
      capabilityVersion: '1',
      parameters: compileBasicCleanWorkerParametersV1({
        op: 'basic-clean',
        opVersion: '1',
        params: {},
        capabilityName: DATA_JUICER_BATCH_CAPABILITY_V1,
        capabilityVersion: '1',
      }),
      inputs: [
        {
          name: 'input',
          readUrl: `${artifactBaseUrl}/data-juicer-input`,
          mediaType: WORKER_STAGING_JSONL_MEDIA_TYPE,
          size: dataJuicerInput.byteLength,
          digest: createHash('sha256').update(dataJuicerInput).digest('hex'),
        },
      ],
      outputs: [
        {
          name: 'output',
          writeUrl: `${artifactBaseUrl}/data-juicer-output`,
          mediaType: WORKER_STAGING_JSONL_MEDIA_TYPE,
          maxSize: 1024 * 1024,
        },
      ],
      deadlineUnixMs: Date.now() + 30_000,
    }
    let markInputReady: (() => void) | undefined
    const inputReady = new Promise<void>((resolveReady) => {
      markInputReady = resolveReady
    })
    const eventsPromise = (async () => {
      const events = []
      for await (const event of client.runJob(request)) {
        events.push(event)
        if (event.type === 'progress' && event.phase === 'input_ready') markInputReady?.()
      }
      return events
    })()

    await inputReady
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 100))
    await expect(
      client.cancelJob({
        executionId: request.executionId,
        attempt: request.attempt,
        leaseToken: request.leaseToken,
      }),
    ).resolves.toBe('stopped')
    const events = await eventsPromise
    expect(events.at(-1)?.type).toBe('cancelled')
    expect(dataJuicerUploaded).toHaveLength(0)
  }, 20_000)

  test('cancels only the matching execution token', async () => {
    const request = requestFor('cancel', 'wait_for_cancel')
    let markStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const eventsPromise = (async () => {
      const events = []
      for await (const event of client.runJob(request)) {
        events.push(event)
        if (event.type === 'started') markStarted?.()
      }
      return events
    })()

    await started
    await expect(
      client.cancelJob({
        executionId: request.executionId,
        attempt: request.attempt,
        leaseToken: randomBytes(32),
      }),
    ).resolves.toBe('token_mismatch')
    await expect(
      client.cancelJob({
        executionId: request.executionId,
        attempt: request.attempt,
        leaseToken: request.leaseToken,
      }),
    ).resolves.toBe('stopped')
    const events = await eventsPromise
    expect(events.map((event) => event.type)).toEqual([
      'accepted',
      'started',
      'progress',
      'cancelled',
    ])
  })

  test('releases the execution when the streaming client disconnects', async () => {
    const request = requestFor('client-disconnect', 'wait_for_cancel')
    const controller = new AbortController()
    let markStarted: (() => void) | undefined
    const started = new Promise<void>((resolveStarted) => {
      markStarted = resolveStarted
    })
    const consume = (async () => {
      for await (const event of client.runJob(request, { signal: controller.signal })) {
        if (event.type === 'started') markStarted?.()
      }
    })()

    await started
    controller.abort()
    await expect(consume).rejects.toEqual(
      expect.objectContaining<Partial<WorkerTransportError>>({ name: 'WorkerTransportError' }),
    )

    await waitUntilAsync(
      async () =>
        (await client.cancelJob({
          executionId: request.executionId,
          attempt: request.attempt,
          leaseToken: randomBytes(32),
        })) === 'not_found',
      5_000,
    )
  })

  test('rejects OK EOF when no terminal event was emitted', async () => {
    const consume = async () => {
      for await (const _event of client.runJob(requestFor('bad-eof', 'eof_without_terminal'))) {
        // Consume the complete stream so the client can validate EOF.
      }
    }
    await expect(consume()).rejects.toEqual(
      expect.objectContaining<Partial<WorkerProtocolError>>({
        name: 'WorkerProtocolError',
        message: 'Worker stream ended without a terminal event',
      }),
    )
  })
})

function requestFor(suffix: string, mode: string): WorkerRunJobRequest {
  return {
    executionId: `execution-${suffix}`,
    jobId: `job-${suffix}`,
    attempt: 1,
    leaseToken: randomBytes(32),
    capabilityName: 'fixture.copy',
    capabilityVersion: '1',
    parameters: {
      schemaName: 'databench.worker.fixture-copy-parameters',
      schemaVersion: '1',
      utf8Json: Buffer.from(JSON.stringify({ mode, delay_ms: 1, steps: 1 })),
    },
    inputs: [
      {
        name: 'input',
        readUrl: `${artifactBaseUrl}/input`,
        mediaType: 'application/octet-stream',
        size: INPUT.byteLength,
        digest: createHash('sha256').update(INPUT).digest('hex'),
      },
    ],
    outputs: [
      {
        name: 'output',
        writeUrl: `${artifactBaseUrl}/output`,
        mediaType: 'application/octet-stream',
        maxSize: 1024,
      },
    ],
    deadlineUnixMs: Date.now() + 10_000,
  }
}

function minioConfig(bucket: string) {
  return {
    bucket,
    region: process.env.S3_REGION ?? 'us-east-1',
    endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
    workerEndpoint: process.env.S3_WORKER_ENDPOINT ?? 'http://localhost:9000',
    accessKeyId: process.env.S3_ACCESS_KEY_ID ?? 'databench',
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? 'databench-secret',
    forcePathStyle: true,
  }
}

async function waitForTransformJob(workspace: V2Workspace, id: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const job = await workspace.getTransformJob(id)
    if (job?.status === 'completed') return job
    if (job?.status === 'failed' || job?.status === 'cancelled') {
      throw new Error(`Transform job ended as ${job.status}: ${job.error?.message ?? 'no error'}`)
    }
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 25))
  }
  throw new Error('Timed out waiting for transform job completion')
}

async function waitUntil(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for condition')
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 10))
  }
}

async function waitUntilAsync(condition: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await condition())) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for async condition')
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 10))
  }
}

async function deleteAllObjects(admin: S3Client, bucket: string): Promise<void> {
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

function workerRecord(suffix: string, text: string) {
  return {
    schema_version: '2.0.0' as const,
    id: `rec_${suffix.repeat(64)}`,
    contents: [
      {
        role: 'user' as const,
        parts: [
          {
            type: 'text' as const,
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
    lang: null,
    lineage: null,
    tags: [],
    extra: {},
  }
}

async function collect(source: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of source) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

async function* chunks(bytes: Uint8Array): AsyncIterableIterator<Uint8Array> {
  yield bytes
}

function expectedBasicClean(revisions: readonly RecordRevisionV2[]): readonly RecordRevisionV2[] {
  const seen = new Set<string>()
  return revisions.filter((revision) => {
    const text = revision.record.contents
      .flatMap((content) => content.parts)
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('\n')
      .trim()
      .replace(/[\t\u2000-\u200a\u00a0\u202f\u205f\u3000\u200b-\u200d\u2060\ufffc\u0084]/g, ' ')
    if (text.length < 40 || seen.has(text)) return false
    seen.add(text)
    return true
  })
}

function dataJuicerRows(count: number): Buffer {
  const lines: string[] = []
  for (let index = 0; index < count; index += 1) {
    lines.push(
      `${JSON.stringify({
        record_id: `rec_${index.toString(16).padStart(64, '0')}`,
        record_digest: (count + index).toString(16).padStart(64, '0'),
        text: `Record ${index} has enough deterministic characters for the cancellation fixture.`,
      })}\n`,
    )
  }
  return Buffer.from(lines.join(''))
}

async function readFirstLine(child: ChildProcessWithoutNullStreams): Promise<string> {
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  return await new Promise<string>((resolveLine, reject) => {
    let stdout = ''
    let stderr = ''
    const timeout = setTimeout(
      () => reject(new Error(`Worker startup timed out: ${stderr}`)),
      10_000,
    )
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
      const newline = stdout.indexOf('\n')
      if (newline === -1) return
      clearTimeout(timeout)
      resolveLine(stdout.slice(0, newline))
    })
    child.once('exit', (code) => {
      clearTimeout(timeout)
      reject(new Error(`Worker exited during startup (${code}): ${stderr}`))
    })
    child.once('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
  })
}
