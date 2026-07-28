import { describe, expect, test } from 'vitest'
import type { PerfRunSummary, ReportSummary } from '../api/schemas.js'
import { filterDashboardRuns, mergeDashboardRuns, summarizeDashboard } from './dashboard.js'

const report = (overrides: Partial<ReportSummary> = {}): ReportSummary => ({
  dataset_name: 'gsm8k',
  model_name: 'Qwen',
  name: 'eval-a',
  num_samples: 10,
  score: 0.8,
  timestamp: '2026-07-01T10:00:00',
  ...overrides,
})

const perf = (overrides: Partial<PerfRunSummary> = {}): PerfRunSummary => ({
  api_type: 'openai',
  best_latency: 1.2,
  best_rps: 4,
  dataset: 'speed',
  has_html: true,
  is_embedding: false,
  model: 'Qwen',
  num_runs: 2,
  path: 'perf-a',
  success_rate: 100,
  timestamp: '2026-07-02T10:00:00',
  total_requests: 20,
  ...overrides,
})

describe('dashboard domain', () => {
  test('merges before sorting and never pre-truncates the feed', () => {
    const reports = Array.from({ length: 20 }, (_, index) =>
      report({ name: `eval-${index}`, timestamp: `2026-07-${String(index + 1).padStart(2, '0')}` }),
    )
    const result = mergeDashboardRuns(reports, [perf({ timestamp: '2026-08-02T10:00:00' })])
    expect(result).toHaveLength(21)
    expect(result[0]?.kind).toBe('perf')
  })

  test('computes four KPIs and searches provider/protocol independently', () => {
    const performance = [perf({ provider: 'DashScope', protocol: 'OpenAI-compatible' })]
    expect(summarizeDashboard([report()], performance)).toMatchObject({
      evaluations: 1,
      models: 1,
      performance: 1,
    })
    const runs = mergeDashboardRuns([report()], performance)
    expect(filterDashboardRuns(runs, 'perf', 'dashscope')).toHaveLength(1)
    expect(filterDashboardRuns(runs, 'eval', 'dashscope')).toHaveLength(0)
  })
})
