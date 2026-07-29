import { describe, expect, it } from 'vitest'
import { contentBlockSchema, predictionRowSchema, reportDataSchema } from './reports.schema.js'

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

  it('rejects schema mismatches in identity and normalized score fields', () => {
    expect(reportDataSchema.safeParse({ dataset_name: 'gsm8k', score: '0.5' }).success).toBe(false)
    expect(predictionRowSchema.safeParse({ Index: '0', NScore: 'high' }).success).toBe(false)
  })
})
