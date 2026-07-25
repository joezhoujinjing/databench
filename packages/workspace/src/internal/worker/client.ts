export interface WorkerArtifactContract {
  readonly name: string
  readonly mediaType: string
}

export interface WorkerCapability {
  readonly name: string
  readonly version: string
  readonly mode: 'batch'
  readonly parameterSchemaName: string
  readonly parameterSchemaVersion: string
  readonly inputs: readonly WorkerArtifactContract[]
  readonly outputs: readonly WorkerArtifactContract[]
}

export interface WorkerCapabilities {
  readonly workerVersion: string
  readonly capabilities: readonly WorkerCapability[]
}

export interface WorkerJsonPayload {
  readonly schemaName: string
  readonly schemaVersion: string
  readonly utf8Json: Uint8Array
}

export interface WorkerInputArtifact {
  readonly name: string
  readonly readUrl: string
  readonly mediaType: string
  readonly size: number
  readonly digest: string
}

export interface WorkerOutputTarget {
  readonly name: string
  readonly writeUrl: string
  readonly mediaType: string
  readonly maxSize: number
}

export interface WorkerRunJobRequest {
  readonly executionId: string
  readonly jobId: string
  readonly attempt: number
  readonly leaseToken: Uint8Array
  readonly capabilityName: string
  readonly capabilityVersion: string
  readonly parameters: WorkerJsonPayload
  readonly inputs: readonly WorkerInputArtifact[]
  readonly outputs: readonly WorkerOutputTarget[]
  readonly deadlineUnixMs: number
}

export interface WorkerOutputArtifact {
  readonly name: string
  readonly size: number
  readonly digest: string
  readonly recordCount: number
}

export type WorkerJobEvent =
  | { readonly type: 'accepted'; readonly timestampUnixMs: number }
  | { readonly type: 'started'; readonly timestampUnixMs: number }
  | {
      readonly type: 'progress'
      readonly timestampUnixMs: number
      readonly phase: string
      readonly completedUnits: number
      readonly totalUnits?: number
    }
  | { readonly type: 'heartbeat'; readonly timestampUnixMs: number }
  | {
      readonly type: 'completed'
      readonly timestampUnixMs: number
      readonly outputs: readonly WorkerOutputArtifact[]
    }
  | {
      readonly type: 'failed'
      readonly timestampUnixMs: number
      readonly code: string
      readonly message: string
      readonly retryable: boolean
    }
  | { readonly type: 'cancelled'; readonly timestampUnixMs: number; readonly message: string }

export type WorkerCancelResult = 'stopped' | 'not_found' | 'token_mismatch'

export interface WorkerCancelJobRequest {
  readonly executionId: string
  readonly attempt: number
  readonly leaseToken: Uint8Array
}

export interface WorkerCallOptions {
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
}

export interface WorkerClient {
  describeCapabilities(options?: WorkerCallOptions): Promise<WorkerCapabilities>
  runJob(request: WorkerRunJobRequest, options?: WorkerCallOptions): AsyncIterable<WorkerJobEvent>
  cancelJob(
    request: WorkerCancelJobRequest,
    options?: WorkerCallOptions,
  ): Promise<WorkerCancelResult>
  close(): void
}

export class WorkerProtocolError extends Error {
  override readonly name = 'WorkerProtocolError'
}

export class WorkerTransportError extends Error {
  override readonly name = 'WorkerTransportError'

  constructor(
    message: string,
    readonly statusCode?: number,
    options?: ErrorOptions,
  ) {
    super(message, options)
  }
}
