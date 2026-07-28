import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, '..')
const CHECKER = path.join(REPOSITORY_ROOT, 'scripts/check-swift-baseline.mjs')

const DOCUMENTS = {
  lock: path.join(REPOSITORY_ROOT, 'third_party/ms-swift/upstream.lock'),
  capability: path.join(REPOSITORY_ROOT, 'third_party/ms-swift/runtime-capabilities.json'),
  baseline: path.join(REPOSITORY_ROOT, 'third_party/ms-swift/gradio-baseline.json'),
  routes: path.join(REPOSITORY_ROOT, 'third_party/ms-swift/gradio-routes.json'),
  source: path.join(REPOSITORY_ROOT, 'third_party/ms-swift/upstream-manifest.json'),
}

async function expectFailure(documentName, mutate, expectedMessage) {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'databench-swift-negative-'))
  try {
    const document = JSON.parse(await readFile(DOCUMENTS[documentName], 'utf8'))
    mutate(document)
    const documentPath = path.join(temporaryRoot, `${documentName}.json`)
    await writeFile(documentPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
    if (documentName === 'lock') {
      const baselineRoot = path.dirname(DOCUMENTS.lock)
      for (const directory of ['patches', 'vendor']) {
        await symlink(
          path.join(baselineRoot, directory),
          path.join(temporaryRoot, directory),
          'dir',
        )
      }
      for (const fileName of [
        'runtime-requirements.in',
        'runtime-provided.txt',
        'runtime-requirements.lock',
      ]) {
        await symlink(path.join(baselineRoot, fileName), path.join(temporaryRoot, fileName), 'file')
      }
    }
    const environmentName = {
      lock: 'SWIFT_UPSTREAM_LOCK_PATH',
      capability: 'SWIFT_CAPABILITY_MANIFEST_PATH',
      baseline: 'SWIFT_GRADIO_BASELINE_PATH',
      routes: 'SWIFT_GRADIO_ROUTES_PATH',
      source: 'SWIFT_SOURCE_MANIFEST_PATH',
    }[documentName]
    const result = spawnSync(process.execPath, [CHECKER], {
      cwd: REPOSITORY_ROOT,
      env: { ...process.env, [environmentName]: documentPath },
      encoding: 'utf8',
    })
    assert.notEqual(result.status, 0, result.stdout)
    assert.match(`${result.stdout}\n${result.stderr}`, expectedMessage)
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}

test('rejects a capability manifest from another upstream commit', async () => {
  await expectFailure(
    'capability',
    (document) => {
      document.upstream_commit = '0'.repeat(40)
    },
    /capability manifest commit does not match upstream\.lock/,
  )
})

test('rejects removal of a complete native Gradio surface', async () => {
  await expectFailure(
    'capability',
    (document) => {
      document.capabilities = document.capabilities.filter((entry) => entry.id !== 'surface.grpo')
    },
    /required native surface is missing: surface\.grpo/,
  )
})

test('rejects runtime validation backed only by planned evidence', async () => {
  await expectFailure(
    'capability',
    (document) => {
      const capability = document.capabilities.find(
        (entry) => entry.id === 'runtime.qwen-small-sft-lora',
      )
      capability.runtime_validated = true
    },
    /runtime-validated capability still has planned evidence/,
  )
})

test('rejects removal of a required Gradio queue route', async () => {
  await expectFailure(
    'routes',
    (document) => {
      document.routes = document.routes.filter((entry) => entry.path !== '/gradio_api/queue/join')
      document.route_count = document.routes.length
      document.routes_sha256 = '0'.repeat(64)
    },
    /required Gradio route is missing: POST \/gradio_api\/queue\/join/,
  )
})

test('rejects component baseline drift', async () => {
  await expectFailure(
    'baseline',
    (document) => {
      document.components.pop()
      document.component_count = document.components.length
      document.components_sha256 = '0'.repeat(64)
    },
    /locked component count must be 1005/,
  )
})

test('rejects a tracked source digest mismatch', async () => {
  await expectFailure(
    'source',
    (document) => {
      document.files.find((entry) => entry.upstream_path === 'swift/ui/app.py').upstream_sha256 =
        '0'.repeat(64)
    },
    /source archive digest mismatch: swift\/ui\/app\.py/,
  )
})

test('rejects a floating Linux GPU base image', async () => {
  await expectFailure(
    'lock',
    (document) => {
      document.runtime_target.base_image_digest = null
    },
    /Swift runtime base image tag and digest must be locked/,
  )
})

test('rejects a dependency lock outside the third-party baseline', async () => {
  await expectFailure(
    'lock',
    (document) => {
      document.runtime_target.dependency_lock_path = '../runtime-requirements.lock'
    },
    /dependency lock path must be relative to upstream\.lock/,
  )
})
