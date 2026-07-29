import {
  firstInvalidField,
  parseDatasetArgs,
  TASK_FORM_MESSAGES,
  type TaskFieldErrors,
  validateNumericText,
} from './validation.js'

export type EvaluationSourceKind = 'benchmark' | 'databench'
export type DatabenchTargetSource = 'none' | 'selected-candidate' | 'verification-ground-truth'

export interface EvaluationFormValues {
  readonly apiKey: string
  readonly apiUrl: string
  readonly datasetArgs: string
  readonly datasets: string
  readonly evalBatchSize: string
  readonly limit: string
  readonly maxTokens: string
  readonly model: string
  readonly repeats: string
  readonly stream: boolean
  readonly temperature: string
  readonly timeout: string
  readonly topK: string
  readonly topP: string
}

export const EVALUATION_FORM_DEFAULTS: EvaluationFormValues = {
  apiKey: '',
  apiUrl: '',
  datasetArgs: '',
  datasets: '',
  evalBatchSize: '16',
  limit: '5',
  maxTokens: '',
  model: '',
  repeats: '1',
  stream: false,
  temperature: '',
  timeout: '60',
  topK: '',
  topP: '',
}

export const EVALUATION_FIELD_IDS = {
  apiKey: 'eval-api-key',
  apiUrl: 'eval-api-url',
  datasetArgs: 'eval-dataset-args',
  datasets: 'eval-datasets',
  evalBatchSize: 'eval-batch-size',
  limit: 'eval-limit',
  maxTokens: 'eval-max-tokens',
  model: 'eval-model',
  repeats: 'eval-repeats',
  stream: 'eval-stream',
  temperature: 'eval-temperature',
  timeout: 'eval-timeout',
  topK: 'eval-top-k',
  topP: 'eval-top-p',
} as const

export const EVALUATION_FIELD_ORDER = [
  EVALUATION_FIELD_IDS.model,
  EVALUATION_FIELD_IDS.datasets,
  EVALUATION_FIELD_IDS.apiUrl,
  EVALUATION_FIELD_IDS.apiKey,
  EVALUATION_FIELD_IDS.limit,
  EVALUATION_FIELD_IDS.evalBatchSize,
  EVALUATION_FIELD_IDS.repeats,
  EVALUATION_FIELD_IDS.timeout,
  EVALUATION_FIELD_IDS.temperature,
  EVALUATION_FIELD_IDS.topP,
  EVALUATION_FIELD_IDS.maxTokens,
  EVALUATION_FIELD_IDS.topK,
  EVALUATION_FIELD_IDS.datasetArgs,
] as const

export const EVALUATION_ADVANCED_FIELDS = new Set<string>([
  EVALUATION_FIELD_IDS.repeats,
  EVALUATION_FIELD_IDS.timeout,
  EVALUATION_FIELD_IDS.temperature,
  EVALUATION_FIELD_IDS.topP,
  EVALUATION_FIELD_IDS.maxTokens,
  EVALUATION_FIELD_IDS.topK,
  EVALUATION_FIELD_IDS.datasetArgs,
])

export interface DatabenchEvaluationBinding {
  readonly acceptedFidelityDigest: string
  readonly datasetVersion: string
  readonly sourceRef: string | null
  readonly targetSource: DatabenchTargetSource
}

export type EvaluationValidation =
  | {
      readonly datasetArgs: Record<string, unknown> | undefined
      readonly errors: TaskFieldErrors
      readonly firstInvalid: string
      readonly ok: false
    }
  | {
      readonly datasetArgs: Record<string, unknown> | undefined
      readonly errors: TaskFieldErrors
      readonly firstInvalid: null
      readonly ok: true
    }

