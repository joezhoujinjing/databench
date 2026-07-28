import { z } from 'zod'
import { Rfc3339UtcSchema } from './common.js'
import { OpaqueCursorQueryV2Schema } from './contracts.js'
import { ModelArtifactIdV2Schema } from './model-artifact.js'

export const V2_MODEL_DEPLOYMENT_PAGE_DEFAULT_LIMIT = 20
export const V2_MODEL_DEPLOYMENT_PAGE_MAX_LIMIT = 100

const encoder = new TextEncoder()
const CREDENTIAL_VALUE =
  /(?:\bsk-(?:proj-)?[A-Za-z0-9_-]{8,}\b)|(?:\b(?:authorization|x-api-key|api[_-]?key|token)\s*[:=]\s*\S+)/i

function utf8BoundedText(maxBytes: number) {
  return z
    .string()
    .min(1)
    .max(maxBytes)
    .refine((value) => encoder.encode(value).byteLength <= maxBytes, {
      message: `Expected at most ${maxBytes} UTF-8 bytes`,
    })
    .refine(
      (value) => {
        for (const character of value) {
          const codePoint = character.codePointAt(0)
          if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return false
        }
        return true
      },
      { message: 'Control characters are not allowed' },
    )
    .refine((value) => !CREDENTIAL_VALUE.test(value), {
      message: 'Credential-like values are not allowed',
    })
}

export const ModelDeploymentIdV2Schema = z.uuid()
export const ModelDeploymentProviderV2Schema = z.literal('openai_compatible')
export type ModelDeploymentProviderV2 = z.infer<typeof ModelDeploymentProviderV2Schema>
export const ModelDeploymentAuthModeV2Schema = z.literal('none')
export type ModelDeploymentAuthModeV2 = z.infer<typeof ModelDeploymentAuthModeV2Schema>
export const ModelDeploymentStatusV2Schema = z.enum(['active', 'disabled'])
export type ModelDeploymentStatusV2 = z.infer<typeof ModelDeploymentStatusV2Schema>
export const ModelDeploymentHealthStatusV2Schema = z.enum(['unknown', 'healthy', 'unhealthy'])
export type ModelDeploymentHealthStatusV2 = z.infer<typeof ModelDeploymentHealthStatusV2Schema>
export const ModelDeploymentHealthErrorCodeV2Schema = z.enum([
  'timeout',
  'network_error',
  'http_error',
  'invalid_response',
  'served_model_missing',
  'unhealthy',
])

export const ModelDeploymentDisplayNameV2Schema = utf8BoundedText(256)
export const ModelDeploymentServedModelNameV2Schema = utf8BoundedText(512)

export const ModelDeploymentEndpointBaseUrlV2Schema = z
  .string()
  .min(1)
  .max(2_048)
  .refine((value) => normalizeModelDeploymentEndpointBaseUrlV2(value) !== null, {
    message: 'Endpoint base URL must be an HTTP(S) URL without credentials, query, or fragment',
  })
  .refine((value) => !value.includes('@') && !CREDENTIAL_VALUE.test(value), {
    message: 'Endpoint base URL must not contain credential-like values',
  })

export function normalizeModelDeploymentEndpointBaseUrlV2(value: string): string | null {
  if (encoder.encode(value).byteLength > 2_048) return null
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return null
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.hostname === '' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    return null
  }
  const pathname = parsed.pathname.replace(/\/+$/u, '')
  parsed.pathname = pathname === '' ? '/' : pathname
  const normalized = parsed.toString().replace(/\/$/u, '')
  return normalized === parsed.origin ? parsed.origin : normalized
}

export const CreateModelDeploymentRequestV2Schema = z
  .strictObject({
    artifact_id: ModelArtifactIdV2Schema,
    display_name: ModelDeploymentDisplayNameV2Schema,
    provider: ModelDeploymentProviderV2Schema,
    served_model_name: ModelDeploymentServedModelNameV2Schema,
    endpoint_base_url: ModelDeploymentEndpointBaseUrlV2Schema,
    auth_mode: ModelDeploymentAuthModeV2Schema,
  })
  .meta({ id: 'CreateModelDeploymentRequestV2' })
export type CreateModelDeploymentRequestV2 = z.infer<typeof CreateModelDeploymentRequestV2Schema>

