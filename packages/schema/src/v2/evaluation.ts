import { z } from 'zod'
import { ConflictError } from '../errors.js'
import { DigestHexSchema, Rfc3339UtcSchema } from './common.js'
import {
  EvaluationRunStateConflictDetailV2Schema,
  OpaqueCursorQueryV2Schema,
  RefNameV2Schema,
} from './contracts.js'
import { ConverterNameV2Schema, ConverterVersionV2Schema } from './converter.js'
import { JsonObjectSchema } from './json-value.js'
import { ModelArtifactIdV2Schema } from './model-artifact.js'
import { ModelDeploymentIdV2Schema } from './model-deployment.js'

export const V2_EVALUATION_RUN_PAGE_DEFAULT_LIMIT = 20
export const V2_EVALUATION_RUN_PAGE_MAX_LIMIT = 100
export const V2_EVALUATION_METRICS_MAX_ITEMS = 10_000
export const V2_EVALUATION_PROVIDER_REPORT_IDS_MAX_ITEMS = 32

const SAFE_TOKEN = /^[a-z][a-z0-9._-]{0,127}$/
const PROVIDER_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/
const PROVIDER_REPORT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,511}$/
const GIT_COMMIT = /^[0-9a-f]{40}$/
const CREDENTIAL_VALUE =
  /(?:\bsk-(?:proj-)?[A-Za-z0-9_-]{8,}\b)|(?:\b(?:authorization|x-api-key|api[_-]?key|token)\s*[:=]\s*\S+)/i
const encoder = new TextEncoder()

function utf8BoundedString(maxBytes: number, allowEmpty = false) {
  const minimum = allowEmpty ? 0 : 1
  return z
    .string()
    .min(minimum)
    .max(maxBytes)
    .refine((value) => encoder.encode(value).byteLength <= maxBytes, {
      message: `Expected at most ${maxBytes} UTF-8 bytes`,
    })
    .refine(
      (value) => {
        for (let index = 0; index < value.length; index += 1) {
          const codeUnit = value.charCodeAt(index)
          if (codeUnit <= 0x1f || codeUnit === 0x7f) return false
        }
        return true
      },
      { message: 'Control characters are not allowed' },
    )
    .refine((value) => !CREDENTIAL_VALUE.test(value), {
      message: 'Credential-like values are not allowed',
    })
}

export const EvaluationProviderV2Schema = z.literal('evalscope')
export type EvaluationProviderV2 = z.infer<typeof EvaluationProviderV2Schema>

export const EvaluationRunIdV2Schema = z.uuid()

export const EvaluationProviderTaskIdV2Schema = z
  .string()
  .regex(PROVIDER_TASK_ID)
  .refine((value) => encoder.encode(value).byteLength <= 256, {
    message: 'Provider task ID must not exceed 256 UTF-8 bytes',
  })

export const EvaluationRunStatusV2Schema = z.enum([
  'prepared',
  'running',
  'completed',
  'failed',
  'cancelled',
])
export type EvaluationRunStatusV2 = z.infer<typeof EvaluationRunStatusV2Schema>

export const EvaluationRunCreateProfileV2Schema = z.enum([
  'evaluation-run-create-v1',
  'evaluation-run-create-v2',
])
export type EvaluationRunCreateProfileV2 = z.infer<typeof EvaluationRunCreateProfileV2Schema>

export const EvaluationArchiveStatusV2Schema = z.enum([
  'not_requested',
  'pending',
  'uploading',
  'available',
  'failed',
])
export type EvaluationArchiveStatusV2 = z.infer<typeof EvaluationArchiveStatusV2Schema>

const MetricLabelV2Schema = utf8BoundedString(512)
const MetricCategoryV2Schema = utf8BoundedString(128)

export const EvaluationMetricV2Schema = z
  .strictObject({
    dataset: MetricLabelV2Schema,
    subset: MetricLabelV2Schema.nullable(),
    metric: MetricLabelV2Schema,
    score: z.number().finite().nullable(),
    sample_count: z.number().int().safe().nonnegative().nullable(),
    categories: z.array(MetricCategoryV2Schema).max(64),
  })
  .superRefine((metric, context) => {
    if (new Set(metric.categories).size !== metric.categories.length) {
      context.addIssue({
        code: 'custom',
        path: ['categories'],
        message: 'Metric categories must be unique',
      })
    }
  })
  .meta({ id: 'EvaluationMetricV2' })
export type EvaluationMetricV2 = z.infer<typeof EvaluationMetricV2Schema>

export const EvaluationMetricsV2Schema = z
  .array(EvaluationMetricV2Schema)
  .max(V2_EVALUATION_METRICS_MAX_ITEMS)

export const EvaluationRunErrorV2Schema = z
  .strictObject({
    phase: z.string().regex(SAFE_TOKEN),
    code: z.string().regex(SAFE_TOKEN),
    message: utf8BoundedString(2_048),
  })
  .meta({ id: 'EvaluationRunErrorV2' })
