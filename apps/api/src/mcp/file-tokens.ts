import { randomBytes } from 'node:crypto'
import { BadInputError, CapacityExceededError } from '@databench/schema'

export interface ValidationPreviewProcessMetadata {
  readonly kind: 'process'
  readonly format: 'canonical-jsonl' | 'canonical-draft-jsonl-v1'
  readonly action: 'validate-preview'
  readonly previewRecords: number
}

export interface CanonicalImportProcessMetadata {
  readonly kind: 'process'
  readonly format: 'canonical-jsonl'
  readonly action: 'import-dataset'
  readonly ref: string
  readonly expectedRefVersion: string | null
  readonly message: string | null
}

export interface CanonicalDraftMaterializeProcessMetadata {
  readonly kind: 'process'
  readonly format: 'canonical-draft-jsonl-v1'
  readonly action: 'materialize-jsonl'
  readonly expectedInputDigest?: string
}

export interface CanonicalDraftImportProcessMetadata {
  readonly kind: 'process'
  readonly format: 'canonical-draft-jsonl-v1'
  readonly action: 'import-dataset'
  readonly ref: string
  readonly expectedRefVersion: string | null
  readonly message: string | null
  readonly expectedInputDigest?: string
}

export interface CanonicalExportMetadata {
  readonly kind: 'export'
  readonly datasetVersion: string
  readonly filename: string
  readonly mediaType: 'application/x-ndjson'
}

export type McpFileTokenMetadata =
  | ValidationPreviewProcessMetadata
  | CanonicalImportProcessMetadata
  | CanonicalDraftImportProcessMetadata
  | CanonicalDraftMaterializeProcessMetadata
  | CanonicalExportMetadata

interface TokenEntry<T extends McpFileTokenMetadata = McpFileTokenMetadata> {
  readonly token: string
  readonly metadata: T
  readonly expiresAtMs: number
  state: 'ready' | 'active'
}

export interface PreparedMcpFileToken<T extends McpFileTokenMetadata> {
  readonly token: string
  readonly metadata: T
  readonly expiresAt: string
}

export interface ActiveMcpFileToken<T extends McpFileTokenMetadata> {
  readonly busy: false
  readonly metadata: T
  finish(): void
}

export interface BusyMcpFileToken {
  readonly busy: true
}

export interface McpFileTokenRegistryOptions {
  readonly maxEntries: number
  readonly maxActive: number
  readonly ttlMs: number
  readonly now?: () => number
  readonly randomBytes32?: () => Uint8Array
}

export class McpFileTokenRegistry {
  readonly #entries = new Map<string, TokenEntry>()
  readonly #maxEntries: number
  readonly #maxActive: number
  readonly #ttlMs: number
  readonly #now: () => number
  readonly #randomBytes32: () => Uint8Array
  #activeCount = 0

  constructor(options: McpFileTokenRegistryOptions) {
    this.#maxEntries = positiveSafeInteger('maxEntries', options.maxEntries)
    this.#maxActive = positiveSafeInteger('maxActive', options.maxActive)
    this.#ttlMs = positiveSafeInteger('ttlMs', options.ttlMs)
    this.#now = options.now ?? Date.now
    this.#randomBytes32 = options.randomBytes32 ?? (() => randomBytes(32))
  }

  get size(): number {
    return this.#entries.size
  }

  get activeCount(): number {
    return this.#activeCount
  }

  prepare<T extends McpFileTokenMetadata>(metadata: T): PreparedMcpFileToken<T> {
    const now = validNow(this.#now())
    this.#sweepExpiredReady(now)
    if (this.#entries.size >= this.#maxEntries) {
      throw new CapacityExceededError('MCP file token capacity is exhausted', {
        resource: 'mcp_file_tokens',
        limit: this.#maxEntries,
        actual: this.#entries.size,
      })
    }

    const prefix = metadata.kind === 'process' ? 'proc_' : 'exp_'
    let token: string | undefined
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const bytes = this.#randomBytes32()
      if (!(bytes instanceof Uint8Array) || bytes.byteLength !== 32) {
        throw new TypeError('MCP token random source must return exactly 32 bytes')
      }
      const candidate = `${prefix}${Buffer.from(bytes).toString('hex')}`
      if (!this.#entries.has(candidate)) {
        token = candidate
        break
      }
    }
    if (token === undefined) {
      throw new Error('MCP token random source repeatedly collided')
    }

    const expiresAtMs = checkedAddTime(now, this.#ttlMs)
    const metadataSnapshot = Object.freeze({ ...metadata }) as unknown as T
    const entry: TokenEntry<T> = {
      token,
      metadata: metadataSnapshot,
      expiresAtMs,
      state: 'ready',
    }
    this.#entries.set(token, entry)
    return Object.freeze({
      token,
      metadata: metadataSnapshot,
      expiresAt: new Date(expiresAtMs).toISOString(),
    })
  }

  begin<T extends McpFileTokenMetadata['kind']>(
    token: string,
    kind: T,
  ): ActiveMcpFileToken<Extract<McpFileTokenMetadata, { readonly kind: T }>> | BusyMcpFileToken {
    const now = validNow(this.#now())
    const entry = this.#entries.get(token)
    if (
      entry === undefined ||
      entry.metadata.kind !== kind ||
      entry.state !== 'ready' ||
      entry.expiresAtMs <= now
    ) {
      if (entry?.state === 'ready' && entry.expiresAtMs <= now) this.#entries.delete(token)
      throw invalidTokenError()
    }
    if (this.#activeCount >= this.#maxActive) return Object.freeze({ busy: true })

    entry.state = 'active'
    this.#activeCount += 1
    let finished = false
    return Object.freeze({
      busy: false,
      metadata: entry.metadata as Extract<McpFileTokenMetadata, { readonly kind: T }>,
      finish: () => {
        if (finished) return
        finished = true
        if (this.#entries.get(token) === entry) this.#entries.delete(token)
        this.#activeCount -= 1
      },
    })
  }

  #sweepExpiredReady(now: number): void {
    for (const [token, entry] of this.#entries) {
      if (entry.state === 'ready' && entry.expiresAtMs <= now) this.#entries.delete(token)
    }
  }
}

function invalidTokenError(): BadInputError {
  const message = 'MCP file token is invalid, expired, active, or already used'
  return new BadInputError(message, {
    issues: [{ path: '', line: null, code: 'token_invalid_or_used', message }],
  })
}

function positiveSafeInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`MCP token registry ${name} must be a positive safe integer`)
  }
  return value
}

function validNow(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('MCP token registry clock must return a non-negative safe integer')
  }
  return value
}

function checkedAddTime(now: number, ttlMs: number): number {
  const result = now + ttlMs
  if (!Number.isSafeInteger(result)) throw new TypeError('MCP token expiry exceeds safe time range')
  return result
}
