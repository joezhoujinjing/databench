import {
  type CanonicalJsonObject,
  type CanonicalJsonValue,
  canonicalJsonV2,
} from '@databench/hashing'
import { z } from 'zod'
import {
  CandidateIdSchema,
  CanonicalMimeTypeSchema,
  DigestHexSchema,
  NonEmptyStringSchema,
  NonNegativeSafeIntegerSchema,
  NullableNonEmptyStringSchema,
  RecordIdSchema,
  StableUriSchema,
} from './common.js'
import { ContentRoleSchema } from './content.js'
import { JsonObjectSchema, JsonValueSchema } from './json-value.js'
import { type CompatiblePartV2, UnknownPartSchema } from './part.js'

export type CompatibleContentV2 = CanonicalJsonObject & {
  readonly role: 'system' | 'user' | 'ai'
  readonly parts: readonly CompatiblePartV2[]
  readonly loss_weight: number | null
}

export type CompatibleCandidateV2 = CanonicalJsonObject & {
  readonly id: string
  readonly contents: readonly CompatibleContentV2[]
}

export type CompatiblePostTrainingRecordV2 = CanonicalJsonObject & {
  readonly schema_version: string
  readonly id: string
  readonly contents: readonly CompatibleContentV2[]
  readonly candidates: readonly CompatibleCandidateV2[]
}

const CompatiblePartBaseShape = {
  thought: z.boolean(),
  thought_signature: NullableNonEmptyStringSchema,
  part_metadata: JsonObjectSchema,
} as const

const CompatibleFunctionCallSchema = z.looseObject({
  id: NonEmptyStringSchema,
  name: NonEmptyStringSchema,
  args: JsonObjectSchema,
})

const CompatibleFunctionResponseSchema = z.looseObject({
  call_id: NonEmptyStringSchema,
  response: JsonValueSchema,
})

const CompatibleKnownPartSchemas = {
  text: z.looseObject({ ...CompatiblePartBaseShape, type: z.literal('text'), text: z.string() }),
  function_call: z.looseObject({
    ...CompatiblePartBaseShape,
    type: z.literal('function_call'),
    function_call: CompatibleFunctionCallSchema,
  }),
  function_response: z.looseObject({
    ...CompatiblePartBaseShape,
    type: z.literal('function_response'),
    function_response: CompatibleFunctionResponseSchema,
  }),
  file_data: z.looseObject({
    ...CompatiblePartBaseShape,
    type: z.literal('file_data'),
    file_data: z.looseObject({
      uri: StableUriSchema,
      media_type: CanonicalMimeTypeSchema,
      digest: z.looseObject({ algorithm: z.literal('blake3'), value: DigestHexSchema }),
      size_bytes: NonNegativeSafeIntegerSchema,
    }),
  }),
} as const

const CompatibleFuturePartSchema = z.looseObject({
  ...CompatiblePartBaseShape,
  type: NonEmptyStringSchema,
})

const CompatiblePartInputSchema = JsonObjectSchema.superRefine((part, context) => {
  const type = part.type
  const schema =
    typeof type === 'string'
      ? CompatibleKnownPartSchemas[type as keyof typeof CompatibleKnownPartSchemas]
      : undefined
  const result = (schema ?? CompatibleFuturePartSchema).safeParse(part)
  if (!result.success) {
    for (const issue of result.error.issues) {
      context.addIssue({ code: 'custom', path: issue.path, message: issue.message })
    }
  }
})

const CompatibleContentSchema = z
  .looseObject({
    role: ContentRoleSchema,
    parts: z.array(CompatiblePartInputSchema).min(1),
    loss_weight: z.number().finite().nonnegative().nullable(),
  })
  .superRefine((content, context) => {
    if (content.role !== 'system') {
      return
    }
    if (content.loss_weight !== 0) {
      context.addIssue({
        code: 'custom',
        path: ['loss_weight'],
        message: 'System content loss_weight must be 0',
      })
    }
    if (content.parts.length !== 1 || content.parts[0]?.type !== 'text') {
      context.addIssue({
        code: 'custom',
        path: ['parts'],
        message: 'System content must contain exactly one text part',
      })
    }
  })

const CompatibleCandidateSchema = z
  .looseObject({
    id: CandidateIdSchema,
    contents: z.array(CompatibleContentSchema).min(1),
  })
  .superRefine((candidate, context) => {
    validateCompatibleConversation(candidate.contents, context, ['contents'], false)
  })

