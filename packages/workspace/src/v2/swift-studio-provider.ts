import { ServiceUnavailableError } from '@databench/schema'
import { z } from 'zod'

const DigestSchema = z.string().regex(/^[0-9a-f]{64}$/u)
const DatasetVersionSchema = DigestSchema
const ProviderSessionIdSchema = z.string().regex(/^sws_[A-Za-z0-9_-]{16,128}$/u)
const ProviderGenerationSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._-]+$/u)

const ProviderCreateResponseSchema = z
  .strictObject({
    provider_session_id: ProviderSessionIdSchema,
    status: z.literal('ready'),
    dataset_version: DatasetVersionSchema,
    converter: z.literal('ms-swift'),
    converter_version: z.literal('1.0.0'),
    export_digest: DigestSchema,
    export_size_bytes: z.number().int().safe().positive(),
    output_count: z.number().int().safe().positive(),
    provider_generation: ProviderGenerationSchema,
    replayed: z.boolean(),
  })
  .readonly()

const ProviderCloseResponseSchema = z
  .strictObject({
    provider_session_id: ProviderSessionIdSchema,
    status: z.literal('closed'),
    provider_generation: ProviderGenerationSchema,
    replayed: z.boolean(),
  })
  .readonly()

const ProviderErrorResponseSchema = z
  .strictObject({
    error: z
      .strictObject({
        code: z
          .string()
          .min(1)
          .max(128)
          .regex(/^[a-z][a-z0-9._-]*$/u),
        message: z.string().min(1).max(2_048),
      })
      .readonly(),
  })
  .readonly()

export interface SwiftStudioProviderExpectedExportV2 {
  readonly digestAlgorithm: 'blake3'
  readonly digest: string
  readonly sizeBytes: number
  readonly lineCount: number
}

export interface CreateSwiftStudioProviderSessionV2 {
  readonly requestId: string
  readonly datasetVersion: string
  readonly displayLabel: string
  readonly exportUrl: string
  readonly acceptedFidelityDigest: string | null
  readonly expected: SwiftStudioProviderExpectedExportV2
}

export interface SwiftStudioProviderSessionV2 {
  readonly providerSessionId: string
  readonly status: 'ready'
  readonly datasetVersion: string
  readonly converter: 'ms-swift'
  readonly converterVersion: '1.0.0'
  readonly exportDigest: string
  readonly exportSizeBytes: number
  readonly outputCount: number
  readonly providerGeneration: string
  readonly replayed: boolean
}

export interface ClosedSwiftStudioProviderSessionV2 {
  readonly providerSessionId: string
  readonly status: 'closed'
  readonly providerGeneration: string
  readonly replayed: boolean
}

export interface SwiftStudioProviderV2 {
  createSession(
    input: CreateSwiftStudioProviderSessionV2,
    options?: { readonly signal?: AbortSignal },
  ): Promise<Readonly<SwiftStudioProviderSessionV2>>
  getCurrentSession(options?: {
    readonly signal?: AbortSignal
  }): Promise<Readonly<SwiftStudioProviderSessionV2> | null>
  closeSession(
    providerSessionId: string,
    requestId: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<Readonly<ClosedSwiftStudioProviderSessionV2>>
}

export class SwiftStudioProviderConflictError extends Error {
  override readonly name = 'SwiftStudioProviderConflictError'

  constructor(
    readonly providerCode: string,
    message: string,
  ) {
    super(message)
  }
}

export interface HttpSwiftStudioProviderOptions {
  readonly baseUrl: string
  readonly credential?: string
  readonly fetch?: typeof fetch
  readonly timeoutMs?: number
}

export class HttpSwiftStudioProvider implements SwiftStudioProviderV2 {
  readonly #baseUrl: string
  readonly #credential: string | undefined
  readonly #fetch: typeof fetch
  readonly #timeoutMs: number

  constructor(options: HttpSwiftStudioProviderOptions) {
    this.#baseUrl = requireHttpOrigin(options.baseUrl)
    this.#credential = requireOptionalCredential(options.credential)
    this.#fetch = options.fetch ?? fetch
    this.#timeoutMs = requirePositiveSafeInteger(options.timeoutMs ?? 300_000)
  }

  async createSession(
    input: CreateSwiftStudioProviderSessionV2,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<Readonly<SwiftStudioProviderSessionV2>> {
    const response = await this.#request(
      '/sessions',
      {
        request_id: DigestSchema.parse(input.requestId),
        dataset_version: DatasetVersionSchema.parse(input.datasetVersion),
        display_label: z.string().min(1).max(256).parse(input.displayLabel),
        export_url: z.url().parse(input.exportUrl),
        export_request: {
          converter: 'ms-swift',
          options: {},
          accepted_fidelity_digest:
            input.acceptedFidelityDigest === null
              ? null
              : DigestSchema.parse(input.acceptedFidelityDigest),
        },
        expected: {
          digest_algorithm: 'blake3',
          digest: DigestSchema.parse(input.expected.digest),
          size_bytes: z.number().int().safe().positive().parse(input.expected.sizeBytes),
          line_count: z.number().int().safe().positive().parse(input.expected.lineCount),
        },
        converter_version: '1.0.0',
      },
      options.signal,
    )
    if (response.status !== 200 && response.status !== 201) {
      throw providerContractError('create Session', 'unexpected success status')
    }
    const parsed = ProviderCreateResponseSchema.safeParse(response.body)
    if (!parsed.success) {
      throw providerContractError('create Session', parsed.error)
    }
    return Object.freeze({
      providerSessionId: parsed.data.provider_session_id,
      status: parsed.data.status,
      datasetVersion: parsed.data.dataset_version,
      converter: parsed.data.converter,
      converterVersion: parsed.data.converter_version,
      exportDigest: parsed.data.export_digest,
      exportSizeBytes: parsed.data.export_size_bytes,
      outputCount: parsed.data.output_count,
      providerGeneration: parsed.data.provider_generation,
      replayed: parsed.data.replayed,
    })
  }

