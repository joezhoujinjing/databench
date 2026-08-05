import { createHmac, timingSafeEqual } from 'node:crypto'
import { canonicalJsonV2 } from '@databench/hashing'
import {
  EvaluationRunIdV2Schema,
  EvaluationRunStatusV2Schema,
  ModelAliasFilterV2Schema,
  ModelArchiveFilterV2Schema,
  ModelArtifactIdV2Schema,
  ModelArtifactKindV2Schema,
  ModelDeploymentHealthFilterV2Schema,
  ModelDeploymentIdV2Schema,
  ModelDeploymentStatusV2Schema,
  ModelEvaluationWorkloadProfileV2Schema,
  ModelIdV2Schema,
  ModelSourceKindV2Schema,
  ModelSourceMutabilityV2Schema,
  ModelTagV2Schema,
  ModelTaskFamilyV2Schema,
  ModelVerificationLevelV2Schema,
  ModelVersionDeploymentLifecycleV2Schema,
  ModelVersionIdV2Schema,
  parseRawJsonV2,
  RefNameV2Schema,
  SwiftStudioSessionIdV2Schema,
  SwiftStudioSessionStatusV2Schema,
  TransformJobIdV2Schema,
  V2_CURSOR_MAX_CHARS,
  V2_LINEAGE_CURSOR_MAX_CHARS,
  V2_LINEAGE_MAX_DEPTH,
  V2_LINEAGE_MAX_NODES,
  ValidationError,
} from '@databench/schema'

const CURSOR_VERSION = 1
const CURSOR_MAX_BYTES = 1024
const LINEAGE_CURSOR_MAX_BYTES = CURSOR_MAX_BYTES
const BASE64URL = /^[A-Za-z0-9_-]+$/
const DIGEST_HEX = /^[0-9a-f]{64}$/
const NON_NEGATIVE_BIGINT_DECIMAL = /^(?:0|[1-9][0-9]{0,18})$/
const POSTGRES_BIGINT_MAX = 9_223_372_036_854_775_807n
const encoder = new TextEncoder()
export const DEFAULT_V2_CURSOR_TTL_MS = 15 * 60 * 1000

type RefCursorKindV2 = 'deleted_refs' | 'refs'

interface RefCursorPayloadV2 {
  readonly v: typeof CURSOR_VERSION
  readonly kind: RefCursorKindV2
  readonly scope: string
  readonly after: string
  readonly expires_at: number
}

export interface V2LineageCursorState {
  readonly root_dataset_version: string
  readonly snapshot_sequence: string
  readonly max_depth: number
  readonly max_nodes: number
  readonly emitted_nodes: number
  readonly emitted_edges: number
}

interface LineageCursorPayloadV2 extends V2LineageCursorState {
  readonly v: typeof CURSOR_VERSION
  readonly kind: 'lineage'
  readonly scope: string
  readonly requested_ref: string
  readonly expires_at: number
}

export interface V2TransformJobCursorState {
  readonly created_at: string
  readonly id: string
}

interface TransformJobCursorPayloadV2 extends V2TransformJobCursorState {
  readonly v: typeof CURSOR_VERSION
  readonly kind: 'transform_jobs'
  readonly scope: string
  readonly expires_at: number
}

export interface V2EvaluationRunCursorState {
  readonly created_at: string
  readonly id: string
  readonly dataset_version: string | null
  readonly model_deployment_id: string | null
  readonly model_id: string | null
  readonly model_version_id: string | null
  readonly status: string | null
}

interface EvaluationRunCursorPayloadV2 extends V2EvaluationRunCursorState {
  readonly v: typeof CURSOR_VERSION
  readonly kind: 'evaluation_runs'
  readonly scope: string
  readonly expires_at: number
}

export interface V2SwiftStudioSessionCursorState {
  readonly created_at: string
  readonly id: string
  readonly dataset_version: string | null
  readonly status: string | null
}

interface SwiftStudioSessionCursorPayloadV2 extends V2SwiftStudioSessionCursorState {
  readonly v: typeof CURSOR_VERSION
  readonly kind: 'swift_studio_sessions'
  readonly scope: string
  readonly expires_at: number
}

export interface V2ModelArtifactCursorState {
  readonly created_at: string
  readonly id: string
  readonly dataset_version: string | null
  readonly artifact_kind: string | null
  readonly registration_status: string
}

interface ModelArtifactCursorPayloadV2 extends V2ModelArtifactCursorState {
  readonly v: typeof CURSOR_VERSION
  readonly kind: 'model_artifacts'
  readonly scope: string
  readonly expires_at: number
}

export interface V2ModelCursorFilterState {
  readonly search: string
  readonly archive: string
  readonly source_kind: string | null
  readonly source_mutability: string | null
  readonly verification_level: string | null
  readonly task_family: string | null
  readonly artifact_kind: string | null
  readonly artifact_id: string | null
  readonly alias: string | null
  readonly deployment_lifecycle: string | null
  readonly deployment_health: string | null
  readonly tag: string | null
}

export interface V2ModelCursorState extends V2ModelCursorFilterState {
  readonly updated_at: string
  readonly id: string
}

interface ModelCursorPayloadV2 extends V2ModelCursorState {
  readonly v: typeof CURSOR_VERSION
  readonly kind: 'models'
  readonly scope: string
  readonly expires_at: number
}

export interface V2ModelVersionCursorState {
  readonly created_at: string
  readonly id: string
  readonly model_id: string
}

interface ModelVersionCursorPayloadV2 extends V2ModelVersionCursorState {
  readonly v: typeof CURSOR_VERSION
  readonly kind: 'model_versions'
  readonly scope: string
  readonly expires_at: number
}

export interface V2ModelDeploymentCursorState {
  readonly created_at: string
  readonly id: string
  readonly artifact_id: string | null
  readonly status: string | null
}

interface ModelDeploymentCursorPayloadV2 extends V2ModelDeploymentCursorState {
  readonly v: typeof CURSOR_VERSION
  readonly kind: 'model_deployments'
  readonly scope: string
  readonly expires_at: number
}

export interface V2ModelVersionDeploymentCursorState {
  readonly created_at: string
  readonly id: string
  readonly model_version_id: string
  readonly lifecycle: string | null
}

interface ModelVersionDeploymentCursorPayloadV2 extends V2ModelVersionDeploymentCursorState {
  readonly v: typeof CURSOR_VERSION
  readonly kind: 'model_version_deployments'
  readonly scope: string
  readonly expires_at: number
}

export interface V2ModelDeploymentAdoptionCursorState {
  readonly adopted_at: string
  readonly deployment_id: string
  readonly model_version_id: string
}

