import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
} from '@tanstack/react-router'
import {
  evaluationBenchmarksSearchSchema,
  evaluationCompareSearchSchema,
  evaluationDashboardSearchSchema,
  evaluationPerformanceCompareSearchSchema,
  evaluationPerformanceDetailSearchSchema,
  evaluationPerformanceSearchSchema,
  evaluationReportDetailSearchSchema,
  evaluationReportsSearchSchema,
  evaluationTasksSearchSchema,
  evaluationViewerSearchSchema,
  parseReportRouteParams,
  stringifyReportRouteParams,
} from './evaluations/routes/contracts.js'
import {
  EvaluationRouteError,
  EvaluationRouteNotFound,
  EvaluationRoutePending,
} from './evaluations/routes/route-state.js'
import { RootLayout } from './routes/__root.js'
import { IndexPage } from './routes/index.js'
import { NotFoundPage } from './routes/not-found.js'
import { V2DatasetDetailPage } from './v2/routes/dataset-detail.js'
import { V2DatasetsPage } from './v2/routes/datasets.js'
import { V2ExportPage } from './v2/routes/export.js'
import { V2IngestPage } from './v2/routes/ingest.js'
import { V2LineagePage } from './v2/routes/lineage.js'
import { V2RecordDetailPage } from './v2/routes/record-detail.js'
import { V2TransformsPage } from './v2/routes/transforms.js'

const rootRoute = createRootRoute({
  component: RootLayout,
  notFoundComponent: NotFoundPage,
})

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: IndexPage,
})

const datasetsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/datasets',
  component: V2DatasetsPage,
})

const datasetDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/datasets/$ref',
  component: V2DatasetDetailPage,
})

const recordDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/datasets/$ref/records/$recordId',
  component: V2RecordDetailPage,
})

const ingestRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/ingest',
  component: V2IngestPage,
})

const transformsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/transforms',
  component: V2TransformsPage,
})

const lineageRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/lineage/$ref',
  component: V2LineagePage,
})

const exportRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/export/$ref',
  component: V2ExportPage,
})

const evaluationRouteDefaults = {
  errorComponent: EvaluationRouteError,
  pendingComponent: EvaluationRoutePending,
}

const evaluationsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/evaluations',
  component: lazyRouteComponent(
    () => import('./evaluations/layouts/EvaluationLayout.js'),
    'EvaluationLayout',
  ),
  notFoundComponent: EvaluationRouteNotFound,
  ...evaluationRouteDefaults,
})

const evaluationsDashboardRoute = createRoute({
  getParentRoute: () => evaluationsRoute,
  path: '/',
  validateSearch: evaluationDashboardSearchSchema,
  component: lazyRouteComponent(
    () => import('./evaluations/routes/dashboard.js'),
    'EvaluationDashboardRoute',
  ),
  ...evaluationRouteDefaults,
})

const evaluationTasksRoute = createRoute({
  getParentRoute: () => evaluationsRoute,
  path: 'tasks',
  validateSearch: evaluationTasksSearchSchema,
  component: lazyRouteComponent(
    () => import('./evaluations/routes/tasks.js'),
    'EvaluationTasksRoute',
  ),
  ...evaluationRouteDefaults,
})

const evaluationReportsRoute = createRoute({
  getParentRoute: () => evaluationsRoute,
  path: 'reports',
  validateSearch: evaluationReportsSearchSchema,
  component: lazyRouteComponent(
    () => import('./evaluations/routes/reports.js'),
    'EvaluationReportsRoute',
  ),
  ...evaluationRouteDefaults,
})

const evaluationReportDetailRoute = createRoute({
  getParentRoute: () => evaluationsRoute,
  path: 'reports/$reportKey',
  params: {
    parse: (params) => parseReportRouteParams(params, 'reportKey'),
    stringify: (params) => stringifyReportRouteParams(params, 'reportKey'),
  },
  validateSearch: evaluationReportDetailSearchSchema,
  component: lazyRouteComponent(
    () => import('./evaluations/routes/report-detail.js'),
    'EvaluationReportDetailRoute',
  ),
  ...evaluationRouteDefaults,
})

const evaluationCompareRoute = createRoute({
  getParentRoute: () => evaluationsRoute,
  path: 'compare',
  validateSearch: evaluationCompareSearchSchema,
  component: lazyRouteComponent(
    () => import('./evaluations/routes/compare.js'),
    'EvaluationCompareRoute',
  ),
  ...evaluationRouteDefaults,
})

const evaluationPerformanceRoute = createRoute({
  getParentRoute: () => evaluationsRoute,
  path: 'performance',
  validateSearch: evaluationPerformanceSearchSchema,
  component: lazyRouteComponent(
    () => import('./evaluations/routes/performance.js'),
    'EvaluationPerformanceRoute',
  ),
  ...evaluationRouteDefaults,
})

const evaluationPerformanceDetailRoute = createRoute({
  getParentRoute: () => evaluationsRoute,
  path: 'performance/$performanceKey',
  params: {
    parse: (params) => parseReportRouteParams(params, 'performanceKey'),
    stringify: (params) => stringifyReportRouteParams(params, 'performanceKey'),
  },
  validateSearch: evaluationPerformanceDetailSearchSchema,
  component: lazyRouteComponent(
    () => import('./evaluations/routes/performance-detail.js'),
    'EvaluationPerformanceDetailRoute',
  ),
  ...evaluationRouteDefaults,
})

const evaluationPerformanceCompareRoute = createRoute({
  getParentRoute: () => evaluationsRoute,
  path: 'performance/compare',
  validateSearch: evaluationPerformanceCompareSearchSchema,
  component: lazyRouteComponent(
    () => import('./evaluations/routes/performance-compare.js'),
    'EvaluationPerformanceCompareRoute',
  ),
  ...evaluationRouteDefaults,
})

const evaluationBenchmarksRoute = createRoute({
  getParentRoute: () => evaluationsRoute,
  path: 'benchmarks',
  validateSearch: evaluationBenchmarksSearchSchema,
  component: lazyRouteComponent(
    () => import('./evaluations/routes/benchmarks.js'),
    'EvaluationBenchmarksRoute',
  ),
  ...evaluationRouteDefaults,
})

const evaluationViewerRoute = createRoute({
  getParentRoute: () => evaluationsRoute,
  path: 'viewer',
  validateSearch: evaluationViewerSearchSchema,
  component: lazyRouteComponent(
    () => import('./evaluations/routes/viewer.js'),
    'EvaluationViewerRoute',
  ),
  ...evaluationRouteDefaults,
})

const evaluationRouteTree = evaluationsRoute.addChildren([
  evaluationsDashboardRoute,
  evaluationTasksRoute,
  evaluationReportsRoute,
  evaluationReportDetailRoute,
  evaluationCompareRoute,
  evaluationPerformanceRoute,
  evaluationPerformanceDetailRoute,
  evaluationPerformanceCompareRoute,
  evaluationBenchmarksRoute,
  evaluationViewerRoute,
])

const routeTree = rootRoute.addChildren([
  indexRoute,
  datasetsRoute,
  datasetDetailRoute,
  recordDetailRoute,
  ingestRoute,
  transformsRoute,
  lineageRoute,
  exportRoute,
  evaluationRouteTree,
])

export const router = createRouter({
  routeTree,
  defaultPendingMs: 0,
  defaultPendingMinMs: 150,
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
