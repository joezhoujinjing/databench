const origin = 'http://web'
const apiPaths = ['/health', '/version', '/capabilities', '/v1/refs', '/v2/refs?limit=1']

for (const path of apiPaths) {
  const response = await fetch(origin + path)
  if (!response.ok) throw new Error(`${path} returned ${response.status}`)
}

const sharedPath = '/v2/datasets/system-offline-smoke-v2'
const apiResponse = await fetch(origin + sharedPath, {
  headers: { Accept: 'application/json' },
})
if (!apiResponse.ok) throw new Error(`${sharedPath} API returned ${apiResponse.status}`)
if (!apiResponse.headers.get('content-type')?.includes('application/json')) {
  throw new Error(`${sharedPath} API did not return JSON`)
}

for (const path of ['/v2/datasets', sharedPath, '/v2/transforms']) {
  const response = await fetch(origin + path, { headers: { Accept: 'text/html' } })
  if (!response.ok) throw new Error(`${path} SPA navigation returned ${response.status}`)
  if (!response.headers.get('content-type')?.includes('text/html')) {
    throw new Error(`${path} SPA navigation did not return HTML`)
  }
  if (!(await response.text()).includes('<div id="root"></div>')) {
    throw new Error(`${path} SPA navigation did not return the Web entry point`)
  }
}
