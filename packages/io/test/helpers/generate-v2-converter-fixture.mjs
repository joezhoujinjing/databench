import { readFileSync, writeFileSync } from 'node:fs'
import { createExportPlanV2, createRecordRevisionV2 } from '@databench/schema'
import { createDefaultV2ConverterRegistry } from '../../dist/index.js'

const DATASET_VERSION = '9'.repeat(64)
const sourceFixtures = [
  'packages/io/test/golden/fixtures/v2/converter-output-bytes-and-fidelity.input.json',
  'packages/schema/test/golden/fixtures/v2/record-all-fields.input.json',
]
const sourceUrls = [
  new URL('../golden/fixtures/v2/converter-output-bytes-and-fidelity.input.json', import.meta.url),
  new URL('../../../schema/test/golden/fixtures/v2/record-all-fields.input.json', import.meta.url),
]
const outputUrl = new URL(
  '../golden/fixtures/v2/converter-output-bytes-and-fidelity.expected.json',
  import.meta.url,
)
const converterNames = ['canonical-jsonl', 'ms-swift', 'trl-dpo', 'trl-grpo-rlvr', 'trl-sft']

const revisions = sourceUrls.map((url) =>
  createRecordRevisionV2(JSON.parse(readFileSync(url, 'utf8'))),
)
const registry = createDefaultV2ConverterRegistry()
const descriptors = new Map(
  registry.descriptors().map((descriptor) => [descriptor.name, descriptor]),
)
const converters = []

for (const name of converterNames) {
  const descriptor = descriptors.get(name)
  if (!descriptor) throw new TypeError(`Missing converter descriptor: ${name}`)
  const analysis = registry.inspect(name, revisions, {})
  const outputUtf8 = await collectUtf8(
    registry.stream(name, revisions, analysis.normalized_options, analysis),
  )
  converters.push({
    name,
    plan: createExportPlanV2({
      export_fidelity_profile: 'databench-export-fidelity-1',
      dataset_version: DATASET_VERSION,
      converter: name,
      converter_version: descriptor.version,
      normalized_options: analysis.normalized_options,
      media_type: analysis.media_type,
      suggested_filename: analysis.suggested_filename,
      output_count: analysis.output_count,
      config_hints: analysis.config_hints,
      fidelity: analysis.fidelity,
    }),
    output_utf8: outputUtf8,
  })
}

writeFileSync(
  outputUrl,
  `${JSON.stringify(
    {
      source_fixtures: sourceFixtures,
      dataset_version: DATASET_VERSION,
      converters,
    },
    null,
    2,
  )}\n`,
)

async function collectUtf8(source) {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let output = ''
  for await (const chunk of source) output += decoder.decode(chunk, { stream: true })
  output += decoder.decode()
  return output
}
