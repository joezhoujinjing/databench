import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { asyncBufferFromFile, parquetMetadataAsync } from 'hyparquet'
import { V2Dataset, writeRecordJsonV1ToPath } from '../../dist/index.js'
import { matrixRecords, V2_PARQUET_MATRIX_CASES } from './v2-parquet-fixture-cases.mjs'

const helperDirectory = dirname(fileURLToPath(import.meta.url))
const fixtureRoot = join(helperDirectory, '..', 'golden', 'fixtures', 'v2')
const rawRoot = join(fixtureRoot, 'parquet-determinism-matrix')
mkdirSync(rawRoot, { recursive: true })

const cases = []
for (const descriptor of V2_PARQUET_MATRIX_CASES) {
  const outputPath = join(rawRoot, `${descriptor.id}.parquet`)
  writeFileSync(outputPath, new Uint8Array(), { mode: 0o600 })
  const dataset = V2Dataset.fromRecords(matrixRecords(descriptor.id))
  const result = await writeRecordJsonV1ToPath(dataset, outputPath)
  const metadata = await parquetMetadataAsync(await asyncBufferFromFile(outputPath), {
    geoparquet: false,
  })
  const records = [...dataset.records()]
  cases.push({
    id: descriptor.id,
    rows: descriptor.rows,
    raw_fixture: `parquet-determinism-matrix/${descriptor.id}.parquet`,
    dataset_identity: dataset.identity,
    artifact_digest: result.artifactDigest,
    artifact_size_bytes: result.artifactSizeBytes,
    row_groups: metadata.row_groups.map((group) => Number(group.num_rows)),
    first_record_id: records[0]?.record.id ?? null,
    last_record_id: records.at(-1)?.record.id ?? null,
  })
  const bytes = readFileSync(outputPath)
  if (bytes.byteLength !== result.artifactSizeBytes) {
    throw new Error(`Fixture size changed while generating ${descriptor.id}`)
  }
}

const expected = {
  fixture_version: 1,
  layout_version: 'record-json-v1',
  writer: 'hyparquet-writer@0.16.1',
  compressor: '@bokuweb/zstd-wasm@0.0.27',
  compression: { codec: 'ZSTD', level: 3 },
  encoding: 'PLAIN',
  row_group_size: 65_536,
  data_page_size: 1_048_576,
  supported_platforms: ['linux-x64-gnu', 'darwin-arm64'],
  cases,
}
writeFileSync(
  join(fixtureRoot, 'parquet-determinism-matrix.expected.json'),
  `${JSON.stringify(expected, null, 2)}\n`,
)
