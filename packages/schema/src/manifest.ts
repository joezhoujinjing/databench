import { HASH_ALGO } from '@databench/hashing'
import { z } from 'zod'
import { COLUMNS, SCHEMA_VERSION } from './constants.js'

export const ManifestSchema = z
  .object({
    name: z.string().nullable().default(null),
    version: z.string(),
    schema_version: z.string().default(SCHEMA_VERSION),
    hash_algo: z.string().default(HASH_ALGO),
    num_rows: z.number().int().nonnegative(),
    kinds: z.record(z.string(), z.number().int().nonnegative()),
    columns: z.array(z.string()).default(() => [...COLUMNS]),
    created_at: z.string(),
  })
  // `.meta({ id })` names this as a reusable OpenAPI component (single source: zod).
  .meta({ id: 'Manifest' })
export type Manifest = z.infer<typeof ManifestSchema>