export type EvaluationRunErrorV2 = z.infer<typeof EvaluationRunErrorV2Schema>

export const EvaluationProviderReportIdV2Schema = z
  .string()
  .regex(PROVIDER_REPORT_ID)
  .refine((value) => encoder.encode(value).byteLength <= 512, {
    message: 'Provider report ID must not exceed 512 UTF-8 bytes',
  })
  .refine((value) => !CREDENTIAL_VALUE.test(value), {
    message: 'Provider report IDs cannot contain credential-like values',
  })

export const EvaluationProviderReportIdsV2Schema = z
  .array(EvaluationProviderReportIdV2Schema)
  .max(V2_EVALUATION_PROVIDER_REPORT_IDS_MAX_ITEMS)
  .superRefine((ids, context) => {
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: 'custom', message: 'Provider report IDs must be unique' })
    }
  })

export const CreateEvaluationRunRequestV2Schema = z
  .strictObject({
    provider: EvaluationProviderV2Schema,
    provider_task_id: EvaluationProviderTaskIdV2Schema,
    dataset_version: DigestHexSchema,
    source_ref: RefNameV2Schema.nullable(),
    converter: ConverterNameV2Schema,
    converter_options: JsonObjectSchema,
    accepted_fidelity_digest: DigestHexSchema,
    model_name: utf8BoundedString(512).nullable(),
    model_deployment_id: ModelDeploymentIdV2Schema.nullable().default(null),
    evalscope_commit: z.string().regex(GIT_COMMIT).nullable(),
  })
  .superRefine((request, context) => {
    if (request.model_deployment_id !== null && request.model_name !== null) {
      context.addIssue({
        code: 'custom',
        path: ['model_name'],
        message: 'Deployment-bound runs derive model_name from the registered Deployment',
      })
    }
  })
  .meta({ id: 'CreateEvaluationRunRequestV2' })
export type CreateEvaluationRunRequestV2 = z.infer<typeof CreateEvaluationRunRequestV2Schema>

export const EvaluationRunParamsV2Schema = z
  .strictObject({ run_id: EvaluationRunIdV2Schema })
  .meta({ id: 'EvaluationRunParamsV2' })

export const EvaluationRunPageRequestV2Schema = z
  .strictObject({
    dataset_version: DigestHexSchema.optional(),
    model_deployment_id: ModelDeploymentIdV2Schema.optional(),
    status: EvaluationRunStatusV2Schema.optional(),
    cursor: OpaqueCursorQueryV2Schema,
    limit: z.coerce
      .number()
      .int()
      .safe()
      .min(1)
      .max(V2_EVALUATION_RUN_PAGE_MAX_LIMIT)
      .default(V2_EVALUATION_RUN_PAGE_DEFAULT_LIMIT),
  })
  .meta({ id: 'EvaluationRunPageRequestV2' })
export type EvaluationRunPageRequestV2 = z.infer<typeof EvaluationRunPageRequestV2Schema>

export const StartEvaluationRunRequestV2Schema = z
  .strictObject({})
  .meta({ id: 'StartEvaluationRunRequestV2' })

export const CompleteEvaluationRunRequestV2Schema = z
  .strictObject({
    metrics: EvaluationMetricsV2Schema,
    provider_report_ids: EvaluationProviderReportIdsV2Schema,
  })
  .meta({ id: 'CompleteEvaluationRunRequestV2' })
export type CompleteEvaluationRunRequestV2 = z.infer<typeof CompleteEvaluationRunRequestV2Schema>

export const FailEvaluationRunRequestV2Schema = z
  .strictObject({ error: EvaluationRunErrorV2Schema })
  .meta({ id: 'FailEvaluationRunRequestV2' })
export type FailEvaluationRunRequestV2 = z.infer<typeof FailEvaluationRunRequestV2Schema>

export const CancelEvaluationRunRequestV2Schema = z
  .strictObject({ error: EvaluationRunErrorV2Schema })
  .meta({ id: 'CancelEvaluationRunRequestV2' })
export type CancelEvaluationRunRequestV2 = z.infer<typeof CancelEvaluationRunRequestV2Schema>