interface ModelDeploymentAdoptionCursorPayloadV2 extends V2ModelDeploymentAdoptionCursorState {
  readonly v: typeof CURSOR_VERSION
  readonly kind: 'model_deployment_adoptions'
  readonly scope: string
  readonly expires_at: number
}

export interface V2ModelEvaluationDeploymentCursorState {
  readonly created_at: string
  readonly id: string
  readonly model_version_id: string
  readonly workload_profile: string
  readonly max_output_tokens: number | null
}

interface ModelEvaluationDeploymentCursorPayloadV2 extends V2ModelEvaluationDeploymentCursorState {
  readonly v: typeof CURSOR_VERSION
  readonly kind: 'model_evaluation_deployments'
  readonly scope: string
  readonly expires_at: number
}

export interface V2CursorCodecOptions {
  readonly ttlMs?: number
  readonly now?: () => number
}

export class V2CursorCodec {
  readonly #key: Uint8Array
  readonly #ttlMs: number
  readonly #now: () => number

  constructor(secret: Uint8Array | string, options: V2CursorCodecOptions = {}) {
    const key = typeof secret === 'string' ? encoder.encode(secret) : secret.slice()
    if (key.byteLength < 16) {
      throw new TypeError('V2 cursor secret must contain at least 16 bytes')
    }
    this.#key = key
    this.#ttlMs = positiveSafeInteger('V2 cursor ttlMs', options.ttlMs ?? DEFAULT_V2_CURSOR_TTL_MS)
    this.#now = options.now ?? Date.now
  }

  encodeRef(namespace: string, after: string): string {
    return this.#encodeRef(namespace, after, 'refs')
  }

  encodeDeletedRef(namespace: string, after: string): string {
    return this.#encodeRef(namespace, after, 'deleted_refs')
  }

  #encodeRef(namespace: string, after: string, kind: RefCursorKindV2): string {
    const payload: RefCursorPayloadV2 = {
      v: CURSOR_VERSION,
      kind,
      scope: this.#scope(namespace, kind),
      after: RefNameV2Schema.parse(after),
      expires_at: checkedAdd(this.#now(), this.#ttlMs),
    }
    const bytes = encoder.encode(canonicalJsonV2(payload))
    return `${Buffer.from(bytes).toString('base64url')}.${this.#sign(bytes).toString('base64url')}`
  }

  decodeRef(cursor: string, namespace: string): string {
    return this.#decodeRef(cursor, namespace, 'refs')
  }

  decodeDeletedRef(cursor: string, namespace: string): string {
    return this.#decodeRef(cursor, namespace, 'deleted_refs')
  }

