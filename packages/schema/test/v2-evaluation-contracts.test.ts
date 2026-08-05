import { describe, expect, test } from 'vitest'
import {
  CancelEvaluationRunRequestV2Schema,
  CompleteEvaluationRunRequestV2Schema,
  CreateEvaluationRunRequestV2Schema,
  EvaluationProviderReportIdsV2Schema,
  EvaluationRunPageRequestV2Schema,
  EvaluationRunV2Schema,
  FailEvaluationResultUploadRequestV2Schema,
  FinalizeEvaluationResultUploadRequestV2Schema,
  PrepareEvaluationResultUploadResponseV2Schema,
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

function preparedRun() {
  return {
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
    create_profile: 'evaluation-run-create-v1',
    model_deployment_id: null,
    model_artifact_id: null,
    evalscope_commit: null,
    scoring_config: null,
    primary_metric_id: null,
    primary_output_key: null,
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
}

function scoringConfigFixture() {
  return {
    schema_version: 1 as const,
    mode: 'explicit' as const,
    evalscope_commit: 'c'.repeat(40),
    benchmark: 'general_qa',
    metrics: [
      {
        id: 'exact_match',
        implementation_digest: 'e'.repeat(64),
        parameters: {},
        output_keys: ['exact_match'],
      },
    ],
    primary_metric_id: 'exact_match',
    primary_output_key: 'exact_match',
  }
}

describe('V2 evaluation contracts', () => {
  test('accepts only an exact Dataset-bound EvalScope create request', () => {
    expect(CreateEvaluationRunRequestV2Schema.parse(createRequest())).toEqual({
      ...createRequest(),
      model_deployment_id: null,
      scoring_config: null,
    })
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
    expect(CompleteEvaluationRunRequestV2Schema.parse(completion)).toEqual({
      ...completion,
      metrics: completion.metrics.map((metric) => ({
        ...metric,
        metric_id: null,
        output_key: null,
      })),
      primary_metric_id: null,
      primary_output_key: null,
      scoring_config: null,
    })
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
    const prepared = preparedRun()
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

  test('keeps legacy response shape exact and validates v5/v6 Registry snapshots', () => {
    const legacy = preparedRun()
    expect(EvaluationRunV2Schema.parse(legacy)).toEqual(legacy)
    expect(
      EvaluationRunV2Schema.safeParse({ ...legacy, source_evidence_digest: null }).success,
    ).toBe(false)

    const versionBound = {
      ...legacy,
      create_profile: 'evaluation-run-create-v5',
      model_name: 'registry-route',
      model_deployment_id: '22222222-2222-4222-8222-222222222222',
      model_artifact_id: null,
      model_deployment_digest: 'e'.repeat(64),
      model_id: '33333333-3333-4333-8333-333333333333',
      model_version_id: '44444444-4444-4444-8444-444444444444',
      source_mutability_snapshot: 'unknown',
      verification_level_snapshot: 'operator_attested',
      source_evidence_digest: null,
      source_observed_at: '2026-08-05T12:34:56.789Z',
    }
    expect(EvaluationRunV2Schema.parse(versionBound)).toEqual(versionBound)
    for (const field of [
      'model_deployment_digest',
      'model_id',
      'model_version_id',
      'source_mutability_snapshot',
      'verification_level_snapshot',
      'source_evidence_digest',
      'source_observed_at',
    ] as const) {
      const invalid: Record<string, unknown> = { ...versionBound }
      delete invalid[field]
      expect(EvaluationRunV2Schema.safeParse(invalid).success).toBe(false)
    }
    expect(
      EvaluationRunV2Schema.safeParse({
        ...versionBound,
        verification_level_snapshot: 'provider_verified',
      }).success,
    ).toBe(false)

    const scoring = scoringConfigFixture()
    const metricVersionBound = {
      ...versionBound,
      create_profile: 'evaluation-run-create-v6',
      evalscope_commit: scoring.evalscope_commit,
      scoring_config: scoring,
      primary_metric_id: scoring.primary_metric_id,
      primary_output_key: scoring.primary_output_key,
    }
    expect(EvaluationRunV2Schema.parse(metricVersionBound)).toEqual(metricVersionBound)
    expect(
      EvaluationRunV2Schema.safeParse({
        ...metricVersionBound,
        create_profile: 'evaluation-run-create-v5',
      }).success,
    ).toBe(false)
  })

  test('binds explicit scoring config, primary Metric, and required outputs', () => {
    const scoringConfig = {
      schema_version: 1,
      mode: 'explicit',
      evalscope_commit: 'c'.repeat(40),
      benchmark: 'general_qa',
      metrics: [
        {
          id: 'anls',
          implementation_digest: 'd'.repeat(64),
          parameters: { threshold: 0.7 },
          output_keys: ['anls'],
        },
        {
          id: 'exact_match',
          implementation_digest: 'e'.repeat(64),
          parameters: {},
          output_keys: ['exact_match'],
        },
      ],
      primary_metric_id: 'exact_match',
      primary_output_key: 'exact_match',
    } as const
    expect(
      CreateEvaluationRunRequestV2Schema.safeParse({
        ...createRequest(),
        scoring_config: scoringConfig,
      }).success,
    ).toBe(true)
    const completion = {
      metrics: [
        {
          dataset: 'general_qa',
          subset: 'databench',
          metric_id: 'anls',
          output_key: 'anls',
          metric: 'anls',
          score: 0.8,
          sample_count: 2,
          categories: [],
        },
        {
          dataset: 'general_qa',
          subset: 'databench',
          metric_id: 'exact_match',
          output_key: 'exact_match',
          metric: 'exact_match',
          score: 0.5,
          sample_count: 2,
          categories: [],
        },
      ],
      provider_report_ids: ['report-1'],
      scoring_config: scoringConfig,
      primary_metric_id: 'exact_match',
      primary_output_key: 'exact_match',
    }
    expect(CompleteEvaluationRunRequestV2Schema.safeParse(completion).success).toBe(true)
    expect(
      CompleteEvaluationRunRequestV2Schema.safeParse({
        ...completion,
        metrics: completion.metrics.filter((metric) => metric.metric !== 'anls'),
      }).success,
    ).toBe(false)
    expect(
      CompleteEvaluationRunRequestV2Schema.safeParse({
        ...completion,
        primary_metric_id: 'anls',
      }).success,
    ).toBe(false)
    expect(
      CompleteEvaluationRunRequestV2Schema.safeParse({
        ...completion,
        metrics: completion.metrics.map((metric) =>
          metric.metric_id === 'anls' ? { ...metric, metric_id: 'exact_match' } : metric,
        ),
      }).success,
    ).toBe(false)
    const primaryMetric = completion.metrics[1]
    if (primaryMetric === undefined) throw new Error('primary Metric fixture is missing')
    expect(
      CompleteEvaluationRunRequestV2Schema.safeParse({
        ...completion,
        metrics: [...completion.metrics, { ...primaryMetric, score: 0.75 }],
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

  test('keeps archive upload descriptors exact, bounded, and attempt scoped', () => {
    const response = {
      run_id: '11111111-1111-4111-8111-111111111111',
      archive_status: 'uploading',
      archive_attempt: 1,
      upload: {
        method: 'PUT',
        url: 'https://objects.example/exact?signature=opaque',
        expires_at: '2026-07-28T00:15:00.000Z',
        content_type: 'application/zstd',
        required_headers: {
          'content-type': 'application/zstd',
          'if-none-match': '*',
        },
        max_size_bytes: 1024 * 1024 * 1024,
      },
    }
    expect(PrepareEvaluationResultUploadResponseV2Schema.parse(response)).toEqual(response)
    expect(
      PrepareEvaluationResultUploadResponseV2Schema.safeParse({
        ...response,
        upload: { ...response.upload, required_headers: { 'content-type': 'application/zstd' } },
      }).success,
    ).toBe(false)
    expect(
      FinalizeEvaluationResultUploadRequestV2Schema.parse({
        archive_attempt: 1,
        digest: DIGEST,
        size_bytes: 1,
      }),
    ).toEqual({ archive_attempt: 1, digest: DIGEST, size_bytes: 1 })
    expect(
      FinalizeEvaluationResultUploadRequestV2Schema.safeParse({
        archive_attempt: 0,
        digest: DIGEST,
        size_bytes: 1,
      }).success,
    ).toBe(false)
    expect(
      FailEvaluationResultUploadRequestV2Schema.safeParse({
        archive_attempt: 1,
        error: { phase: 'provider_archive', code: 'archive_failed', message: 'api_key=secret' },
      }).success,
    ).toBe(false)
  })
})
