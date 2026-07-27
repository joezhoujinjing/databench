import { describe, expect, test } from 'vitest'
import {
  CancelEvaluationRunRequestV2Schema,
  CompleteEvaluationRunRequestV2Schema,
  CreateEvaluationRunRequestV2Schema,
  EvaluationProviderReportIdsV2Schema,
  EvaluationRunPageRequestV2Schema,
  EvaluationRunV2Schema,
} from '../src/index.js'

const VERSION = 'a'.repeat(64)
const DIGEST = 'b'.repeat(64)

function createRequest() {
  return {
    provider: 'evalscope',
    provider_task_id: 'task-20260727-001',
    dataset_version: VERSION,
    source_ref: 'main',
    converter: 'evalscope-general-qa',
    converter_options: { target_source: 'none' },
    accepted_fidelity_digest: DIGEST,
    model_name: 'Qwen/Qwen3-8B',
    evalscope_commit: 'c'.repeat(40),
  }
}

describe('V2 evaluation contracts', () => {
  test('accepts only an exact Dataset-bound EvalScope create request', () => {
    expect(CreateEvaluationRunRequestV2Schema.parse(createRequest())).toEqual(createRequest())
    for (const invalid of [
      { ...createRequest(), provider: 'other' },
      { ...createRequest(), dataset_version: 'main' },
      { ...createRequest(), provider_task_id: '../task' },
      { ...createRequest(), source_ref: VERSION },
      { ...createRequest(), unknown: true },
    ]) {
      expect(CreateEvaluationRunRequestV2Schema.safeParse(invalid).success).toBe(false)
    }
  })

  test('bounds opaque provider report IDs and rejects paths, URLs, credentials, and duplicates', () => {
    const maximumIds = Array.from({ length: 32 }, (_, index) => `r${index}-`.padEnd(512, 'x'))
    expect(EvaluationProviderReportIdsV2Schema.parse(['report-1', 'report_2'])).toEqual([
      'report-1',
      'report_2',
    ])
    expect(EvaluationProviderReportIdsV2Schema.parse(maximumIds)).toEqual(maximumIds)
    for (const ids of [
      ['report/1'],
      ['https://reports.example/1'],
      ['sk-proj-1234567890abcdef'],
      ['report-1', 'report-1'],
      Array.from({ length: 33 }, (_, index) => `report-${index}`),
      ['界'.repeat(171)],
    ]) {
      expect(EvaluationProviderReportIdsV2Schema.safeParse(ids).success).toBe(false)
    }
  })

  test('keeps metrics and errors strict, finite, bounded, and free of nested sample payloads', () => {
    const completion = {
      metrics: [
        {
          dataset: 'general_qa',
          subset: 'databench',
          metric: 'accuracy',
          score: 0.75,
          sample_count: 4,
          categories: ['knowledge'],
        },
      ],
      provider_report_ids: ['report-1'],
    }
    expect(CompleteEvaluationRunRequestV2Schema.parse(completion)).toEqual(completion)
    expect(
      CompleteEvaluationRunRequestV2Schema.safeParse({
        ...completion,
        metrics: [{ ...completion.metrics[0], score: Number.NaN }],
      }).success,
    ).toBe(false)
    expect(
      CompleteEvaluationRunRequestV2Schema.safeParse({
        ...completion,
        metrics: [{ ...completion.metrics[0], dataset: 'sk-proj-1234567890abcdef' }],
      }).success,
    ).toBe(false)
    expect(
      CompleteEvaluationRunRequestV2Schema.safeParse({
        ...completion,
        metrics: [{ ...completion.metrics[0], prompt: 'secret sample content' }],
      }).success,
    ).toBe(false)
    expect(
      CancelEvaluationRunRequestV2Schema.safeParse({
        error: {
          phase: 'provider_stop',
          code: 'user_cancelled',
          message: 'Authorization: Bearer-secret-value',
        },
      }).success,
    ).toBe(false)
    expect(
      CancelEvaluationRunRequestV2Schema.safeParse({
        error: {
          phase: 'provider_stop',
          code: 'user_cancelled',
          message: 'cancelled',
          api_key: 'sk-secret',
        },
      }).success,
    ).toBe(false)
  })

  test('enforces execution and archive shapes on stored run responses', () => {
    const prepared = {
      id: '11111111-1111-4111-8111-111111111111',
      provider: 'evalscope',
      provider_task_id: 'task-1',
      create_request_digest: DIGEST,
      provider_report_ids: null,
      dataset_version: VERSION,
      source_ref: null,
      converter: 'evalscope-general-qa',
      converter_version: '1.0.0',
      converter_options: { target_source: 'none' },
      fidelity_digest: 'd'.repeat(64),
      benchmark: 'general_qa',
      model_name: null,
      evalscope_commit: null,
      status: 'prepared',
      metrics: null,
      error: null,
      archive_status: 'not_requested',
      archive_attempt: 0,
      result_artifact_key: null,
      result_artifact_digest: null,
      result_artifact_size_bytes: null,
      archive_error: null,
      created_at: '2026-07-27T00:00:00.000Z',
      started_at: null,
      finished_at: null,
      updated_at: '2026-07-27T00:00:00.000Z',
    }
    expect(EvaluationRunV2Schema.parse(prepared)).toEqual(prepared)
    expect(
      EvaluationRunV2Schema.safeParse({
        ...prepared,
        status: 'completed',
        finished_at: prepared.created_at,
      }).success,
    ).toBe(false)
    expect(
      EvaluationRunV2Schema.safeParse({
        ...prepared,
        result_artifact_key: 'objects/result.tar.zst',
      }).success,
    ).toBe(false)
  })

  test('binds opaque pagination cursors to strict filters', () => {
    expect(EvaluationRunPageRequestV2Schema.parse({})).toEqual({
      cursor: null,
      limit: 20,
    })
    expect(
      EvaluationRunPageRequestV2Schema.parse({
        dataset_version: VERSION,
        status: 'running',
        cursor: '',
        limit: '100',
      }),
    ).toEqual({ dataset_version: VERSION, status: 'running', cursor: null, limit: 100 })
  })
})
