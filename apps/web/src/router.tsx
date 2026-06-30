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
])

export const router = createRouter({ routeTree })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