  encodeTransformJob(namespace: string, stateInput: V2TransformJobCursorState): string {
    const state = validateTransformJobState(stateInput)
    const payload: TransformJobCursorPayloadV2 = {
      v: CURSOR_VERSION,
      kind: 'transform_jobs',
      scope: this.#scope(namespace, 'transform_jobs'),
      ...state,
      expires_at: checkedAdd(this.#now(), this.#ttlMs),
    }
    const bytes = encoder.encode(canonicalJsonV2(payload))
    return `${Buffer.from(bytes).toString('base64url')}.${this.#sign(bytes).toString('base64url')}`
  }

  decodeTransformJob(cursor: string, namespace: string): Readonly<V2TransformJobCursorState> {
    try {
      if (typeof cursor !== 'string' || cursor.length > V2_CURSOR_MAX_CHARS) {
        throw new Error('cursor text size is invalid')
      }
      const parts = cursor.split('.')
      if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error('malformed cursor')
      const bytes = decodeBase64Url(parts[0])
      if (bytes.byteLength === 0 || bytes.byteLength > CURSOR_MAX_BYTES) {
        throw new Error('cursor payload size is invalid')
      }
      const signature = decodeBase64Url(parts[1])
      const expected = this.#sign(bytes)
      if (signature.byteLength !== expected.byteLength || !timingSafeEqual(signature, expected)) {
        throw new Error('cursor signature is invalid')
      }
      const value = parseRawJsonV2(bytes, { maxBytes: CURSOR_MAX_BYTES, maxDepth: 4 })
      if (
        !isTransformJobCursorPayload(value) ||
        value.scope !== this.#scope(namespace, 'transform_jobs') ||
        value.expires_at <= this.#now()
      ) {
        throw new Error('cursor scope is invalid')
      }
      return validateTransformJobState(value)
    } catch {
      throw new ValidationError('Invalid or expired V2 transform job cursor', {
        issues: [
          { path: '/cursor', line: null, code: 'invalid_cursor', message: 'Invalid cursor' },
        ],
      })
    }
  }

  encodeEvaluationRun(namespace: string, stateInput: V2EvaluationRunCursorState): string {
    const state = validateEvaluationRunState(stateInput)
    const payload: EvaluationRunCursorPayloadV2 = {
      v: CURSOR_VERSION,
      kind: 'evaluation_runs',
      scope: this.#scope(namespace, 'evaluation_runs'),
      ...state,
      expires_at: checkedAdd(this.#now(), this.#ttlMs),
    }
    const bytes = encoder.encode(canonicalJsonV2(payload))
    return `${Buffer.from(bytes).toString('base64url')}.${this.#sign(bytes).toString('base64url')}`
  }

  decodeEvaluationRun(
    cursor: string,
    namespace: string,
    datasetVersion: string | null,
    modelDeploymentId: string | null,
    modelId: string | null,
    modelVersionId: string | null,
    status: string | null,
  ): Readonly<V2EvaluationRunCursorState> {
    try {
      if (typeof cursor !== 'string' || cursor.length > V2_CURSOR_MAX_CHARS) {
        throw new Error('cursor text size is invalid')
      }
      const parts = cursor.split('.')
      if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error('malformed cursor')
      const bytes = decodeBase64Url(parts[0])
      if (bytes.byteLength === 0 || bytes.byteLength > CURSOR_MAX_BYTES) {
        throw new Error('cursor payload size is invalid')
      }
      const signature = decodeBase64Url(parts[1])
      const expected = this.#sign(bytes)
      if (signature.byteLength !== expected.byteLength || !timingSafeEqual(signature, expected)) {
        throw new Error('cursor signature is invalid')
      }
      const value = parseRawJsonV2(bytes, { maxBytes: CURSOR_MAX_BYTES, maxDepth: 4 })
      if (
        !isEvaluationRunCursorPayload(value) ||
        value.scope !== this.#scope(namespace, 'evaluation_runs') ||
        value.dataset_version !== datasetVersion ||
        value.model_deployment_id !== modelDeploymentId ||
        value.model_id !== modelId ||
        value.model_version_id !== modelVersionId ||
        value.status !== status ||
        value.expires_at <= this.#now()
      ) {
        throw new Error('cursor scope is invalid')
      }
      return validateEvaluationRunState(value)
    } catch {
      throw new ValidationError('Invalid or expired V2 evaluation run cursor', {
        issues: [
          { path: '/cursor', line: null, code: 'invalid_cursor', message: 'Invalid cursor' },
        ],
      })
    }
  }

  encodeSwiftStudioSession(namespace: string, stateInput: V2SwiftStudioSessionCursorState): string {
    const state = validateSwiftStudioSessionState(stateInput)
    const payload: SwiftStudioSessionCursorPayloadV2 = {
      v: CURSOR_VERSION,
      kind: 'swift_studio_sessions',
      scope: this.#scope(namespace, 'swift_studio_sessions'),
      ...state,
      expires_at: checkedAdd(this.#now(), this.#ttlMs),
    }
    const bytes = encoder.encode(canonicalJsonV2(payload))
    return `${Buffer.from(bytes).toString('base64url')}.${this.#sign(bytes).toString('base64url')}`
  }

  decodeSwiftStudioSession(
    cursor: string,
    namespace: string,
    datasetVersion: string | null,
    status: string | null,
  ): Readonly<V2SwiftStudioSessionCursorState> {
    try {
      if (typeof cursor !== 'string' || cursor.length > V2_CURSOR_MAX_CHARS) {
        throw new Error('cursor text size is invalid')
      }
      const parts = cursor.split('.')
      if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error('malformed cursor')
      const bytes = decodeBase64Url(parts[0])
      if (bytes.byteLength === 0 || bytes.byteLength > CURSOR_MAX_BYTES) {
        throw new Error('cursor payload size is invalid')
      }
      const signature = decodeBase64Url(parts[1])
      const expected = this.#sign(bytes)
      if (signature.byteLength !== expected.byteLength || !timingSafeEqual(signature, expected)) {
        throw new Error('cursor signature is invalid')
      }
      const value = parseRawJsonV2(bytes, { maxBytes: CURSOR_MAX_BYTES, maxDepth: 4 })
      if (
        !isSwiftStudioSessionCursorPayload(value) ||
        value.scope !== this.#scope(namespace, 'swift_studio_sessions') ||
        value.dataset_version !== datasetVersion ||
        value.status !== status ||
        value.expires_at <= this.#now()
      ) {
        throw new Error('cursor scope is invalid')
      }
      return validateSwiftStudioSessionState(value)
    } catch {
      throw new ValidationError('Invalid or expired V2 Swift Studio Session cursor', {
        issues: [
          { path: '/cursor', line: null, code: 'invalid_cursor', message: 'Invalid cursor' },
        ],
      })
    }
  }

  encodeModelArtifact(namespace: string, stateInput: V2ModelArtifactCursorState): string {
    const state = validateModelArtifactState(stateInput)
    const payload: ModelArtifactCursorPayloadV2 = {
      v: CURSOR_VERSION,
      kind: 'model_artifacts',
      scope: this.#scope(namespace, 'model_artifacts'),
      ...state,
      expires_at: checkedAdd(this.#now(), this.#ttlMs),
    }
    const bytes = encoder.encode(canonicalJsonV2(payload))
    return `${Buffer.from(bytes).toString('base64url')}.${this.#sign(bytes).toString('base64url')}`
  }

  encodeModel(namespace: string, stateInput: V2ModelCursorState): string {
    const state = validateModelState(stateInput)
    const payload: ModelCursorPayloadV2 = {
      v: CURSOR_VERSION,
      kind: 'models',
      scope: this.#scope(namespace, 'models'),
      ...state,
      expires_at: checkedAdd(this.#now(), this.#ttlMs),
    }
    const bytes = encoder.encode(canonicalJsonV2(payload))
    return `${Buffer.from(bytes).toString('base64url')}.${this.#sign(bytes).toString('base64url')}`
  }

  decodeModel(
    cursor: string,
    namespace: string,
    filters: V2ModelCursorFilterState,
  ): Readonly<V2ModelCursorState> {
    try {
      const value = this.#decode(cursor)
      if (
        !isModelCursorPayload(value) ||
        value.scope !== this.#scope(namespace, 'models') ||
        !sameModelCursorFilters(value, filters) ||
        value.expires_at <= this.#now()
      ) {
        throw new Error('cursor scope is invalid')
      }
      return validateModelState(value)
    } catch {
      throw invalidCursor('Model')
    }
  }

  encodeModelVersion(namespace: string, stateInput: V2ModelVersionCursorState): string {
    const state = validateModelVersionState(stateInput)
    const payload: ModelVersionCursorPayloadV2 = {
      v: CURSOR_VERSION,
      kind: 'model_versions',
      scope: this.#scope(namespace, 'model_versions'),
      ...state,
      expires_at: checkedAdd(this.#now(), this.#ttlMs),
    }
    const bytes = encoder.encode(canonicalJsonV2(payload))
    return `${Buffer.from(bytes).toString('base64url')}.${this.#sign(bytes).toString('base64url')}`
  }

  decodeModelVersion(
    cursor: string,
    namespace: string,
    modelId: string,
  ): Readonly<V2ModelVersionCursorState> {
    try {
      const value = this.#decode(cursor)
      if (
        !isModelVersionCursorPayload(value) ||
        value.scope !== this.#scope(namespace, 'model_versions') ||
        value.model_id !== modelId ||
        value.expires_at <= this.#now()
      ) {
        throw new Error('cursor scope is invalid')
      }
      return validateModelVersionState(value)
    } catch {
      throw invalidCursor('Model Version')
    }
  }

  decodeModelArtifact(
    cursor: string,
    namespace: string,
    datasetVersion: string | null,
    artifactKind: string | null,
    registrationStatus: string,
  ): Readonly<V2ModelArtifactCursorState> {
    try {
      if (typeof cursor !== 'string' || cursor.length > V2_CURSOR_MAX_CHARS) {
        throw new Error('cursor text size is invalid')
      }
      const parts = cursor.split('.')
      if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error('malformed cursor')
      const bytes = decodeBase64Url(parts[0])
      if (bytes.byteLength === 0 || bytes.byteLength > CURSOR_MAX_BYTES) {
        throw new Error('cursor payload size is invalid')
      }
      const signature = decodeBase64Url(parts[1])
      const expected = this.#sign(bytes)
      if (signature.byteLength !== expected.byteLength || !timingSafeEqual(signature, expected)) {
        throw new Error('cursor signature is invalid')
      }
      const value = parseRawJsonV2(bytes, { maxBytes: CURSOR_MAX_BYTES, maxDepth: 4 })
      if (
        !isModelArtifactCursorPayload(value) ||
        value.scope !== this.#scope(namespace, 'model_artifacts') ||
        value.dataset_version !== datasetVersion ||
        value.artifact_kind !== artifactKind ||
        value.registration_status !== registrationStatus ||
        value.expires_at <= this.#now()
      ) {
        throw new Error('cursor scope is invalid')
      }
      return validateModelArtifactState(value)
    } catch {
      throw new ValidationError('Invalid or expired V2 Model Artifact cursor', {
        issues: [
          { path: '/cursor', line: null, code: 'invalid_cursor', message: 'Invalid cursor' },
        ],
      })
    }
  }

  encodeModelDeployment(namespace: string, stateInput: V2ModelDeploymentCursorState): string {
    const state = validateModelDeploymentState(stateInput)
    const payload: ModelDeploymentCursorPayloadV2 = {
      v: CURSOR_VERSION,
      kind: 'model_deployments',
      scope: this.#scope(namespace, 'model_deployments'),
      ...state,
      expires_at: checkedAdd(this.#now(), this.#ttlMs),
    }
    const bytes = encoder.encode(canonicalJsonV2(payload))
    return `${Buffer.from(bytes).toString('base64url')}.${this.#sign(bytes).toString('base64url')}`
  }

  decodeModelDeployment(
    cursor: string,
    namespace: string,
    artifactId: string | null,
    status: string | null,
  ): Readonly<V2ModelDeploymentCursorState> {
    try {
      if (typeof cursor !== 'string' || cursor.length > V2_CURSOR_MAX_CHARS) {
        throw new Error('cursor text size is invalid')
      }
      const parts = cursor.split('.')
      if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error('malformed cursor')
      const bytes = decodeBase64Url(parts[0])
      if (bytes.byteLength === 0 || bytes.byteLength > CURSOR_MAX_BYTES) {
        throw new Error('cursor payload size is invalid')
      }
      const signature = decodeBase64Url(parts[1])
      const expected = this.#sign(bytes)
      if (signature.byteLength !== expected.byteLength || !timingSafeEqual(signature, expected)) {
        throw new Error('cursor signature is invalid')
      }
      const value = parseRawJsonV2(bytes, { maxBytes: CURSOR_MAX_BYTES, maxDepth: 4 })
      if (
        !isModelDeploymentCursorPayload(value) ||
        value.scope !== this.#scope(namespace, 'model_deployments') ||
        value.artifact_id !== artifactId ||
        value.status !== status ||
        value.expires_at <= this.#now()
      ) {
        throw new Error('cursor scope is invalid')
      }
      return validateModelDeploymentState(value)
    } catch {
      throw new ValidationError('Invalid or expired V2 Model Deployment cursor', {
        issues: [
          { path: '/cursor', line: null, code: 'invalid_cursor', message: 'Invalid cursor' },
        ],
      })
    }
  }

  encodeModelVersionDeployment(
    namespace: string,
    stateInput: V2ModelVersionDeploymentCursorState,
  ): string {
    const state = validateModelVersionDeploymentState(stateInput)
    const payload: ModelVersionDeploymentCursorPayloadV2 = {
      v: CURSOR_VERSION,
      kind: 'model_version_deployments',
      scope: this.#scope(namespace, 'model_version_deployments'),
      ...state,
      expires_at: checkedAdd(this.#now(), this.#ttlMs),
    }
    const bytes = encoder.encode(canonicalJsonV2(payload))
    return `${Buffer.from(bytes).toString('base64url')}.${this.#sign(bytes).toString('base64url')}`
  }

  decodeModelVersionDeployment(
    cursor: string,
    namespace: string,
    modelVersionId: string,
    lifecycle: string | null,
  ): Readonly<V2ModelVersionDeploymentCursorState> {
    try {
      const value = this.#decode(cursor)
      if (
        !isModelVersionDeploymentCursorPayload(value) ||
        value.scope !== this.#scope(namespace, 'model_version_deployments') ||
        value.model_version_id !== modelVersionId ||
        value.lifecycle !== lifecycle ||
        value.expires_at <= this.#now()
      ) {
        throw new Error('cursor scope is invalid')
      }
      return validateModelVersionDeploymentState(value)
    } catch {
      throw invalidCursor('Model Version Deployment')
    }
  }

  encodeModelDeploymentAdoption(
    namespace: string,
    stateInput: V2ModelDeploymentAdoptionCursorState,
  ): string {
    const state = validateModelDeploymentAdoptionState(stateInput)
    return this.#encode({
      v: CURSOR_VERSION,
      kind: 'model_deployment_adoptions',
      scope: this.#scope(namespace, 'model_deployment_adoptions'),
      ...state,
      expires_at: checkedAdd(this.#now(), this.#ttlMs),
    })
  }

  decodeModelDeploymentAdoption(
    cursor: string,
    namespace: string,
    modelVersionId: string,
  ): Readonly<V2ModelDeploymentAdoptionCursorState> {
    try {
      const value = this.#decode(cursor)
      if (
        !isModelDeploymentAdoptionCursorPayload(value) ||
        value.scope !== this.#scope(namespace, 'model_deployment_adoptions') ||
        value.model_version_id !== modelVersionId ||
        value.expires_at <= this.#now()
      ) {
        throw new Error('cursor scope is invalid')
      }
      return validateModelDeploymentAdoptionState(value)
    } catch {
      throw invalidCursor('Model Deployment adoption')
    }
  }

  encodeModelEvaluationDeployment(
    namespace: string,
    stateInput: V2ModelEvaluationDeploymentCursorState,
  ): string {
    const state = validateModelEvaluationDeploymentState(stateInput)
    return this.#encode({
      v: CURSOR_VERSION,
      kind: 'model_evaluation_deployments',
      scope: this.#scope(namespace, 'model_evaluation_deployments'),
      ...state,
      expires_at: checkedAdd(this.#now(), this.#ttlMs),
    })
  }

  decodeModelEvaluationDeployment(
    cursor: string,
    namespace: string,
    modelVersionId: string,
    workloadProfile: string,
    maxOutputTokens: number | null,
  ): Readonly<V2ModelEvaluationDeploymentCursorState> {
    try {
      const value = this.#decode(cursor)
      if (
        !isModelEvaluationDeploymentCursorPayload(value) ||
        value.scope !== this.#scope(namespace, 'model_evaluation_deployments') ||
        value.model_version_id !== modelVersionId ||
        value.workload_profile !== workloadProfile ||
        value.max_output_tokens !== maxOutputTokens ||
        value.expires_at <= this.#now()
      ) {
        throw new Error('cursor scope is invalid')
      }
      return validateModelEvaluationDeploymentState(value)
    } catch {
      throw invalidCursor('Model Evaluation Deployment')
    }
  }

  #decodeRef(cursor: string, namespace: string, kind: RefCursorKindV2): string {
    try {
      if (typeof cursor !== 'string' || cursor.length > V2_CURSOR_MAX_CHARS) {
        throw new Error('cursor text size is invalid')
      }
      const parts = cursor.split('.')
      if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error('malformed cursor')
      const bytes = decodeBase64Url(parts[0])
      if (bytes.byteLength === 0 || bytes.byteLength > CURSOR_MAX_BYTES) {
        throw new Error('cursor payload size is invalid')
      }
      const signature = decodeBase64Url(parts[1])
      const expected = this.#sign(bytes)
      if (signature.byteLength !== expected.byteLength || !timingSafeEqual(signature, expected)) {
        throw new Error('cursor signature is invalid')
      }
      const value = parseRawJsonV2(bytes, { maxBytes: CURSOR_MAX_BYTES, maxDepth: 4 })
      if (
        !isRefCursorPayload(value, kind) ||
        value.scope !== this.#scope(namespace, kind) ||
        value.expires_at <= this.#now()
      ) {
        throw new Error('cursor scope is invalid')
      }
      return RefNameV2Schema.parse(value.after)
    } catch {
      throw new ValidationError('Invalid or expired V2 refs cursor', {
        issues: [
          { path: '/cursor', line: null, code: 'invalid_cursor', message: 'Invalid cursor' },
        ],
      })
    }
  }

  encodeLineage(namespace: string, requestedRef: string, stateInput: V2LineageCursorState): string {
    const state = validateLineageState(stateInput)
    const payload: LineageCursorPayloadV2 = {
      v: CURSOR_VERSION,
      kind: 'lineage',
      scope: this.#scope(namespace, 'lineage'),
      requested_ref: requestedRef,
      ...state,
      expires_at: checkedAdd(this.#now(), this.#ttlMs),
    }
    const bytes = encoder.encode(canonicalJsonV2(payload))
    if (bytes.byteLength > LINEAGE_CURSOR_MAX_BYTES) {
      throw new ValidationError('V2 lineage continuation state is too large', {
        issues: [
          {
            path: '/cursor',
            line: null,
            code: 'cursor_capacity',
            message: 'Lineage cursor state exceeds its bounded capacity',
          },
        ],
      })
    }
    return `${Buffer.from(bytes).toString('base64url')}.${this.#sign(bytes).toString('base64url')}`
  }

  decodeLineage(
    cursor: string,
    namespace: string,
    requestedRef: string,
    maxDepth: number,
    maxNodes: number,
  ): Readonly<V2LineageCursorState> {
    try {
      if (typeof cursor !== 'string' || cursor.length > V2_LINEAGE_CURSOR_MAX_CHARS) {
        throw new Error('lineage cursor text size is invalid')
      }
      const parts = cursor.split('.')
      if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error('malformed cursor')
      const bytes = decodeBase64Url(parts[0])
      if (bytes.byteLength === 0 || bytes.byteLength > LINEAGE_CURSOR_MAX_BYTES) {
        throw new Error('lineage cursor payload size is invalid')
      }
      const signature = decodeBase64Url(parts[1])
      const expected = this.#sign(bytes)
      if (signature.byteLength !== expected.byteLength || !timingSafeEqual(signature, expected)) {
        throw new Error('lineage cursor signature is invalid')
      }
      const value = parseRawJsonV2(bytes, {
        maxBytes: LINEAGE_CURSOR_MAX_BYTES,
        maxDepth: 8,
      })
      if (
        !isLineageCursorPayload(value) ||
        value.scope !== this.#scope(namespace, 'lineage') ||
        value.requested_ref !== requestedRef ||
        value.max_depth !== maxDepth ||
        value.max_nodes !== maxNodes ||
        value.expires_at <= this.#now()
      ) {
        throw new Error('lineage cursor scope is invalid')
      }
      return validateLineageState(value)
    } catch {
      throw new ValidationError('Invalid or expired V2 lineage cursor', {
        issues: [
          { path: '/cursor', line: null, code: 'invalid_cursor', message: 'Invalid cursor' },
        ],
      })
    }
  }

  #sign(bytes: Uint8Array): Buffer {
    return createHmac('sha256', this.#key).update(bytes).digest()
  }

  #encode(value: object): string {
    const bytes = encoder.encode(canonicalJsonV2(value))
    return `${Buffer.from(bytes).toString('base64url')}.${this.#sign(bytes).toString('base64url')}`
  }

  #decode(cursor: string): unknown {
    if (typeof cursor !== 'string' || cursor.length > V2_CURSOR_MAX_CHARS) {
      throw new Error('cursor text size is invalid')
    }
    const parts = cursor.split('.')
    if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error('malformed cursor')
    const bytes = decodeBase64Url(parts[0])
    if (bytes.byteLength === 0 || bytes.byteLength > CURSOR_MAX_BYTES) {
      throw new Error('cursor payload size is invalid')
    }
    const signature = decodeBase64Url(parts[1])
    const expected = this.#sign(bytes)
    if (signature.byteLength !== expected.byteLength || !timingSafeEqual(signature, expected)) {
      throw new Error('cursor signature is invalid')
    }
    return parseRawJsonV2(bytes, { maxBytes: CURSOR_MAX_BYTES, maxDepth: 4 })
  }

  #scope(
    namespace: string,
    kind:
      | RefCursorKindV2
      | 'lineage'
      | 'transform_jobs'
      | 'evaluation_runs'
      | 'swift_studio_sessions'
      | 'models'
      | 'model_versions'
      | 'model_artifacts'
      | 'model_deployments'
      | 'model_version_deployments'
      | 'model_deployment_adoptions'
      | 'model_evaluation_deployments',
  ): string {
    return createHmac('sha256', this.#key)
      .update(canonicalJsonV2({ kind: `databench-v2-${kind}-cursor-scope`, namespace }))
      .digest('base64url')
  }
}

function decodeBase64Url(value: string): Buffer {
  if (!BASE64URL.test(value)) throw new Error('cursor base64url is invalid')
  const decoded = Buffer.from(value, 'base64url')
  if (decoded.toString('base64url') !== value) {
    throw new Error('cursor base64url is not canonical')
  }
  return decoded
}

function invalidCursor(kind: string): ValidationError {
  return new ValidationError(`Invalid or expired V2 ${kind} cursor`, {
    issues: [{ path: '/cursor', line: null, code: 'invalid_cursor', message: 'Invalid cursor' }],
  })
}

function isRefCursorPayload(value: unknown, kind: RefCursorKindV2): value is RefCursorPayloadV2 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    Object.keys(record).length === 5 &&
    record.v === CURSOR_VERSION &&
    record.kind === kind &&
    typeof record.scope === 'string' &&
    typeof record.after === 'string' &&
    typeof record.expires_at === 'number' &&
    Number.isSafeInteger(record.expires_at) &&
    record.expires_at >= 0
  )
}

function isLineageCursorPayload(value: unknown): value is LineageCursorPayloadV2 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    Object.keys(record).length === 11 &&
    record.v === CURSOR_VERSION &&
    record.kind === 'lineage' &&
    typeof record.scope === 'string' &&
    typeof record.requested_ref === 'string' &&
    typeof record.root_dataset_version === 'string' &&
    typeof record.snapshot_sequence === 'string' &&
    typeof record.max_depth === 'number' &&
    typeof record.max_nodes === 'number' &&
    typeof record.emitted_nodes === 'number' &&
    typeof record.emitted_edges === 'number' &&
    typeof record.expires_at === 'number' &&
    Number.isSafeInteger(record.expires_at) &&
    record.expires_at >= 0
  )
}

