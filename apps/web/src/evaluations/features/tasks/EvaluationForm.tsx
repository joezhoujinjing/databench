import { ChevronDown, ChevronUp, Play } from 'lucide-react'
import { type FormEvent, type ReactNode, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button.js'
import { SelectInput, TextInput } from '@/components/ui/input.js'
import {
  EVALUATION_ADVANCED_FIELDS,
  EVALUATION_FIELD_IDS,
  EVALUATION_FORM_DEFAULTS,
  type EvaluationFormValues,
  type EvaluationSourceKind,
  validateEvaluationForm,
} from '../../domain/form/evaluation.js'
import type { TaskRunnerError } from '../../domain/tasks/state.js'
import { BenchmarkAutocomplete } from './BenchmarkAutocomplete.js'
import { DatasetArgsEditor } from './DatasetArgsEditor.js'
import { fieldAria, TaskFormField } from './TaskFormField.js'

export function EvaluationForm({
  canSubmit = true,
  databenchSource,
  disabled,
  initialBenchmark,
  onSourceChange,
  onSubmit,
  serverError,
  source,
}: {
  readonly canSubmit?: boolean
  readonly databenchSource: ReactNode
  readonly disabled: boolean
  readonly initialBenchmark?: string | undefined
  readonly onSourceChange: (source: EvaluationSourceKind) => void
  readonly onSubmit: (values: EvaluationFormValues) => void
  readonly serverError: TaskRunnerError | null
  readonly source: EvaluationSourceKind
}) {
  const { t } = useTranslation()
  const [values, setValues] = useState<EvaluationFormValues>({
    ...EVALUATION_FORM_DEFAULTS,
    datasets: initialBenchmark ?? '',
  })
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({})
  const [advanced, setAdvanced] = useState(false)

  useEffect(() => {
    if (initialBenchmark !== undefined) {
      setValues((current) => ({ ...current, datasets: initialBenchmark }))
    }
  }, [initialBenchmark])

  useEffect(() => {
    const field = serverError?.field
    if (
      serverError?.code !== 'dataset_args_locator_forbidden' ||
      (field !== '/dataset_args' && !field?.startsWith('/dataset_args/'))
    ) {
      return
    }
    setAdvanced(true)
    setErrors((current) => ({
      ...current,
      [EVALUATION_FIELD_IDS.datasetArgs]: serverError.message,
    }))
    requestAnimationFrame(() => document.getElementById(EVALUATION_FIELD_IDS.datasetArgs)?.focus())
  }, [serverError])

  const change = <K extends keyof EvaluationFormValues>(
    field: K,
    value: EvaluationFormValues[K],
  ) => {
    setValues((current) => ({ ...current, [field]: value }))
    const id = EVALUATION_FIELD_IDS[field]
    setErrors((current) => {
      if (current[id] === undefined) return current
      const next = { ...current }
      delete next[id]
      return next
    })
  }

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const validation = validateEvaluationForm(values, source)
    setErrors(validation.errors)
    if (!validation.ok) {
      if (EVALUATION_ADVANCED_FIELDS.has(validation.firstInvalid)) setAdvanced(true)
      requestAnimationFrame(() => document.getElementById(validation.firstInvalid)?.focus())
      return
    }
    onSubmit(values)
  }

  return (
    <form className="space-y-5" noValidate onSubmit={submit}>
      <TaskFormField id="eval-source" label={t('evaluations.tasks.source')}>
        <SelectInput
          aria-label={t('evaluations.tasks.source')}
          disabled={disabled}
          id="eval-source"
          onValueChange={onSourceChange}
          options={[
            { label: t('evaluations.tasks.benchmarkSource'), value: 'benchmark' },
            { label: t('evaluations.tasks.databenchSource'), value: 'databench' },
          ]}
          value={source}
        />
      </TaskFormField>

      <div className="grid gap-4 md:grid-cols-2">
        <TaskFormField
          error={errors[EVALUATION_FIELD_IDS.model]}
          id={EVALUATION_FIELD_IDS.model}
          label={t('evaluations.eval.modelName')}
          required
        >
          <TextInput
            {...fieldAria(errors[EVALUATION_FIELD_IDS.model], EVALUATION_FIELD_IDS.model)}
            autoComplete="off"
            disabled={disabled}
            id={EVALUATION_FIELD_IDS.model}
            onChange={(event) => change('model', event.currentTarget.value)}
            placeholder="Qwen/Qwen3"
            value={values.model}
          />
        </TaskFormField>

        {source === 'benchmark' ? (
          <TaskFormField
            error={errors[EVALUATION_FIELD_IDS.datasets]}
            id={EVALUATION_FIELD_IDS.datasets}
            label={t('evaluations.eval.datasets')}
            required
          >
            <BenchmarkAutocomplete
              disabled={disabled}
              error={errors[EVALUATION_FIELD_IDS.datasets]}
              id={EVALUATION_FIELD_IDS.datasets}
              onChange={(value) => change('datasets', value)}
              value={values.datasets}
            />
          </TaskFormField>
        ) : (
          <div className="md:col-span-2">{databenchSource}</div>
        )}

        <TaskFormField
          error={errors[EVALUATION_FIELD_IDS.apiUrl]}
          id={EVALUATION_FIELD_IDS.apiUrl}
          label={t('evaluations.eval.apiUrl')}
          required
        >
          <TextInput
            {...fieldAria(errors[EVALUATION_FIELD_IDS.apiUrl], EVALUATION_FIELD_IDS.apiUrl)}
            autoComplete="url"
            disabled={disabled}
            id={EVALUATION_FIELD_IDS.apiUrl}
            onChange={(event) => change('apiUrl', event.currentTarget.value)}
            placeholder="http://model-service:8000/v1"
            value={values.apiUrl}
          />
        </TaskFormField>

        <TaskFormField id={EVALUATION_FIELD_IDS.apiKey} label={t('evaluations.eval.apiKey')}>
          <TextInput
            autoComplete="off"
            disabled={disabled}
            id={EVALUATION_FIELD_IDS.apiKey}
            onChange={(event) => change('apiKey', event.currentTarget.value)}
            placeholder="sk-..."
            type="password"
            value={values.apiKey}
          />
        </TaskFormField>

        <NumberField
          disabled={disabled}
          error={errors[EVALUATION_FIELD_IDS.limit]}
          id={EVALUATION_FIELD_IDS.limit}
          label={t('evaluations.eval.limit')}
          min={1}
          onChange={(value) => change('limit', value)}
          value={values.limit}
        />
        <NumberField
          disabled={disabled}
          error={errors[EVALUATION_FIELD_IDS.evalBatchSize]}
          id={EVALUATION_FIELD_IDS.evalBatchSize}
          label={t('evaluations.eval.batchSize')}
          min={1}
          onChange={(value) => change('evalBatchSize', value)}
          value={values.evalBatchSize}
        />
      </div>

      <button
        aria-expanded={advanced}
        className="flex min-h-9 items-center gap-1.5 font-medium text-primary text-sm hover:underline"
        onClick={() => setAdvanced((current) => !current)}
        type="button"
      >
        {t('evaluations.eval.moreParams')}
        {advanced ? (
          <ChevronUp aria-hidden="true" size={15} />
        ) : (
          <ChevronDown aria-hidden="true" size={15} />
        )}
      </button>

      {advanced ? (
        <div className="grid gap-4 border-border border-y py-5 md:grid-cols-3">
          <NumberField
            disabled={disabled}
            error={errors[EVALUATION_FIELD_IDS.repeats]}
            id={EVALUATION_FIELD_IDS.repeats}
            label={t('evaluations.eval.repeats')}
            min={1}
            onChange={(value) => change('repeats', value)}
            value={values.repeats}
          />
          <NumberField
            disabled={disabled}
            error={errors[EVALUATION_FIELD_IDS.timeout]}
            id={EVALUATION_FIELD_IDS.timeout}
            label={t('evaluations.eval.timeout')}
            min={0}
            onChange={(value) => change('timeout', value)}
            value={values.timeout}
          />
          <TaskFormField id={EVALUATION_FIELD_IDS.stream} label={t('evaluations.eval.stream')}>
            <label
              className="flex min-h-10 items-center gap-3 text-sm"
              htmlFor={EVALUATION_FIELD_IDS.stream}
            >
              <input
                checked={values.stream}
                className="size-5 accent-primary"
                disabled={disabled}
                id={EVALUATION_FIELD_IDS.stream}
                onChange={(event) => change('stream', event.currentTarget.checked)}
                type="checkbox"
              />
              {t('evaluations.tasks.enabled')}
            </label>
          </TaskFormField>
          <NumberField
            disabled={disabled}
            error={errors[EVALUATION_FIELD_IDS.temperature]}
            id={EVALUATION_FIELD_IDS.temperature}
            label={t('evaluations.eval.temperature')}
            max={2}
            min={0}
            onChange={(value) => change('temperature', value)}
            step={0.1}
            value={values.temperature}
          />
          <NumberField
            disabled={disabled}
            error={errors[EVALUATION_FIELD_IDS.topP]}
            id={EVALUATION_FIELD_IDS.topP}
            label={t('evaluations.eval.topP')}
            max={1}
            min={0}
            onChange={(value) => change('topP', value)}
            step={0.1}
            value={values.topP}
          />
          <NumberField
            disabled={disabled}
            error={errors[EVALUATION_FIELD_IDS.maxTokens]}
            id={EVALUATION_FIELD_IDS.maxTokens}
            label={t('evaluations.eval.maxTokens')}
            min={1}
            onChange={(value) => change('maxTokens', value)}
            value={values.maxTokens}
          />
          <NumberField
            disabled={disabled}
            error={errors[EVALUATION_FIELD_IDS.topK]}
            id={EVALUATION_FIELD_IDS.topK}
            label={t('evaluations.eval.topK')}
            min={1}
            onChange={(value) => change('topK', value)}
            value={values.topK}
          />
          {source === 'benchmark' ? (
            <div className="md:col-span-2">
              <DatasetArgsEditor
                disabled={disabled}
                error={errors[EVALUATION_FIELD_IDS.datasetArgs]}
                id={EVALUATION_FIELD_IDS.datasetArgs}
                label={t('evaluations.eval.datasetArgs')}
                onChange={(value) => change('datasetArgs', value)}
                value={values.datasetArgs}
              />
            </div>
          ) : null}
        </div>
      ) : null}

      <Button disabled={disabled || !canSubmit} type="submit">
        <Play aria-hidden="true" size={15} />
        {t('evaluations.eval.startEval')}
      </Button>
    </form>
  )
}

function NumberField({
  disabled,
  error,
  id,
  label,
  max,
  min,
  onChange,
  step,
  value,
}: {
  readonly disabled: boolean
  readonly error?: string | undefined
  readonly id: string
  readonly label: string
  readonly max?: number | undefined
  readonly min?: number | undefined
  readonly onChange: (value: string) => void
  readonly step?: number | undefined
  readonly value: string
}) {
  return (
    <TaskFormField error={error} id={id} label={label}>
      <TextInput
        {...fieldAria(error, id)}
        disabled={disabled}
        id={id}
        max={max}
        min={min}
        onChange={(event) => onChange(event.currentTarget.value)}
        step={step}
        type="number"
        value={value}
      />
    </TaskFormField>
  )
}