  async getCurrentSession(
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<Readonly<SwiftStudioProviderSessionV2> | null> {
    const response = await this.#request(
      '/sessions/current',
      undefined,
      options.signal,
      'GET',
      true,
    )
    if (response.status === 404) {
      const notFound = ProviderErrorResponseSchema.safeParse(response.body)
      if (!notFound.success || notFound.data.error.code !== 'active_session_not_found') {
        throw providerContractError('read the current Session', 'unexpected not-found response')
      }
      return null
    }
    if (response.status !== 200) {
      throw providerContractError('read the current Session', 'unexpected success status')
    }
    const parsed = ProviderCreateResponseSchema.safeParse(response.body)
    if (!parsed.success) {
      throw providerContractError('read the current Session', parsed.error)
    }
    return Object.freeze({
      providerSessionId: parsed.data.provider_session_id,
      status: parsed.data.status,
      datasetVersion: parsed.data.dataset_version,
      converter: parsed.data.converter,
      converterVersion: parsed.data.converter_version,
      exportDigest: parsed.data.export_digest,
      exportSizeBytes: parsed.data.export_size_bytes,
      outputCount: parsed.data.output_count,
      providerGeneration: parsed.data.provider_generation,
      replayed: parsed.data.replayed,
    })
  }

  async closeSession(
    providerSessionId: string,
    requestId: string,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<Readonly<ClosedSwiftStudioProviderSessionV2>> {
    const locator = ProviderSessionIdSchema.parse(providerSessionId)
    const response = await this.#request(
      `/sessions/${encodeURIComponent(locator)}:close`,
      { request_id: DigestSchema.parse(requestId) },
      options.signal,
    )
    if (response.status !== 200 && response.status !== 202) {
      throw providerContractError('close Session', 'unexpected success status')
    }
    const parsed = ProviderCloseResponseSchema.safeParse(response.body)
    if (!parsed.success) {
      throw providerContractError('close Session', parsed.error)
    }
    return Object.freeze({
      providerSessionId: parsed.data.provider_session_id,
      status: parsed.data.status,
      providerGeneration: parsed.data.provider_generation,
      replayed: parsed.data.replayed,
    })
  }

  async #request(
    path: string,
    body: Readonly<Record<string, unknown>> | undefined,
    signal: AbortSignal | undefined,
    method: 'GET' | 'POST' = 'POST',
    allowNotFound = false,
  ): Promise<{ readonly body: unknown; readonly status: number }> {
    const timeoutSignal = AbortSignal.timeout(this.#timeoutMs)
    const operationSignal =
      signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal])
    let response: Response
    try {
      response = await this.#fetch(new URL(path, this.#baseUrl), {
        method,
        headers: {
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(this.#credential === undefined
            ? {}
            : { Authorization: `Bearer ${this.#credential}` }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: operationSignal,
      })
    } catch (error) {
      if (signal?.aborted) throw signal.reason
      throw new ServiceUnavailableError(
        'Swift Studio Provider is unavailable',
        { dependency: 'swift_studio_provider' },
        { cause: error },
      )
    }
    const responseBody = await readBoundedJson(response)
    if (response.ok || (allowNotFound && response.status === 404)) {
      return { body: responseBody, status: response.status }
    }
    const providerError = ProviderErrorResponseSchema.safeParse(responseBody)
    if (response.status === 409 && providerError.success) {
      throw new SwiftStudioProviderConflictError(
        providerError.data.error.code,
        providerError.data.error.message,
      )
    }
    throw new ServiceUnavailableError('Swift Studio Provider request failed', {
      dependency: 'swift_studio_provider',
      status: response.status,
      provider_code: providerError.success ? providerError.data.error.code : 'invalid_response',
    })
  }
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength === 0 || bytes.byteLength > 64 * 1024) {
    throw new ServiceUnavailableError('Swift Studio Provider response size is invalid', {
      dependency: 'swift_studio_provider',
    })
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
  } catch (error) {
    throw providerContractError('decode response', error)
  }
}

function providerContractError(operation: string, cause: unknown): ServiceUnavailableError {
  return new ServiceUnavailableError(
    `Swift Studio Provider could not ${operation}`,
    { dependency: 'swift_studio_provider', reason: 'contract_mismatch' },
    { cause },
  )
}

function requireHttpOrigin(value: string): string {
  const url = new URL(value)
  if (
    url.protocol !== 'http:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new TypeError('Swift Studio Provider base URL must be an HTTP origin')
  }
  return url.origin
}

function requireOptionalCredential(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const hasControlCharacter = Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0)
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)
  })
  if (value.length < 16 || value.length > 4_096 || hasControlCharacter) {
    throw new TypeError('Swift Studio Provider credential is invalid')
  }
  return value
}

function requirePositiveSafeInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError('Swift Studio Provider timeout must be a positive safe integer')
  }
  return value
}