export const EvaluationRunV2Schema = z
  .strictObject({
    id: EvaluationRunIdV2Schema,
    provider: EvaluationProviderV2Schema,
    provider_task_id: EvaluationProviderTaskIdV2Schema,
    create_profile: EvaluationRunCreateProfileV2Schema,
    create_request_digest: DigestHexSchema,
    provider_report_ids: EvaluationProviderReportIdsV2Schema.nullable(),
    dataset_version: DigestHexSchema,
    source_ref: RefNameV2Schema.nullable(),
    converter: ConverterNameV2Schema,
    converter_version: ConverterVersionV2Schema,
    converter_options: JsonObjectSchema,
    fidelity_digest: DigestHexSchema,
    benchmark: z.string().regex(SAFE_TOKEN),
    model_name: utf8BoundedString(512).nullable(),
    model_deployment_id: ModelDeploymentIdV2Schema.nullable(),
    model_artifact_id: ModelArtifactIdV2Schema.nullable(),
    evalscope_commit: z.string().regex(GIT_COMMIT).nullable(),
    status: EvaluationRunStatusV2Schema,
    metrics: EvaluationMetricsV2Schema.nullable(),
    error: EvaluationRunErrorV2Schema.nullable(),
    archive_status: EvaluationArchiveStatusV2Schema,
    archive_attempt: z.number().int().safe().nonnegative(),
    result_artifact_key: utf8BoundedString(2_048).nullable(),
    result_artifact_digest: DigestHexSchema.nullable(),
    result_artifact_size_bytes: z.number().int().safe().nonnegative().nullable(),
    archive_error: EvaluationRunErrorV2Schema.nullable(),
    created_at: Rfc3339UtcSchema,
    started_at: Rfc3339UtcSchema.nullable(),
    finished_at: Rfc3339UtcSchema.nullable(),
    updated_at: Rfc3339UtcSchema,
  })
  .superRefine((run, context) => {
    const hasDeployment = run.model_deployment_id !== null
    if (hasDeployment !== (run.model_artifact_id !== null)) {
      context.addIssue({
        code: 'custom',
        path: ['model_artifact_id'],
        message: 'Deployment-bound runs require both Deployment and Artifact IDs',
      })
    }
    if ((run.create_profile === 'evaluation-run-create-v2') !== hasDeployment) {
      context.addIssue({
        code: 'custom',
        path: ['create_profile'],
        message: 'Only evaluation-run-create-v2 can bind a Model Deployment',
      })
    }
    const terminal =
      run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled'
    if (terminal !== (run.finished_at !== null)) {
      context.addIssue({
        code: 'custom',
        path: ['finished_at'],
        message: 'Terminal evaluation runs must have finished_at',
      })
    }
    if ((run.status === 'running' || run.status === 'completed') && run.started_at === null) {
      context.addIssue({
        code: 'custom',
        path: ['started_at'],
        message: 'Running and completed evaluation runs must have started_at',
      })
    }
    if ((run.status === 'completed') !== (run.metrics !== null)) {
      context.addIssue({
        code: 'custom',
        path: ['metrics'],
        message: 'Only completed evaluation runs expose metrics',
      })
    }
    if ((run.status === 'completed') !== (run.provider_report_ids !== null)) {
      context.addIssue({
        code: 'custom',
        path: ['provider_report_ids'],
        message: 'Only completed evaluation runs expose provider report IDs',
      })
    }
    const hasExecutionError = run.status === 'failed' || run.status === 'cancelled'
    if (hasExecutionError !== (run.error !== null)) {
      context.addIssue({
        code: 'custom',
        path: ['error'],
        message: 'Failed and cancelled evaluation runs must expose an error summary',
      })
    }
    const artifactFields = [
      run.result_artifact_key,
      run.result_artifact_digest,
      run.result_artifact_size_bytes,
    ]
    const artifactCount = artifactFields.filter((value) => value !== null).length
    if (artifactCount !== 0 && artifactCount !== artifactFields.length) {
      context.addIssue({
        code: 'custom',
        path: ['result_artifact_key'],
        message: 'Result artifact fields must be all null or all present',
      })
    }
    if ((run.archive_status === 'available') !== (artifactCount === artifactFields.length)) {
      context.addIssue({
        code: 'custom',
        path: ['archive_status'],
        message: 'Available archives must identify a complete result artifact',
      })
    }
    if ((run.archive_status === 'failed') !== (run.archive_error !== null)) {
      context.addIssue({
        code: 'custom',
        path: ['archive_error'],
        message: 'Only failed archives expose an archive error',
      })
    }
  })
  .meta({ id: 'EvaluationRunV2' })
export type EvaluationRunV2 = z.infer<typeof EvaluationRunV2Schema>

export const EvaluationRunPageV2Schema = z
  .strictObject({
    items: z.array(EvaluationRunV2Schema).max(V2_EVALUATION_RUN_PAGE_MAX_LIMIT),
    next_cursor: z.string().min(1).max(1_536).nullable(),
  })
  .meta({ id: 'EvaluationRunPageV2' })
export type EvaluationRunPageV2 = z.infer<typeof EvaluationRunPageV2Schema>

export class EvaluationRunStateConflictErrorV2 extends ConflictError {
  override readonly name = 'EvaluationRunStateConflictErrorV2'
  override readonly code = 'evaluation_run_state_conflict'

  constructor(detailInput: z.input<typeof EvaluationRunStateConflictDetailV2Schema>) {
    const detail = Object.freeze(EvaluationRunStateConflictDetailV2Schema.parse(detailInput))
    super(`V2 evaluation run state conflict for ${detail.run_id}`, detail)
  }
}
