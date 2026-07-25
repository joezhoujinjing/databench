import {
  type ClientReadableStream,
  type ClientUnaryCall,
  credentials,
  Metadata,
  type ServiceError,
} from '@grpc/grpc-js'

import type {
  WorkerCallOptions,
  WorkerCancelJobRequest,
  WorkerCancelResult,
  WorkerCapabilities,
  WorkerCapability,
  WorkerClient,
  WorkerJobEvent,
  WorkerRunJobRequest,
} from './client.js'
import { WorkerProtocolError, WorkerTransportError } from './client.js'
import {
  type CancelJobResponse,
  CancelResult,
  CapabilityMode,
  type DescribeCapabilitiesResponse,
  type JobEvent,
  WorkerServiceClient,
} from './generated/databench/worker/v1/worker.js'

export interface GrpcWorkerClientOptions {
  readonly address: string
  readonly defaultTimeoutMs?: number
  readonly terminalEofTimeoutMs?: number
}

export class GrpcWorkerClient implements WorkerClient {
  readonly #client: InstanceType<typeof WorkerServiceClient>
  readonly #defaultTimeoutMs: number
  readonly #terminalEofTimeoutMs: number

  constructor(options: GrpcWorkerClientOptions) {
    this.#client = new WorkerServiceClient(options.address, credentials.createInsecure())
    this.#defaultTimeoutMs = options.defaultTimeoutMs ?? 5_000
    this.#terminalEofTimeoutMs = options.terminalEofTimeoutMs ?? 5_000
  }

