import { describe, expect, it } from 'vitest'
import {
  boundedMetricRatio,
  formatMetricValue,
  metricSupportsRadar,
  resolveMetricKey,
  roundHalfUp,
} from './metric.js'

describe('EvalScope metric display domain', () => {
  it('keeps bounded and native-scale metrics distinct', () => {
    expect(formatMetricValue('mean_acc', 0.925).primary).toBe('92.5%')
    expect(formatMetricValue('latency', 0.925).primary).toBe('0.93 s')
    expect(formatMetricValue('unknown_metric', 0.925)).toMatchObject({
      isSpecUndefined: true,
      primary: '0.9250',
    })
    expect(boundedMetricRatio('latency', 0.925)).toBeNull()
  })

  it('uses canonical aliases and deterministic half-up rounding', () => {
    expect(resolveMetricKey('Average Accuracy')).toBe('accuracy')
    expect(resolveMetricKey('Average latency (s)')).toBe('latency')
    expect(resolveMetricKey('Output throughput (tokens/s)')).toBe('throughput')
    expect(resolveMetricKey('pass@1')).toBe('pass_rate')
    expect(roundHalfUp(1.005, 2)).toBe(1.01)
    expect(roundHalfUp(-0.5, 0)).toBe(0)
  })

  it('only enables radar for three comparable bounded metrics', () => {
    expect(metricSupportsRadar(['acc', 'mean_acc', 'accuracy'])).toBe(true)
    expect(metricSupportsRadar(['acc', 'f1', 'accuracy'])).toBe(false)
    expect(metricSupportsRadar(['latency', 'latency', 'latency'])).toBe(false)
    expect(metricSupportsRadar(['acc', 'acc'])).toBe(false)
  })
})