export const ModelDeploymentParamsV2Schema = z
  .strictObject({ deployment_id: ModelDeploymentIdV2Schema })
  .meta({ id: 'ModelDeploymentParamsV2' })

export const DisableModelDeploymentRequestV2Schema = z
  .strictObject({})
  .meta({ id: 'DisableModelDeploymentRequestV2' })

export const CheckModelDeploymentRequestV2Schema = z
  .strictObject({})
  .meta({ id: 'CheckModelDeploymentRequestV2' })

export const ModelDeploymentPageRequestV2Schema = z
  .strictObject({
    artifact_id: ModelArtifactIdV2Schema.optional(),
    status: ModelDeploymentStatusV2Schema.optional(),
    cursor: OpaqueCursorQueryV2Schema,
    limit: z.coerce
      .number()
      .int()
      .safe()
      .min(1)
      .max(V2_MODEL_DEPLOYMENT_PAGE_MAX_LIMIT)
      .default(V2_MODEL_DEPLOYMENT_PAGE_DEFAULT_LIMIT),
  })
  .meta({ id: 'ModelDeploymentPageRequestV2' })
export type ModelDeploymentPageRequestV2 = z.infer<typeof ModelDeploymentPageRequestV2Schema>

export const ModelDeploymentV2Schema = z
  .strictObject({
    id: ModelDeploymentIdV2Schema,
    artifact_id: ModelArtifactIdV2Schema,
    display_name: ModelDeploymentDisplayNameV2Schema,
    provider: ModelDeploymentProviderV2Schema,
    registration_mode: z.literal('operator_attested'),
    served_model_name: ModelDeploymentServedModelNameV2Schema,
    auth_mode: ModelDeploymentAuthModeV2Schema,
    status: ModelDeploymentStatusV2Schema,
    health_status: ModelDeploymentHealthStatusV2Schema,
    health_checked_at: Rfc3339UtcSchema.nullable(),
    health_error_code: ModelDeploymentHealthErrorCodeV2Schema.nullable(),
    created_at: Rfc3339UtcSchema,
    disabled_at: Rfc3339UtcSchema.nullable(),
    updated_at: Rfc3339UtcSchema,
  })
  .superRefine((deployment, context) => {
    if ((deployment.status === 'disabled') !== (deployment.disabled_at !== null)) {
      context.addIssue({
        code: 'custom',
        path: ['disabled_at'],
        message: 'Only disabled deployments expose disabled_at',
      })
    }
    if ((deployment.health_status === 'unknown') !== (deployment.health_checked_at === null)) {
      context.addIssue({
        code: 'custom',
        path: ['health_checked_at'],
        message: 'Known health observations require health_checked_at',
      })
    }
    if ((deployment.health_status === 'unhealthy') !== (deployment.health_error_code !== null)) {
      context.addIssue({
        code: 'custom',
        path: ['health_error_code'],
        message: 'Only unhealthy deployments expose a health error code',
      })
    }
  })
  .meta({ id: 'ModelDeploymentV2' })
export type ModelDeploymentV2 = z.infer<typeof ModelDeploymentV2Schema>

export const ResolvedModelDeploymentV2Schema = z
  .strictObject({
    id: ModelDeploymentIdV2Schema,
    artifact_id: ModelArtifactIdV2Schema,
    create_digest: z.string().regex(/^[0-9a-f]{64}$/),
    provider: ModelDeploymentProviderV2Schema,
    registration_mode: z.literal('operator_attested'),
    served_model_name: ModelDeploymentServedModelNameV2Schema,
    endpoint_base_url: ModelDeploymentEndpointBaseUrlV2Schema,
    auth_mode: ModelDeploymentAuthModeV2Schema,
    base_model_reference: utf8BoundedText(512),
    base_model_revision: utf8BoundedText(256),
  })
  .meta({ id: 'ResolvedModelDeploymentV2' })
export type ResolvedModelDeploymentV2 = z.infer<typeof ResolvedModelDeploymentV2Schema>

export const ModelDeploymentPageV2Schema = z
  .strictObject({
    items: z.array(ModelDeploymentV2Schema).max(V2_MODEL_DEPLOYMENT_PAGE_MAX_LIMIT),
    next_cursor: z.string().min(1).max(1_536).nullable(),
  })
  .meta({ id: 'ModelDeploymentPageV2' })
export type ModelDeploymentPageV2 = z.infer<typeof ModelDeploymentPageV2Schema>
