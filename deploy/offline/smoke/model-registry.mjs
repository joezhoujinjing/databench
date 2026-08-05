import { spawnSync } from 'node:child_process'
import { isDeepStrictEqual } from 'node:util'

// biome-ignore lint/suspicious/noUndeclaredEnvVars: Optional local harness override; the packaged smoke keeps the Compose default.
const origin = process.env.DATABENCH_OFFLINE_SMOKE_ORIGIN ?? 'http://web'
// biome-ignore lint/suspicious/noUndeclaredEnvVars: Compose injects this runtime-only secret; Turbo tasks must not receive it.
const operatorToken = process.env.DATABENCH_MODEL_DEPLOYMENT_OPERATOR_TOKEN
if (operatorToken === undefined || operatorToken.length < 32) {
  throw new Error('Model Registry smoke requires the configured operator token')
}

const request = {
  target: {
    kind: 'create_model',
    key: 'system-offline-model-registry-smoke',
    display_name: 'Offline Model Registry Smoke',
    description: 'Idempotent ModelScope declared-only lifecycle proof',
    task_family: 'chat',
    tags: ['offline-smoke'],
  },
  version_label: 'modelscope-main',
  source: {
    kind: 'repository_reference',
    provider: 'modelscope',
    repository_id: 'Qwen/Qwen3-0.6B',
    revision: 'main',
    revision_kind: 'tag',
    base_model: null,
  },
}

const apiPlan = await postJson('/api/v2/model-registrations:inspect', request)
const cliPlan = runCli(['model', 'registration', 'inspect', '--input', '-', '--compact'], request)
if (!isDeepStrictEqual(cliPlan, apiPlan)) {
  throw new Error('CLI and API produced different Model registration plans')
}

const commitRequest = {
  request,
  expected_registration_digest: apiPlan.registration_digest,
}
const apiResult = await postJson('/api/v2/models:register', commitRequest)
const cliResult = runCli(
  [
    'model',
    'registration',
    'commit',
    '--input',
    '-',
    '--expected-digest',
    apiPlan.registration_digest,
    '--compact',
  ],
  request,
)
for (const key of ['model_id', 'model_version_id', 'deployment_id', 'deployment_digest', 'alias']) {
  if (!isDeepStrictEqual(cliResult[key], apiResult[key])) {
    throw new Error(`CLI and API Model registration results differ at ${key}`)
  }
}
if (cliResult.replayed !== true) {
  throw new Error('CLI did not replay the registration committed through the API')
}

const versions = runCli(['model', 'versions', apiResult.model_id, '--compact'])
if (
  !Array.isArray(versions.items) ||
  !versions.items.some((version) => version.id === apiResult.model_version_id)
) {
  throw new Error('CLI Model versions did not contain the committed Version')
}
const deployments = runCli(['model', 'deployment', 'list', apiResult.model_version_id, '--compact'])
if (!Array.isArray(deployments.items) || deployments.items.length !== 0) {
  throw new Error('Declared-only repository Version unexpectedly acquired a Deployment')
}

const modelResponse = await fetch(`${origin}/api/v2/models/${apiResult.model_id}`)
if (!modelResponse.ok) throw new Error(`Model show returned ${modelResponse.status}`)
const model = await modelResponse.json()
if (model.id !== apiResult.model_id || model.key !== request.target.key) {
  throw new Error('Model show did not return the committed logical Model')
}

function runCli(args, input) {
  const result = spawnSync('databench', args, {
    encoding: 'utf8',
    env: process.env,
    input: input === undefined ? undefined : JSON.stringify(input),
    maxBuffer: 512 * 1024,
    timeout: 30_000,
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`databench ${args.slice(0, 3).join(' ')} exited ${result.status}`)
  }
  return JSON.parse(result.stdout)
}

async function postJson(path, body) {
  const response = await fetch(origin + path, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${operatorToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`${path} returned ${response.status}`)
  return await response.json()
}
