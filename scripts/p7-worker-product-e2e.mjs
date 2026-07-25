const baseUrl = process.env.DATABENCH_E2E_BASE_URL ?? 'http://127.0.0.1:8000'
const count = Number(process.env.DATABENCH_E2E_ROWS ?? '100000')
const variant = process.env.DATABENCH_E2E_VARIANT ?? 'baseline'

if (!Number.isSafeInteger(count) || count <= 0 || count > 100_000) {
  throw new TypeError('DATABENCH_E2E_ROWS must be an integer from 1 through 100000')
}

const started = performance.now()
const chunks = []
let previous = ''
for (let index = 0; index < count; index += 1) {
  const offset = index % 10
  let text
  if (offset === 0) {
    text = `short-${index}`
  } else if (offset === 2) {
    text = previous
  } else {
    text = `Record ${index.toString().padStart(6, '0')} variant ${variant} has enough deterministic characters for the fixed Data-Juicer filter.`
  }
  if (offset === 1) previous = text
  chunks.push(
    `${JSON.stringify({
      schema_version: '2.0.0',
      id: `rec_${index.toString(16).padStart(64, '0')}`,
      contents: [
        {
          role: 'user',
          parts: [
            {
              type: 'text',
              text,
              thought: false,
              thought_signature: null,
              part_metadata: {},
            },
          ],
          loss_weight: null,
        },
      ],
      candidates: [],
      preference_relations: [],
      tools: [],
      verification: null,
      source: null,
      lang: null,
      lineage: null,
      tags: [],
      extra: {},
    })}\n`,
  )
}

const form = new FormData()
form.append('file', new Blob(chunks, { type: 'application/x-ndjson' }), `worker-p7-${count}.jsonl`)
const ingestStarted = performance.now()
const ingest = await jsonFetch('/v2/datasets:ingest-jsonl', { method: 'POST', body: form }, 200)
const ingestSeconds = secondsSince(ingestStarted)
chunks.length = 0

const submitStarted = performance.now()
const submitted = await jsonFetch(
  '/v2/transforms/basic-clean/jobs',
  {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ inputs: [ingest.dataset_version] }),
  },
  202,
)

let job = submitted
while (!['completed', 'failed', 'cancelled'].includes(job.status)) {
  await new Promise((resolve) => setTimeout(resolve, 500))
  job = await jsonFetch(`/v2/transform-jobs/${job.id}`, {}, 200)
}
if (job.status !== 'completed') {
  throw new Error(`Worker job ended as ${job.status}: ${job.error?.message ?? 'no error'}`)
}
const transformSeconds = secondsSince(submitStarted)
const remainder = count % 10
const expectedOutput =
  Math.floor(count / 10) * 8 + Math.max(0, remainder - 3) + (remainder >= 2 ? 1 : 0)
if (job.input_count !== count || job.output_count !== expectedOutput) {
  throw new Error(
    `Unexpected counts: input=${job.input_count}, output=${job.output_count}, expected=${expectedOutput}`,
  )
}

const output = await jsonFetch(`/v2/datasets/${job.output_dataset_version}`, {}, 200)
if (output.manifest.num_records !== expectedOutput) {
  throw new Error(`Canonical output count mismatch: ${output.manifest.num_records}`)
}
const lineage = await jsonFetch(
  `/v2/lineage/${job.output_dataset_version}?max_depth=2&max_nodes=10`,
  {},
  200,
)
if (!lineage.edges.some((edge) => edge.run_id === `run_${job.cache_key}`)) {
  throw new Error('Canonical lineage is missing the deterministic Worker run')
}

const replay = await jsonFetch(
  '/v2/transforms/basic-clean/jobs',
  {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ inputs: [ingest.dataset_version] }),
  },
  202,
)
if (
  replay.id !== job.id ||
  replay.status !== 'completed' ||
  replay.attempt !== job.attempt ||
  replay.output_dataset_version !== job.output_dataset_version
) {
  throw new Error('Repeated submit did not converge on the existing completed job')
}

console.log(
  JSON.stringify({
    rows: count,
    retained: job.output_count,
    filtered: count - job.output_count,
    input_dataset_version: ingest.dataset_version,
    output_dataset_version: job.output_dataset_version,
    job_id: job.id,
    attempt: job.attempt,
    ingest_seconds: ingestSeconds,
    transform_seconds: transformSeconds,
    total_seconds: secondsSince(started),
    repeated_submit_reused_job: true,
    cache_hit: replay.cache_hit,
    lineage_edges: lineage.edges.length,
  }),
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

function secondsSince(value) {
  return Math.round((performance.now() - value) / 10) / 100
}
