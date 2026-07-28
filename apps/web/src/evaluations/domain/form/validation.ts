export const TASK_FORM_MESSAGES = {
  datasetArgsInvalidJson: 'evaluations.form.validation.datasetArgs.invalidJson',
  datasetArgsInvalidStructure: 'evaluations.form.validation.datasetArgs.invalidStructure',
  numericAboveMax: 'evaluations.form.validation.numeric.aboveMax',
  numericBelowMin: 'evaluations.form.validation.numeric.belowMin',
  numericNotFinite: 'evaluations.form.validation.numeric.notFinite',
  numericStepMismatch: 'evaluations.form.validation.numeric.stepMismatch',
  positiveIntegerList: 'evaluations.tasks.validation.positiveIntegerList',
  required: 'evaluations.form.validation.required',
} as const

export type TaskFieldErrors = Readonly<Record<string, string>>

export function firstInvalidField(
  fieldOrder: readonly string[],
  errors: TaskFieldErrors,
): string | null {
  for (const field of fieldOrder) {
    if (errors[field] !== undefined) return field
  }
  return null
}

export function validateNumericText(
  raw: string,
  bounds: { readonly max?: number; readonly min?: number; readonly step?: number } = {},
): string | null {
  if (raw.trim() === '') return null
  const value = Number(raw)
  if (!Number.isFinite(value)) return TASK_FORM_MESSAGES.numericNotFinite
  if (bounds.min !== undefined && value < bounds.min) {
    return TASK_FORM_MESSAGES.numericBelowMin
  }
  if (bounds.max !== undefined && value > bounds.max) {
    return TASK_FORM_MESSAGES.numericAboveMax
  }
  if (bounds.step !== undefined && bounds.step > 0) {
    const anchor = bounds.min ?? 0
    const remainder = value - anchor - Math.round((value - anchor) / bounds.step) * bounds.step
    if (Math.abs(remainder) > 1e-9 * Math.max(1, Math.abs(bounds.step))) {
      return TASK_FORM_MESSAGES.numericStepMismatch
    }
  }
  return null
}

export type DatasetArgsResult =
  | { readonly ok: true; readonly value: Record<string, unknown> | undefined }
  | { readonly messageKey: string; readonly ok: false }

export function parseDatasetArgs(raw: string): DatasetArgsResult {
  if (raw.trim() === '') return { ok: true, value: undefined }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { messageKey: TASK_FORM_MESSAGES.datasetArgsInvalidJson, ok: false }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { messageKey: TASK_FORM_MESSAGES.datasetArgsInvalidStructure, ok: false }
  }
  return { ok: true, value: parsed as Record<string, unknown> }
}

export function parsePositiveIntegerList(raw: string): readonly number[] | null {
  const parts = raw.split(',').map((part) => part.trim())
  if (parts.length === 0 || parts.some((part) => !/^[0-9]+$/u.test(part) || Number(part) < 1)) {
    return null
  }
  return parts.map(Number)
}