function isTransformJobCursorPayload(value: unknown): value is TransformJobCursorPayloadV2 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    Object.keys(record).length === 6 &&
    record.v === CURSOR_VERSION &&
    record.kind === 'transform_jobs' &&
    typeof record.scope === 'string' &&
    typeof record.created_at === 'string' &&
    typeof record.id === 'string' &&
    typeof record.expires_at === 'number' &&
    Number.isSafeInteger(record.expires_at) &&
    record.expires_at >= 0
  )
}

function isEvaluationRunCursorPayload(value: unknown): value is EvaluationRunCursorPayloadV2 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    Object.keys(record).length === 11 &&
    record.v === CURSOR_VERSION &&
    record.kind === 'evaluation_runs' &&
    typeof record.scope === 'string' &&
    typeof record.created_at === 'string' &&
    typeof record.id === 'string' &&
    (record.dataset_version === null || typeof record.dataset_version === 'string') &&
    (record.model_deployment_id === null || typeof record.model_deployment_id === 'string') &&
    (record.model_id === null || typeof record.model_id === 'string') &&
    (record.model_version_id === null || typeof record.model_version_id === 'string') &&
    (record.status === null || typeof record.status === 'string') &&
    typeof record.expires_at === 'number' &&
    Number.isSafeInteger(record.expires_at) &&
    record.expires_at >= 0
  )
}

