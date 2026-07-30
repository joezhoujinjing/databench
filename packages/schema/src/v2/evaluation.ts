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
export const V2_EVALUATION_ARCHIVE_DEFAULT_MAX_BYTES = 1024 * 1024 * 1024
export const V2_EVALUATION_ARCHIVE_DEFAULT_SIGNED_URL_TTL_MS = 15 * 60 * 1000
export const V2_EVALUATION_ARCHIVE_MEDIA_TYPE = 'application/zstd'

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
  'evaluation-run-create-v3',
  'evaluation-run-create-v4',
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
const MetricIdentityV2Schema = z.string().regex(SAFE_TOKEN)
const MetricOutputKeyV2Schema = utf8BoundedString(128)
const MetricParameterValueV2Schema = z.union([
  z.boolean(),
  z.number().finite(),
  utf8BoundedString(512, true),
])

export const EvaluationScoringMetricV2Schema = z
  .strictObject({
    id: MetricIdentityV2Schema,
    implementation_digest: DigestHexSchema,
    parameters: z.record(MetricIdentityV2Schema, MetricParameterValueV2Schema),
    output_keys: z.array(MetricOutputKeyV2Schema).min(1).max(32),
  })
  .superRefine((metric, context) => {
    if (new Set(metric.output_keys).size !== metric.output_keys.length) {
      context.addIssue({
        code: 'custom',
        path: ['output_keys'],
        message: 'Metric output keys must be unique',
      })
    }
    if (Object.keys(metric.parameters).length > 32) {
      context.addIssue({
        code: 'custom',
        path: ['parameters'],
        message: 'Metric parameters exceed the field bound',
      })
    }
  })
  .meta({ id: 'EvaluationScoringMetricV2' })
export type EvaluationScoringMetricV2 = z.infer<typeof EvaluationScoringMetricV2Schema>

export const EvaluationScoringConfigV2Schema = z
  .strictObject({
    schema_version: z.literal(1),
    mode: z.literal('explicit'),
    evalscope_commit: z.string().regex(GIT_COMMIT),
    benchmark: z.string().regex(SAFE_TOKEN),
    metrics: z.array(EvaluationScoringMetricV2Schema).min(1).max(16),
    primary_metric_id: MetricIdentityV2Schema,
    primary_output_key: MetricOutputKeyV2Schema,
  })
  .superRefine((config, context) => {
    const metricIds = config.metrics.map((metric) => metric.id)
    if (
      new Set(metricIds).size !== metricIds.length ||
      metricIds.some((metricId, index) => index > 0 && metricId <= (metricIds[index - 1] ?? ''))
    ) {
      context.addIssue({
        code: 'custom',
        path: ['metrics'],
        message: 'Scoring Metrics must be unique and sorted by canonical ID',
      })
    }
    const outputOwners = new Map<string, string>()
    for (const metric of config.metrics) {
      for (const outputKey of metric.output_keys) {
        if (outputOwners.has(outputKey)) {
          context.addIssue({
            code: 'custom',
            path: ['metrics'],
            message: 'Scoring Metric output keys must not overlap',
          })
        }
        outputOwners.set(outputKey, metric.id)
      }
    }
    if (!metricIds.includes(config.primary_metric_id)) {
      context.addIssue({
        code: 'custom',
        path: ['primary_metric_id'],
        message: 'Primary Metric must be selected',
      })
    }
    if (outputOwners.get(config.primary_output_key) !== config.primary_metric_id) {
      context.addIssue({
        code: 'custom',
        path: ['primary_output_key'],
        message: 'Primary output must belong to the primary Metric',
      })
    }
  })
  .meta({ id: 'EvaluationScoringConfigV2' })
export type EvaluationScoringConfigV2 = z.infer<typeof EvaluationScoringConfigV2Schema>

export const EvaluationMetricV2Schema = z
  .strictObject({
    dataset: MetricLabelV2Schema,
    subset: MetricLabelV2Schema.nullable(),
    metric_id: MetricIdentityV2Schema.nullable().default(null),
    output_key: MetricOutputKeyV2Schema.nullable().default(null),
    metric: MetricLabelV2Schema,
    score: z.number().finite().nullable(),
    sample_count: z.number().int().safe().nonnegative().nullable(),
    categories: z.array(MetricCategoryV2Schema).max(64),
  })
  .superRefine((metric, context) => {
    if ((metric.metric_id === null) !== (metric.output_key === null)) {
      context.addIssue({
        code: 'custom',
        path: ['metric_id'],
        message: 'Metric ID and output key must be both null or both present',
      })
    }
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
    scoring_config: EvaluationScoringConfigV2Schema.nullable().default(null),
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
    scoring_config: EvaluationScoringConfigV2Schema.nullable().default(null),
    primary_metric_id: MetricIdentityV2Schema.nullable().default(null),
    primary_output_key: MetricOutputKeyV2Schema.nullable().default(null),
  })
  .superRefine((request, context) => {
    const scoringFields = [
      request.scoring_config,
      request.primary_metric_id,
      request.primary_output_key,
    ]
    const present = scoringFields.filter((value) => value !== null).length
    if (present !== 0 && present !== scoringFields.length) {
      context.addIssue({
        code: 'custom',
        path: ['scoring_config'],
        message: 'Scoring completion fields must be all null or all present',
      })
      return
    }
    if (
      request.scoring_config !== null &&
      (request.primary_metric_id !== request.scoring_config.primary_metric_id ||
        request.primary_output_key !== request.scoring_config.primary_output_key)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['primary_metric_id'],
        message: 'Completion primary Metric must match the scoring config',
      })
    }
    if (request.scoring_config !== null) {
      const expectedOutputs = new Map<string, string>()
      for (const metric of request.scoring_config.metrics) {
        for (const outputKey of metric.output_keys) {
          expectedOutputs.set(outputKey, metric.id)
        }
      }
      const observedOutputs = new Map<string, number[]>()
      for (const metric of request.metrics) {
        if (
          metric.metric_id === null ||
          metric.output_key === null ||
          expectedOutputs.get(metric.output_key) !== metric.metric_id
        ) {
          context.addIssue({
            code: 'custom',
            path: ['metrics'],
            message: 'Completed Metric output does not match the scoring config',
          })
          continue
        }
        if (metric.score !== null) {
          const scores = observedOutputs.get(metric.output_key) ?? []
          scores.push(metric.score)
          observedOutputs.set(metric.output_key, scores)
        }
      }
      for (const outputKey of expectedOutputs.keys()) {
        if ((observedOutputs.get(outputKey)?.length ?? 0) === 0) {
          context.addIssue({
            code: 'custom',
            path: ['metrics'],
            message: `Requested Metric output is missing: ${outputKey}`,
          })
        }
      }
    }
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