export function validateEvaluationForm(
  values: EvaluationFormValues,
  source: EvaluationSourceKind,
): EvaluationValidation {
  const errors: Record<string, string> = {}
  if (values.model.trim() === '') errors[EVALUATION_FIELD_IDS.model] = TASK_FORM_MESSAGES.required
  if (values.apiUrl.trim() === '') {
    errors[EVALUATION_FIELD_IDS.apiUrl] = TASK_FORM_MESSAGES.required
  }
  if (source === 'benchmark' && values.datasets.trim() === '') {
    errors[EVALUATION_FIELD_IDS.datasets] = TASK_FORM_MESSAGES.required
  }
  const numericChecks = [
    [EVALUATION_FIELD_IDS.limit, values.limit, { min: 1 }],
    [EVALUATION_FIELD_IDS.evalBatchSize, values.evalBatchSize, { min: 1 }],
    [EVALUATION_FIELD_IDS.repeats, values.repeats, { min: 1 }],
    [EVALUATION_FIELD_IDS.timeout, values.timeout, { min: 0 }],
    [EVALUATION_FIELD_IDS.temperature, values.temperature, { max: 2, min: 0, step: 0.1 }],
    [EVALUATION_FIELD_IDS.topP, values.topP, { max: 1, min: 0, step: 0.1 }],
    [EVALUATION_FIELD_IDS.maxTokens, values.maxTokens, { min: 1 }],
    [EVALUATION_FIELD_IDS.topK, values.topK, { min: 1 }],
  ] as const
  for (const [field, value, bounds] of numericChecks) {
    const error = validateNumericText(value, bounds)
    if (error !== null) errors[field] = error
  }
  const datasetArgs =
    source === 'benchmark'
      ? parseDatasetArgs(values.datasetArgs)
      : ({ ok: true, value: undefined } as const)
  if (!datasetArgs.ok) errors[EVALUATION_FIELD_IDS.datasetArgs] = datasetArgs.messageKey

  const firstInvalid = firstInvalidField(EVALUATION_FIELD_ORDER, errors)
  if (firstInvalid !== null) {
    return {
      datasetArgs: datasetArgs.ok ? datasetArgs.value : undefined,
      errors,
      firstInvalid,
      ok: false,
    }
  }
  return {
    datasetArgs: datasetArgs.ok ? datasetArgs.value : undefined,
    errors,
    firstInvalid: null,
    ok: true,
  }
}

export function buildEvaluationPayload(
  values: EvaluationFormValues,
  source: EvaluationSourceKind,
  binding?: DatabenchEvaluationBinding,
): Record<string, unknown> {
  const validation = validateEvaluationForm(values, source)
  if (!validation.ok) throw new TypeError('Evaluation form is invalid')
  const payload: Record<string, unknown> = {
    model: values.model,
    api_url: values.apiUrl,
    limit: optionalNumber(values.limit),
    eval_batch_size: optionalNumber(values.evalBatchSize),
  }
  if (values.apiKey !== '') payload.api_key = values.apiKey
  if (source === 'benchmark') {
    payload.datasets = splitDatasets(values.datasets)
    if (validation.datasetArgs !== undefined) payload.dataset_args = validation.datasetArgs
  } else {
    if (binding === undefined) throw new TypeError('Databench evaluation binding is required')
    payload.databench_source = {
      source_ref: binding.sourceRef,
      dataset_version: binding.datasetVersion,
      converter: 'evalscope-general-qa',
      options: { target_source: binding.targetSource },
      accepted_fidelity_digest: binding.acceptedFidelityDigest,
    }
  }
  if (values.repeats !== '' && Number(values.repeats) > 1) {
    payload.repeats = Number(values.repeats)
  }
  if (values.timeout !== '') payload.timeout = Number(values.timeout)
  if (values.stream) payload.stream = true
  const generationConfig: Record<string, number> = {}
  if (values.temperature !== '') generationConfig.temperature = Number(values.temperature)
  if (values.topP !== '') generationConfig.top_p = Number(values.topP)
  if (values.maxTokens !== '') generationConfig.max_tokens = Number(values.maxTokens)
  if (values.topK !== '') generationConfig.top_k = Number(values.topK)
  if (Object.keys(generationConfig).length > 0) payload.generation_config = generationConfig
  return payload
}

export function splitDatasets(value: string): readonly string[] {
  return value
    .split(',')
    .map((dataset) => dataset.trim())
    .filter(Boolean)
}

function optionalNumber(value: string): number | undefined {
  return value === '' ? undefined : Number(value)
}
