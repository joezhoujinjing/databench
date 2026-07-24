import { z } from 'zod'
import {
  addIssue,
  CandidateIdSchema,
  FiniteNumberSchema,
  findForbiddenJsonKey,
  hasDuplicate,
  NonEmptyStringSchema,
  NonNegativeSafeIntegerSchema,
  NullableNonEmptyStringSchema,
} from './common.js'
import { ContentSchema } from './content.js'
import { JsonObjectSchema } from './json-value.js'
import { SignalSchema, type SignalSourceV2, type SignalV2 } from './signal.js'

export const GeneratorInfoSchema = z.strictObject({
  provider: NullableNonEmptyStringSchema,
  model: NonEmptyStringSchema,
  revision: NullableNonEmptyStringSchema,
  parameters: JsonObjectSchema,
})
export type GeneratorInfoV2 = z.infer<typeof GeneratorInfoSchema>

const CandidatePayloadShape = {
  contents: z.array(ContentSchema).min(1),
  finish_reason: z.string().nullable(),
  rank: NonNegativeSafeIntegerSchema.nullable(),
  selected: z.boolean().nullable(),
  signals: z.array(SignalSchema),
  generator: GeneratorInfoSchema.nullable(),
  token_count: NonNegativeSafeIntegerSchema.nullable(),
  avg_logprobs: FiniteNumberSchema.nullable(),
} as const

export const CandidateSchema = z
  .strictObject({
    id: CandidateIdSchema,
    ...CandidatePayloadShape,
  })
  .superRefine(validateCandidateContents)
export type CandidateV2 = z.infer<typeof CandidateSchema>

export const InitialCandidateV2Schema = z
  .strictObject(CandidatePayloadShape)
  .superRefine(validateCandidateContents)
export type InitialCandidateV2 = z.infer<typeof InitialCandidateV2Schema>

function validateCandidateContents(
  candidate: {
    contents: z.infer<typeof ContentSchema>[]
    signals: SignalV2[]
    generator: { parameters: unknown } | null
  },
  context: z.RefinementCtx,
): void {
  candidate.contents.forEach((content, index) => {
    if (content.role === 'system') {
      context.addIssue({
        code: 'custom',
        path: ['contents', index, 'role'],
        message: 'Candidate contents must not contain system content',
      })
    }
  })
  if (candidate.contents[0]?.role !== 'ai') {
    context.addIssue({
      code: 'custom',
      path: ['contents', 0, 'role'],
      message: 'Candidate must start with ai',
    })
  }
  for (let index = 1; index < candidate.contents.length; index += 1) {
    if (candidate.contents[index]?.role === candidate.contents[index - 1]?.role) {
      context.addIssue({
        code: 'custom',
        path: ['contents', index, 'role'],
        message: 'Candidate content roles must alternate',
      })
    }
  }

  const signalIds = candidate.signals.map((signal) => signal.id)
  if (hasDuplicate(signalIds)) {
    context.addIssue({
      code: 'custom',
      path: ['signals'],
      message: 'Signal IDs must be unique within a candidate',
    })
  }
  validateSignalSupersession(candidate.signals, context)
  validateLocalTrajectory(candidate.contents, context)
  validateSensitiveCandidatePayload(candidate, context)
}

