import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { EVALSCOPE_CLIENT_CONFIG, EVALSCOPE_PLOTLY_ASSET_SHA256 } from './config.js'
import { EVALSCOPE_JSON_OPERATIONS, EVALSCOPE_NON_JSON_ROUTES } from './routes.js'

type RouteManifest = {
  routes: Array<{ classification: string; method: string; path: string }>
}

describe('EvalScope route manifest client', () => {
  test('covers every and only browser-allowed exact route', async () => {
    const manifestPath = path.resolve(
      import.meta.dirname,
      '../../../../../deploy/evalscope/api-routes.json',
    )
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as RouteManifest
    const allowed = manifest.routes
      .filter((route) =>
        ['allowed', 'allowed-patched', 'databench-generated'].includes(route.classification),
      )
      .map((route) => `${route.method} ${route.path}`)
      .sort()

    const internalApiPrefix = EVALSCOPE_CLIENT_CONFIG.apiBase.slice(
      EVALSCOPE_CLIENT_CONFIG.gatewayBase.length,
    )
    const clientRoutes = Object.values(EVALSCOPE_JSON_OPERATIONS).map((route) => {
      const prefix = route.scope === 'api' ? internalApiPrefix : ''
      return `${route.method} ${prefix}${route.path}`
    })
    clientRoutes.push(
      `GET ${EVALSCOPE_NON_JSON_ROUTES.generatedDocument}`,
      `GET ${internalApiPrefix}${EVALSCOPE_NON_JSON_ROUTES.media}`,
      `GET ${EVALSCOPE_NON_JSON_ROUTES.plotlyAsset}`,
    )

    expect(
      clientRoutes.map((route) => route.replace('{sha256}', EVALSCOPE_PLOTLY_ASSET_SHA256)).sort(),
    ).toEqual(allowed.map((route) => route.replace('{sha256}', EVALSCOPE_PLOTLY_ASSET_SHA256)))
  })
})
