import { describe, expect, test } from 'vitest'
import {
  evaluationPerformanceCompareSearchSchema,
  evaluationReportDetailSearchSchema,
  evaluationTasksSearchSchema,
  evaluationViewerSearchSchema,
  parseReportRouteParams,
  stringifyReportRouteParams,
} from './contracts.js'

describe('Evaluation route contracts', () => {
  test('applies stable task defaults and validates Databench exact versions', () => {
    const taskId = 'eval_123e4567-e89b-42d3-a456-426614174000'
    expect(evaluationTasksSearchSchema.parse({})).toEqual({ tab: 'eval' })
    expect(
      evaluationTasksSearchSchema.parse({
        tab: 'eval',
        source: 'databench',
        datasetVersion: 'a'.repeat(64),
        taskId,
      }),
    ).toEqual({
      tab: 'eval',
      source: 'databench',
      datasetVersion: 'a'.repeat(64),
      taskId,
    })
    expect(() =>
      evaluationTasksSearchSchema.parse({ source: 'databench', datasetVersion: '/tmp/data' }),
    ).toThrow()
    expect(() => evaluationTasksSearchSchema.parse({ taskId: 'eval_1700000000000' })).toThrow()
  })

  test('keeps generated document ids opaque', () => {
    expect(evaluationViewerSearchSchema.parse({ document: 'a'.repeat(43) })).toEqual({
      document: 'a'.repeat(43),
    })
    expect(() => evaluationViewerSearchSchema.parse({ document: '/raw/report.html' })).toThrow()
  })

  test('accepts numeric search parsing while preserving the typed embedding flag', () => {
    expect(evaluationPerformanceCompareSearchSchema.parse({ embedding: 0 })).toEqual({
      embedding: 0,
    })
  })

  test('keeps report detail tab and dataset selection refreshable', () => {
    expect(evaluationReportDetailSearchSchema.parse({})).toEqual({ tab: 'overview' })
    expect(
      evaluationReportDetailSearchSchema.parse({
        dataset: 'gsm8k',
        subset: 'main',
        tab: 'predictions',
      }),
    ).toEqual({ dataset: 'gsm8k', subset: 'main', tab: 'predictions' })
    expect(() => evaluationReportDetailSearchSchema.parse({ tab: 'unknown' })).toThrow()
  })

  test('parses route keys to relative locators and stringifies canonically', () => {
    const encoded = stringifyReportRouteParams({ reportKey: 'nested/report.json' }, 'reportKey')
    expect(encoded.reportKey).not.toContain('/')
    expect(parseReportRouteParams(encoded, 'reportKey')).toEqual({
      reportKey: 'nested/report.json',
    })
    expect(parseReportRouteParams({ reportKey: '***' }, 'reportKey')).toBe(false)
  })
})
