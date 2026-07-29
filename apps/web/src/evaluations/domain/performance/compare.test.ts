import { describe, expect, test } from 'vitest'
import type { PerfDetailResponse } from '../../api/schemas.js'
import {
  buildPerformanceCompareModel,
  classifyPerformanceSampleSize,
  shouldDeemphasizePercentile,
} from './compare.js'

const detail = (overrides: Partial<PerfDetailResponse> = {}): PerfDetailResponse => ({
  basic_info: { 'Total Requests': '20' },
  best_config: { concurrency: '1', rate: '5' },
  dataset: 'speed',
  generated_at: '2026-07-01T00:00:00Z',
  has_html: true,
  is_embedding: false,
  model: 'Qwen',
  num_runs: 2,
  path: 'old',
  recommendations: [],
  summary_columns: ['Metric', 'Value'],
  summary_rows: [
    ['rps', 10],
    ['latency', 2],
  ],
  api_type: 'openai',
  ...overrides,
})

describe('performance compare domain', () => {
  test('defaults oldest to baseline and applies metric direction', () => {
    const model = buildPerformanceCompareModel([
      detail(),
      detail({
        generated_at: '2026-07-02T00:00:00Z',
        path: 'new',
        summary_rows: [
          ['rps', 12],
          ['latency', 3],
        ],
      }),
    ])
    expect(model?.baselineId).toBe('old')
    expect(model?.deltas.map((delta) => delta.verdict)).toEqual(['improvement', 'regression'])
  })

  test('keeps partial metrics, symmetric config diff and low-sample thresholds', () => {
    const model = buildPerformanceCompareModel([
      detail(),
      detail({ best_config: { concurrency: '2' }, path: 'new', summary_rows: [['rps', 12]] }),
    ])
    expect(model?.deltas.find((delta) => delta.key === 'latency')?.verdict).toBe('incomputable')
    expect(model?.configDiff.map((entry) => entry.key)).toEqual(['concurrency', 'rate'])
    expect(classifyPerformanceSampleSize(29)).toBe('critical')
    expect(classifyPerformanceSampleSize(30)).toBe('warning')
    expect(classifyPerformanceSampleSize(100)).toBe('normal')
    expect(shouldDeemphasizePercentile('P90 latency', 'warning')).toBe(false)
    expect(shouldDeemphasizePercentile('P95 latency', 'warning')).toBe(true)
    expect(shouldDeemphasizePercentile('P90 latency', 'critical')).toBe(true)
  })

  test('compares only matching wide-table workloads and flags incompatible configurations', () => {
    const baseline = detail({
      summary_columns: ['Conc.', 'Rate', 'RPS', 'Avg Lat (s)'],
      summary_rows: [
        [1, 'INF', 5, 2],
        [2, 'INF', 8, 1.5],
      ],
    })
    const candidate = detail({
      generated_at: '2026-07-02T00:00:00Z',
      path: 'new',
      summary_columns: ['Conc.', 'Rate', 'RPS', 'Avg Lat (s)'],
      summary_rows: [
        [2, 'INF', 10, 1.2],
        [4, 'INF', 12, 1],
      ],
    })
    const model = buildPerformanceCompareModel([baseline, candidate])
    expect(model?.workloadMismatch).toBe(false)
    expect(model?.deltas.map((delta) => [delta.key, delta.baseline, delta.candidate])).toEqual([
      ['rps', 8, 10],
      ['latency', 1.5, 1.2],
    ])

    const incompatible = buildPerformanceCompareModel([
      baseline,
      { ...candidate, summary_rows: [[4, 'INF', 12, 1]] },
    ])
    expect(incompatible?.workloadMismatch).toBe(true)
    expect(incompatible?.deltas).toEqual([])
  })
})
