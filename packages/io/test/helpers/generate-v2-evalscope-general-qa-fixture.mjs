import { readFileSync, writeFileSync } from 'node:fs'
import {
  createExportPlanV2,
  createRecordRevisionV2,
  datasetVersionForSortedRecordRevisionsV2,
} from '@databench/schema'
import { createDefaultV2ConverterRegistry } from '../../dist/index.js'

const sourceFixture =
  'packages/io/test/golden/fixtures/v2/converter-output-bytes-and-fidelity.input.json'
const sourceUrl = new URL(
  '../golden/fixtures/v2/converter-output-bytes-and-fidelity.input.json',
  import.meta.url,
)
const outputUrl = new URL(
  '../golden/fixtures/v2/evalscope-general-qa.expected.json',
  import.meta.url,
)
const targetSources = ['selected-candidate', 'verification-ground-truth', 'none']

const revision = createRecordRevisionV2(JSON.parse(readFileSync(sourceUrl, 'utf8')))
const datasetVersion = datasetVersionForSortedRecordRevisionsV2([revision])
const registry = createDefaultV2ConverterRegistry()
const descriptor = registry.require('evalscope-general-qa')
const profiles = []

for (const targetSource of targetSources) {
  const options = { target_source: targetSource }
  const analysis = registry.inspect('evalscope-general-qa', [revision], options)
  const outputUtf8 = await collectUtf8(
    registry.stream('evalscope-general-qa', [revision], options, analysis),
  )
  profiles.push({
    target_source: targetSource,
    plan: createExportPlanV2({
      export_fidelity_profile: 'databench-export-fidelity-1',
      dataset_version: datasetVersion,
      converter: 'evalscope-general-qa',
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
      source_fixture: sourceFixture,
      dataset_version: datasetVersion,
      profiles,
    },
    null,
    2,
  )}\n`,
)

async function collectUtf8(source) {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let output = ''
  for await (const chunk of source) output += decoder.decode(chunk, { stream: true })
  return output + decoder.decode()
}
