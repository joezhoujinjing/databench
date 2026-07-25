import type { CatalogTransformJobRowV2 } from '@databench/catalog'
import type { WorkerJsonPayload } from './client.js'

export const BASIC_CLEAN_OPERATION_V1 = 'basic-clean'
export const DATA_JUICER_BATCH_CAPABILITY_V1 = 'data_juicer.batch'
export const DATA_JUICER_BATCH_PARAMETER_SCHEMA_V1 = 'databench.worker.data-juicer-batch-parameters'

const BASIC_CLEAN_PARAMETERS_V1 = new TextEncoder().encode(
  '{"np":1,"process":[{"whitespace_normalization_mapper":{}},{"text_length_filter":{"min_len":40}},{"document_deduplicator":{"lowercase":false}}]}',
)

/** Compile the TS-owned basic-clean@1 operation into its fixed Worker payload. */
export function compileBasicCleanWorkerParametersV1(
  job: Pick<
    CatalogTransformJobRowV2,
    'op' | 'opVersion' | 'params' | 'capabilityName' | 'capabilityVersion'
  >,
): WorkerJsonPayload {
  if (
    job.op !== BASIC_CLEAN_OPERATION_V1 ||
    job.opVersion !== '1' ||
    job.capabilityName !== DATA_JUICER_BATCH_CAPABILITY_V1 ||
    job.capabilityVersion !== '1' ||
    Object.keys(job.params).length !== 0
  ) {
    throw new TypeError('Transform job is not the fixed basic-clean@1 operation')
  }
  return {
    schemaName: DATA_JUICER_BATCH_PARAMETER_SCHEMA_V1,
    schemaVersion: '1',
    utf8Json: BASIC_CLEAN_PARAMETERS_V1.slice(),
  }
}
