import { type ChildProcessWithoutNullStreams, execFile, spawn } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { CreateBucketCommand, DeleteBucketCommand, S3Client } from '@aws-sdk/client-s3'
import type { CatalogTransformJobRowV2 } from '@databench/catalog'
import { V2Dataset } from '@databench/engine'
import {
  S3ConditionalObjectStoreV2,
  WORKER_STAGING_JSONL_MEDIA_TYPE,
  WorkerStagingStoreV1,
} from '@databench/store'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import type { WorkerProtocolError, WorkerRunJobRequest } from '../src/internal/worker/client.js'
import { GrpcWorkerClient } from '../src/internal/worker/grpc-client.js'
import {
  WorkerStagingJobCleanerV1,
  WorkerStagingJobPreparerV1,
} from '../src/internal/worker/staging.js'
import { writeWorkerRecordTextJsonlV1 } from '../src/v2/batch-transform.js'

const RUN_INTEGRATION = process.env.RUN_WORKER_INTEGRATION_TESTS === '1'
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const WORKER_ROOT = resolve(REPO_ROOT, 'workers/python')
const INPUT = Buffer.from('fixture-copy-cross-language')
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

  test('round-trips record-text-v1 through real MinIO signed URLs and exact cleanup', async () => {
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
    const staging = new WorkerStagingStoreV1({
      objectStore,
      tempRoot: root,
      maxBytes: 1024 * 1024,
      signedUrlTtlMs: 60_000,
    })
    const jobId = `job_${'a'.repeat(64)}`
    const ref = { jobId, attempt: 1 }

    try {
      const dataset = V2Dataset.fromRecords([
        workerRecord('1', ' first '),
        workerRecord('2', '第二条'),
      ])
      const job = workerJob(jobId, dataset.version, dataset.length)
      let stagingKeys: { readonly inputKey: string; readonly outputKey: string } | null = null
      const preparer = new WorkerStagingJobPreparerV1({
        catalog: {
          async setTransformJobStagingKeys(input) {
            expect(input).toMatchObject({ id: job.id, attempt: job.attempt })
            stagingKeys = { inputKey: input.inputKey, outputKey: input.outputKey }
            return true
          },
        },
        staging,
        projector: {
          project(_job, signal) {
            return writeWorkerRecordTextJsonlV1(dataset.records(), { signal })
          },
        },
        parameters: () => ({
          schemaName: 'databench.worker.fixture-copy-parameters',
          schemaVersion: '1',
          utf8Json: Buffer.from('{"mode":"complete","steps":1}'),
        }),
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
      if (!source || !target || !stagingKeys) throw new Error('staging preparation is incomplete')

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
        attempt: 1,
        leaseToken: job.leaseToken ?? randomBytes(32),
        capabilityName: 'fixture.copy',
        capabilityVersion: '1',
        ...prepared,
        deadlineUnixMs: Date.now() + 10_000,
      })) {
        events.push(event)
      }
      const completed = events.at(-1)
      expect(completed?.type).toBe('completed')
      if (completed?.type !== 'completed') throw new Error('fixture did not complete')
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
      expect(outputBytes).toEqual(inputBytes)

      const expiring = new WorkerStagingStoreV1({
        objectStore,
        tempRoot: join(root, 'expiring'),
        maxBytes: 1024 * 1024,
        signedUrlTtlMs: 1,
      })
      const expiringSource = await expiring.signRead(ref, {
        key: stagingKeys.inputKey,
        mediaType: WORKER_STAGING_JSONL_MEDIA_TYPE,
        size: source.size,
        digest: source.digest,
      })
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 1_200))
      expect((await fetch(expiringSource.readUrl)).ok).toBe(false)

      if (!job.leaseToken) throw new Error('fixture lease token is missing')
      await new WorkerStagingJobCleanerV1(staging).cleanup({
        job: { ...job, inputKey: stagingKeys.inputKey, outputKey: stagingKeys.outputKey },
        lease: { id: job.id, attempt: job.attempt, leaseToken: job.leaseToken },
      })
      await expect(staging.statExact({ ...ref, logicalName: 'input' })).resolves.toBeNull()
      await expect(staging.statExact({ ...ref, logicalName: 'output' })).resolves.toBeNull()
    } finally {
      await Promise.allSettled([
        staging.deleteExact({ ...ref, logicalName: 'input' }),
        staging.deleteExact({ ...ref, logicalName: 'output' }),
      ])
      await admin.send(new DeleteBucketCommand({ Bucket: bucket }))
      admin.destroy()
      await rm(root, { recursive: true, force: true })
    }
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

function workerJob(id: string, inputVersion: string, inputCount: number): CatalogTransformJobRowV2 {
  return {
    id,
    cacheKey: id.slice(4),
    op: 'fixture-copy',
    opVersion: '1',
    params: {},
    inputVersion,
    capabilityName: 'fixture.copy',
    capabilityVersion: '1',
    inputCount: BigInt(inputCount),
    status: 'leased',
    attempt: 1,
    leaseOwner: 'integration.test',
    leaseToken: randomBytes(32),
    leaseExpiresAt: new Date(Date.now() + 30_000),
    progress: null,
    inputKey: null,
    outputKey: null,
    outputCount: null,
    outputVersion: null,
    cacheHit: false,
    error: null,
    createdAt: new Date(),
    startedAt: null,
    finishedAt: null,
    updatedAt: new Date(),
  }
}

async function collect(source: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of source) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
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