function validateLocalTrajectory(
  contents: readonly z.infer<typeof ContentSchema>[],
  context: z.RefinementCtx,
): void {
  const allCallIds = new Set<string>()
  for (const content of contents) {
    for (const part of content.parts) {
      if (part.type === 'function_call') {
        allCallIds.add(part.function_call.id)
      }
    }
  }

  const seenCalls = new Set<string>()
  const seenResponses = new Set<string>()
  contents.forEach((content, contentIndex) => {
    content.parts.forEach((part, partIndex) => {
      const partPath: PropertyKey[] = ['contents', contentIndex, 'parts', partIndex]
      if (part.type === 'function_call') {
        if (content.role !== 'ai') {
          addIssue(context, [...partPath, 'function_call'], 'Function calls must be in ai content')
        }
        if (seenCalls.has(part.function_call.id)) {
          addIssue(
            context,
            [...partPath, 'function_call', 'id'],
            'Function call ID must be unique within a candidate',
          )
        }
        seenCalls.add(part.function_call.id)
      }
      if (part.type === 'function_response') {
        const callId = part.function_response.call_id
        if (content.role !== 'user') {
          addIssue(
            context,
            [...partPath, 'function_response'],
            'Function responses must be in user content',
          )
        }
        if (seenResponses.has(callId)) {
          addIssue(
            context,
            [...partPath, 'function_response', 'call_id'],
            'Each call may have at most one candidate response',
          )
        }
        if (allCallIds.has(callId) && !seenCalls.has(callId)) {
          addIssue(
            context,
            [...partPath, 'function_response', 'call_id'],
            'Response cannot precede its candidate-local function call',
          )
        }
        seenResponses.add(callId)
      }
    })
  })
}

function validateSignalSupersession(signals: readonly SignalV2[], context: z.RefinementCtx): void {
  const byId = new Map<string, SignalV2>()
  const successorCount = new Map<string, number>()

  signals.forEach((signal, index) => {
    if (signal.supersedes !== null) {
      const target = byId.get(signal.supersedes)
      if (!target) {
        context.addIssue({
          code: 'custom',
          path: ['signals', index, 'supersedes'],
          message: 'Signal may only supersede an earlier signal',
        })
      } else if (
        target.name !== signal.name ||
        target.kind !== signal.kind ||
        !sameSignalSource(target.source, signal.source)
      ) {
        context.addIssue({
          code: 'custom',
          path: ['signals', index, 'supersedes'],
          message: 'Superseded signal must have the same name, kind, and source',
        })
      }
      successorCount.set(signal.supersedes, (successorCount.get(signal.supersedes) ?? 0) + 1)
    }
    byId.set(signal.id, signal)
  })

  if ([...successorCount.values()].some((count) => count > 1)) {
    context.addIssue({
      code: 'custom',
      path: ['signals'],
      message: 'A signal may have at most one direct successor',
    })
  }
}

function sameSignalSource(left: SignalSourceV2, right: SignalSourceV2): boolean {
  return left.type === right.type && left.id === right.id && left.version === right.version
}

function validateSensitiveCandidatePayload(
  candidate: {
    contents: z.infer<typeof ContentSchema>[]
    generator: { parameters: unknown } | null
  },
  context: z.RefinementCtx,
): void {
  checkSensitiveJson(
    candidate.generator?.parameters,
    ['generator', 'parameters'],
    context,
    new Set(['endpoint', 'headers', 'request_headers']),
  )
  candidate.contents.forEach((content, contentIndex) => {
    content.parts.forEach((part, partIndex) => {
      const partPath: PropertyKey[] = ['contents', contentIndex, 'parts', partIndex]
      checkSensitiveJson(part.part_metadata, [...partPath, 'part_metadata'], context)
      if (part.type === 'function_call') {
        checkSensitiveJson(part.function_call.args, [...partPath, 'function_call', 'args'], context)
      }
      if (part.type === 'function_response') {
        checkSensitiveJson(
          part.function_response.response,
          [...partPath, 'function_response', 'response'],
          context,
        )
      }
    })
  })
}

function checkSensitiveJson(
  value: unknown,
  path: PropertyKey[],
  context: z.RefinementCtx,
  extraForbiddenKeys: ReadonlySet<string> = new Set(),
): void {
  const forbiddenPath = findForbiddenJsonKey(value, extraForbiddenKeys)
  if (forbiddenPath) {
    addIssue(
      context,
      [...path, ...forbiddenPath],
      'Canonical candidates must not contain credentials or execution endpoints',
    )
  }
}
