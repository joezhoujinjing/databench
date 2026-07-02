import { z } from 'zod'
import {
  API_VERSION,
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  MIN_CLIENT,
  SCHEMA_VERSION,
} from './constants.js'
import { ErrorResponseSchema } from './errors.js'
import { ManifestSchema } from './manifest.js'
import { RecipeSchema } from './recipe.js'
import { KindSchema, MessageSchema, SampleSchema } from './sample.js'
import {
  ValidateSummarySchema,
  VocabularyInfoSchema,
  VocabularyInputSchema,
  VocabularySchema,
} from './vocabulary.js'

export const HealthInfoSchema = z
  .object({
    status: z.literal('ok'),
    workspace_root: z.string(),
    version: z.string(),
  })
  .meta({ id: 'HealthInfo' })
export type HealthInfo = z.infer<typeof HealthInfoSchema>
export const HealthResponseSchema = HealthInfoSchema
export type HealthResponse = z.infer<typeof HealthResponseSchema>

export const VersionInfoSchema = z
  .object({
    api_version: z.string().default(API_VERSION),
    service_version: z.string(),
    schema_version: z.string().default(SCHEMA_VERSION),
  })
  .meta({ id: 'VersionInfo' })
export type VersionInfo = z.infer<typeof VersionInfoSchema>
export const VersionResponseSchema = VersionInfoSchema
export type VersionResponse = z.infer<typeof VersionResponseSchema>

export const CapabilityFeaturesSchema = z.object({
  transforms: z.boolean(),
  recipes: z.boolean(),
  lineage: z.boolean(),
  jsonl_ingest: z.boolean(),
  export: z.boolean(),
  synthesis: z.boolean(),
  annotation: z.boolean(),
  vocabularies: z.boolean(),
})
export type CapabilityFeatures = z.infer<typeof CapabilityFeaturesSchema>

export const CapabilitiesSchema = z
  .object({
    api_version: z.string().default(API_VERSION),
    min_client: z.string().default(MIN_CLIENT),
    features: CapabilityFeaturesSchema,
  })
  .meta({ id: 'Capabilities' })
export type Capabilities = z.infer<typeof CapabilitiesSchema>
export const CapabilitiesResponseSchema = CapabilitiesSchema
export type CapabilitiesResponse = z.infer<typeof CapabilitiesResponseSchema>

export function defaultCapabilityFeatures(): CapabilityFeatures {
  return {
    transforms: false,
    recipes: false,
    lineage: false,
    jsonl_ingest: false,
    export: false,
    synthesis: false,
    annotation: false,
    vocabularies: false,
  }
}

export function defaultCapabilities(): Capabilities {
  return {
    api_version: API_VERSION,
    min_client: MIN_CLIENT,
    features: defaultCapabilityFeatures(),
  }
}

