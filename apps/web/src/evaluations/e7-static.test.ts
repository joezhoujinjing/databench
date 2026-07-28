import { access, readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, test } from 'vitest'

const evaluationsRoot = path.resolve(import.meta.dirname)
const repositoryRoot = path.resolve(evaluationsRoot, '../../../..')

async function source(relativePath: string): Promise<string> {
  return readFile(path.join(evaluationsRoot, relativePath), 'utf8')
}

describe('E7 complete EvalScope UI parity static contracts', () => {
  test('keeps dashboard refresh, partial data and URL-backed feed controls', async () => {
    const [page, state, recent] = await Promise.all([
      source('features/dashboard/DashboardPage.tsx'),
      source('features/dashboard/DashboardState.tsx'),
      source('features/dashboard/RecentRuns.tsx'),
    ])

    expect(page).toContain("request('reportsList'")
    expect(page).toContain("request('perfList'")
    expect(page).toContain('Promise.allSettled')
    expect(page).toContain('window.setTimeout')
    expect(page).toContain('ConfiguredSourceRefresh')
    expect(state).toContain('DashboardPartialState')
    expect(recent).toContain('/evaluations/reports/$reportKey')
    expect(recent).toContain('/evaluations/performance/$performanceKey')
  })

  test('keeps comparison slots, charts, per-column degradation and keyboard navigation', async () => {
    const [page, navigator, parallel, score] = await Promise.all([
      source('features/compare/ComparePage.tsx'),
      source('features/compare/AlignedSampleNavigator.tsx'),
      source('features/compare/ParallelSamples.tsx'),
      source('features/compare/ScoreComparison.tsx'),
    ])

    expect(page).toContain("request('reportsLoad'")
    expect(page).toContain('Promise.allSettled')
    expect(page).toContain('encodeCompareReports')
    expect(page).toContain('Object.keys(predictions.data.errors)')
    expect(navigator).toContain("event.key === 'ArrowLeft'")
    expect(navigator).toContain("event.key === 'ArrowRight'")
    expect(parallel).toContain('<ChatView')
    expect(parallel).toContain('errors[name]')
    expect(score).toContain("'radar'")
    expect(score).toContain("'grouped_bar'")
    expect(score).toContain('<SafeGeneratedDocumentFrame')
  })

  test('keeps the complete performance catalogue, detail, request and comparison surfaces', async () => {
    const [catalogue, page, detail, runs, requests, compare, charts] = await Promise.all([
      source('features/performance/PerformanceCatalogue.tsx'),
      source('features/performance/PerformancePage.tsx'),
      source('routes/performance-detail.tsx'),
      source('features/performance/PerformanceRuns.tsx'),
      source('features/performance/PerformanceRequests.tsx'),
      source('routes/performance-compare.tsx'),
      source('features/performance/PerformanceCompareCharts.tsx'),
    ])

    expect(catalogue).toContain('identity.provider')
    expect(catalogue).toContain('identity.protocol')
    expect(page).toContain('current.length >= 5')
    expect(page).toContain('keepPreviousData')
    expect(page).toContain('ConfiguredSourceRefresh')
    expect(detail).toContain("'evaluations.performance.provider'")
    expect(detail).toContain("'evaluations.performance.protocol'")
    expect(detail).toContain('normalizePerformanceDetailTab')
    expect(runs).toContain("chart_type: 'percentile_latency'")
    expect(runs).toContain("chart_type: 'percentile_token'")
    expect(requests).toContain('const PAGE_SIZE = 50')
    expect(requests).toContain("['all', 'success', 'failed']")
    expect(compare).toContain('shouldDeemphasizePercentile')
    expect(compare).toContain('sparseCompareHint')
    expect(compare).toContain('encodeReportKey(model.candidateId)')
    expect(charts).toContain('PERFORMANCE_LATENCY_CHARTS')
    expect(charts).toContain('PERFORMANCE_THROUGHPUT_CHARTS')
  })

  test('keeps five Benchmark categories, safe modal actions and the isolated viewer', async () => {
    const [benchmarks, detail, action, viewer] = await Promise.all([
      source('features/benchmarks/BenchmarksPage.tsx'),
      source('features/benchmarks/BenchmarkDetail.tsx'),
      source('features/benchmarks/UseBenchmarkAction.tsx'),
      source('routes/viewer.tsx'),
    ])

    expect(benchmarks).toContain("['all', 'text', 'multimodal', 'agent', 'aigc']")
    expect(benchmarks).toContain('const PAGE_SIZE = 24')
    expect(benchmarks).toContain('role="toolbar"')
    expect(benchmarks).toContain('aria-pressed')
    expect(detail).toContain('benchmarkMarkdown')
    expect(detail).toContain("event.key !== 'Tab'")
    expect(detail).toContain('previousFocus?.focus()')
    expect(action).toContain('to="/evaluations/tasks"')
    expect(action).toContain("tab: 'eval'")
    expect(viewer).toContain('sandbox="allow-scripts"')
    expect(viewer).not.toContain('allow-same-origin')
    expect(viewer).toContain('onError')
    expect(viewer).toContain('onLoad')
    expect(viewer).toContain('/evaluations/viewer?document=')
  })

  test('maps every locked upstream file and all 34 upstream tests to an existing local target', async () => {
    const manifest = JSON.parse(
      await readFile(path.join(evaluationsRoot, 'upstream-manifest.json'), 'utf8'),
    ) as {
      readonly files: ReadonlyArray<{
        readonly kind: 'production' | 'test'
        readonly status: 'adapted' | 'excluded' | 'migrated' | 'replaced'
        readonly target_path: string | null
      }>
    }
    const upstreamTests = manifest.files.filter((entry) => entry.kind === 'test')
    expect(upstreamTests).toHaveLength(34)
    for (const entry of manifest.files) {
      if (entry.status === 'excluded') continue
      expect(entry.target_path).toBeTruthy()
      await expect(
        access(path.join(repositoryRoot, entry.target_path ?? '')),
      ).resolves.toBeUndefined()
    }
    for (const entry of upstreamTests) {
      expect(entry.target_path).toMatch(/\.test\.tsx?$/u)
    }
  })
})
