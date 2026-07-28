import { describe, expect, test } from 'vitest'
import {
  evaluationPerformanceCompareSearchSchema,
  evaluationTasksSearchSchema,
  evaluationViewerSearchSchema,
  parseReportRouteParams,
  stringifyReportRouteParams,
} from './contracts.js'

describe('Evaluation route contracts', () => {
  test('applies stable task defaults and validates Databench exact versions', () => {
    expect(evaluationTasksSearchSchema.parse({})).toEqual({ tab: 'eval' })
    expect(
      evaluationTasksSearchSchema.parse({
        tab: 'eval',
        source: 'databench',
        datasetVersion: 'a'.repeat(64),
      }),
    ).toEqual({ tab: 'eval', source: 'databench', datasetVersion: 'a'.repeat(64) })
    expect(() =>
      evaluationTasksSearchSchema.parse({ source: 'databench', datasetVersion: '/tmp/data' }),
    ).toThrow()
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

  test('parses route keys to relative locators and stringifies canonically', () => {
    const encoded = stringifyReportRouteParams({ reportKey: 'nested/report.json' }, 'reportKey')
    expect(encoded.reportKey).not.toContain('/')
    expect(parseReportRouteParams(encoded, 'reportKey')).toEqual({
      reportKey: 'nested/report.json',
    })
    expect(parseReportRouteParams({ reportKey: '***' }, 'reportKey')).toBe(false)
  })
})
