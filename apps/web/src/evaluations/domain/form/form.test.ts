import { describe, expect, it } from 'vitest'
import { benchmarkSuggestions, replaceLastBenchmark } from './benchmark.js'
import {
  buildEvaluationPayload,
  EVALUATION_FORM_DEFAULTS,
  validateEvaluationForm,
} from './evaluation.js'
import {
  buildPerformancePayload,
  PERFORMANCE_FORM_DEFAULTS,
  validatePerformanceForm,
} from './performance.js'
import { parseDatasetArgs, parsePositiveIntegerList } from './validation.js'

describe('EvalScope task form domain', () => {
  it('preserves native benchmark payload defaults and generation fields', () => {
    const values = {
      ...EVALUATION_FORM_DEFAULTS,
      apiUrl: 'http://model.test/v1',
      datasetArgs: '{"gsm8k":{"few_shot_num":4}}',
      datasets: 'gsm8k',
      model: 'Qwen/Qwen3',
      stream: true,
      temperature: '0.7',
    }
    expect(buildEvaluationPayload(values, 'benchmark')).toEqual({
      api_url: 'http://model.test/v1',
      dataset_args: { gsm8k: { few_shot_num: 4 } },
      datasets: ['gsm8k'],
      eval_batch_size: 16,
      generation_config: { temperature: 0.7 },
      model: 'Qwen/Qwen3',
      metric_selection: { mode: 'benchmark_default' },
      stream: true,
      timeout: 300,
    })
  })

  it('isolates Databench source payload from native datasets and dataset_args', () => {
    const payload = buildEvaluationPayload(
      {
        ...EVALUATION_FORM_DEFAULTS,
        apiUrl: 'http://model.test/v1',
        datasetArgs: '{"local_path":"/must/not/leak"}',
        datasets: 'gsm8k',
        model: 'Qwen/Qwen3',
      },
      'databench',
      {
        acceptedFidelityDigest: 'b'.repeat(64),
        datasetVersion: 'a'.repeat(64),
        sourceRef: 'support-qa',
        targetSource: 'selected-candidate',
      },
    )
    expect(payload).not.toHaveProperty('datasets')
    expect(payload).not.toHaveProperty('dataset_args')
    expect(payload).toHaveProperty('metric_selection', { mode: 'benchmark_default' })
    expect(payload).toHaveProperty('databench_source', {
      accepted_fidelity_digest: 'b'.repeat(64),
      converter: 'evalscope-general-qa',
      dataset_version: 'a'.repeat(64),
      options: { target_source: 'selected-candidate' },
      source_ref: 'support-qa',
    })
  })

  it('fails closed when a caller tries to submit no-reference scoring', () => {
    expect(() =>
      buildEvaluationPayload(
        {
          ...EVALUATION_FORM_DEFAULTS,
          apiUrl: 'http://model.test/v1',
          model: 'Qwen/Qwen3',
        },
        'databench',
        {
          acceptedFidelityDigest: 'b'.repeat(64),
          datasetVersion: 'a'.repeat(64),
          sourceRef: 'support-qa',
          targetSource: 'none' as never,
        },
      ),
    ).toThrow('requires a reference answer')
  })

  it('submits only an opaque Deployment ID for a Databench model binding', () => {
    const payload = buildEvaluationPayload(
      {
        ...EVALUATION_FORM_DEFAULTS,
        apiKey: 'must-not-leak',
        apiUrl: 'http://must-not-leak.test/v1',
        datasets: 'gsm8k',
        model: 'must-not-leak',
      },
      'benchmark',
      undefined,
      {
        deploymentId: '123e4567-e89b-42d3-a456-426614174099',
        kind: 'databench-deployment',
      },
    )

    expect(payload).toMatchObject({
      databench_deployment_id: '123e4567-e89b-42d3-a456-426614174099',
      datasets: ['gsm8k'],
      metric_selection: { mode: 'benchmark_default' },
    })
    expect(payload).not.toHaveProperty('model')
    expect(payload).not.toHaveProperty('api_url')
    expect(payload).not.toHaveProperty('api_key')
  })

  it('requires model, policy-gated endpoint and native datasets while keeping Databench datasets external', () => {
    const native = validateEvaluationForm(EVALUATION_FORM_DEFAULTS, 'benchmark')
    expect(native.ok).toBe(false)
    expect(Object.keys(native.errors)).toEqual(['eval-model', 'eval-api-url', 'eval-datasets'])
    const databench = validateEvaluationForm(
      { ...EVALUATION_FORM_DEFAULTS, apiUrl: 'http://model.test/v1', model: 'model' },
      'databench',
    )
    expect(databench.ok).toBe(true)
    expect(
      validateEvaluationForm(EVALUATION_FORM_DEFAULTS, 'benchmark', 'databench-deployment').errors,
    ).toEqual({ 'eval-datasets': 'evaluations.form.validation.required' })
  })

  it('preserves raw dataset args validation and rejects non-object JSON', () => {
    expect(parseDatasetArgs('not-json')).toEqual({
      messageKey: 'evaluations.form.validation.datasetArgs.invalidJson',
      ok: false,
    })
    expect(parseDatasetArgs('[]')).toEqual({
      messageKey: 'evaluations.form.validation.datasetArgs.invalidStructure',
      ok: false,
    })
  })

  it('matches text and multimodal Benchmark autocomplete semantics', () => {
    const names = [
      'gsm8k',
      'arc',
      'mmmu',
      'math',
      'ceval',
      'mmlu',
      'humaneval',
      'ifeval',
      'truthfulqa',
    ]
    expect(benchmarkSuggestions('m', names)).toEqual(['gsm8k', 'mmmu', 'math', 'mmlu', 'humaneval'])
    expect(benchmarkSuggestions('a', names)).toHaveLength(6)
    expect(replaceLastBenchmark('mm', 'mmmu')).toBe('mmmu')
  })

  it('submits an explicit Metric set and primary Metric', () => {
    const payload = buildEvaluationPayload(
      {
        ...EVALUATION_FORM_DEFAULTS,
        apiUrl: 'http://model.test/v1',
        datasets: 'general_qa',
        metricIds: ['anls', 'exact_match'],
        metricMode: 'explicit',
        metricParameters: { anls: { threshold: 0.7 } },
        model: 'Qwen/Qwen3',
        primaryMetricId: 'exact_match',
      },
      'benchmark',
    )
    expect(payload).toHaveProperty('metric_selection', {
      mode: 'explicit',
      metric_ids: ['anls', 'exact_match'],
      parameters: { anls: { threshold: 0.7 } },
      primary_metric_id: 'exact_match',
    })
  })

  it('rejects multiple Benchmarks before building an evaluation payload', () => {
    const validation = validateEvaluationForm(
      {
        ...EVALUATION_FORM_DEFAULTS,
        apiUrl: 'http://model.test/v1',
        datasets: 'gsm8k,arc',
        model: 'Qwen/Qwen3',
      },
      'benchmark',
    )
    expect(validation.ok).toBe(false)
    expect(validation.errors).toHaveProperty('eval-datasets')
  })

  it('validates and serializes the complete performance form', () => {
    expect(parsePositiveIntegerList('1, 4, 8')).toEqual([1, 4, 8])
    expect(parsePositiveIntegerList('1, 0')).toBeNull()
    const values = {
      ...PERFORMANCE_FORM_DEFAULTS,
      apiKey: 'secret',
      dataset: 'openqa',
      maxPromptLength: '2048',
      minPromptLength: '16',
      minTokens: '8',
      model: 'Qwen/Qwen3',
      number: '10, 100',
      parallel: '1, 4',
      rate: '2',
      url: 'http://model.test/v1',
    }
    expect(validatePerformanceForm(values).ok).toBe(true)
    expect(buildPerformancePayload(values)).toEqual({
      api: 'openai',
      api_key: 'secret',
      dataset: 'openqa',
      max_prompt_length: 2048,
      max_tokens: 512,
      min_prompt_length: 16,
      min_tokens: 8,
      model: 'Qwen/Qwen3',
      number: [10, 100],
      parallel: [1, 4],
      rate: 2,
      url: 'http://model.test/v1',
    })
  })
})