function isSwiftStudioSessionCursorPayload(
  value: unknown,
): value is SwiftStudioSessionCursorPayloadV2 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    Object.keys(record).length === 8 &&
    record.v === CURSOR_VERSION &&
    record.kind === 'swift_studio_sessions' &&
    typeof record.scope === 'string' &&
    typeof record.created_at === 'string' &&
    typeof record.id === 'string' &&
    (record.dataset_version === null || typeof record.dataset_version === 'string') &&
    (record.status === null || typeof record.status === 'string') &&
    typeof record.expires_at === 'number' &&
    Number.isSafeInteger(record.expires_at) &&
    record.expires_at >= 0
  )
}

function isModelArtifactCursorPayload(value: unknown): value is ModelArtifactCursorPayloadV2 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    Object.keys(record).length === 9 &&
    record.v === CURSOR_VERSION &&
    record.kind === 'model_artifacts' &&
    typeof record.scope === 'string' &&
    typeof record.created_at === 'string' &&
    typeof record.id === 'string' &&
    (record.dataset_version === null || typeof record.dataset_version === 'string') &&
    (record.artifact_kind === null || typeof record.artifact_kind === 'string') &&
    typeof record.registration_status === 'string' &&
    typeof record.expires_at === 'number' &&
    Number.isSafeInteger(record.expires_at) &&
    record.expires_at >= 0
  )
}

