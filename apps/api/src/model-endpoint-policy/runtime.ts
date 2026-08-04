import {
  type V2ModelVersionDeploymentConfigurationV2,
  type V2ModelVersionDeploymentRuntime,
  V2ModelVersionDeploymentRuntimeError,
  type V2ModelVersionDeploymentRuntimeRequest,
} from '@databench/workspace'
import {
  ModelCredentialRegistryError,
  type ModelCredentialRegistryV1,
  type ModelCredentialSnapshotV1,
} from '../model-credentials/registry.js'
import { ModelEndpointPolicyError, type ModelEndpointPolicyV1Runtime } from './policy.js'
import { ModelEndpointTransportError, type PinnedModelEndpointTransportV1 } from './transport.js'

export interface PinnedModelVersionDeploymentRuntimeV2Options {
  readonly policy: ModelEndpointPolicyV1Runtime
  readonly transport: PinnedModelEndpointTransportV1
  readonly credentials?: ModelCredentialRegistryV1
}

export function createPinnedModelVersionDeploymentRuntimeV2(
  options: PinnedModelVersionDeploymentRuntimeV2Options,
): V2ModelVersionDeploymentRuntime {
  const runtime = new PinnedModelVersionDeploymentRuntimeV2(options)
  return Object.freeze({
    configuration: (request: Readonly<V2ModelVersionDeploymentRuntimeRequest>) =>
      runtime.configuration(request),
    observe: (
      request: Readonly<V2ModelVersionDeploymentRuntimeRequest>,
      context?: { readonly signal?: AbortSignal },
    ) => runtime.observe(request, context),
  })
}

class PinnedModelVersionDeploymentRuntimeV2 implements V2ModelVersionDeploymentRuntime {
  readonly #policy: ModelEndpointPolicyV1Runtime
  readonly #transport: PinnedModelEndpointTransportV1
  readonly #credentials: ModelCredentialRegistryV1 | undefined

  constructor(options: PinnedModelVersionDeploymentRuntimeV2Options) {
    this.#policy = options.policy
    this.#transport = options.transport
    this.#credentials = options.credentials
  }

  async configuration(
    request: Readonly<V2ModelVersionDeploymentRuntimeRequest>,
  ): Promise<Readonly<V2ModelVersionDeploymentConfigurationV2>> {
    try {
      return (await this.#snapshot(request)).configuration
    } catch (error) {
      throw runtimeConfigurationError(error)
    }
  }

  async observe(
    request: Readonly<V2ModelVersionDeploymentRuntimeRequest>,
    context: { readonly signal?: AbortSignal } = {},
  ) {
    try {
      const snapshot = await this.#snapshot(request)
      const models = await this.#transport.discoverModels(request.endpointBaseUrl, {
        scope: request.connectivityScope,
        ...(snapshot.credential === undefined ? {} : { credential: snapshot.credential }),
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      })
      return models.includes(request.servedModelName)
        ? Object.freeze({ status: 'healthy' as const, error: null })
        : Object.freeze({ status: 'unhealthy' as const, error: 'served_model_missing' })
    } catch (error) {
      if (context.signal?.aborted) throw error
      return Object.freeze({ status: 'unhealthy' as const, error: healthErrorCode(error) })
    }
  }

  async #snapshot(request: Readonly<V2ModelVersionDeploymentRuntimeRequest>): Promise<{
    readonly configuration: Readonly<V2ModelVersionDeploymentConfigurationV2>
    readonly credential?: ModelCredentialSnapshotV1
  }> {
    const admitted = this.#policy.admitConfiguration(
      request.endpointBaseUrl,
      request.connectivityScope,
    )
    if (request.authProfile === 'none') {
      if (request.credentialRef !== null) {
        throw new ModelCredentialRegistryError('credential_reference_invalid')
      }
      return Object.freeze({
        configuration: Object.freeze({
          policyGeneration: admitted.policyGeneration,
          credentialGeneration: null,
        }),
      })
    }
    if (request.credentialRef === null || this.#credentials === undefined) {
      throw new ModelCredentialRegistryError('credential_registry_not_loaded')
    }
    this.#credentials.reload()
    const credential = this.#credentials.resolve(request.credentialRef, request.deploymentId)
    return Object.freeze({
      configuration: Object.freeze({
        policyGeneration: admitted.policyGeneration,
        credentialGeneration: credential.generation,
      }),
      credential,
    })
  }
}

function runtimeConfigurationError(error: unknown): V2ModelVersionDeploymentRuntimeError {
  if (error instanceof V2ModelVersionDeploymentRuntimeError) return error
  if (error instanceof ModelEndpointPolicyError) {
    return new V2ModelVersionDeploymentRuntimeError(
      error.code === 'model_endpoint_public_network_disabled'
        ? 'public_network_disabled'
        : 'policy_rejected',
    )
  }
  if (error instanceof ModelCredentialRegistryError) {
    return new V2ModelVersionDeploymentRuntimeError('credential_unavailable')
  }
  return new V2ModelVersionDeploymentRuntimeError('runtime_unavailable')
}

function healthErrorCode(error: unknown): string {
  if (error instanceof ModelCredentialRegistryError) return 'credential_rejected'
  if (error instanceof ModelEndpointPolicyError) return 'policy_rejected'
  if (error instanceof ModelEndpointTransportError) {
    if (error.code === 'model_endpoint_timeout') return 'timeout'
    if (
      error.code === 'model_endpoint_http_error' ||
      error.code === 'model_endpoint_redirect_rejected'
    ) {
      return 'http_error'
    }
    if (error.code === 'model_endpoint_network_error') return 'network_error'
    return 'invalid_response'
  }
  return 'unhealthy'
}
