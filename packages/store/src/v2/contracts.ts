import type { Readable, Writable } from 'node:stream'
import type { V2Dataset, V2DatasetLimits } from '@databench/engine'
import type { DatasetLayoutIdentityV2, DatasetManifestV2 } from '@databench/schema'
import { ConflictError, ServiceUnavailableError } from '@databench/schema'

declare const preparedArtifactV2Brand: unique symbol

export interface PreparedArtifactV2 {
  readonly [preparedArtifactV2Brand]: true
  readonly identity: Readonly<DatasetLayoutIdentityV2>
  readonly manifest: Readonly<DatasetManifestV2>
}

export interface V2OperationContext {
  readonly signal?: AbortSignal
}

export interface AuditResultV2 {
  readonly ok: true
  readonly identity: Readonly<DatasetLayoutIdentityV2>
  readonly manifest: Readonly<DatasetManifestV2>
}

export interface V2Store {
  readonly readDatasetLimits: Readonly<V2DatasetLimits>
  prepare(dataset: V2Dataset, context?: V2OperationContext): Promise<PreparedArtifactV2>
  commit(
    prepared: PreparedArtifactV2,
    context?: V2OperationContext,
  ): Promise<Readonly<DatasetManifestV2>>
  discard(prepared: PreparedArtifactV2, cleanupContext?: V2OperationContext): Promise<void>
  exists(identity: DatasetLayoutIdentityV2, context?: V2OperationContext): Promise<boolean>
  read(identity: DatasetLayoutIdentityV2, context?: V2OperationContext): Promise<V2Dataset>
  audit(identity: DatasetLayoutIdentityV2, context?: V2OperationContext): Promise<AuditResultV2>
  ping(context?: V2OperationContext): Promise<void>
}

export interface ConditionalCreateInput {
  readonly key: string
  readonly contentType: string
  readonly contentLength: number
  readonly body: () => Readable
  readonly signal?: AbortSignal
}

export type ConditionalCreateResult =
  | { readonly status: 'created' }
  | { readonly status: 'already_exists' }
  | { readonly status: 'ambiguous'; readonly error: unknown }
  | { readonly status: 'failure'; readonly error: unknown }

export interface ObjectHeadV2 {
  readonly size: number
}

export interface ObjectDownloadInputV2 {
  readonly key: string
  readonly destination: Writable
  readonly signal?: AbortSignal
}

export interface ConditionalObjectStoreV2 {
  conditionalCreate(input: ConditionalCreateInput): Promise<ConditionalCreateResult>
  head(key: string, context?: V2OperationContext): Promise<Readonly<ObjectHeadV2> | null>
  download(input: ObjectDownloadInputV2): Promise<'downloaded' | 'not_found'>
  ping(context?: V2OperationContext): Promise<void>
}

export class LayoutConflictErrorV2 extends ConflictError {
  override readonly name = 'LayoutConflictErrorV2'
  override readonly code = 'layout_conflict'

  constructor(message = 'Dataset layout already exists with different canonical metadata') {
    super(message, { reason: 'layout_conflict' })
  }
}

export class ObjectStoreFailureErrorV2 extends ServiceUnavailableError {
  override readonly name = 'ObjectStoreFailureErrorV2'
  readonly provider: 's3' | 'oss' | 'unknown'

  constructor(message: string, cause: unknown, provider: 's3' | 'oss' | 'unknown' = 'unknown') {
    super(message, { provider }, { cause })
    this.provider = provider
  }
}
