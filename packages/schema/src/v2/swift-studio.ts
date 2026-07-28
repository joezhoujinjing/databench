import { z } from 'zod'
import { ConflictError } from '../errors.js'
import { DigestHexSchema, NonNegativeSafeIntegerSchema, Rfc3339UtcSchema } from './common.js'
import {
  OpaqueCursorQueryV2Schema,
  RefNameV2Schema,
  SwiftStudioSessionStateConflictDetailV2Schema,
} from './contracts.js'
import { JsonObjectSchema } from './json-value.js'

export const V2_SWIFT_STUDIO_SESSION_PAGE_DEFAULT_LIMIT = 20
export const V2_SWIFT_STUDIO_SESSION_PAGE_MAX_LIMIT = 100

const SAFE_TOKEN = /^[a-z][a-z0-9._-]{0,127}$/
const GIT_COMMIT = /^[0-9a-f]{40}$/
const OPAQUE_PROVIDER_LOCATOR = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/
const CREDENTIAL_VALUE =
  /(?:\bsk-(?:proj-)?[A-Za-z0-9_-]{8,}\b)|(?:\b(?:authorization|x-api-key|api[_-]?key|token)\s*[:=]\s*\S+)/i
const encoder = new TextEncoder()

function boundedSanitizedText(maxBytes: number) {
  return z
    .string()
    .min(1)
    .max(maxBytes)
    .refine((value) => encoder.encode(value).byteLength <= maxBytes, {
      message: `Expected at most ${maxBytes} UTF-8 bytes`,
    })
    .refine(
      (value) => {
        for (let index = 0; index < value.length; index += 1) {
          const codeUnit = value.charCodeAt(index)
          if (codeUnit <= 0x1f || codeUnit === 0x7f) return false
        }
        return true
      },
      { message: 'Control characters are not allowed' },
    )
    .refine((value) => !CREDENTIAL_VALUE.test(value), {
      message: 'Credential-like values are not allowed',
    })
}

export const SwiftStudioProviderV2Schema = z.literal('swift-studio')
export type SwiftStudioProviderV2 = z.infer<typeof SwiftStudioProviderV2Schema>

export const SwiftStudioSessionIdV2Schema = z.uuid()

export const SwiftStudioSessionStatusV2Schema = z.enum([
  'preparing',
  'ready',
  'closing',
  'closed',
  'failed',
])
export type SwiftStudioSessionStatusV2 = z.infer<typeof SwiftStudioSessionStatusV2Schema>

export const SwiftStudioProviderSessionIdV2Schema = z
  .string()
  .regex(OPAQUE_PROVIDER_LOCATOR)
  .refine((value) => encoder.encode(value).byteLength <= 256, {
    message: 'Provider Session ID must not exceed 256 UTF-8 bytes',
  })

export const SwiftStudioSessionFailureV2Schema = z
  .strictObject({
    phase: z.string().regex(SAFE_TOKEN),
    code: z.string().regex(SAFE_TOKEN),
    message: boundedSanitizedText(2_048),
  })
  .meta({ id: 'SwiftStudioSessionFailureV2' })
export type SwiftStudioSessionFailureV2 = z.infer<typeof SwiftStudioSessionFailureV2Schema>

export const CreateSwiftStudioSessionRequestV2Schema = z
  .strictObject({
    dataset_version: DigestHexSchema,
    display_ref: RefNameV2Schema.nullable(),
    converter: z.literal('ms-swift'),
    options: JsonObjectSchema,
    accepted_fidelity_digest: DigestHexSchema.nullable(),
  })
  .meta({ id: 'CreateSwiftStudioSessionRequestV2' })
export type CreateSwiftStudioSessionRequestV2 = z.infer<
  typeof CreateSwiftStudioSessionRequestV2Schema
>

export const SwiftStudioSessionParamsV2Schema = z
  .strictObject({ session_id: SwiftStudioSessionIdV2Schema })
  .meta({ id: 'SwiftStudioSessionParamsV2' })
export type SwiftStudioSessionParamsV2 = z.infer<typeof SwiftStudioSessionParamsV2Schema>

export const CloseSwiftStudioSessionRequestV2Schema = z
  .strictObject({})
  .meta({ id: 'CloseSwiftStudioSessionRequestV2' })
export type CloseSwiftStudioSessionRequestV2 = z.infer<
  typeof CloseSwiftStudioSessionRequestV2Schema
>

