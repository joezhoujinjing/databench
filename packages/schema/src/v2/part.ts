import { z } from 'zod'
import {
  CanonicalMimeTypeSchema,
  DigestHexSchema,
  NonEmptyStringSchema,
  NonNegativeSafeIntegerSchema,
  NullableNonEmptyStringSchema,
  StableUriSchema,
} from './common.js'
import { JsonObjectSchema, JsonValueSchema } from './json-value.js'

const PartBaseShape = {
  thought: z.boolean(),
  thought_signature: NullableNonEmptyStringSchema,
  part_metadata: JsonObjectSchema,
} as const

export const FunctionCallSchema = z.strictObject({
  id: NonEmptyStringSchema,
  name: NonEmptyStringSchema,
  args: JsonObjectSchema,
})
export type FunctionCallV2 = z.infer<typeof FunctionCallSchema>

export const FunctionResponseSchema = z.strictObject({
  call_id: NonEmptyStringSchema,
  response: JsonValueSchema,
})
export type FunctionResponseV2 = z.infer<typeof FunctionResponseSchema>

export const FileDigestV2Schema = z.strictObject({
  algorithm: z.literal('blake3'),
  value: DigestHexSchema,
})
export type FileDigestV2 = z.infer<typeof FileDigestV2Schema>

export const FileDataSchema = z.strictObject({
  uri: StableUriSchema,
  media_type: CanonicalMimeTypeSchema,
  digest: FileDigestV2Schema,
  size_bytes: NonNegativeSafeIntegerSchema,
})
export type FileDataV2 = z.infer<typeof FileDataSchema>

export const TextPartSchema = z.strictObject({
  ...PartBaseShape,
  type: z.literal('text'),
  text: z.string(),
})

export const FunctionCallPartSchema = z.strictObject({
  ...PartBaseShape,
  type: z.literal('function_call'),
  function_call: FunctionCallSchema,
})

export const FunctionResponsePartSchema = z.strictObject({
  ...PartBaseShape,
  type: z.literal('function_response'),
  function_response: FunctionResponseSchema,
})

export const FileDataPartSchema = z.strictObject({
  ...PartBaseShape,
  type: z.literal('file_data'),
  file_data: FileDataSchema,
})

export const PartSchema = z.discriminatedUnion('type', [
  TextPartSchema,
  FunctionCallPartSchema,
  FunctionResponsePartSchema,
  FileDataPartSchema,
])
export type PartV2 = z.infer<typeof PartSchema>

export const UnknownPartSchema = z.strictObject({
  ...PartBaseShape,
  type: z.literal('unknown'),
  original_type: NonEmptyStringSchema,
  payload: JsonObjectSchema,
})
export type UnknownPartV2 = z.infer<typeof UnknownPartSchema>
export type CompatiblePartV2 = PartV2 | UnknownPartV2
