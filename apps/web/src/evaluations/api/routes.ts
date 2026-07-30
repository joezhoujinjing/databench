import type { ZodType } from 'zod'
import {
  analysisResponseSchema,
  benchmarksResponseSchema,
  dataFrameResponseSchema,
  evalInvokeResponseSchema,
  evalScopePublicConfigSchema,
  generatedDocumentDescriptorSchema,
  listPerfRunsResponseSchema,
  listReportsResponseSchema,
  loadMultiReportResponseSchema,
  loadReportResponseSchema,
  logResponseSchema,
  perfDetailResponseSchema,
  perfRequestsResponseSchema,
  perfRunsListResponseSchema,
  predictionsResponseSchema,
  progressResponseSchema,
  serviceHealthSchema,
  taskStatusResponseSchema,
} from './schemas.js'

type EvalScopeOperationDescriptor = {
  readonly method: 'GET' | 'POST'
  readonly path: `/${string}`
  readonly query: readonly string[]
  readonly requestBody?: 'json'
  readonly schema: ZodType
  readonly scope: 'api' | 'gateway'
}

function operation<const T extends EvalScopeOperationDescriptor>(descriptor: T): T {
  return descriptor
}

export const EVALSCOPE_JSON_OPERATIONS = {
  health: operation({
    method: 'GET',
    path: '/health',
    query: [],
    schema: serviceHealthSchema,
    scope: 'gateway',
  }),
  config: operation({
    method: 'GET',
    path: '/config',
    query: [],
    schema: evalScopePublicConfigSchema,
    scope: 'api',
  }),
  evalInvoke: operation({
    method: 'POST',
    path: '/eval/invoke',
    query: [],
    requestBody: 'json',
    schema: evalInvokeResponseSchema,
    scope: 'api',
  }),
  evalStop: operation({
    method: 'POST',
    path: '/eval/stop',
    query: ['task_id'],
    schema: taskStatusResponseSchema,
    scope: 'api',
  }),
  evalProgress: operation({
    method: 'GET',
    path: '/eval/progress',
    query: ['task_id'],
    schema: progressResponseSchema,
    scope: 'api',
  }),
  evalLog: operation({
    method: 'GET',
    path: '/eval/log',
    query: ['task_id', 'start_line', 'page'],
    schema: logResponseSchema,
    scope: 'api',
  }),
  evalReport: operation({
    method: 'GET',
    path: '/eval/report',
    query: ['task_id'],
    schema: generatedDocumentDescriptorSchema,
    scope: 'api',
  }),
  benchmarks: operation({
    method: 'GET',
    path: '/eval/benchmarks',
    query: ['type', 'all'],
    schema: benchmarksResponseSchema,
    scope: 'api',
  }),
  perfInvoke: operation({
    method: 'POST',
    path: '/perf/invoke',
    query: [],
    requestBody: 'json',
    schema: evalInvokeResponseSchema,
    scope: 'api',
  }),
  perfStop: operation({
    method: 'POST',
    path: '/perf/stop',
    query: ['task_id'],
    schema: taskStatusResponseSchema,
    scope: 'api',
  }),
  perfProgress: operation({
    method: 'GET',
    path: '/perf/progress',
    query: ['task_id'],
    schema: progressResponseSchema,
    scope: 'api',
  }),
  perfLog: operation({
    method: 'GET',
    path: '/perf/log',
    query: ['task_id', 'start_line', 'page'],
    schema: logResponseSchema,
    scope: 'api',
  }),
  perfReport: operation({
    method: 'GET',
    path: '/perf/report',
    query: ['task_id'],
    schema: generatedDocumentDescriptorSchema,
    scope: 'api',
  }),
  perfList: operation({
    method: 'GET',
    path: '/perf/list',
    query: ['refresh'],
    schema: listPerfRunsResponseSchema,
    scope: 'api',
  }),
  perfDetail: operation({
    method: 'GET',
    path: '/perf/detail',
    query: ['path'],
    schema: perfDetailResponseSchema,
    scope: 'api',
  }),
  perfChart: operation({
    method: 'GET',
    path: '/perf/chart',
    query: ['path', 'chart_type', 'run', 'theme'],
    schema: generatedDocumentDescriptorSchema,
    scope: 'api',
  }),
  perfCompareChart: operation({
    method: 'GET',
    path: '/perf/compare/chart',
    query: ['paths', 'chart_type', 'theme'],
    schema: generatedDocumentDescriptorSchema,
    scope: 'api',
  }),
  perfRuns: operation({
    method: 'GET',
    path: '/perf/runs',
    query: ['path'],
    schema: perfRunsListResponseSchema,
    scope: 'api',
  }),
  perfRequests: operation({
    method: 'GET',
    path: '/perf/requests',
    query: ['path', 'run', 'status', 'page', 'page_size'],
    schema: perfRequestsResponseSchema,
    scope: 'api',
  }),
  perfHistoryReport: operation({
    method: 'GET',
    path: '/perf/history/report',
    query: ['path'],
    schema: generatedDocumentDescriptorSchema,
    scope: 'api',
  }),
  reportsList: operation({
    method: 'GET',
    path: '/reports/list',
    query: [
      'search',
      'models',
      'datasets',
      'score_min',
      'score_max',
      'sort_by',
      'sort_order',
      'page',
      'page_size',
      'refresh',
    ],
    schema: listReportsResponseSchema,
    scope: 'api',
  }),
  reportsLoad: operation({
    method: 'GET',
    path: '/reports/load',
    query: ['report_name'],
    schema: loadReportResponseSchema,
    scope: 'api',
  }),
  reportsLoadMulti: operation({
    method: 'GET',
    path: '/reports/load_multi',
    query: ['report_names'],
    schema: loadMultiReportResponseSchema,
    scope: 'api',
  }),
  reportsDataFrame: operation({
    method: 'GET',
    path: '/reports/dataframe',
    query: ['report_name', 'type', 'dataset_name'],
    schema: dataFrameResponseSchema,
    scope: 'api',
  }),
  reportsPredictions: operation({
    method: 'GET',
    path: '/reports/predictions',
    query: [
      'report_name',
      'dataset_name',
      'subset_name',
      'page',
      'page_size',
      'mode',
      'threshold',
      'index',
      'message_id_prefix',
    ],
    schema: predictionsResponseSchema,
    scope: 'api',
  }),
  reportsAnalysis: operation({
    method: 'GET',
    path: '/reports/analysis',
    query: ['report_name', 'dataset_name'],
    schema: analysisResponseSchema,
    scope: 'api',
  }),
  reportsHtml: operation({
    method: 'GET',
    path: '/reports/html',
    query: ['report_name'],
    schema: generatedDocumentDescriptorSchema,
    scope: 'api',
  }),
  reportsChart: operation({
    method: 'GET',
    path: '/reports/chart',
    query: ['report_name', 'report_names', 'chart_type', 'dataset_name', 'subset_name', 'theme'],
    schema: generatedDocumentDescriptorSchema,
    scope: 'api',
  }),
} as const

export type EvalScopeJsonOperation = keyof typeof EVALSCOPE_JSON_OPERATIONS

export const EVALSCOPE_NON_JSON_ROUTES = {
  generatedDocument: '/generated-documents/{opaque_id}',
  media: '/reports/media/file',
  plotlyAsset: '/generated-assets/plotly-{sha256}.min.js',
} as const
