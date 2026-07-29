import { describe, expect, test } from 'vitest'
import type { PredictionRow, ReportData } from '../api/schemas.js'
import {
  aboveRates,
  alignPredictions,
  commonDatasets,
  commonSubsets,
  decodeCompareReports,
  encodeCompareReports,
  filterAlignedPredictions,
} from './compare.js'

const report = (reportName: string, dataset: string, subsets: string[]) =>
  ({
    analysis: '',
    dataset_name: dataset,
    metrics: [
      {
        categories: [
          {
            name: ['cat'],
            num: 1,
            score: 1,
            subsets: subsets.map((name) => ({ name, num: 1, score: 1 })),
          },
        ],
        name: 'accuracy',
        num: 1,
        score: 1,
      },
    ],
    model_name: reportName,
    name: reportName,
    reportName,
    score: 1,
  }) satisfies ReportData & { reportName: string }

const prediction = (Index: string, NScore: number): PredictionRow => ({
  Generated: '',
  Gold: '',
  Index,
  Input: '',
  Metadata: {},
  NScore,
  Pred: '',
  Score: {},
})

describe('evaluation compare domain', () => {
  test('round-trips and hard-clamps URL report slots', () => {
    const encoded = encodeCompareReports(['a', 'b', 'c', 'd'])
    expect(decodeCompareReports(encoded)).toEqual(['a', 'b', 'c'])
    expect(decodeCompareReports('***;bad')).toEqual([])
  })

  test('computes dataset and subset intersections without changing selection', () => {
    const rows = [
      report('a', 'shared', ['main', 'hard']),
      report('a', 'only-a', ['main']),
      report('b', 'shared', ['main']),
    ]
    expect(commonDatasets(rows, ['a', 'b'])).toEqual(['shared'])
    expect(commonSubsets(rows, ['a', 'b'], 'shared')).toEqual(['main'])
  })

  test('aligns by Index and applies independent per-model filters', () => {
    const rows = alignPredictions(
      { a: [prediction('0', 0.9), prediction('1', 0.1)], b: [prediction('0', 0.8)] },
      ['a', 'b'],
    )
    expect(rows.map((row) => row.index)).toEqual(['0'])
    expect(
      filterAlignedPredictions(rows, ['a', 'b'], { a: 'above', b: 'below' }, 0.85),
    ).toHaveLength(1)
    expect(aboveRates(rows, ['a', 'b'], 0.85)).toEqual({ a: 1, b: 0 })
  })

  test('keeps a successful prediction column available when another column fails', () => {
    const rows = alignPredictions({ a: [prediction('0', 0.9)] }, ['a'])
    expect(rows).toHaveLength(1)
    expect(rows[0]?.models.a?.Index).toBe('0')
  })
})
