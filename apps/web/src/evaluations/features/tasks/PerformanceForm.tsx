import { Play } from 'lucide-react'
import { type FormEvent, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button.js'
import { SelectInput, TextInput } from '@/components/ui/input.js'
import {
  buildPerformancePayload,
  PERFORMANCE_FIELD_IDS,
  PERFORMANCE_FORM_DEFAULTS,
  type PerformanceFormValues,
  validatePerformanceForm,
} from '../../domain/form/performance.js'
import { fieldAria, TaskFormField } from './TaskFormField.js'

export function PerformanceForm({
  disabled,
  onSubmit,
}: {
  readonly disabled: boolean
  readonly onSubmit: (payload: Record<string, unknown>) => void
}) {
  const { t } = useTranslation()
  const [values, setValues] = useState<PerformanceFormValues>(PERFORMANCE_FORM_DEFAULTS)
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({})

  const change = <K extends keyof PerformanceFormValues>(
    field: K,
    value: PerformanceFormValues[K],
  ) => {
    setValues((current) => ({ ...current, [field]: value }))
    const id = PERFORMANCE_FIELD_IDS[field]
    setErrors((current) => {
      if (current[id] === undefined) return current
      const next = { ...current }
      delete next[id]
      return next
    })
  }

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const validation = validatePerformanceForm(values)
    setErrors(validation.errors)
    if (!validation.ok) {
      requestAnimationFrame(() => document.getElementById(validation.firstInvalid)?.focus())
      return
    }
    onSubmit(buildPerformancePayload(values))
  }

  const fields: readonly {
    field: keyof Pick<
      PerformanceFormValues,
      | 'dataset'
      | 'maxPromptLength'
      | 'maxTokens'
      | 'minPromptLength'
      | 'minTokens'
      | 'number'
      | 'parallel'
      | 'rate'
    >
    inputMode?: 'numeric'
    label: string
    min?: number
    placeholder?: string
    type?: 'number' | 'text'
  }[] = [
    {
      field: 'parallel',
      inputMode: 'numeric',
      label: t('evaluations.perf.parallel'),
      placeholder: '1, 4, 8',
      type: 'text',
    },
    {
      field: 'number',
      inputMode: 'numeric',
      label: t('evaluations.perf.number'),
      placeholder: '10, 100',
      type: 'text',
    },
    { field: 'rate', label: t('evaluations.perf.rate'), min: 0, type: 'number' },
    { field: 'maxTokens', label: t('evaluations.perf.maxTokens'), min: 1, type: 'number' },
    { field: 'minTokens', label: t('evaluations.perf.minTokens'), min: 0, type: 'number' },
    { field: 'dataset', label: t('evaluations.perf.dataset'), placeholder: 'openqa', type: 'text' },
    { field: 'maxPromptLength', label: t('evaluations.perf.maxPromptLen'), min: 0, type: 'number' },
    { field: 'minPromptLength', label: t('evaluations.perf.minPromptLen'), min: 0, type: 'number' },
  ]

  return (
    <form className="space-y-5" noValidate onSubmit={submit}>
      <div className="grid gap-4 md:grid-cols-2">
        <TaskFormField
          error={errors[PERFORMANCE_FIELD_IDS.model]}
          id={PERFORMANCE_FIELD_IDS.model}
          label={t('evaluations.eval.modelName')}
          required
        >
          <TextInput
            {...fieldAria(errors[PERFORMANCE_FIELD_IDS.model], PERFORMANCE_FIELD_IDS.model)}
            autoComplete="off"
            disabled={disabled}
            id={PERFORMANCE_FIELD_IDS.model}
            onChange={(event) => change('model', event.currentTarget.value)}
            placeholder="Qwen/Qwen3"
            value={values.model}
          />
        </TaskFormField>
        <TaskFormField id={PERFORMANCE_FIELD_IDS.api} label={t('evaluations.perf.apiType')}>
          <SelectInput
            aria-label={t('evaluations.perf.apiType')}
            disabled={disabled}
            id={PERFORMANCE_FIELD_IDS.api}
            onValueChange={(value) => change('api', value)}
            options={[
              { label: 'OpenAI', value: 'openai' },
              { label: 'DashScope', value: 'dashscope' },
              { label: 'Local', value: 'local' },
            ]}
            value={values.api}
          />
        </TaskFormField>
        <TaskFormField
          error={errors[PERFORMANCE_FIELD_IDS.url]}
          id={PERFORMANCE_FIELD_IDS.url}
          label={t('evaluations.eval.apiUrl')}
          required
        >
          <TextInput
            {...fieldAria(errors[PERFORMANCE_FIELD_IDS.url], PERFORMANCE_FIELD_IDS.url)}
            autoComplete="url"
            disabled={disabled}
            id={PERFORMANCE_FIELD_IDS.url}
            onChange={(event) => change('url', event.currentTarget.value)}
            placeholder="http://model-service:8000/v1"
            value={values.url}
          />
        </TaskFormField>
        <TaskFormField id={PERFORMANCE_FIELD_IDS.apiKey} label={t('evaluations.eval.apiKey')}>
          <TextInput
            autoComplete="off"
            disabled={disabled}
            id={PERFORMANCE_FIELD_IDS.apiKey}
            onChange={(event) => change('apiKey', event.currentTarget.value)}
            placeholder="sk-..."
            type="password"
            value={values.apiKey}
          />
        </TaskFormField>
        {fields.map(({ field, inputMode, label, min, placeholder, type }) => {
          const id = PERFORMANCE_FIELD_IDS[field]
          return (
            <TaskFormField error={errors[id]} id={id} key={field} label={label}>
              <TextInput
                {...fieldAria(errors[id], id)}
                disabled={disabled}
                id={id}
                inputMode={inputMode}
                min={min}
                onChange={(event) => change(field, event.currentTarget.value)}
                placeholder={placeholder}
                type={type}
                value={values[field]}
              />
            </TaskFormField>
          )
        })}
      </div>
      <Button disabled={disabled} type="submit">
        <Play aria-hidden="true" size={15} />
        {t('evaluations.perf.startPerf')}
      </Button>
    </form>
  )
}