// The service's declared capability policy (per D1/D2), single-sourced so the
// HTTP API and the CLI cannot drift. `transforms` is runtime-derived (whether
// any transform is registered), so callers pass it in.
export function serviceCapabilities(runtime: { readonly transforms: boolean }): Capabilities {
  return {
    api_version: API_VERSION,
    min_client: MIN_CLIENT,
    features: {
      transforms: runtime.transforms,
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

export const IngestSamplesRequestSchema = z.object({
  name: z.string().nullable().default(null),
  message: z.string().nullable().default(null),
  samples: z.array(SampleSchema),
})
export type IngestSamplesRequest = z.infer<typeof IngestSamplesRequestSchema>

// Query params arrive as strings; `z.coerce.*` makes the SAME schema both the
// runtime validator (via `c.req.valid('query')`) and the OpenAPI source — no
// separate `*OpenApiQuerySchema` is needed.
export const PaginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
  offset: z.coerce.number().int().min(0).default(0),
})
export type PaginationQuery = z.infer<typeof PaginationQuerySchema>

export const IngestJsonlQuerySchema = z.object({
  name: z.string().nullable().optional(),
  kind: KindSchema.nullable().optional(),
  source: z.string().nullable().optional(),
})
export type IngestJsonlQuery = z.infer<typeof IngestJsonlQuerySchema>

export const ExportDatasetQuerySchema = z.object({
  fmt: z.string().default('messages-jsonl'),
})
export type ExportDatasetQuery = z.infer<typeof ExportDatasetQuerySchema>

// --- OpenAPI surrogates for schemas @hono/zod-openapi cannot render ---------
// `@hono/zod-openapi@1` (zod-to-openapi v8) throws `UnknownZodTypeError` on the
// `z.custom()` JSON-number lexeme used by SampleSchema/RecipeSchema (the lexeme
// preserves exact numeric source for deterministic hashing). The discriminated
// `SampleSchema` and `RecipeSchema` therefore cannot be emitted as OpenAPI.
// These `*OpenApi*` surrogates document the wire shape; the corresponding full
// schema (IngestSamplesRequestSchema / MaterializeRequestSchema) still performs
// runtime validation in the handler. Validation behaviour is unchanged.
const SampleBaseOpenApiSchema = z.object({
  source: z.string().nullable().optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
  signals: z.record(z.string(), z.unknown()).optional(),
})

const RolloutOpenApiSchema = z.object({
  text: z.string(),
  reward: z.number().nullable().optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
})

const CandidateOpenApiSchema = z.object({
  completion: z.union([MessageSchema, z.array(MessageSchema)]),
  rank: z.number().int().nullable().optional(),
  score: z.number().nullable().optional(),
})

export const SampleOpenApiSchema = z
  .discriminatedUnion('kind', [
    SampleBaseOpenApiSchema.extend({
      kind: z.literal('sft'),
      messages: z.array(MessageSchema),
    }),
    SampleBaseOpenApiSchema.extend({
      kind: z.literal('preference'),
      prompt: z.array(MessageSchema).optional(),
      chosen: z.union([MessageSchema, z.array(MessageSchema)]),
      rejected: z.union([MessageSchema, z.array(MessageSchema)]),
      candidates: z.array(CandidateOpenApiSchema).nullable().optional(),
    }),
    SampleBaseOpenApiSchema.extend({
      kind: z.literal('rl'),
      prompt: z.array(MessageSchema).optional(),
      answer: z.string().nullable().optional(),
      verifier: z.string().nullable().optional(),
      rollouts: z.array(RolloutOpenApiSchema).optional(),
    }),
    SampleBaseOpenApiSchema.extend({
      kind: z.literal('trajectory'),
      messages: z.array(MessageSchema),
    }),
  ])
  .meta({ id: 'Sample' })

export const IngestSamplesOpenApiRequestSchema = z
  .object({
    name: z.string().nullable().optional(),
    message: z.string().nullable().optional(),
    samples: z.array(SampleOpenApiSchema),
  })
  .meta({ id: 'IngestSamplesRequest' })

export const TransformRunRequestSchema = z
  .object({
    inputs: z.array(z.string()),
    params: z.record(z.string(), z.unknown()).default(() => ({})),
    ref: z.string().nullable().default(null),
  })
  .meta({ id: 'TransformRunRequest' })
export type TransformRunRequest = z.infer<typeof TransformRunRequestSchema>

export const TransformInfoSchema = z
  .object({
    name: z.string(),
    version: z.string(),
    params_schema: z.record(z.string(), z.unknown()).nullable().default(null),
  })
  .meta({ id: 'TransformInfo' })
export type TransformInfo = z.infer<typeof TransformInfoSchema>

export const RefInfoSchema = z
  .object({
    name: z.string(),
    version: z.string(),
  })
  .meta({ id: 'RefInfo' })
export type RefInfo = z.infer<typeof RefInfoSchema>

export const PageSchema = z.object({
  total: z.number().int().nonnegative(),
  limit: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
})
export type Page = z.infer<typeof PageSchema>

export const SamplesPageSchema = PageSchema.extend({
  items: z.array(SampleSchema),
})
export type SamplesPage = z.infer<typeof SamplesPageSchema>

export const SamplesPageOpenApiSchema = PageSchema.extend({
  items: z.array(SampleOpenApiSchema),
}).meta({ id: 'SamplesPage' })

export const TransformsPageSchema = PageSchema.extend({
  items: z.array(TransformInfoSchema),
}).meta({ id: 'TransformsPage' })
export type TransformsPage = z.infer<typeof TransformsPageSchema>

export const RefsPageSchema = PageSchema.extend({
  items: z.array(RefInfoSchema),
}).meta({ id: 'RefsPage' })
export type RefsPage = z.infer<typeof RefsPageSchema>

export const VocabulariesPageSchema = PageSchema.extend({
  items: z.array(VocabularyInfoSchema),
}).meta({ id: 'VocabulariesPage' })
export type VocabulariesPage = z.infer<typeof VocabulariesPageSchema>

export const MaterializeRequestSchema = z.object({
  recipe: RecipeSchema,
  ref: z.string().nullable().default(null),
})
export type MaterializeRequest = z.infer<typeof MaterializeRequestSchema>

// Surrogate for the materialize body — RecipeSchema embeds the unrenderable
// JSON-number lexeme (see surrogate note above). MaterializeRequestSchema does
// the real validation in the handler.
export const MaterializeOpenApiRequestSchema = z
  .object({
    recipe: z.object({
      name: z.string(),
      sources: z.array(
        z.object({
          dataset: z.string(),
          weight: z.number().nullable().optional(),
          max_samples: z.number().int().nullable().optional(),
        }),
      ),
      target_format: z.enum(['messages-jsonl', 'trl']).optional(),
      target_size: z.number().int().nullable().optional(),
      seed: z.number().int().optional(),
    }),
    ref: z.string().nullable().optional(),
  })
  .meta({ id: 'MaterializeRequest' })

export const VocabularyResponseSchema = VocabularySchema
export const VocabularyRequestSchema = VocabularyInputSchema

export const ValidateResponseSchema = z
  .object({
    summary: ValidateSummarySchema,
    dataset: ManifestSchema,
  })
  .meta({ id: 'ValidateResponse' })
export type ValidateResponse = z.infer<typeof ValidateResponseSchema>

export const DatasetResponseSchema = ManifestSchema
export const ServiceErrorResponseSchema = ErrorResponseSchema

export const LineageProducedBySchema = z.object({
  op: z.string(),
  op_version: z.string(),
  params: z.record(z.string(), z.unknown()),
})
export type LineageProducedBy = z.infer<typeof LineageProducedBySchema>

export interface LineageNode {
  readonly version: string
  readonly name?: string | null | undefined
  readonly num_rows?: number | undefined
  readonly produced_by?: LineageProducedBy | undefined
  readonly inputs?: readonly LineageNode[] | undefined
  readonly cycle?: true | undefined
}

export const LineageNodeSchema: z.ZodType<LineageNode> = z
  .lazy(() =>
    z.object({
      version: z.string(),
      name: z.string().nullable().optional(),
      num_rows: z.number().int().nonnegative().optional(),
      produced_by: LineageProducedBySchema.optional(),
      inputs: z.array(LineageNodeSchema).optional(),
      cycle: z.literal(true).optional(),
    }),
  )
  .meta({ id: 'LineageNode' })
