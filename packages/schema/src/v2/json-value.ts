import {
  type CanonicalJsonObject,
  type CanonicalJsonValue,
  canonicalJsonV2,
} from '@databench/hashing'
import { z } from 'zod'

const JSON_VALUE_OPENAPI_SCHEMA = {
  oneOf: [
    { type: 'object', additionalProperties: true, nullable: true },
    { type: 'array', items: {} },
    { type: 'string' },
    { type: 'number' },
    { type: 'boolean' },
  ],
} as const

export const JsonValueSchema: z.ZodType<CanonicalJsonValue> = z
  .any()
  .superRefine(validateCanonicalJsonValue)
  .meta(JSON_VALUE_OPENAPI_SCHEMA)

export const JsonObjectSchema: z.ZodType<CanonicalJsonObject> = z
  .any()
  .superRefine((value, context) => {
    validateCanonicalJsonValue(value, context)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      context.addIssue({ code: 'custom', message: 'Expected a JSON object' })
    }
  })
  .meta({ type: 'object', additionalProperties: true })

function validateCanonicalJsonValue(value: unknown, context: z.RefinementCtx): void {
  try {
    canonicalJsonV2(value)
  } catch (error) {
    context.addIssue({
      code: 'custom',
      message: error instanceof Error ? error.message : 'Expected a canonical JSON value',
    })
  }
}

export type JsonValueV2 = CanonicalJsonValue
export type JsonObjectV2 = CanonicalJsonObject
