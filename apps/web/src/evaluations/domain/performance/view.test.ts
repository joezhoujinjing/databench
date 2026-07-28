import { describe, expect, test } from 'vitest'
import {
  applicableLatencyCharts,
  defaultPerformanceDetailTab,
  formatPerformanceTableCell,
  formatRequestRate,
  normalizePerformanceDetailTab,
} from './view.js'

describe('performance detail view rules', () => {
  test('normalizes single-run charts to Runs and hides token latency for embedding', () => {
    expect(defaultPerformanceDetailTab({ num_runs: 1 })).toBe('runs')
    expect(normalizePerformanceDetailTab({ num_runs: 1 }, 'charts')).toBe('runs')
    expect(applicableLatencyCharts({ api_type: 'embedding', is_embedding: true })).toEqual([
      'latency',
    ])
  })

  test('formats unlimited request rate as closed-loop', () => {
    expect(formatRequestRate(null)).toBe('closed-loop')
    expect(formatRequestRate(Number.POSITIVE_INFINITY)).toBe('closed-loop')
    expect(formatRequestRate(5)).toBe('5')
    expect(formatPerformanceTableCell('Rate', 'INF')).toBe('closed-loop')
    expect(formatPerformanceTableCell('RPS', 'INF')).toBe('INF')
    expect(formatPerformanceTableCell('P99', null)).toBe('—')
  })
})
