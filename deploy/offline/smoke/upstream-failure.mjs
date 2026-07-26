const origin = 'http://web'
const requests = [
  {
    url: `${origin}/api/mcp-files/process/proc_${'f'.repeat(64)}`,
    init: {
      method: 'PUT',
      headers: { 'content-type': 'application/x-ndjson' },
      body: '{}\n',
    },
  },
  {
    url: `${origin}/api/mcp-files/export/exp_${'e'.repeat(64)}`,
    init: undefined,
  },
]

for (const { url, init } of requests) {
  const response = await fetch(url, init)
  if (response.status !== 502) {
    throw new Error(`Caddy upstream failure probe returned ${response.status}`)
  }
}
