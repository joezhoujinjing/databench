const origin = 'http://web'
const apiPaths = [
  '/api/health',
  '/api/version',
  '/api/capabilities',
  '/api/openapi.json',
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

const mcpMethodResponse = await fetch(`${origin}/api/mcp`)
if (mcpMethodResponse.status !== 405 || mcpMethodResponse.headers.get('allow') !== 'POST') {
  throw new Error('/api/mcp did not reach the MCP handler through Caddy')
}

const logSentinel = `proc_${'f'.repeat(64)}`
const invalidTokenResponse = await fetch(`${origin}/api/mcp-files/process/${logSentinel}`, {
  method: 'PUT',
  headers: { 'content-type': 'application/x-ndjson' },
  body: '{}\n',
})
if (invalidTokenResponse.status !== 400) {
  throw new Error('invalid companion token did not reach the API through Caddy')
}
if ((await invalidTokenResponse.text()).includes(logSentinel)) {
  throw new Error('companion error response leaked its bearer token')
}

const exportLogSentinel = `exp_${'e'.repeat(64)}`
const invalidExportResponse = await fetch(`${origin}/api/mcp-files/export/${exportLogSentinel}`)
if (invalidExportResponse.status !== 400) {
  throw new Error('invalid export token did not reach the API through Caddy')
}
if ((await invalidExportResponse.text()).includes(exportLogSentinel)) {
  throw new Error('export error response leaked its bearer token')
}

const pagePath = '/datasets/system-offline-smoke-v2'
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

for (const path of ['/datasets', '/transforms']) {
  const response = await fetch(origin + path)
  if (!response.ok) throw new Error(`${path} SPA navigation returned ${response.status}`)
  if (!response.headers.get('content-type')?.includes('text/html')) {
    throw new Error(`${path} SPA navigation did not return HTML`)
  }
  if (!(await response.text()).includes('<div id="root"></div>')) {
    throw new Error(`${path} SPA navigation did not return the Web entry point`)
  }
}
