import type { CatalogEvaluationMetricV2, CatalogEvaluationRunRowV2 } from '@databench/catalog'
import {
  hashV2EvaluationRunCreate,
  hashV2EvaluationRunCreateWithDeployment,
  hashV2EvaluationRunCreateWithDeploymentAndMetrics,
  hashV2EvaluationRunCreateWithMetrics,
  V2_EVALUATION_RUN_CREATE_PROFILE,
  V2_EVALUATION_RUN_CREATE_WITH_DEPLOYMENT_AND_METRICS_PROFILE,
  V2_EVALUATION_RUN_CREATE_WITH_DEPLOYMENT_PROFILE,
  V2_EVALUATION_RUN_CREATE_WITH_METRICS_PROFILE,
} from '@databench/hashing'
import {
  type ConverterNameV2,
  type EvaluationRunV2,
  EvaluationRunV2Schema,
  type ExportPlanV2,
  IntegrityError,
  ValidationError,
} from '@databench/schema'

const SAFE_BENCHMARK = /^[a-z][a-z0-9._-]{0,127}$/

export function evaluationBenchmarkFromPlanV2(plan: ExportPlanV2): string {
  const evalscope = plan.config_hints.evalscope
  if (typeof evalscope !== 'object' || evalscope === null || Array.isArray(evalscope)) {
    throw new ValidationError('Evaluation converter does not provide EvalScope config hints', {
      issues: [
        {
          path: '/converter',
          line: null,
          code: 'evaluation_converter_required',
          message: 'Converter must support the evaluation-qa task view',
        },
      ],
    })
  }
  const benchmark = (evalscope as Readonly<Record<string, unknown>>).benchmark
  if (typeof benchmark !== 'string' || !SAFE_BENCHMARK.test(benchmark)) {
    throw new IntegrityError('Evaluation converter returned invalid benchmark config', {
      reason: 'evaluation_benchmark_hint_invalid',
      dataset_version: plan.dataset_version,
    })
  }
  return benchmark
}

