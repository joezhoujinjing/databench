const baseUrl = 'http://web/api'
const inputRef = 'system-offline-smoke-v2'
const resultRef = 'system-offline-smoke-clean-v2'
const request = { inputs: [inputRef], result_ref: resultRef }

const submitted = await jsonFetch(
  '/v2/transforms/basic-clean/jobs',
  {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  },
  202,
)

const deadline = Date.now() + 300_000
let job = submitted
while (!['completed', 'failed', 'cancelled'].includes(job.status)) {
  if (Date.now() >= deadline) {
    throw new Error(`offline Worker smoke timed out while job was ${job.status}`)
  }
  await new Promise((resolve) => setTimeout(resolve, 1_000))
  job = await jsonFetch(`/v2/transform-jobs/${job.id}`, {}, 200)
}

if (job.status !== 'completed') {
  throw new Error(
    `offline Worker smoke ended as ${job.status}: ${job.error?.message ?? 'no error'}`,
  )
}
if (job.input_count !== 1 || job.output_count !== 0) {
  throw new Error(
    `offline Worker smoke returned unexpected counts: ${job.input_count}/${job.output_count}`,
  )
}
if (
  job.result_ref?.name !== resultRef ||
  job.result_ref.status !== 'updated' ||
  job.result_ref.version !== job.output_dataset_version
) {
  throw new Error(`offline Worker smoke did not adopt ${resultRef}`)
}

const output = await jsonFetch(`/v2/datasets/${resultRef}`, {}, 200)
if (output.dataset_version !== job.output_dataset_version || output.manifest.num_records !== 0) {
  throw new Error('offline Worker smoke result Ref did not resolve to the canonical empty output')
}

const lineage = await jsonFetch(
  `/v2/lineage/${job.output_dataset_version}?max_depth=2&max_nodes=10`,
  {},
  200,
)
if (!lineage.edges.some((edge) => edge.run_id === `run_${job.cache_key}`)) {
  throw new Error('offline Worker smoke output is missing deterministic lineage')
}

const replay = await jsonFetch(
  '/v2/transforms/basic-clean/jobs',
  {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  },
  202,
)
if (
  replay.id !== job.id ||
  replay.status !== 'completed' ||
  replay.output_dataset_version !== job.output_dataset_version
) {
  throw new Error('offline Worker smoke replay did not reuse the completed deterministic job')
}

process.stdout.write(
  `${JSON.stringify({
    job_id: job.id,
    input_count: job.input_count,
    output_count: job.output_count,
    output_dataset_version: job.output_dataset_version,
    result_ref: resultRef,
    cache_hit: replay.cache_hit,
  })}\n`,
)

async function jsonFetch(path, init, expectedStatus) {
  const response = await fetch(`${baseUrl}${path}`, init)
  const text = await response.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    throw new Error(`${path} returned non-JSON status ${response.status}: ${text.slice(0, 500)}`)
  }
  if (response.status !== expectedStatus) {
    throw new Error(`${path} returned ${response.status}: ${JSON.stringify(body)}`)
  }
  return body
}
