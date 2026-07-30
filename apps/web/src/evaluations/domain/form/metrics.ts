import type { MetricDescriptor } from '../../api/schemas.js'
import type { EvaluationFormValues } from './evaluation.js'

export type MetricSelectionFormValue = Pick<
  EvaluationFormValues,
  'metricIds' | 'metricMode' | 'metricParameters' | 'primaryMetricId'
>

export function toggleMetricSelection(
  value: MetricSelectionFormValue,
  descriptor: MetricDescriptor,
): MetricSelectionFormValue {
  if (!descriptor.availability.selectable) return value
  const selected = value.metricIds.includes(descriptor.id)
  const metricIds = (
    selected
      ? value.metricIds.filter((metricId) => metricId !== descriptor.id)
      : [...value.metricIds, descriptor.id]
  ).sort()
  const metricParameters = { ...value.metricParameters }
  if (selected) {
    delete metricParameters[descriptor.id]
  } else {
    const defaults = Object.fromEntries(
      Object.entries(descriptor.parameters).flatMap(([name, parameter]) =>
        parameter.default === undefined ? [] : [[name, parameter.default] as const],
      ),
    )
    if (Object.keys(defaults).length > 0) metricParameters[descriptor.id] = defaults
  }
  const primaryMetricId =
    metricIds.length === 1
      ? (metricIds[0] ?? '')
      : !selected
        ? ''
        : metricIds.includes(value.primaryMetricId)
          ? value.primaryMetricId
          : ''
  return { ...value, metricIds, metricParameters, primaryMetricId }
}
