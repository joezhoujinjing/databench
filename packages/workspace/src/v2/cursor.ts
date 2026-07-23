import { createHmac, timingSafeEqual } from 'node:crypto'
import { canonicalJsonV2 } from '@databench/hashing'
import {
  parseRawJsonV2,
  RefNameV2Schema,
  V2_CURSOR_MAX_CHARS,
  ValidationError,
} from '@databench/schema'

const CURSOR_VERSION = 1
const CURSOR_MAX_BYTES = 1024
const BASE64URL = /^[A-Za-z0-9_-]+$/
const encoder = new TextEncoder()
export const DEFAULT_V2_CURSOR_TTL_MS = 15 * 60 * 1000

interface RefCursorPayloadV2 {
  readonly v: typeof CURSOR_VERSION
  readonly kind: 'refs'
  readonly scope: string
  readonly after: string
  readonly expires_at: number
}

export interface V2CursorCodecOptions {
  readonly ttlMs?: number
  readonly now?: () => number
}

export class V2CursorCodec {
  readonly #key: Uint8Array
  readonly #ttlMs: number
  readonly #now: () => number

  constructor(secret: Uint8Array | string, options: V2CursorCodecOptions = {}) {
    const key = typeof secret === 'string' ? encoder.encode(secret) : secret.slice()
    if (key.byteLength < 16) {
      throw new TypeError('V2 cursor secret must contain at least 16 bytes')
    }
    this.#key = key
    this.#ttlMs = positiveSafeInteger('V2 cursor ttlMs', options.ttlMs ?? DEFAULT_V2_CURSOR_TTL_MS)
    this.#now = options.now ?? Date.now
  }

  encodeRef(namespace: string, after: string): string {
    const payload: RefCursorPayloadV2 = {
      v: CURSOR_VERSION,
      kind: 'refs',
      scope: this.#scope(namespace),
      after: RefNameV2Schema.parse(after),
      expires_at: checkedAdd(this.#now(), this.#ttlMs),
    }
    const bytes = encoder.encode(canonicalJsonV2(payload))
    return `${Buffer.from(bytes).toString('base64url')}.${this.#sign(bytes).toString('base64url')}`
  }

  decodeRef(cursor: string, namespace: string): string {
    try {
      if (typeof cursor !== 'string' || cursor.length > V2_CURSOR_MAX_CHARS) {
        throw new Error('cursor text size is invalid')
      }
      const parts = cursor.split('.')
      if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error('malformed cursor')
      const bytes = decodeBase64Url(parts[0])
      if (bytes.byteLength === 0 || bytes.byteLength > CURSOR_MAX_BYTES) {
        throw new Error('cursor payload size is invalid')
      }
      const signature = decodeBase64Url(parts[1])
      const expected = this.#sign(bytes)
      if (signature.byteLength !== expected.byteLength || !timingSafeEqual(signature, expected)) {
        throw new Error('cursor signature is invalid')
      }
      const value = parseRawJsonV2(bytes, { maxBytes: CURSOR_MAX_BYTES, maxDepth: 4 })
      if (
        !isRefCursorPayload(value) ||
        value.scope !== this.#scope(namespace) ||
        value.expires_at <= this.#now()
      ) {
        throw new Error('cursor scope is invalid')
      }
      return RefNameV2Schema.parse(value.after)
    } catch {
      throw new ValidationError('Invalid or expired V2 refs cursor', {
        issues: [
          { path: '/cursor', line: null, code: 'invalid_cursor', message: 'Invalid cursor' },
        ],
      })
    }
  }

  #sign(bytes: Uint8Array): Buffer {
    return createHmac('sha256', this.#key).update(bytes).digest()
  }

  #scope(namespace: string): string {
    return createHmac('sha256', this.#key)
      .update(canonicalJsonV2({ kind: 'databench-v2-cursor-scope', namespace }))
      .digest('base64url')
  }
}

function decodeBase64Url(value: string): Buffer {
  if (!BASE64URL.test(value)) throw new Error('cursor base64url is invalid')
  const decoded = Buffer.from(value, 'base64url')
  if (decoded.toString('base64url') !== value) {
    throw new Error('cursor base64url is not canonical')
  }
  return decoded
}

function isRefCursorPayload(value: unknown): value is RefCursorPayloadV2 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    Object.keys(record).length === 5 &&
    record.v === CURSOR_VERSION &&
    record.kind === 'refs' &&
    typeof record.scope === 'string' &&
    typeof record.after === 'string' &&
    typeof record.expires_at === 'number' &&
    Number.isSafeInteger(record.expires_at) &&
    record.expires_at >= 0
  )
}

function positiveSafeInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`)
  }
  return value
}

function checkedAdd(left: number, right: number): number {
  if (!Number.isSafeInteger(left) || left < 0 || right > Number.MAX_SAFE_INTEGER - left) {
    throw new TypeError('V2 cursor expiry exceeds the safe integer range')
  }
  return left + right
}
