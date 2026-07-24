import { createRootRoute, createRoute, createRouter } from '@tanstack/react-router'
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

const routeTree = rootRoute.addChildren([
  indexRoute,
  datasetsRoute,
  datasetDetailRoute,
  recordDetailRoute,
  ingestRoute,
  transformsRoute,
  lineageRoute,
  exportRoute,
])

export const router = createRouter({ routeTree })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
