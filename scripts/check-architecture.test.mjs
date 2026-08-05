import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { checkArchitecture } from './check-architecture.mjs'

const roots = []

async function fixture(files) {
  const root = await mkdtemp(path.join(tmpdir(), 'databench-architecture-'))
  roots.push(root)
  for (const [relativePath, contents] of Object.entries(files)) {
    const target = path.join(root, relativePath)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, contents)
  }
  return root
}

function manifest(name, dependencies = {}) {
  return `${JSON.stringify({ dependencies, name, private: true, type: 'module' }, null, 2)}\n`
}

test.after(async () => {
  await Promise.all(roots.map((root) => rm(root, { force: true, recursive: true })))
})

test('accepts the repository architecture', async () => {
  const root = path.resolve(import.meta.dirname, '..')
  const result = await checkArchitecture(root)
  assert.deepEqual(result.errors, [])
  assert.ok(result.workspaces >= 13)
  assert.ok(result.models >= 18)
})

test('rejects dependency DAG violations and non-workspace internal versions', async () => {
  const root = await fixture({
    'packages/hashing/package.json': manifest('@databench/hashing', {
      '@databench/catalog': 'workspace:*',
      '@databench/schema': '^1.0.0',
    }),
    'prisma/schema.prisma': '',
  })
  const result = await checkArchitecture(root)
  assert.ok(result.errors.some((error) => error.includes('may not depend on @databench/catalog')))
  assert.ok(result.errors.some((error) => error.includes('must use workspace:*')))
})

test('rejects deep imports and application data-boundary bypasses', async () => {
  const root = await fixture({
    'apps/api/package.json': manifest('@databench/api', {
      '@databench/schema': 'workspace:*',
      '@databench/workspace': 'workspace:*',
    }),
    'apps/api/src/app.ts': [
      `import { x } from '${['@databench/workspace', 'src/internal.js'].join('/')}'`,
      "import { PrismaClient } from '@prisma/client/runtime/library'",
    ].join('\n'),
    'prisma/schema.prisma': '',
  })
  const result = await checkArchitecture(root)
  assert.ok(result.errors.some((error) => error.includes('deep import is forbidden')))
  assert.ok(result.errors.some((error) => error.includes('must access data through Workspace')))
})

test('rejects unreviewed Prisma JSON and record payload fields', async () => {
  const root = await fixture({
    'prisma/schema.prisma': [
      'model V2DatasetSnapshot {',
      '  version String @id',
      '  samplePayload Json @map("sample_payload_json")',
      '}',
    ].join('\n'),
  })
  const result = await checkArchitecture(root)
  assert.ok(result.errors.some((error) => error.includes('unreviewed PostgreSQL JSON field')))
  assert.ok(result.errors.some((error) => error.includes('payload-bearing field is forbidden')))
})

test('keeps record tables locator-only', async () => {
  const root = await fixture({
    'prisma/schema.prisma': [
      'model V2RecordRevisionLocation {',
      '  recordId String',
      '  recordDigest String',
      '  datasetVersion String',
      '  rawBody String',
      '}',
    ].join('\n'),
  })
  const result = await checkArchitecture(root)
  assert.ok(result.errors.some((error) => error.includes('record locator-only boundary')))
})

test('rejects unreviewed JSON columns in migrations even when Prisma omits them', async () => {
  const root = await fixture({
    'prisma/migrations/9999_bad/migration.sql': [
      'CREATE TABLE "sample_cache" (',
      '  "id" UUID NOT NULL,',
      '  "data_json" JSONB NOT NULL',
      ');',
    ].join('\n'),
    'prisma/schema.prisma': '',
  })
  const result = await checkArchitecture(root)
  assert.ok(result.errors.some((error) => error.includes('unreviewed PostgreSQL JSON column')))
})
