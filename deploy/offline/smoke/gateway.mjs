const origin = 'http://web'
const apiPaths = [
  '/api/health',
  '/api/version',
  '/api/capabilities',
  '/api/openapi.json',
  '/api/v1/refs',
  '/api/v2/refs?limit=1',
]

for (const path of apiPaths) {
  const response = await fetch(origin + path)
  if (!response.ok) throw new Error(`${path} returned ${response.status}`)
  if (!response.headers.get('content-type')?.includes('application/json')) {
    throw new Error(`${path} did not return JSON`)
  }
  if (path === '/api/openapi.json') {
    const document = await response.json()
    if (
      !Array.isArray(document.servers) ||
      document.servers.length !== 1 ||
      document.servers[0]?.url !== '/api'
    ) {
      throw new Error(`${path} did not advertise /api as its server URL`)
    }
  }
}

const pagePath = '/v2/datasets/system-offline-smoke-v2'
const apiPath = '/api/v2/datasets/system-offline-smoke-v2'
const pageResponse = await fetch(origin + pagePath, { headers: { Accept: 'text/html' } })
if (!pageResponse.ok) throw new Error(`${pagePath} SPA navigation returned ${pageResponse.status}`)
if (!pageResponse.headers.get('content-type')?.includes('text/html')) {
  throw new Error(`${pagePath} SPA navigation did not return HTML`)
}
if (!(await pageResponse.text()).includes('<div id="root"></div>')) {
  throw new Error(`${pagePath} SPA navigation did not return the Web entry point`)
}

const apiResponse = await fetch(origin + apiPath)
if (!apiResponse.ok) throw new Error(`${apiPath} API returned ${apiResponse.status}`)
if (!apiResponse.headers.get('content-type')?.includes('application/json')) {
  throw new Error(`${apiPath} API did not return JSON`)
}

for (const path of ['/v2/datasets', '/v2/transforms']) {
  const response = await fetch(origin + path)
  if (!response.ok) throw new Error(`${path} SPA navigation returned ${response.status}`)
  if (!response.headers.get('content-type')?.includes('text/html')) {
    throw new Error(`${path} SPA navigation did not return HTML`)
  }
  if (!(await response.text()).includes('<div id="root"></div>')) {
    throw new Error(`${path} SPA navigation did not return the Web entry point`)
  }
}
