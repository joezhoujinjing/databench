export type EvalScopeProxyMethod = 'GET' | 'POST'

export const EVALSCOPE_PLOTLY_ASSET_SHA256 =
  '6d21266ce1bd7d9e5ab4e115989c70c20de0382fd973a8f26ab58619eba4d603'

export interface EvalScopeProxyRoute {
  readonly method: EvalScopeProxyMethod
  readonly path: string
  readonly query: readonly string[]
  readonly invoke?: boolean
  readonly requestBody?: 'json'
  readonly response: 'asset' | 'document' | 'json' | 'media'
}

export const EVALSCOPE_PROXY_ROUTES = [
  route('GET', '/health'),
  route('GET', '/api/v1/config'),
  route('POST', '/api/v1/eval/invoke', [], 'json', 'json', true),
  route('POST', '/api/v1/eval/stop', ['task_id']),
  route('GET', '/api/v1/eval/progress', ['task_id']),
  route('GET', '/api/v1/eval/log', ['task_id', 'start_line', 'page']),
  route('GET', '/api/v1/eval/report', ['task_id']),
  route('GET', '/api/v1/eval/benchmarks', ['type', 'all']),
  route('GET', '/api/v1/eval/metrics', ['benchmark']),
  route('POST', '/api/v1/perf/invoke', [], 'json', 'json', true),
  route('POST', '/api/v1/perf/stop', ['task_id']),
  route('GET', '/api/v1/perf/progress', ['task_id']),
  route('GET', '/api/v1/perf/log', ['task_id', 'start_line', 'page']),
  route('GET', '/api/v1/perf/report', ['task_id']),
  route('GET', '/api/v1/perf/list', ['refresh']),
  route('GET', '/api/v1/perf/detail', ['path']),
  route('GET', '/api/v1/perf/chart', ['path', 'chart_type', 'run', 'theme']),
  route('GET', '/api/v1/perf/compare/chart', ['paths', 'chart_type', 'theme']),
  route('GET', '/api/v1/perf/runs', ['path']),
  route('GET', '/api/v1/perf/requests', ['path', 'run', 'status', 'page', 'page_size']),
  route('GET', '/api/v1/perf/history/report', ['path']),
  route('GET', '/api/v1/reports/list', [
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
  ]),
  route('GET', '/api/v1/reports/load', ['report_name']),
  route('GET', '/api/v1/reports/load_multi', ['report_names']),
  route('GET', '/api/v1/reports/dataframe', ['report_name', 'type', 'dataset_name']),
  route('GET', '/api/v1/reports/predictions', [
    'report_name',
    'dataset_name',
    'subset_name',
    'page',
    'page_size',
    'mode',
    'threshold',
    'index',
    'message_id_prefix',
  ]),
  route('GET', '/api/v1/reports/analysis', ['report_name', 'dataset_name']),
  route('GET', '/api/v1/reports/html', ['report_name']),
  route('GET', '/api/v1/reports/chart', [
    'report_name',
    'report_names',
    'chart_type',
    'dataset_name',
    'subset_name',
    'theme',
  ]),
  route('GET', '/api/v1/reports/media/file', ['path'], undefined, 'media'),
  route('GET', '/generated-documents/{opaque_id}', [], undefined, 'document'),
  route('GET', '/generated-assets/plotly-{sha256}.min.js', [], undefined, 'asset'),
] as const satisfies readonly EvalScopeProxyRoute[]

export const EVALSCOPE_PROXY_ROUTE_KEYS = EVALSCOPE_PROXY_ROUTES.map(
  (item) => `${item.method} ${item.path}`,
)

function route(
  method: EvalScopeProxyMethod,
  path: string,
  query: readonly string[] = [],
  requestBody?: 'json',
  response: EvalScopeProxyRoute['response'] = 'json',
  invoke = false,
): EvalScopeProxyRoute {
  return {
    method,
    path,
    query,
    ...(requestBody === undefined ? {} : { requestBody }),
    response,
    ...(invoke ? { invoke: true } : {}),
  }
}