export const SwiftStudioSessionPageRequestV2Schema = z
  .strictObject({
    dataset_version: DigestHexSchema.optional(),
    status: SwiftStudioSessionStatusV2Schema.optional(),
    cursor: OpaqueCursorQueryV2Schema,
    limit: z.coerce
      .number()
      .int()
      .safe()
      .min(1)
      .max(V2_SWIFT_STUDIO_SESSION_PAGE_MAX_LIMIT)
      .default(V2_SWIFT_STUDIO_SESSION_PAGE_DEFAULT_LIMIT),
  })
  .meta({ id: 'SwiftStudioSessionPageRequestV2' })
export type SwiftStudioSessionPageRequestV2 = z.infer<typeof SwiftStudioSessionPageRequestV2Schema>

export const SwiftStudioSessionV2Schema = z
  .strictObject({
    id: SwiftStudioSessionIdV2Schema,
    create_digest: DigestHexSchema,
    status: SwiftStudioSessionStatusV2Schema,
    dataset_version: DigestHexSchema,
    display_ref: RefNameV2Schema.nullable(),
    converter: z.literal('ms-swift'),
    converter_version: z.literal('1.0.0'),
    normalized_options: JsonObjectSchema,
    fidelity_digest: DigestHexSchema,
    output_count: NonNegativeSafeIntegerSchema.positive(),
    export_digest: DigestHexSchema.nullable(),
    export_size_bytes: NonNegativeSafeIntegerSchema.nullable(),
    provider: SwiftStudioProviderV2Schema,
    upstream_commit: z.string().regex(GIT_COMMIT),
    image_digest: DigestHexSchema,
    runtime_capability_digest: DigestHexSchema,
    failure: SwiftStudioSessionFailureV2Schema.nullable(),
    studio_path: z.literal('/swift-studio/').nullable(),
    created_at: Rfc3339UtcSchema,
    ready_at: Rfc3339UtcSchema.nullable(),
    closed_at: Rfc3339UtcSchema.nullable(),
    updated_at: Rfc3339UtcSchema,
  })
  .superRefine((session, context) => {
    const hasExport = session.export_digest !== null && session.export_size_bytes !== null
    if ((session.export_digest === null) !== (session.export_size_bytes === null)) {
      context.addIssue({
        code: 'custom',
        path: ['export_digest'],
        message: 'Export digest and size must be both null or both present',
      })
    }
    if ((session.status === 'failed') !== (session.failure !== null)) {
      context.addIssue({
        code: 'custom',
        path: ['failure'],
        message: 'Only failed Sessions expose a failure summary',
      })
    }
    if ((session.status === 'ready') !== (session.studio_path !== null)) {
      context.addIssue({
        code: 'custom',
        path: ['studio_path'],
        message: 'Only ready Sessions expose the Studio path',
      })
    }
    const reachedReady =
      session.status === 'ready' || session.status === 'closing' || session.status === 'closed'
    if (reachedReady !== (session.ready_at !== null && hasExport)) {
      context.addIssue({
        code: 'custom',
        path: ['ready_at'],
        message: 'Ready, closing, and closed Sessions require a verified export and ready_at',
      })
    }
    if ((session.status === 'closed') !== (session.closed_at !== null)) {
      context.addIssue({
        code: 'custom',
        path: ['closed_at'],
        message: 'Only closed Sessions expose closed_at',
      })
    }
  })
  .meta({ id: 'SwiftStudioSessionV2' })
export type SwiftStudioSessionV2 = z.infer<typeof SwiftStudioSessionV2Schema>

export const SwiftStudioSessionPageV2Schema = z
  .strictObject({
    items: z.array(SwiftStudioSessionV2Schema).max(V2_SWIFT_STUDIO_SESSION_PAGE_MAX_LIMIT),
    next_cursor: z.string().min(1).max(1_536).nullable(),
  })
  .meta({ id: 'SwiftStudioSessionPageV2' })
export type SwiftStudioSessionPageV2 = z.infer<typeof SwiftStudioSessionPageV2Schema>

export class SwiftStudioSessionStateConflictErrorV2 extends ConflictError {
  override readonly name = 'SwiftStudioSessionStateConflictErrorV2'
  override readonly code = 'swift_studio_session_state_conflict'

  constructor(input: z.input<typeof SwiftStudioSessionStateConflictDetailV2Schema>) {
    const detail = Object.freeze(SwiftStudioSessionStateConflictDetailV2Schema.parse(input))
    super(`Swift Studio Session state conflict for ${detail.session_id}`, detail)
  }
}
