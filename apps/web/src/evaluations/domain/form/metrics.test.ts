import { describe, expect, it } from 'vitest'
import type { MetricDescriptor } from '../../api/schemas.js'
import { EVALUATION_FORM_DEFAULTS } from './evaluation.js'
import { toggleMetricSelection } from './metrics.js'

function descriptor(
  id: string,
  selectable = true,
  parameters: MetricDescriptor['parameters'] = {},
): MetricDescriptor {
  return {
    aliases: [],
    availability: {
      asset_ready: true,
      compatible: true,
      dependency_ready: true,
      reasons: selectable ? [] : ['metric_incompatible'],
      registered: true,
      selectable,
    },
    id,
    implementation: {
      evalscope_commit: 'b2a62f05fd81e89ec2cf4f83b9a79ce0a5535d60',
      implementation_digest: 'd'.repeat(64),
      source: 'evalscope-native',
    },
    input_contract: 'text-reference',
    label: id,
    output_keys: [id],
    parameters,
    primary_output_key: id,
  }
}

describe('Evaluation Metric selection', () => {
  it('auto-selects a single primary Metric and applies typed defaults', () => {
    const selected = toggleMetricSelection(
      EVALUATION_FORM_DEFAULTS,
      descriptor('anls', true, {
        threshold: { default: 0.5, maximum: 1, minimum: 0, type: 'number' },
      }),
    )
    expect(selected).toMatchObject({
      metricIds: ['anls'],
      metricParameters: { anls: { threshold: 0.5 } },
      primaryMetricId: 'anls',
    })
  })

  it('requires an explicit primary after adding a second Metric', () => {
    const first = toggleMetricSelection(EVALUATION_FORM_DEFAULTS, descriptor('exact_match'))
    const second = toggleMetricSelection(first, descriptor('anls'))
    expect(second.metricIds).toEqual(['anls', 'exact_match'])
    expect(second.primaryMetricId).toBe('')
  })

  it('keeps unavailable Metrics visible but impossible to select', () => {
    const value = toggleMetricSelection(EVALUATION_FORM_DEFAULTS, descriptor('comet', false))
    expect(value).toBe(EVALUATION_FORM_DEFAULTS)
  })
})
