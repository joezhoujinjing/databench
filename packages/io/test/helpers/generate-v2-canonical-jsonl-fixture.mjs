import { readFileSync, writeFileSync } from 'node:fs'
import { createRecordRevisionV2 } from '@databench/schema'
import { writeCanonicalJsonlV2 } from '../../dist/index.js'

const inputUrl = new URL(
  '../golden/fixtures/v2/canonical-jsonl-round-trip.input.jsonl',
  import.meta.url,
)
const outputUrl = new URL(
  '../golden/fixtures/v2/canonical-jsonl-round-trip.expected.jsonl',
  import.meta.url,
)
const records = readFileSync(inputUrl, 'utf8')
  .trimEnd()
  .split('\n')
  .map((line) => createRecordRevisionV2(JSON.parse(line)))
const chunks = []
for await (const chunk of writeCanonicalJsonlV2(records)) chunks.push(chunk)
writeFileSync(outputUrl, Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))))