export function evaluationRunFromCatalogV2(row: CatalogEvaluationRunRowV2): EvaluationRunV2 {
  const baseIdentity = {
    provider: row.provider,
    provider_task_id: row.providerTaskId,
    dataset_version: row.datasetVersion,
    source_ref: row.sourceRef,
    converter: requireConverter(row.converter),
    converter_version: row.converterVersion,
    normalized_options: row.converterOptions,
    fidelity_digest: row.fidelityDigest,
    benchmark: row.benchmark,
    model_name: row.modelName,
    evalscope_commit: row.evalscopeCommit,
  }
  const deploymentIdentity =
    row.modelDeploymentId !== null &&
    row.modelArtifactId !== null &&
    row.modelDeploymentDigest !== null
      ? {
          model_deployment_id: row.modelDeploymentId,
          model_artifact_id: row.modelArtifactId,
          model_deployment_digest: row.modelDeploymentDigest,
        }
      : null
  const scoringIdentity =
    row.scoringConfig !== null && row.primaryMetricId !== null && row.primaryOutputKey !== null
      ? {
          scoring_config: row.scoringConfig,
          primary_metric_id: row.primaryMetricId,
          primary_output_key: row.primaryOutputKey,
        }
      : null
  const recomputedDigest =
    row.createProfile === V2_EVALUATION_RUN_CREATE_PROFILE
      ? hashV2EvaluationRunCreate({
          evaluation_run_create_profile: V2_EVALUATION_RUN_CREATE_PROFILE,
          ...baseIdentity,
        })
      : row.createProfile === V2_EVALUATION_RUN_CREATE_WITH_DEPLOYMENT_PROFILE &&
          deploymentIdentity !== null
        ? hashV2EvaluationRunCreateWithDeployment({
            evaluation_run_create_profile: V2_EVALUATION_RUN_CREATE_WITH_DEPLOYMENT_PROFILE,
            ...baseIdentity,
            ...deploymentIdentity,
          })
        : row.createProfile === V2_EVALUATION_RUN_CREATE_WITH_METRICS_PROFILE &&
            scoringIdentity !== null
          ? hashV2EvaluationRunCreateWithMetrics({
              evaluation_run_create_profile: V2_EVALUATION_RUN_CREATE_WITH_METRICS_PROFILE,
              ...baseIdentity,
              ...scoringIdentity,
            })
          : row.createProfile === V2_EVALUATION_RUN_CREATE_WITH_DEPLOYMENT_AND_METRICS_PROFILE &&
              deploymentIdentity !== null &&
              scoringIdentity !== null
            ? hashV2EvaluationRunCreateWithDeploymentAndMetrics({
                evaluation_run_create_profile:
                  V2_EVALUATION_RUN_CREATE_WITH_DEPLOYMENT_AND_METRICS_PROFILE,
                ...baseIdentity,
                ...deploymentIdentity,
                ...scoringIdentity,
              })
            : null
  if (recomputedDigest !== row.createRequestDigest) {
    throw new IntegrityError('Stored evaluation run create digest is inconsistent', {
      reason: 'evaluation_create_digest_mismatch',
      dataset_version: row.datasetVersion,
    })
  }
  return EvaluationRunV2Schema.parse({
    id: row.id,
    provider: row.provider,
    provider_task_id: row.providerTaskId,
    create_profile: row.createProfile,
    create_request_digest: row.createRequestDigest,
    provider_report_ids: row.providerReportIds,
    dataset_version: row.datasetVersion,
    source_ref: row.sourceRef,
    converter: row.converter,
    converter_version: row.converterVersion,
    converter_options: row.converterOptions,
    fidelity_digest: row.fidelityDigest,
    benchmark: row.benchmark,
    model_name: row.modelName,
    model_deployment_id: row.modelDeploymentId,
    model_artifact_id: row.modelArtifactId,
    evalscope_commit: row.evalscopeCommit,
    scoring_config: row.scoringConfig,
    primary_metric_id: row.primaryMetricId,
    primary_output_key: row.primaryOutputKey,
    status: row.status,
    metrics: row.metrics?.map((metric) => metricFromCatalog(metric)) ?? null,
    error: row.error,
    archive_status: row.archiveStatus,
    archive_attempt: row.archiveAttempt,
    result_artifact_key: row.resultArtifactKey,
    result_artifact_digest: row.resultArtifactDigest,
    result_artifact_size_bytes:
      row.resultArtifactSizeBytes === null
        ? null
        : storedBigIntToSafeNumber(row.resultArtifactSizeBytes, 'result_artifact_size_bytes'),
    archive_error: row.archiveError,
    created_at: row.createdAt.toISOString(),
    started_at: row.startedAt?.toISOString() ?? null,
    finished_at: row.finishedAt?.toISOString() ?? null,
    updated_at: row.updatedAt.toISOString(),
  })
}

function requireConverter(value: string): ConverterNameV2 {
  if (
    value === 'canonical-jsonl' ||
    value === 'evalscope-general-qa' ||
    value === 'trl-sft' ||
    value === 'trl-dpo' ||
    value === 'trl-grpo-rlvr' ||
    value === 'ms-swift'
  ) {
    return value
  }
  throw new IntegrityError('Stored evaluation run converter is invalid', {
    reason: 'evaluation_converter_invalid',
  })
}

function metricFromCatalog(metric: CatalogEvaluationMetricV2) {
  return {
    dataset: metric.dataset,
    subset: metric.subset,
    metric_id: metric.metricId,
    output_key: metric.outputKey,
    metric: metric.metric,
    score: metric.score,
    sample_count: metric.sampleCount,
    categories: metric.categories,
  }
}

function storedBigIntToSafeNumber(value: bigint, field: string): number {
  const converted = Number(value)
  if (!Number.isSafeInteger(converted) || converted < 0) {
    throw new IntegrityError('Stored evaluation run quantity is outside the wire range', {
      reason: 'evaluation_quantity_invalid',
      field,
    })
  }
  return converted
}
