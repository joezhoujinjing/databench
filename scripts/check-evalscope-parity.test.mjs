import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, '..')
const CHECKER_PATH = path.join(REPOSITORY_ROOT, 'scripts/check-evalscope-parity.mjs')
const INPUTS = {
  EVALSCOPE_SOURCE_MANIFEST_PATH: 'apps/web/src/evaluations/upstream-manifest.json',
  EVALSCOPE_CAPABILITY_MANIFEST_PATH: 'apps/web/src/evaluations/ui-capability-manifest.json',
  EVALSCOPE_IMPLEMENTED_CAPABILITIES_PATH: 'apps/web/src/evaluations/implemented-capabilities.json',
  EVALSCOPE_UPSTREAM_LOCK_PATH: 'deploy/evalscope/upstream.lock',
  EVALSCOPE_ROUTES_PATH: 'deploy/evalscope/api-routes.json',
  EVALSCOPE_BENCHMARK_FIXTURE_PATH:
    'apps/web/src/evaluations/fixtures/benchmarks-five-categories.json',
}

async function setupFixture() {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'databench-evalscope-parity-'))
  const environment = { ...process.env }
  for (const [environmentName, relativePath] of Object.entries(INPUTS)) {
    const sourcePath = path.join(REPOSITORY_ROOT, relativePath)
    const targetPath = path.join(fixtureRoot, path.basename(relativePath))
    await cp(sourcePath, targetPath)
    environment[environmentName] = targetPath
  }
  return { fixtureRoot, environment }
}

async function mutateJson(filePath, mutate) {
  const value = JSON.parse(await readFile(filePath, 'utf8'))
  mutate(value)
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function runChecker(environment) {
  return spawnSync(process.execPath, [CHECKER_PATH], {
    cwd: REPOSITORY_ROOT,
    env: environment,
    encoding: 'utf8',
  })
}

function expectFailure(result, message) {
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, message)
}

test('accepts the committed E0 baseline', async () => {
  const { environment } = await setupFixture()
  const result = runChecker(environment)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /E0 baseline mode/)
})

test('rejects a missing source-to-capability backlink', async () => {
  const { environment } = await setupFixture()
  await mutateJson(environment.EVALSCOPE_SOURCE_MANIFEST_PATH, (manifest) => {
    const source = manifest.files.find((entry) => entry.parity_ids.length > 0)
    source.parity_ids = []
  })
  expectFailure(runChecker(environment), /source\/capability backlink is missing/)
})

test('rejects an upstream capability without a target', async () => {
  const { environment } = await setupFixture()
  await mutateJson(environment.EVALSCOPE_CAPABILITY_MANIFEST_PATH, (manifest) => {
    manifest.capabilities.find(
      (capability) => capability.classification === 'upstream-parity',
    ).target = ''
  })
  expectFailure(runChecker(environment), /capability has no target/)
})

test('rejects extension inflation of upstream coverage', async () => {
  const { environment } = await setupFixture()
  await mutateJson(environment.EVALSCOPE_CAPABILITY_MANIFEST_PATH, (manifest) => {
    manifest.capabilities.find(
      (capability) => capability.classification === 'databench-extension',
    ).upstream_coverage = true
  })
  expectFailure(runChecker(environment), /upstream coverage classification mismatch/)
})

test('rejects an orphan implemented target capability', async () => {
  const { environment } = await setupFixture()
  await mutateJson(environment.EVALSCOPE_IMPLEMENTED_CAPABILITIES_PATH, (registry) => {
    registry.capability_ids.push('orphan.target-capability')
  })
  expectFailure(runChecker(environment), /orphan implemented capability/)
})

test('rejects a route manifest that is not default deny', async () => {
  const { environment } = await setupFixture()
  await mutateJson(environment.EVALSCOPE_ROUTES_PATH, (manifest) => {
    manifest.default = 'allowed'
  })
  expectFailure(runChecker(environment), /route manifest default must be blocked/)
})

test('rejects Benchmark aggregate/category drift', async () => {
  const { environment } = await setupFixture()
  await mutateJson(environment.EVALSCOPE_BENCHMARK_FIXTURE_PATH, (fixture) => {
    fixture.expected_tabs.all += 1
    fixture.response.agent[0].category = 'llm'
  })
  const result = runChecker(environment)
  expectFailure(result, /Benchmark fixture category mismatch/)
  assert.match(result.stderr, /Benchmark fixture all count/)
})
