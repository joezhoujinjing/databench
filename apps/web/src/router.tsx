import { createRootRoute, createRoute, createRouter } from '@tanstack/react-router'
import { RootLayout } from './routes/__root.js'
import { DatasetDetailPage } from './routes/datasets.$ref.js'
import { DatasetsPage } from './routes/datasets.index.js'
import { IndexPage } from './routes/index.js'
import { IngestPage } from './routes/ingest.js'
import { LineagePage } from './routes/lineage.$ref.js'
import { LineageIndexPage } from './routes/lineage.index.js'
import { NotFoundPage } from './routes/not-found.js'
import { RecipesPage } from './routes/recipes.js'
import { TransformsPage } from './routes/transforms.js'
import { VocabularyDetailPage } from './routes/vocabularies.$name.js'
import { VocabularyDerivePage } from './routes/vocabularies.derive.js'
import { VocabulariesPage } from './routes/vocabularies.index.js'
import { VocabularyCreatePage } from './routes/vocabularies.new.js'
import { V2DatasetDetailPage } from './v2/routes/dataset-detail.js'
import { V2DatasetsPage } from './v2/routes/datasets.js'
import { V2Layout } from './v2/routes/layout.js'
import { V2RecordDetailPage } from './v2/routes/record-detail.js'

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
  component: DatasetsPage,
})

const datasetDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/datasets/$ref',
  component: DatasetDetailPage,
})

const transformsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/transforms',
  component: TransformsPage,
})

const recipesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/recipe',
  component: RecipesPage,
})

const lineageRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/lineage/$ref',
  component: LineagePage,
})

const lineageIndexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/lineage',
  component: LineageIndexPage,
})

const ingestRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/ingest',
  component: IngestPage,
})

const vocabulariesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/vocabularies',
  component: VocabulariesPage,
})

const vocabularyDeriveRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/vocabularies/derive',
  component: VocabularyDerivePage,
})

const vocabularyCreateRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/vocabularies/new',
  component: VocabularyCreatePage,
})

const vocabularyDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/vocabularies/$name',
  component: VocabularyDetailPage,
})

const v2Route = createRoute({
  getParentRoute: () => rootRoute,
  path: '/v2',
  component: V2Layout,
})

const v2DatasetsRoute = createRoute({
  getParentRoute: () => v2Route,
  path: '/datasets',
  component: V2DatasetsPage,
})

const v2DatasetDetailRoute = createRoute({
  getParentRoute: () => v2Route,
  path: '/datasets/$ref',
  component: V2DatasetDetailPage,
})

const v2RecordDetailRoute = createRoute({
  getParentRoute: () => v2Route,
  path: '/datasets/$ref/records/$recordId',
  component: V2RecordDetailPage,
})

const v2RouteTree = v2Route.addChildren([
  v2DatasetsRoute,
  v2DatasetDetailRoute,
  v2RecordDetailRoute,
])

const routeTree = rootRoute.addChildren([
  indexRoute,
  datasetsRoute,
  datasetDetailRoute,
  transformsRoute,
  recipesRoute,
  lineageIndexRoute,
  lineageRoute,
  ingestRoute,
  vocabulariesRoute,
  vocabularyDeriveRoute,
  vocabularyCreateRoute,
  vocabularyDetailRoute,
  v2RouteTree,
])

export const router = createRouter({ routeTree })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
