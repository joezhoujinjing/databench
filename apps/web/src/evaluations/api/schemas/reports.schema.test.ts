import { describe, expect, it } from 'vitest'
import {
  contentBlockSchema,
  predictionRowSchema,
  predictionsResponseSchema,
  reportDataSchema,
  reportSummarySchema,
} from './reports.schema.js'

describe('EvalScope report response compatibility', () => {
  it('fills presentation-safe defaults for a partial report', () => {
    expect(
      reportDataSchema.parse({
        dataset_name: 'gsm8k',
        model_name: 'Qwen3',
        name: 'Qwen3@gsm8k',
        score: 0,
      }),
    ).toMatchObject({ analysis: '', metrics: [] })
  })

  it('keeps unknown content and prediction fields for local JSON fallback', () => {
    expect(contentBlockSchema.parse({ type: 'future-block', payload: { value: 1 } })).toEqual({
      payload: { value: 1 },
      type: 'future-block',
    })
    expect(
      predictionRowSchema.parse({
        Index: '0',
        NScore: 0.5,
        future_score: { value: 2 },
      }),
    ).toMatchObject({
      Generated: '',
      Input: '',
      future_score: { value: 2 },
    })
  })

  it('accepts nullable reasoning tokens and paginated prediction metadata', () => {
    expect(
      contentBlockSchema.parse({
        type: 'reasoning',
        reasoning: 'thinking',
        reasoning_tokens: null,
      }),
    ).toMatchObject({ reasoning_tokens: null })
    expect(
      predictionsResponseSchema.parse({
        predictions: [],
        total: 0,
        page: 1,
        page_size: 50,
        counts: { all: 0, above: 0, below: 0 },
      }),
    ).toMatchObject({ page: 1, total: 0 })
  })

  it('keeps Databench source identity separate from the EvalScope benchmark name', () => {
    expect(
      reportSummarySchema.parse({
        dataset_name: 'general_qa',
        model_name: 'GLM',
        name: 'eval-report',
        num_samples: 2,
        score: 0.5,
        timestamp: '2026-07-30T12:00:00',
        databench_source: {
          benchmark: 'general_qa',
          dataset_version: 'a'.repeat(64),
          source_ref: 'support-qa',
        },
      }).databench_source,
    ).toMatchObject({ source_ref: 'support-qa' })
  })

  it('requires explicit primary Metric metadata to resolve to a report output', () => {
    const value = {
      dataset_name: 'general_qa',
      metrics: [{ categories: [], name: 'exact_match', num: 1, score: 1 }],
      model_name: 'GLM',
      name: 'eval-report',
      primary_metric_id: 'exact_match',
      primary_output_key: 'exact_match',
      score: 1,
    }
    expect(reportDataSchema.safeParse(value).success).toBe(true)
    expect(reportDataSchema.safeParse({ ...value, primary_output_key: 'missing' }).success).toBe(
      false,
    )
    expect(reportDataSchema.safeParse({ ...value, primary_metric_id: undefined }).success).toBe(
      false,
    )
  })

  it('rejects schema mismatches in identity and normalized score fields', () => {
    expect(reportDataSchema.safeParse({ dataset_name: 'gsm8k', score: '0.5' }).success).toBe(false)
    expect(predictionRowSchema.safeParse({ Index: '0', NScore: 'high' }).success).toBe(false)
  })
})