  async describeCapabilities(options: WorkerCallOptions = {}): Promise<WorkerCapabilities> {
    const response = await unaryCall<DescribeCapabilitiesResponse>(
      (callback) =>
        this.#client.describeCapabilities(
          {},
          new Metadata(),
          { deadline: deadline(options.timeoutMs ?? this.#defaultTimeoutMs) },
          callback,
        ),
      options.signal,
    )
    return {
      workerVersion: response.workerVersion,
      capabilities: response.capabilities.map(mapCapability),
    }
  }

  async *runJob(
    request: WorkerRunJobRequest,
    options: WorkerCallOptions = {},
  ): AsyncIterable<WorkerJobEvent> {
    const call = this.#client.runJob(
      {
        executionId: request.executionId,
        jobId: request.jobId,
        attempt: request.attempt,
        leaseToken: Buffer.from(request.leaseToken),
        capabilityName: request.capabilityName,
        capabilityVersion: request.capabilityVersion,
        parameters: {
          schemaName: request.parameters.schemaName,
          schemaVersion: request.parameters.schemaVersion,
          utf8Json: Buffer.from(request.parameters.utf8Json),
        },
        inputs: request.inputs.map((value) => ({ ...value })),
        outputs: request.outputs.map((value) => ({ ...value })),
        deadlineUnixMs: request.deadlineUnixMs,
      },
      { deadline: new Date(request.deadlineUnixMs) },
    )
    const removeAbort = bindAbort(options.signal, call)
    const iterator = call[Symbol.asyncIterator]()
    let accepted = false
    let started = false
    let terminal = false

    try {
      while (true) {
        const result = terminal
          ? await nextWithTimeout(iterator, this.#terminalEofTimeoutMs, call)
          : await iterator.next()
        if (result.done) {
          if (!terminal) {
            throw new WorkerProtocolError('Worker stream ended without a terminal event')
          }
          return
        }

        const event = mapEvent(result.value)
        if (!accepted) {
          if (event.type !== 'accepted') {
            throw new WorkerProtocolError('accepted must be the first Worker event')
          }
          accepted = true
        } else if (event.type === 'accepted') {
          throw new WorkerProtocolError('Worker emitted accepted more than once')
        }

        if (terminal) {
          throw new WorkerProtocolError('Worker emitted an event after its terminal event')
        }
        if (event.type === 'started') {
          if (started) {
            throw new WorkerProtocolError('Worker emitted started more than once')
          }
          started = true
        } else if (event.type === 'progress' && !started) {
          throw new WorkerProtocolError('Worker emitted progress before started')
        }

        if (isTerminal(event)) {
          if (!started) {
            throw new WorkerProtocolError('Worker emitted a terminal event before started')
          }
          terminal = true
        }
        yield event
      }
    } catch (error) {
      if (error instanceof WorkerProtocolError || error instanceof WorkerTransportError) {
        throw error
      }
      throw transportError(error)
    } finally {
      removeAbort()
    }
  }

  async cancelJob(
    request: WorkerCancelJobRequest,
    options: WorkerCallOptions = {},
  ): Promise<WorkerCancelResult> {
    const response = await unaryCall<CancelJobResponse>(
      (callback) =>
        this.#client.cancelJob(
          {
            executionId: request.executionId,
            attempt: request.attempt,
            leaseToken: Buffer.from(request.leaseToken),
          },
          new Metadata(),
          { deadline: deadline(options.timeoutMs ?? this.#defaultTimeoutMs) },
          callback,
        ),
      options.signal,
    )
    switch (response.result) {
      case CancelResult.CANCEL_RESULT_STOPPED:
        return 'stopped'
      case CancelResult.CANCEL_RESULT_NOT_FOUND:
        return 'not_found'
      case CancelResult.CANCEL_RESULT_TOKEN_MISMATCH:
        return 'token_mismatch'
      default:
        throw new WorkerProtocolError('Worker returned an unspecified cancellation result')
    }
  }

  close(): void {
    this.#client.close()
  }
}

function mapCapability(value: {
  name: string
  version: string
  mode: CapabilityMode
  parameterSchemaName: string
  parameterSchemaVersion: string
  inputs: { name: string; mediaType: string }[]
  outputs: { name: string; mediaType: string }[]
}): WorkerCapability {
  if (value.mode !== CapabilityMode.CAPABILITY_MODE_BATCH) {
    throw new WorkerProtocolError(`Worker returned unsupported capability mode for ${value.name}`)
  }
  return {
    name: value.name,
    version: value.version,
    mode: 'batch',
    parameterSchemaName: value.parameterSchemaName,
    parameterSchemaVersion: value.parameterSchemaVersion,
    inputs: value.inputs.map((contract) => ({ ...contract })),
    outputs: value.outputs.map((contract) => ({ ...contract })),
  }
}

function mapEvent(value: JobEvent): WorkerJobEvent {
  const fields = [
    value.accepted,
    value.started,
    value.progress,
    value.heartbeat,
    value.completed,
    value.failed,
    value.cancelled,
  ].filter((event) => event !== undefined)
  if (fields.length !== 1) {
    throw new WorkerProtocolError('Worker event must contain exactly one event variant')
  }
  if (value.accepted) {
    return { type: 'accepted', timestampUnixMs: value.accepted.timestampUnixMs }
  }
  if (value.started) {
    return { type: 'started', timestampUnixMs: value.started.timestampUnixMs }
  }
  if (value.progress) {
    return {
      type: 'progress',
      timestampUnixMs: value.progress.timestampUnixMs,
      phase: value.progress.phase,
      completedUnits: value.progress.completedUnits,
      ...(value.progress.totalUnits === undefined ? {} : { totalUnits: value.progress.totalUnits }),
    }
  }
  if (value.heartbeat) {
    return { type: 'heartbeat', timestampUnixMs: value.heartbeat.timestampUnixMs }
  }
  if (value.completed) {
    return {
      type: 'completed',
      timestampUnixMs: value.completed.timestampUnixMs,
      outputs: value.completed.outputs.map((output) => ({ ...output })),
    }
  }
  if (value.failed) {
    return {
      type: 'failed',
      timestampUnixMs: value.failed.timestampUnixMs,
      code: value.failed.code,
      message: value.failed.message,
      retryable: value.failed.retryable,
    }
  }
  if (value.cancelled) {
    return {
      type: 'cancelled',
      timestampUnixMs: value.cancelled.timestampUnixMs,
      message: value.cancelled.message,
    }
  }
  throw new WorkerProtocolError('Worker event variant is missing')
}

function isTerminal(event: WorkerJobEvent): boolean {
  return event.type === 'completed' || event.type === 'failed' || event.type === 'cancelled'
}

async function unaryCall<T>(
  start: (callback: (error: ServiceError | null, response: T) => void) => ClientUnaryCall,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let call: ClientUnaryCall | undefined
    const onAbort = () => call?.cancel()
    if (signal?.aborted) {
      reject(new WorkerTransportError('Worker call was aborted'))
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    call = start((error, response) => {
      signal?.removeEventListener('abort', onAbort)
      if (error) {
        reject(transportError(error))
      } else {
        resolve(response)
      }
    })
  })
}

function bindAbort(
  signal: AbortSignal | undefined,
  call: ClientReadableStream<JobEvent>,
): () => void {
  const onAbort = () => call.cancel()
  if (signal?.aborted) {
    call.cancel()
  } else {
    signal?.addEventListener('abort', onAbort, { once: true })
  }
  return () => signal?.removeEventListener('abort', onAbort)
}

async function nextWithTimeout<T>(
  iterator: AsyncIterator<T>,
  timeoutMs: number,
  call: ClientReadableStream<JobEvent>,
): Promise<IteratorResult<T>> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      iterator.next(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          call.cancel()
          reject(new WorkerProtocolError('Worker did not close with OK EOF after terminal event'))
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function deadline(timeoutMs: number): Date {
  return new Date(Date.now() + timeoutMs)
}

function transportError(error: unknown): WorkerTransportError {
  if (isServiceError(error)) {
    return new WorkerTransportError(error.details || 'Worker transport failed', error.code, {
      cause: error,
    })
  }
  return new WorkerTransportError('Worker transport failed', undefined, { cause: error })
}

function isServiceError(value: unknown): value is ServiceError {
  return value instanceof Error && 'code' in value && typeof value.code === 'number'
}