export const PrepareEvaluationResultUploadRequestV2Schema = z
  .strictObject({})
  .meta({ id: 'PrepareEvaluationResultUploadRequestV2' })

export const EvaluationResultUploadDescriptorV2Schema = z
  .strictObject({
    method: z.literal('PUT'),
    url: z.string().url().max(8_192),
    expires_at: Rfc3339UtcSchema,
    content_type: z.literal(V2_EVALUATION_ARCHIVE_MEDIA_TYPE),
    required_headers: z.strictObject({
      'content-type': z.literal(V2_EVALUATION_ARCHIVE_MEDIA_TYPE),
      'if-none-match': z.literal('*'),
    }),
    max_size_bytes: z.number().int().safe().positive().max(V2_EVALUATION_ARCHIVE_DEFAULT_MAX_BYTES),
  })
  .meta({ id: 'EvaluationResultUploadDescriptorV2' })
export type EvaluationResultUploadDescriptorV2 = z.infer<
  typeof EvaluationResultUploadDescriptorV2Schema
>

export const PrepareEvaluationResultUploadResponseV2Schema = z
  .strictObject({
    run_id: EvaluationRunIdV2Schema,
    archive_status: z.enum(['uploading', 'available']),
    archive_attempt: z.number().int().safe().positive(),
    upload: EvaluationResultUploadDescriptorV2Schema.nullable(),
  })
  .superRefine((response, context) => {
    if ((response.archive_status === 'uploading') !== (response.upload !== null)) {
      context.addIssue({
        code: 'custom',
        path: ['upload'],
        message: 'Only uploading archives expose a signed upload descriptor',
      })
    }
  })
  .meta({ id: 'PrepareEvaluationResultUploadResponseV2' })
export type PrepareEvaluationResultUploadResponseV2 = z.infer<
  typeof PrepareEvaluationResultUploadResponseV2Schema
>

export const FinalizeEvaluationResultUploadRequestV2Schema = z
  .strictObject({
    archive_attempt: z.number().int().safe().positive(),
    digest: DigestHexSchema,
    size_bytes: z.number().int().safe().positive().max(V2_EVALUATION_ARCHIVE_DEFAULT_MAX_BYTES),
  })
  .meta({ id: 'FinalizeEvaluationResultUploadRequestV2' })
export type FinalizeEvaluationResultUploadRequestV2 = z.infer<
  typeof FinalizeEvaluationResultUploadRequestV2Schema
>

export const FailEvaluationResultUploadRequestV2Schema = z
  .strictObject({
    archive_attempt: z.number().int().safe().positive(),
    error: EvaluationRunErrorV2Schema,
  })
  .meta({ id: 'FailEvaluationResultUploadRequestV2' })
export type FailEvaluationResultUploadRequestV2 = z.infer<
  typeof FailEvaluationResultUploadRequestV2Schema
>

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
    scoring_config: EvaluationScoringConfigV2Schema.nullable(),
    primary_metric_id: MetricIdentityV2Schema.nullable(),
    primary_output_key: MetricOutputKeyV2Schema.nullable(),
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
    const deploymentProfile =
      run.create_profile === 'evaluation-run-create-v2' ||
      run.create_profile === 'evaluation-run-create-v4'
    if (deploymentProfile !== hasDeployment) {
      context.addIssue({
        code: 'custom',
        path: ['create_profile'],
        message: 'Only Deployment evaluation profiles can bind a Model Deployment',
      })
    }
    const metricProfile =
      run.create_profile === 'evaluation-run-create-v3' ||
      run.create_profile === 'evaluation-run-create-v4'
    const scoringFields = [run.scoring_config, run.primary_metric_id, run.primary_output_key]
    const hasScoringConfig = scoringFields.every((value) => value !== null)
    if (
      hasScoringConfig !== scoringFields.some((value) => value !== null) ||
      metricProfile !== hasScoringConfig
    ) {
      context.addIssue({
        code: 'custom',
        path: ['scoring_config'],
        message: 'Metric-aware profiles require a complete scoring identity',
      })
    }
    if (
      run.scoring_config !== null &&
      (run.primary_metric_id !== run.scoring_config.primary_metric_id ||
        run.primary_output_key !== run.scoring_config.primary_output_key ||
        run.benchmark !== run.scoring_config.benchmark ||
        run.evalscope_commit !== run.scoring_config.evalscope_commit)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['scoring_config'],
        message: 'Stored scoring identity must match the evaluation run',
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
