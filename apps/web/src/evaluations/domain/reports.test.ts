import { describe, expect, it } from 'vitest'
import type { PredictionRow, ReportData } from '../api/schemas.js'
import {
  decodeFilterList,
  filterPredictions,
  findPredictionByIndex,
  findPredictionByMessagePrefix,
  predictionCounts,
  subsetRows,
  summarizeReportData,
  toggleCurrentPageSelection,
  toggleReportSelection,
} from './reports.js'

const report = (dataset: string, score: number, metric = 'mean_acc'): ReportData => ({
  analysis: '',
  dataset_name: dataset,
  metrics: [{ categories: [], name: metric, num: 2, score }],
  model_name: 'model',
  name: `model@${dataset}`,
  score,
})

const prediction = (index: string, score: number, ids: string[]): PredictionRow => ({
  AgentTrace: null,
  Generated: 'answer',
  Gold: 'gold',
  Index: index,
  Input: 'question',
  Messages: ids.map((id) => ({ content: id, id, role: 'assistant' as const })),
  Metadata: {},
  NScore: score,
  PerfMetrics: null,
  Pred: 'answer',
  Score: {},
})

describe('EvalScope reports domain', () => {
  it('preserves cross-filter selection and enforces the five-report cap', () => {
    expect(toggleReportSelection(['a'], 'a')).toEqual({ next: [], rejected: false })
    const full = ['a', 'b', 'c', 'd', 'e']
    expect(toggleReportSelection(full, 'f')).toEqual({ next: full, rejected: true })
    expect(toggleCurrentPageSelection(['off-page'], ['a', 'b'])).toEqual({
      next: ['off-page', 'a', 'b'],
      rejected: false,
    })
  })

  it('summarizes comparable reports and rejects heterogeneous averages', () => {
    expect(summarizeReportData([report('a', 0.2), report('b', 0.8)])).toMatchObject({
      average: 0.5,
      best: { dataset: 'b', score: 0.8 },
      totalSamples: 4,
      worst: { dataset: 'a', score: 0.2 },
    })
    expect(summarizeReportData([report('a', 0.2), report('b', 12, 'latency')])?.average).toBeNull()
  })

  it('derives unique valid subsets and ignores aggregate rows', () => {
    expect(
      subsetRows({
        columns: ['Subset', 'Score', 'Num', 'Metric', 'Cat.0'],
        data: [
          { 'Cat.0': 'default', Metric: 'acc', Num: 2, Score: 0.5, Subset: 'main' },
          { 'Cat.0': '-', Metric: 'acc', Num: 2, Score: 0.5, Subset: 'aggregate' },
          { 'Cat.0': 'default', Metric: 'acc', Num: 2, Score: 0.5, Subset: 'main' },
        ],
      }),
    ).toEqual([{ metric: 'acc', samples: 2, score: 0.5, subset: 'main' }])
  })

  it('filters predictions and reports exact, missing, and ambiguous searches', () => {
    const rows = [prediction('10', 1, ['abc-1']), prediction('11', 0, ['abc-2', 'unique'])]
    expect(predictionCounts(rows, 0.99)).toEqual({ above: 1, all: 2, below: 1 })
    expect(filterPredictions(rows, 'below', 0.99).map((row) => row.Index)).toEqual(['11'])
    expect(findPredictionByIndex(rows, '11')).toBe(1)
    expect(findPredictionByIndex(rows, '12')).toBeNull()
    expect(findPredictionByMessagePrefix(rows, 'unique')).toEqual({
      kind: 'found',
      messageId: 'unique',
      predictionIndex: 1,
    })
    expect(findPredictionByMessagePrefix(rows, 'abc')).toEqual({ kind: 'ambiguous' })
    expect(findPredictionByMessagePrefix(rows, 'missing')).toEqual({ kind: 'not-found' })
  })

  it('normalizes semicolon filters without losing order', () => {
    expect(decodeFilterList('Qwen; GPT;Qwen;;')).toEqual(['Qwen', 'GPT'])
  })
})
