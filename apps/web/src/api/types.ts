import type { components, paths } from './generated/schema.js'

type JsonContent<Response> = Response extends {
  content: {
    'application/json': infer Content
  }
}
  ? Content
  : never

type NdjsonContent<Response> = Response extends {
  content: {
    'application/x-ndjson': infer Content
  }
}
  ? Content
  : never

type OkJson<Operation> = Operation extends {
  responses: {
    200: infer Response
  }
}
  ? JsonContent<Response>
  : never

type OkNdjson<Operation> = Operation extends {
  responses: {
    200: infer Response
  }
}
  ? NdjsonContent<Response>
  : never

type JsonRequest<Operation> = Operation extends {
  requestBody?: {
    content: {
      'application/json': infer Body
    }
  }
}
  ? Body
  : never

export type Capabilities = components['schemas']['Capabilities']
export type ErrorResponse = components['schemas']['ErrorResponse']
export type HealthInfo = components['schemas']['HealthInfo']
export type RefInfo = components['schemas']['RefInfo']
export type RefsPage = components['schemas']['RefsPage']
export type Term = components['schemas']['Term']
export type TransformInfo = components['schemas']['TransformInfo']
export type TransformRunRequest = components['schemas']['TransformRunRequest']
export type TransformsPage = components['schemas']['TransformsPage']
export type ValidateResponse = components['schemas']['ValidateResponse']
export type ValidateSummary = components['schemas']['ValidateSummary']
export type VersionInfo = components['schemas']['VersionInfo']
export type VocabulariesPage = components['schemas']['VocabulariesPage']
export type Vocabulary = components['schemas']['Vocabulary']
export type VocabularyInfo = components['schemas']['VocabularyInfo']
export type VocabularyInput = components['schemas']['VocabularyInput']

export type DatasetManifest = OkJson<paths['/v1/datasets']['post']>
export type ExportNdjson = OkNdjson<paths['/v1/datasets/{ref}/export']['get']>
export type ExportFormat = NonNullable<Recipe['target_format']>
export type IngestJsonlQuery = NonNullable<
  paths['/v1/datasets:ingest-jsonl']['post']['parameters']['query']
>
export type IngestKind = NonNullable<IngestJsonlQuery['kind']>
export type IngestSamplesRequest = JsonRequest<paths['/v1/datasets']['post']>
export type Lineage = OkJson<paths['/v1/lineage/{ref}']['get']>
export type MaterializeRequest = JsonRequest<paths['/v1/recipes:materialize']['post']>
export type Recipe = MaterializeRequest['recipe']
export type Sample = SamplesPage['items'][number]
export type SampleKind = Sample['kind']
export type SamplesPage = OkJson<paths['/v1/datasets/{ref}/samples']['get']>

export interface Extractor {
  readonly source: 'assistant_json'
  readonly raw_key: string
  readonly std_key: string
}

export interface AliasConflict {
  readonly chosen?: string
  readonly also_seen: readonly string[]
  readonly counts: Record<string, number>
}
