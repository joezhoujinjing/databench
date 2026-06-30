import { API_VERSION, type Capabilities, MIN_CLIENT } from '@databench/schema'
import { listTransforms } from '@databench/workspace'

export function getCapabilities(): Capabilities {
  return {
    api_version: API_VERSION,
    min_client: MIN_CLIENT,
    features: {
      transforms: listTransforms().length > 0,
      recipes: true,
      lineage: true,
      jsonl_ingest: true,
      export: true,
      synthesis: false,
      annotation: false,
      vocabularies: true,
    },
  }
}
