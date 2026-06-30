import { isJsonNumberLexeme, type JsonNumberLexeme, parseCanonicalJson } from '@databench/hashing'
import { z } from 'zod'
import { KINDS } from './constants.js'

const INTEGER_SOURCE_PATTERN = /^-?(?:0|[1-9]\d*)$/

export const JsonNumberLexemeSchema = z.custom<JsonNumberLexeme>(
  (value): value is JsonNumberLexeme => isJsonNumberLexeme(value),
  { message: 'Expected JSON number lexeme' },
)

export const JsonNumberSchema = z.union([z.number(), JsonNumberLexemeSchema])
export type JsonNumber = z.infer<typeof JsonNumberSchema>

export const JsonIntegerSchema = z.union([
  z.number().int(),
  JsonNumberLexemeSchema.refine((value) => INTEGER_SOURCE_PATTERN.test(value.source), {
    message: 'Expected integer JSON number lexeme',
  }),
])
export type JsonInteger = z.infer<typeof JsonIntegerSchema>

export function jsonNumberValue(value: JsonNumber): number {
  return typeof value === 'number' ? value : Number(value.source)
}

export function jsonIntegerValue(value: JsonInteger): number {
  return typeof value === 'number' ? value : Number(value.source)
}

export function parseJsonValue(text: string): unknown {
  return parseCanonicalJson(text)
}

export { isJsonNumberLexeme }

export function toJsonCompatible(value: unknown): unknown {
  if (isJsonNumberLexeme(value)) {
    return jsonNumberValue(value)
  }

  if (Array.isArray(value)) {
    return value.map(toJsonCompatible)
  }

  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, toJsonCompatible(item)]),
    )
  }

  return value
}

export const JsonObjectSchema = z.record(z.string(), z.unknown())
export type JsonObject = z.infer<typeof JsonObjectSchema>

export const ToolCallSchema = z.object({
  id: z.string().nullable().default(null),
  name: z.string(),
  arguments: z.unknown().nullable().default(null),
})
export type ToolCall = z.infer<typeof ToolCallSchema>

export const MessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.string().nullable().default(null),
  name: z.string().nullable().default(null),
  tool_calls: z.array(ToolCallSchema).nullable().default(null),
  tool_call_id: z.string().nullable().default(null),
})
export type Message = z.infer<typeof MessageSchema>

export const RolloutSchema = z.object({
  text: z.string(),
  reward: JsonNumberSchema.nullable().default(null),
  meta: JsonObjectSchema.default(() => ({})),
})
export type Rollout = z.infer<typeof RolloutSchema>

export const CandidateSchema = z.object({
  completion: z.union([MessageSchema, z.array(MessageSchema)]),
  rank: JsonIntegerSchema.nullable().default(null),
  score: JsonNumberSchema.nullable().default(null),
})
export type Candidate = z.infer<typeof CandidateSchema>

const SampleBaseSchema = z.object({
  source: z.string().nullable().default(null),
  meta: JsonObjectSchema.default(() => ({})),
  signals: JsonObjectSchema.default(() => ({})),
})

export const SFTSampleSchema = SampleBaseSchema.extend({
  kind: z.literal('sft'),
  messages: z.array(MessageSchema),
})
export type SFTSample = z.infer<typeof SFTSampleSchema>

export const PreferenceSampleSchema = SampleBaseSchema.extend({
  kind: z.literal('preference'),
  prompt: z.array(MessageSchema).default(() => []),
  chosen: z.union([MessageSchema, z.array(MessageSchema)]),
  rejected: z.union([MessageSchema, z.array(MessageSchema)]),
  candidates: z.array(CandidateSchema).nullable().default(null),
})
export type PreferenceSample = z.infer<typeof PreferenceSampleSchema>

export const RLSampleSchema = SampleBaseSchema.extend({
  kind: z.literal('rl'),
  prompt: z.array(MessageSchema).default(() => []),
  answer: z.string().nullable().default(null),
  verifier: z.string().nullable().default(null),
  rollouts: z.array(RolloutSchema).default(() => []),
})
export type RLSample = z.infer<typeof RLSampleSchema>

export const TrajectorySampleSchema = SampleBaseSchema.extend({
  kind: z.literal('trajectory'),
  messages: z.array(MessageSchema),
})
export type TrajectorySample = z.infer<typeof TrajectorySampleSchema>

export const KindSchema = z.enum(KINDS)

export const SampleSchema = z.discriminatedUnion('kind', [
  SFTSampleSchema,
  PreferenceSampleSchema,
  RLSampleSchema,
  TrajectorySampleSchema,
])
export type Sample = z.infer<typeof SampleSchema>

export function parseSample(value: unknown): Sample {
  return SampleSchema.parse(value)
}