function isModelCursorPayload(value: unknown): value is ModelCursorPayloadV2 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    Object.keys(record).length === 18 &&
    record.v === CURSOR_VERSION &&
    record.kind === 'models' &&
    typeof record.scope === 'string' &&
    typeof record.updated_at === 'string' &&
    typeof record.id === 'string' &&
    typeof record.search === 'string' &&
    typeof record.archive === 'string' &&
    (record.source_kind === null || typeof record.source_kind === 'string') &&
    (record.source_mutability === null || typeof record.source_mutability === 'string') &&
    (record.verification_level === null || typeof record.verification_level === 'string') &&
    (record.task_family === null || typeof record.task_family === 'string') &&
    (record.artifact_kind === null || typeof record.artifact_kind === 'string') &&
    (record.artifact_id === null || typeof record.artifact_id === 'string') &&
    (record.alias === null || typeof record.alias === 'string') &&
    (record.deployment_lifecycle === null || typeof record.deployment_lifecycle === 'string') &&
    (record.deployment_health === null || typeof record.deployment_health === 'string') &&
    (record.tag === null || typeof record.tag === 'string') &&
    typeof record.expires_at === 'number' &&
    Number.isSafeInteger(record.expires_at) &&
    record.expires_at >= 0
  )
}

function isModelVersionCursorPayload(value: unknown): value is ModelVersionCursorPayloadV2 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    Object.keys(record).length === 7 &&
    record.v === CURSOR_VERSION &&
    record.kind === 'model_versions' &&
    typeof record.scope === 'string' &&
    typeof record.created_at === 'string' &&
    typeof record.id === 'string' &&
    typeof record.model_id === 'string' &&
    typeof record.expires_at === 'number' &&
    Number.isSafeInteger(record.expires_at) &&
    record.expires_at >= 0
  )
}

function isModelDeploymentCursorPayload(value: unknown): value is ModelDeploymentCursorPayloadV2 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    Object.keys(record).length === 8 &&
    record.v === CURSOR_VERSION &&
    record.kind === 'model_deployments' &&
    typeof record.scope === 'string' &&
    typeof record.created_at === 'string' &&
    typeof record.id === 'string' &&
    (record.artifact_id === null || typeof record.artifact_id === 'string') &&
    (record.status === null || typeof record.status === 'string') &&
    typeof record.expires_at === 'number' &&
    Number.isSafeInteger(record.expires_at) &&
    record.expires_at >= 0
  )
}

function isModelVersionDeploymentCursorPayload(
  value: unknown,
): value is ModelVersionDeploymentCursorPayloadV2 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    Object.keys(record).length === 8 &&
    record.v === CURSOR_VERSION &&
    record.kind === 'model_version_deployments' &&
    typeof record.scope === 'string' &&
    typeof record.created_at === 'string' &&
    typeof record.id === 'string' &&
    typeof record.model_version_id === 'string' &&
    (record.lifecycle === null || typeof record.lifecycle === 'string') &&
    typeof record.expires_at === 'number' &&
    Number.isSafeInteger(record.expires_at) &&
    record.expires_at >= 0
  )
}

