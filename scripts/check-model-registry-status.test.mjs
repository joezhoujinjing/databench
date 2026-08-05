import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, '..')
const CHECKER = path.join(REPOSITORY_ROOT, 'scripts/check-model-registry-status.mjs')

const DOCUMENTS = {
  status: {
    environment: 'MODEL_REGISTRY_STATUS_PATH',
    path: path.join(REPOSITORY_ROOT, 'docs/models/STATUS.md'),
  },
  fixtures: {
    environment: 'MODEL_REGISTRY_FIXTURE_INDEX_PATH',
    path: path.join(REPOSITORY_ROOT, 'docs/models/fixtures/index.json'),
  },
  legacy: {
    environment: 'MODEL_REGISTRY_LEGACY_BASELINE_PATH',
    path: path.join(REPOSITORY_ROOT, 'docs/models/fixtures/legacy-s4-baseline.json'),
  },
}

function runChecker(environment = {}) {
  return spawnSync(process.execPath, [CHECKER], {
    cwd: REPOSITORY_ROOT,
    env: { ...process.env, ...environment },
    encoding: 'utf8',
  })
}

async function expectFailure(documentName, mutate, expectedMessage) {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'databench-models-negative-'))
  try {
    const descriptor = DOCUMENTS[documentName]
    const source = await readFile(descriptor.path, 'utf8')
    const document = documentName === 'status' ? source : JSON.parse(source)
    const mutated = mutate(document)
    const extension = documentName === 'status' ? 'md' : 'json'
    const documentPath = path.join(temporaryRoot, `${documentName}.${extension}`)
    const output =
      typeof mutated === 'string' ? mutated : `${JSON.stringify(mutated ?? document, null, 2)}\n`
    await writeFile(documentPath, output, 'utf8')
    const result = runChecker({ [descriptor.environment]: documentPath })
    assert.notEqual(result.status, 0, result.stdout)
    assert.match(`${result.stdout}\n${result.stderr}`, expectedMessage)
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}

function rewindStatus(document, currentStep) {
  const currentIndex = Number(currentStep.slice(2))
  const lastCompleted = currentIndex === 0 ? 'none' : `MR${currentIndex - 1}`
  let output = document
    .replace(/^current_step: .+$/m, `current_step: ${currentStep}`)
    .replace(/^last_completed_step: .+$/m, `last_completed_step: ${lastCompleted}`)
    .replace(/^capability_enabled: .+$/m, 'capability_enabled: false')
    .replace(/^runtime_implemented: .+$/m, 'runtime_implemented: false')
  for (let index = currentIndex; index <= 8; index += 1) {
    output = output.replace(
      new RegExp(`^\\| MR${index} \\|(.*?)\\| (?:⬜|🔄|✅|⛔) \\|`, 'm'),
      `| MR${index} |$1| ⬜ |`,
    )
  }
  return output
}

test('accepts the checked-in Model Registry status', () => {
  const result = runChecker()
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
})

test('rejects a completed Step after a skipped Step', async () => {
  await expectFailure(
    'status',
    (document) =>
      document
        .replace(/^\| MR0 \|(.*?)\| (?:⬜|🔄|✅|⛔) \|/m, '| MR0 |$1| ⬜ |')
        .replace(/^\| MR1 \|(.*?)\| (?:⬜|🔄|✅|⛔) \|/m, '| MR1 |$1| ✅ |'),
    /MR1 is complete before an earlier Step/,
  )
})

test('rejects a false-green product capability', async () => {
  await expectFailure(
    'status',
    (document) =>
      rewindStatus(document, 'MR2').replace(
        'capability_enabled: false',
        'capability_enabled: true',
      ),
    /capability_enabled must remain false until MR2 is complete/,
  )
})

test('rejects a false-green runtime implementation', async () => {
  await expectFailure(
    'status',
    (document) =>
      rewindStatus(document, 'MR1').replace(
        'runtime_implemented: false',
        'runtime_implemented: true',
      ),
    /runtime_implemented must remain false until MR1 is complete/,
  )
})

test('rejects public-network activation while D3 is undecided', async () => {
  await expectFailure(
    'status',
    (document) =>
      document.replace('public_network_activation: false', 'public_network_activation: true'),
    /public_network_activation must remain false while D3 is undecided/,
  )
})

test('rejects a false-green GPU gate', async () => {
  await expectFailure(
    'status',
    (document) => document.replace('gpu_gate: deferred', 'gpu_gate: green'),
    /gpu_gate must remain deferred by the Model Registry plan/,
  )
})

test('rejects removal of the V16/V17 non-activation statement', async () => {
  await expectFailure(
    'status',
    (document) => document.replaceAll('不自动完成 V16/V17', '自动完成 V16/V17'),
    /preserve the explicit V16\/V17 non-activation statement/,
  )
})

test('rejects a missing required profile fixture', async () => {
  await expectFailure(
    'fixtures',
    (document) => {
      document.fixtures = document.fixtures.filter(
        (fixture) => fixture.id !== 'mr1-model-create-v1',
      )
      return document
    },
    /fixture index is missing required fixture mr1-model-create-v1/,
  )
})

test('rejects drift in the locked legacy migration baseline', async () => {
  await expectFailure(
    'legacy',
    (document) => {
      document.database.sha256 = '0'.repeat(64)
      return document
    },
    /legacy migration digest mismatch/,
  )
})
