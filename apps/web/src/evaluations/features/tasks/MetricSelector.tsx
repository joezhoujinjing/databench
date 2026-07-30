import { Check, ChevronDown } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { SelectInput, TextInput } from '@/components/ui/input.js'
import { cn } from '@/lib/utils.js'
import type { MetricDescriptor } from '../../api/schemas.js'
import {
  EVALUATION_FIELD_IDS,
  type EvaluationFormValues,
  type EvaluationMetricParameter,
} from '../../domain/form/evaluation.js'
import { type MetricSelectionFormValue, toggleMetricSelection } from '../../domain/form/metrics.js'
import { fieldAria, TaskFormField } from './TaskFormField.js'

export function MetricSelector({
  descriptors,
  disabled,
  metricError,
  onChange,
  primaryMetricError,
  value,
}: {
  readonly descriptors: readonly MetricDescriptor[]
  readonly disabled: boolean
  readonly metricError?: string | undefined
  readonly onChange: (value: MetricSelectionFormValue) => void
  readonly primaryMetricError?: string | undefined
  readonly value: MetricSelectionFormValue
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const listboxId = `${useId()}-metrics`
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [open])

  const descriptorById = new Map(descriptors.map((descriptor) => [descriptor.id, descriptor]))
  const selectedDescriptors = value.metricIds.flatMap((metricId) => {
    const descriptor = descriptorById.get(metricId)
    return descriptor === undefined ? [] : [descriptor]
  })

  const setMode = (mode: EvaluationFormValues['metricMode']) => {
    onChange({
      metricMode: mode,
      metricIds: [],
      metricParameters: {},
      primaryMetricId: '',
    })
  }

  const toggleMetric = (descriptor: MetricDescriptor) => {
    onChange(toggleMetricSelection(value, descriptor))
  }

  const setParameter = (
    metricId: string,
    parameterName: string,
    parameter: EvaluationMetricParameter | undefined,
  ) => {
    const metricParameters = { ...value.metricParameters }
    const next = { ...(metricParameters[metricId] ?? {}) }
    if (parameter === undefined) delete next[parameterName]
    else next[parameterName] = parameter
    if (Object.keys(next).length === 0) delete metricParameters[metricId]
    else metricParameters[metricId] = next
    onChange({ ...value, metricParameters })
  }

  return (
    <div className="space-y-4">
      <TaskFormField id={EVALUATION_FIELD_IDS.metricMode} label={t('evaluations.eval.metricMode')}>
        <SelectInput
          disabled={disabled}
          id={EVALUATION_FIELD_IDS.metricMode}
          onValueChange={setMode}
          options={[
            {
              label: t('evaluations.eval.metricBenchmarkDefault'),
              value: 'benchmark_default',
            },
            { label: t('evaluations.eval.metricExplicit'), value: 'explicit' },
          ]}
          value={value.metricMode}
        />
      </TaskFormField>

      {value.metricMode === 'explicit' ? (
        <>
          <TaskFormField
            error={metricError}
            id={EVALUATION_FIELD_IDS.metricIds}
            label={t('evaluations.eval.metrics')}
            required
          >
            <div className="relative" ref={rootRef}>
              <button
                {...fieldAria(metricError, EVALUATION_FIELD_IDS.metricIds)}
                aria-controls={open ? listboxId : undefined}
                aria-expanded={open}
                aria-haspopup="listbox"
                className={cn(
                  'flex min-h-10 w-full items-center justify-between gap-3 rounded-[4px] border border-border bg-background/70 px-3 py-2.5 text-left text-sm outline-none transition',
                  open && 'border-primary shadow-[0_0_0_1px_var(--primary)]',
                )}
                disabled={disabled}
                id={EVALUATION_FIELD_IDS.metricIds}
                onClick={() => setOpen((current) => !current)}
                type="button"
              >
                <span className="min-w-0 truncate">
                  {selectedDescriptors.length === 0
                    ? t('evaluations.eval.selectMetrics')
                    : selectedDescriptors.map((descriptor) => descriptor.label).join(', ')}
                </span>
                <ChevronDown
                  aria-hidden="true"
                  className={cn('shrink-0 transition', open && 'rotate-180')}
                  size={16}
                />
              </button>
              {open ? (
                <div
                  className="absolute right-0 left-0 z-50 mt-1.5 max-h-80 overflow-auto rounded-[6px] border border-border-strong bg-surface-raised p-1.5 shadow-[0_24px_80px_rgba(0,0,0,0.38)]"
                  id={listboxId}
                  role="listbox"
                >
                  {descriptors.map((descriptor) => {
                    const selected = value.metricIds.includes(descriptor.id)
                    const reason = metricUnavailableReason(descriptor, t)
                    return (
                      <button
                        aria-selected={selected}
                        className={cn(
                          'flex min-h-11 w-full items-center gap-3 rounded-[4px] px-2.5 text-left text-sm transition',
                          selected
                            ? 'bg-primary/14 text-foreground'
                            : 'text-muted-foreground hover:bg-surface-hover hover:text-foreground',
                          !descriptor.availability.selectable &&
                            'cursor-not-allowed opacity-50 hover:bg-transparent',
                        )}
                        disabled={!descriptor.availability.selectable}
                        key={descriptor.id}
                        onClick={() => toggleMetric(descriptor)}
                        role="option"
                        type="button"
                      >
                        <span className="flex size-4 shrink-0 items-center justify-center rounded-[3px] border border-border-strong">
                          {selected ? <Check aria-hidden="true" size={12} /> : null}
                        </span>
                        <span className="min-w-0">
                          <span className="block font-medium">{descriptor.label}</span>
                          <span className="block truncate text-dim-foreground text-xs">
                            {reason ?? descriptor.output_keys.join(', ')}
                          </span>
                        </span>
                      </button>
                    )
                  })}
                </div>
              ) : null}
            </div>
          </TaskFormField>

          {value.metricIds.length > 1 ? (
            <TaskFormField
              error={primaryMetricError}
              id={EVALUATION_FIELD_IDS.primaryMetricId}
              label={t('evaluations.eval.primaryMetric')}
              required
            >
              <SelectInput
                {...fieldAria(primaryMetricError, EVALUATION_FIELD_IDS.primaryMetricId)}
                disabled={disabled}
                id={EVALUATION_FIELD_IDS.primaryMetricId}
                onValueChange={(primaryMetricId) => onChange({ ...value, primaryMetricId })}
                options={[
                  { disabled: true, label: t('evaluations.eval.selectPrimaryMetric'), value: '' },
                  ...selectedDescriptors.map((descriptor) => ({
                    label: descriptor.label,
                    value: descriptor.id,
                  })),
                ]}
                value={value.primaryMetricId}
              />
            </TaskFormField>
          ) : value.metricIds.length === 1 ? (
            <p className="text-muted-foreground text-sm">
              {t('evaluations.eval.primaryMetric')}: {selectedDescriptors[0]?.label}
            </p>
          ) : null}

          {selectedDescriptors.flatMap((descriptor) =>
            Object.entries(descriptor.parameters).map(([name, parameter]) => {
              const parameterValue = value.metricParameters[descriptor.id]?.[name]
              const id = `${EVALUATION_FIELD_IDS.metricParameters}-${descriptor.id}-${name}`
              return (
                <TaskFormField
                  id={id}
                  key={`${descriptor.id}:${name}`}
                  label={`${descriptor.label} · ${name}`}
                >
                  {parameter.type === 'boolean' ? (
                    <label className="flex min-h-10 items-center gap-3 text-sm" htmlFor={id}>
                      <input
                        checked={parameterValue === true}
                        className="size-5 accent-primary"
                        disabled={disabled}
                        id={id}
                        onChange={(event) =>
                          setParameter(descriptor.id, name, event.currentTarget.checked)
                        }
                        type="checkbox"
                      />
                      {t('evaluations.tasks.enabled')}
                    </label>
                  ) : (
                    <TextInput
                      disabled={disabled}
                      id={id}
                      max={parameter.maximum}
                      min={parameter.minimum}
                      onChange={(event) => {
                        const raw = event.currentTarget.value
                        setParameter(
                          descriptor.id,
                          name,
                          raw === '' ? undefined : parameter.type === 'number' ? Number(raw) : raw,
                        )
                      }}
                      type={parameter.type === 'number' ? 'number' : 'text'}
                      value={parameterValue === undefined ? '' : String(parameterValue)}
                    />
                  )}
                </TaskFormField>
              )
            }),
          )}
        </>
      ) : (
        <p className="text-dim-foreground text-xs leading-5">
          {t('evaluations.eval.metricDefaultHint')}
        </p>
      )}
    </div>
  )
}

function metricUnavailableReason(
  descriptor: MetricDescriptor,
  t: (key: string) => string,
): string | null {
  const reason = descriptor.availability.reasons[0]
  if (reason === undefined) return null
  return t(`evaluations.eval.${reason}`)
}