function isModelDeploymentAdoptionCursorPayload(
  value: unknown,
): value is ModelDeploymentAdoptionCursorPayloadV2 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    Object.keys(record).length === 7 &&
    record.v === CURSOR_VERSION &&
    record.kind === 'model_deployment_adoptions' &&
    typeof record.scope === 'string' &&
    typeof record.adopted_at === 'string' &&
    typeof record.deployment_id === 'string' &&
    typeof record.model_version_id === 'string' &&
    typeof record.expires_at === 'number' &&
    Number.isSafeInteger(record.expires_at) &&
    record.expires_at >= 0
  )
}

function isModelEvaluationDeploymentCursorPayload(
  value: unknown,
): value is ModelEvaluationDeploymentCursorPayloadV2 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    Object.keys(record).length === 9 &&
    record.v === CURSOR_VERSION &&
    record.kind === 'model_evaluation_deployments' &&
    typeof record.scope === 'string' &&
    typeof record.created_at === 'string' &&
    typeof record.id === 'string' &&
    typeof record.model_version_id === 'string' &&
    typeof record.workload_profile === 'string' &&
    (record.max_output_tokens === null || typeof record.max_output_tokens === 'number') &&
    typeof record.expires_at === 'number' &&
    Number.isSafeInteger(record.expires_at) &&
    record.expires_at >= 0
  )
}

function validateTransformJobState(
  input: V2TransformJobCursorState,
): Readonly<V2TransformJobCursorState> {
  const timestamp = new Date(input.created_at)
  if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== input.created_at) {
    throw new TypeError('V2 transform job cursor timestamp is invalid')
  }
  return Object.freeze({
    created_at: timestamp.toISOString(),
    id: TransformJobIdV2Schema.parse(input.id),
  })
}

function validateEvaluationRunState(
  input: V2EvaluationRunCursorState,
): Readonly<V2EvaluationRunCursorState> {
  const timestamp = new Date(input.created_at)
  if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== input.created_at) {
    throw new TypeError('V2 evaluation run cursor timestamp is invalid')
  }
  const datasetVersion =
    input.dataset_version === null
      ? null
      : DIGEST_HEX.test(input.dataset_version)
        ? input.dataset_version
        : null
  if (input.dataset_version !== null && datasetVersion === null) {
    throw new TypeError('V2 evaluation run cursor Dataset filter is invalid')
  }
  const status = input.status === null ? null : EvaluationRunStatusV2Schema.parse(input.status)
  const modelDeploymentId =
    input.model_deployment_id === null
      ? null
      : ModelDeploymentIdV2Schema.parse(input.model_deployment_id)
  const modelId = input.model_id === null ? null : ModelIdV2Schema.parse(input.model_id)
  const modelVersionId =
    input.model_version_id === null ? null : ModelVersionIdV2Schema.parse(input.model_version_id)
  return Object.freeze({
    created_at: timestamp.toISOString(),
    id: EvaluationRunIdV2Schema.parse(input.id),
    dataset_version: datasetVersion,
    model_deployment_id: modelDeploymentId,
    model_id: modelId,
    model_version_id: modelVersionId,
    status,
  })
}

function validateSwiftStudioSessionState(
  input: V2SwiftStudioSessionCursorState,
): Readonly<V2SwiftStudioSessionCursorState> {
  const timestamp = new Date(input.created_at)
  if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== input.created_at) {
    throw new TypeError('V2 Swift Studio Session cursor timestamp is invalid')
  }
  const datasetVersion =
    input.dataset_version === null
      ? null
      : DIGEST_HEX.test(input.dataset_version)
        ? input.dataset_version
        : null
  if (input.dataset_version !== null && datasetVersion === null) {
    throw new TypeError('V2 Swift Studio Session cursor Dataset filter is invalid')
  }
  const status = input.status === null ? null : SwiftStudioSessionStatusV2Schema.parse(input.status)
  return Object.freeze({
    created_at: timestamp.toISOString(),
    id: SwiftStudioSessionIdV2Schema.parse(input.id),
    dataset_version: datasetVersion,
    status,
  })
}

function validateModelArtifactState(
  input: V2ModelArtifactCursorState,
): Readonly<V2ModelArtifactCursorState> {
  const timestamp = new Date(input.created_at)
  if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== input.created_at) {
    throw new TypeError('V2 Model Artifact cursor timestamp is invalid')
  }
  const datasetVersion =
    input.dataset_version === null
      ? null
      : DIGEST_HEX.test(input.dataset_version)
        ? input.dataset_version
        : null
  if (input.dataset_version !== null && datasetVersion === null) {
    throw new TypeError('V2 Model Artifact cursor Dataset filter is invalid')
  }
  const artifactKind =
    input.artifact_kind === null ? null : ModelArtifactKindV2Schema.parse(input.artifact_kind)
  const registrationStatus = ['all', 'registered', 'unregistered'].includes(
    input.registration_status,
  )
    ? input.registration_status
    : null
  if (registrationStatus === null) {
    throw new TypeError('V2 Model Artifact cursor registration filter is invalid')
  }
  return Object.freeze({
    created_at: timestamp.toISOString(),
    id: ModelArtifactIdV2Schema.parse(input.id),
    dataset_version: datasetVersion,
    artifact_kind: artifactKind,
    registration_status: registrationStatus,
  })
}

function validateModelState(input: V2ModelCursorState): Readonly<V2ModelCursorState> {
  const timestamp = new Date(input.updated_at)
  if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== input.updated_at) {
    throw new TypeError('V2 Model cursor timestamp is invalid')
  }
  if (new TextEncoder().encode(input.search).byteLength > 256) {
    throw new TypeError('V2 Model cursor search is invalid')
  }
  return Object.freeze({
    updated_at: timestamp.toISOString(),
    id: ModelIdV2Schema.parse(input.id),
    search: input.search,
    archive: ModelArchiveFilterV2Schema.parse(input.archive),
    source_kind:
      input.source_kind === null ? null : ModelSourceKindV2Schema.parse(input.source_kind),
    source_mutability:
      input.source_mutability === null
        ? null
        : ModelSourceMutabilityV2Schema.parse(input.source_mutability),
    verification_level:
      input.verification_level === null
        ? null
        : ModelVerificationLevelV2Schema.parse(input.verification_level),
    task_family:
      input.task_family === null ? null : ModelTaskFamilyV2Schema.parse(input.task_family),
    artifact_kind:
      input.artifact_kind === null ? null : ModelArtifactKindV2Schema.parse(input.artifact_kind),
    artifact_id:
      input.artifact_id === null ? null : ModelArtifactIdV2Schema.parse(input.artifact_id),
    alias: input.alias === null ? null : ModelAliasFilterV2Schema.parse(input.alias),
    deployment_lifecycle:
      input.deployment_lifecycle === null
        ? null
        : ModelVersionDeploymentLifecycleV2Schema.parse(input.deployment_lifecycle),
    deployment_health:
      input.deployment_health === null
        ? null
        : ModelDeploymentHealthFilterV2Schema.parse(input.deployment_health),
    tag: input.tag === null ? null : ModelTagV2Schema.parse(input.tag),
  })
}

