import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { asyncBufferFromFile, parquetMetadataAsync } from 'hyparquet'
import { afterEach, describe, expect, test } from 'vitest'
import { decodeRecordJsonV1FromPath } from '../src/index.js'

interface MatrixExpected {
  fixture_version: number
  layout_version: string
  writer: string
  compressor: string
  supported_platforms: string[]
  cases: MatrixCaseExpected[]
}

interface MatrixCaseExpected {
  id: string
  rows: number
  raw_fixture: string
  dataset_identity: {
    identity_profile: 'databench-v2-jcs-1'
    record_schema_version: '2.0.0'
    dataset_version: string
    num_records: number
  }
  artifact_digest: string
  artifact_size_bytes: number
  row_groups: number[]
  first_record_id: string | null
  last_record_id: string | null
}

interface WorkerResult {
  case_id: string
  dataset_identity: MatrixCaseExpected['dataset_identity']
  artifact_digest: string
  artifact_size_bytes: number
  first_record_id: string | null
  last_record_id: string | null
}

const fixtureRoot = fileURLToPath(new URL('./golden/fixtures/v2/', import.meta.url))
const expected = JSON.parse(
  readFileSync(join(fixtureRoot, 'parquet-determinism-matrix.expected.json'), 'utf8'),
) as MatrixExpected
const workerPath = fileURLToPath(
  new URL('./helpers/v2-parquet-fixture-worker.mjs', import.meta.url),
)
const distPath = fileURLToPath(new URL('../dist/index.js', import.meta.url))
const temporaryDirectories: string[] = []
const detectedPlatform = detectArtifactPlatform()
const expectedPlatform = process.env.DATABENCH_V2_PARQUET_EXPECTED_PLATFORM ?? detectedPlatform

if (detectedPlatform === null) {
  throw new Error(
    `record-json-v1 is unsupported on ${process.platform}-${process.arch}; ` +
      `supported platforms: ${expected.supported_platforms.join(', ')}`,
  )
}
if (expectedPlatform !== detectedPlatform) {
  throw new Error(
    `record-json-v1 CI platform mismatch: expected ${expectedPlatform}, detected ${detectedPlatform}`,
  )
}
if (!expected.supported_platforms.includes(detectedPlatform)) {
  throw new Error(`Fixture manifest does not declare detected platform ${detectedPlatform}`)
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  )
})

describe('record-json-v1 cross-process raw artifact matrix', () => {
  for (const fixtureCase of expected.cases) {
    test(fixtureCase.id, async () => {
      expect(existsSync(distPath), 'Build @databench/engine before running the GV5 matrix').toBe(
        true,
      )
      const directory = await createTemporaryDirectory()
      const firstPath = join(directory, 'first.parquet')
      const secondPath = join(directory, 'second.parquet')

      const first = runWorker(fixtureCase.id, firstPath)
      const second = runWorker(fixtureCase.id, secondPath)
      const goldenBytes = readFileSync(join(fixtureRoot, fixtureCase.raw_fixture))

      expect(first).toEqual(second)
      expect(first).toMatchObject({
        case_id: fixtureCase.id,
        dataset_identity: fixtureCase.dataset_identity,
        artifact_digest: fixtureCase.artifact_digest,
        artifact_size_bytes: fixtureCase.artifact_size_bytes,
        first_record_id: fixtureCase.first_record_id,
        last_record_id: fixtureCase.last_record_id,
      })
      expect(readFileSync(firstPath)).toEqual(goldenBytes)
      expect(readFileSync(secondPath)).toEqual(goldenBytes)

      const metadata = await parquetMetadataAsync(await asyncBufferFromFile(firstPath), {
        geoparquet: false,
      })
      expect(metadata.row_groups.map((group) => Number(group.num_rows))).toEqual(
        fixtureCase.row_groups,
      )

      const decoded = await decodeRecordJsonV1FromPath(firstPath, {
        expectedIdentity: fixtureCase.dataset_identity,
      })
      const decodedRecords = [...decoded.records()]
      expect(decoded.length).toBe(fixtureCase.rows)
      expect(decodedRecords[0]?.record.id ?? null).toBe(fixtureCase.first_record_id)
      expect(decodedRecords.at(-1)?.record.id ?? null).toBe(fixtureCase.last_record_id)
    }, 300_000)
  }
})

function runWorker(caseId: string, outputPath: string): WorkerResult {
  const result = spawnSync(process.execPath, [workerPath, caseId, outputPath], {
    encoding: 'utf8',
    timeout: 300_000,
    maxBuffer: 1024 * 1024,
  })
  expect(result.error).toBeUndefined()
  expect(result.status, result.stderr).toBe(0)
  return JSON.parse(result.stdout) as WorkerResult
}

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'databench-v2-parquet-matrix-'))
  temporaryDirectories.push(directory)
  return directory
}

function detectArtifactPlatform(): string | null {
  if (process.platform === 'darwin' && process.arch === 'arm64') {
    return 'darwin-arm64'
  }
  if (process.platform === 'linux' && process.arch === 'x64') {
    const report = process.report.getReport()
    if (typeof report.header.glibcVersionRuntime === 'string') {
      return 'linux-x64-gnu'
    }
  }
  return null
}
