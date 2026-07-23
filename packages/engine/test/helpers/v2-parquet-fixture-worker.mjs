import { writeFileSync } from 'node:fs'
import { V2Dataset, writeRecordJsonV1ToPath } from '../../dist/index.js'
import { matrixCase, matrixRecords } from './v2-parquet-fixture-cases.mjs'

const [caseId, outputPath] = process.argv.slice(2)
if (!caseId || !outputPath) {
  throw new Error('Usage: v2-parquet-fixture-worker.mjs <case-id> <output-path>')
}

const descriptor = matrixCase(caseId)
writeFileSync(outputPath, new Uint8Array(), { flag: 'wx', mode: 0o600 })
const dataset = V2Dataset.fromRecords(matrixRecords(caseId))
if (dataset.length !== descriptor.rows) {
  throw new Error(`Generated ${dataset.length} rows for ${caseId}; expected ${descriptor.rows}`)
}

const result = await writeRecordJsonV1ToPath(dataset, outputPath)
const records = [...dataset.records()]
process.stdout.write(
  `${JSON.stringify({
    case_id: caseId,
    dataset_identity: dataset.identity,
    artifact_digest: result.artifactDigest,
    artifact_size_bytes: result.artifactSizeBytes,
    first_record_id: records[0]?.record.id ?? null,
    last_record_id: records.at(-1)?.record.id ?? null,
  })}\n`,
)