function sameModelCursorFilters(
  left: V2ModelCursorFilterState,
  right: V2ModelCursorFilterState,
): boolean {
  return (
    left.search === right.search &&
    left.archive === right.archive &&
    left.source_kind === right.source_kind &&
    left.source_mutability === right.source_mutability &&
    left.verification_level === right.verification_level &&
    left.task_family === right.task_family &&
    left.artifact_kind === right.artifact_kind &&
    left.artifact_id === right.artifact_id &&
    left.alias === right.alias &&
    left.deployment_lifecycle === right.deployment_lifecycle &&
    left.deployment_health === right.deployment_health &&
    left.tag === right.tag
  )
}

function validateModelVersionState(
  input: V2ModelVersionCursorState,
): Readonly<V2ModelVersionCursorState> {
  const timestamp = new Date(input.created_at)
  if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== input.created_at) {
    throw new TypeError('V2 Model Version cursor timestamp is invalid')
  }
  return Object.freeze({
    created_at: timestamp.toISOString(),
    id: ModelVersionIdV2Schema.parse(input.id),
    model_id: ModelIdV2Schema.parse(input.model_id),
  })
}

function validateModelDeploymentState(
  input: V2ModelDeploymentCursorState,
): Readonly<V2ModelDeploymentCursorState> {
  const timestamp = new Date(input.created_at)
  if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== input.created_at) {
    throw new TypeError('V2 Model Deployment cursor timestamp is invalid')
  }
  return Object.freeze({
    created_at: timestamp.toISOString(),
    id: ModelDeploymentIdV2Schema.parse(input.id),
    artifact_id:
      input.artifact_id === null ? null : ModelArtifactIdV2Schema.parse(input.artifact_id),
    status: input.status === null ? null : ModelDeploymentStatusV2Schema.parse(input.status),
  })
}

function validateModelVersionDeploymentState(
  input: V2ModelVersionDeploymentCursorState,
): Readonly<V2ModelVersionDeploymentCursorState> {
  const timestamp = new Date(input.created_at)
  if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== input.created_at) {
    throw new TypeError('V2 Model Version Deployment cursor timestamp is invalid')
  }
  return Object.freeze({
    created_at: timestamp.toISOString(),
    id: ModelDeploymentIdV2Schema.parse(input.id),
    model_version_id: ModelVersionIdV2Schema.parse(input.model_version_id),
    lifecycle:
      input.lifecycle === null
        ? null
        : ModelVersionDeploymentLifecycleV2Schema.parse(input.lifecycle),
  })
}

function validateModelDeploymentAdoptionState(
  input: V2ModelDeploymentAdoptionCursorState,
): Readonly<V2ModelDeploymentAdoptionCursorState> {
  const timestamp = new Date(input.adopted_at)
  if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== input.adopted_at) {
    throw new TypeError('V2 Model Deployment adoption cursor timestamp is invalid')
  }
  return Object.freeze({
    adopted_at: timestamp.toISOString(),
    deployment_id: ModelDeploymentIdV2Schema.parse(input.deployment_id),
    model_version_id: ModelVersionIdV2Schema.parse(input.model_version_id),
  })
}

function validateModelEvaluationDeploymentState(
  input: V2ModelEvaluationDeploymentCursorState,
): Readonly<V2ModelEvaluationDeploymentCursorState> {
  const timestamp = new Date(input.created_at)
  if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== input.created_at) {
    throw new TypeError('V2 Model Evaluation Deployment cursor timestamp is invalid')
  }
  const maxOutputTokens = input.max_output_tokens
  if (
    maxOutputTokens !== null &&
    (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 1_000_000)
  ) {
    throw new TypeError('V2 Model Evaluation Deployment cursor output budget is invalid')
  }
  return Object.freeze({
    created_at: timestamp.toISOString(),
    id: ModelDeploymentIdV2Schema.parse(input.id),
    model_version_id: ModelVersionIdV2Schema.parse(input.model_version_id),
    workload_profile: ModelEvaluationWorkloadProfileV2Schema.parse(input.workload_profile),
    max_output_tokens: maxOutputTokens,
  })
}

function validateLineageState(input: V2LineageCursorState): Readonly<V2LineageCursorState> {
  if (
    typeof input !== 'object' ||
    input === null ||
    !DIGEST_HEX.test(input.root_dataset_version) ||
    !NON_NEGATIVE_BIGINT_DECIMAL.test(input.snapshot_sequence) ||
    BigInt(input.snapshot_sequence) > POSTGRES_BIGINT_MAX ||
    !Number.isSafeInteger(input.max_depth) ||
    input.max_depth < 0 ||
    input.max_depth > V2_LINEAGE_MAX_DEPTH ||
    !Number.isSafeInteger(input.max_nodes) ||
    input.max_nodes <= 0 ||
    input.max_nodes > V2_LINEAGE_MAX_NODES ||
    !Number.isSafeInteger(input.emitted_nodes) ||
    input.emitted_nodes < 0 ||
    input.emitted_nodes > V2_LINEAGE_MAX_NODES ||
    !Number.isSafeInteger(input.emitted_edges) ||
    input.emitted_edges < 0 ||
    input.emitted_edges > V2_LINEAGE_MAX_NODES
  ) {
    throw new TypeError('V2 lineage cursor state is invalid')
  }
  return Object.freeze({
    root_dataset_version: input.root_dataset_version,
    snapshot_sequence: input.snapshot_sequence,
    max_depth: input.max_depth,
    max_nodes: input.max_nodes,
    emitted_nodes: input.emitted_nodes,
    emitted_edges: input.emitted_edges,
  })
}

function positiveSafeInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`)
  }
  return value
}

function checkedAdd(left: number, right: number): number {
  if (!Number.isSafeInteger(left) || left < 0 || right > Number.MAX_SAFE_INTEGER - left) {
    throw new TypeError('V2 cursor expiry exceeds the safe integer range')
  }
  return left + right
}