const CompatibleRecordShapeSchema = z
  .looseObject({
    schema_version: z.string().regex(/^2\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/),
    id: RecordIdSchema,
    contents: z.array(CompatibleContentSchema),
    candidates: z.array(CompatibleCandidateSchema),
    preference_relations: z.array(JsonObjectSchema),
    tools: z.array(JsonObjectSchema),
    verification: JsonObjectSchema.nullable(),
    source: JsonObjectSchema.nullable(),
    lang: z.string().nullable(),
    lineage: JsonObjectSchema.nullable(),
    tags: z.array(z.string()),
    extra: JsonObjectSchema,
  })
  .superRefine((record, context) => {
    validateCompatibleConversation(record.contents, context, ['contents'], true)
    if (record.candidates.length > 0 && record.contents.at(-1)?.role !== 'user') {
      context.addIssue({
        code: 'custom',
        path: ['contents'],
        message: 'Shared contents must end with user when candidates exist',
      })
    }
  })

export function readCompatibleRecordV2(input: unknown): CompatiblePostTrainingRecordV2 {
  canonicalJsonV2(input)
  const json = JsonObjectSchema.parse(input)
  CompatibleRecordShapeSchema.parse(json)
  const transformed = transformRecordParts(json, 'read')
  return transformed as CompatiblePostTrainingRecordV2
}

export function writeCompatibleRecordV2(record: CompatiblePostTrainingRecordV2): string {
  canonicalJsonV2(record)
  const json = JsonObjectSchema.parse(record)
  CompatibleRecordShapeSchema.parse(json)
  return canonicalJsonV2(transformRecordParts(json, 'write'))
}

function transformRecordParts(
  record: CanonicalJsonObject,
  direction: 'read' | 'write',
): CanonicalJsonObject {
  const clone = structuredClone(record) as Record<string, CanonicalJsonValue>
  transformContents(clone.contents, direction)
  if (Array.isArray(clone.candidates)) {
    for (const candidate of clone.candidates) {
      if (isObject(candidate)) {
        transformContents(candidate.contents, direction)
      }
    }
  }
  return clone
}

function validateCompatibleConversation(
  contents: readonly z.infer<typeof CompatibleContentSchema>[],
  context: z.RefinementCtx,
  path: PropertyKey[],
  allowLeadingSystem: boolean,
): void {
  const systemIndices = contents.flatMap((content, index) =>
    content.role === 'system' ? [index] : [],
  )
  if (!allowLeadingSystem && systemIndices.length > 0) {
    for (const index of systemIndices) {
      context.addIssue({
        code: 'custom',
        path: [...path, index, 'role'],
        message: 'Candidate contents must not contain system content',
      })
    }
  } else {
    if (systemIndices.length > 1) {
      context.addIssue({
        code: 'custom',
        path,
        message: 'A record may contain at most one system content',
      })
    }
    for (const index of systemIndices) {
      if (index !== 0) {
        context.addIssue({
          code: 'custom',
          path: [...path, index, 'role'],
          message: 'System content must be contents[0]',
        })
      }
    }
  }

  const start = allowLeadingSystem && contents[0]?.role === 'system' ? 1 : 0
  if (!allowLeadingSystem && contents[0]?.role !== 'ai') {
    context.addIssue({
      code: 'custom',
      path: [...path, 0, 'role'],
      message: 'Candidate must start with ai',
    })
  }
  for (let index = start + 1; index < contents.length; index += 1) {
    if (contents[index]?.role === contents[index - 1]?.role) {
      context.addIssue({
        code: 'custom',
        path: [...path, index, 'role'],
        message: 'Content roles must alternate',
      })
    }
  }
}

function transformContents(value: CanonicalJsonValue | undefined, direction: 'read' | 'write') {
  if (!Array.isArray(value)) {
    return
  }
  for (const content of value) {
    if (!isObject(content) || !Array.isArray(content.parts)) {
      continue
    }
    content.parts = content.parts.map((part) => transformPart(part, direction))
  }
}

function transformPart(part: CanonicalJsonValue, direction: 'read' | 'write'): CanonicalJsonValue {
  if (!isObject(part) || typeof part.type !== 'string') {
    return part
  }
  if (direction === 'read') {
    if (['text', 'function_call', 'function_response', 'file_data'].includes(part.type)) {
      return part
    }
    const { type, thought, thought_signature, part_metadata, ...payload } = part
    return UnknownPartSchema.parse({
      type: 'unknown',
      original_type: type,
      thought,
      thought_signature,
      part_metadata,
      payload,
    }) as CanonicalJsonValue
  }
  if (part.type !== 'unknown') {
    return part
  }

  const unknown = UnknownPartSchema.parse(part)
  return {
    ...unknown.payload,
    type: unknown.original_type,
    thought: unknown.thought,
    thought_signature: unknown.thought_signature,
    part_metadata: unknown.part_metadata,
  }
}

function isObject(value: CanonicalJsonValue): value is Record<string, CanonicalJsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
