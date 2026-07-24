import { isApiError } from '@/api/errors.js'
import type { Compatibility } from '@/api/version.js'
import type { CapabilitiesV2Envelope, PostTrainingV2Capability } from './types.js'

export type PostTrainingV2State =
  | { readonly status: 'loading' }
  | { readonly status: 'absent' }
  | { readonly status: 'disabled' }
  | { readonly status: 'unauthorized' }
  | { readonly status: 'forbidden' }
  | { readonly status: 'network_error' }
  | { readonly status: 'server_error'; readonly error: unknown }
  | { readonly status: 'incompatible'; readonly missing: readonly string[] }
  | { readonly status: 'client_incompatible'; readonly compatibility: Compatibility }
  | { readonly status: 'ready'; readonly capability: PostTrainingV2Capability }

export interface PostTrainingV2StateInput {
  readonly capabilities: CapabilitiesV2Envelope | undefined
  readonly compatibility: Compatibility
  readonly error: unknown
  readonly isError: boolean
  readonly isLoading: boolean
}

export function classifyPostTrainingV2(input: PostTrainingV2StateInput): PostTrainingV2State {
  if (input.isLoading) {
    return { status: 'loading' }
  }

  if (input.isError) {
    if (isApiError(input.error)) {
      if (input.error.status === 401) return { status: 'unauthorized' }
      if (input.error.status === 403) return { status: 'forbidden' }
      if (input.error.status === 0) return { status: 'network_error' }
    }

    return { error: input.error, status: 'server_error' }
  }

  if (input.compatibility.status !== 'ok') {
    return { compatibility: input.compatibility, status: 'client_incompatible' }
  }

  const capability = input.capabilities?.post_training_v2

  if (capability === undefined) {
    return { status: 'absent' }
  }

  if (!capability.enabled) {
    return { status: 'disabled' }
  }

  const missing = missingRequiredProfiles(capability)
  return missing.length === 0
    ? { capability, status: 'ready' }
    : { missing, status: 'incompatible' }
}

export function missingRequiredProfiles(capability: PostTrainingV2Capability): string[] {
  const required = [
    ['api', capability.api_versions, '2'],
    ['record schema', capability.record_schema_versions, '2.0.0'],
    ['identity', capability.identity_profiles, 'databench-v2-jcs-1'],
    ['layout', capability.layout_versions, 'record-json-v1'],
    ['fidelity', capability.export_fidelity_profiles, 'databench-export-fidelity-1'],
  ] as const

  return required.flatMap(([label, supported, value]) =>
    (supported as readonly string[]).includes(value) ? [] : [`${label}: ${value}`],
  )
}

export function shouldShowPostTrainingV2Navigation(state: PostTrainingV2State): boolean {
  return state.status === 'ready'
}
