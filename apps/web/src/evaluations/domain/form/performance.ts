import {
  firstInvalidField,
  parsePositiveIntegerList,
  TASK_FORM_MESSAGES,
  type TaskFieldErrors,
  validateNumericText,
} from './validation.js'

export type PerformanceApiType = 'dashscope' | 'local' | 'openai'

export interface PerformanceFormValues {
  readonly api: PerformanceApiType
  readonly apiKey: string
  readonly dataset: string
  readonly maxPromptLength: string
  readonly maxTokens: string
  readonly minPromptLength: string
  readonly minTokens: string
  readonly model: string
  readonly number: string
  readonly parallel: string
  readonly rate: string
  readonly url: string
}

export const PERFORMANCE_FORM_DEFAULTS: PerformanceFormValues = {
  api: 'openai',
  apiKey: '',
  dataset: '',
  maxPromptLength: '',
  maxTokens: '512',
  minPromptLength: '',
  minTokens: '',
  model: '',
  number: '10',
  parallel: '1',
  rate: '',
  url: '',
}

export const PERFORMANCE_FIELD_IDS = {
  api: 'perf-api',
  apiKey: 'perf-api-key',
  dataset: 'perf-dataset',
  maxPromptLength: 'perf-max-prompt-length',
  maxTokens: 'perf-max-tokens',
  minPromptLength: 'perf-min-prompt-length',
  minTokens: 'perf-min-tokens',
  model: 'perf-model',
  number: 'perf-number',
  parallel: 'perf-parallel',
  rate: 'perf-rate',
  url: 'perf-url',
} as const

const PERFORMANCE_FIELD_ORDER = [
  PERFORMANCE_FIELD_IDS.model,
  PERFORMANCE_FIELD_IDS.api,
  PERFORMANCE_FIELD_IDS.url,
  PERFORMANCE_FIELD_IDS.apiKey,
  PERFORMANCE_FIELD_IDS.parallel,
  PERFORMANCE_FIELD_IDS.number,
  PERFORMANCE_FIELD_IDS.rate,
  PERFORMANCE_FIELD_IDS.maxTokens,
  PERFORMANCE_FIELD_IDS.minTokens,
  PERFORMANCE_FIELD_IDS.dataset,
  PERFORMANCE_FIELD_IDS.maxPromptLength,
  PERFORMANCE_FIELD_IDS.minPromptLength,
] as const

export type PerformanceValidation =
  | {
      readonly errors: TaskFieldErrors
      readonly firstInvalid: string
      readonly number: readonly number[] | null
      readonly ok: false
      readonly parallel: readonly number[] | null
    }
  | {
      readonly errors: TaskFieldErrors
      readonly firstInvalid: null
      readonly number: readonly number[]
      readonly ok: true
      readonly parallel: readonly number[]
    }

export function validatePerformanceForm(values: PerformanceFormValues): PerformanceValidation {
  const errors: Record<string, string> = {}
  if (values.model.trim() === '') errors[PERFORMANCE_FIELD_IDS.model] = TASK_FORM_MESSAGES.required
  if (values.url.trim() === '') errors[PERFORMANCE_FIELD_IDS.url] = TASK_FORM_MESSAGES.required
  const parallel = parsePositiveIntegerList(values.parallel)
  const number = parsePositiveIntegerList(values.number)
  if (parallel === null) {
    errors[PERFORMANCE_FIELD_IDS.parallel] = TASK_FORM_MESSAGES.positiveIntegerList
  }
  if (number === null) errors[PERFORMANCE_FIELD_IDS.number] = TASK_FORM_MESSAGES.positiveIntegerList
  const numericChecks = [
    [PERFORMANCE_FIELD_IDS.rate, values.rate, { min: 0 }],
    [PERFORMANCE_FIELD_IDS.maxTokens, values.maxTokens, { min: 1 }],
    [PERFORMANCE_FIELD_IDS.minTokens, values.minTokens, { min: 0 }],
    [PERFORMANCE_FIELD_IDS.maxPromptLength, values.maxPromptLength, { min: 0 }],
    [PERFORMANCE_FIELD_IDS.minPromptLength, values.minPromptLength, { min: 0 }],
  ] as const
  for (const [field, value, bounds] of numericChecks) {
    const error = validateNumericText(value, bounds)
    if (error !== null) errors[field] = error
  }
  const firstInvalid = firstInvalidField(PERFORMANCE_FIELD_ORDER, errors)
  if (firstInvalid !== null) {
    return { errors, firstInvalid, number, ok: false, parallel }
  }
  if (parallel === null || number === null)
    throw new Error('Validated lists are unexpectedly absent')
  return { errors, firstInvalid: null, number, ok: true, parallel }
}

export function buildPerformancePayload(values: PerformanceFormValues): Record<string, unknown> {
  const validation = validatePerformanceForm(values)
  if (!validation.ok) throw new TypeError('Performance form is invalid')
  const payload: Record<string, unknown> = {
    model: values.model,
    api: values.api,
    url: values.url,
    parallel: validation.parallel,
    number: validation.number,
  }
  if (values.apiKey !== '') payload.api_key = values.apiKey
  addNumber(payload, 'rate', values.rate)
  addNumber(payload, 'max_tokens', values.maxTokens)
  addNumber(payload, 'min_tokens', values.minTokens)
  if (values.dataset !== '') payload.dataset = values.dataset
  addNumber(payload, 'max_prompt_length', values.maxPromptLength)
  addNumber(payload, 'min_prompt_length', values.minPromptLength)
  return payload
}

function addNumber(payload: Record<string, unknown>, field: string, raw: string): void {
  if (raw !== '') payload[field] = Number(raw)
}
