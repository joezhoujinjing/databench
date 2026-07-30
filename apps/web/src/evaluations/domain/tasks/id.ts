import type { TaskKind } from './state.js'

const UUID_BYTE_LENGTH = 16

export interface BrowserCryptoSource {
  readonly getRandomValues: (values: Uint8Array) => Uint8Array
  readonly randomUUID?: (() => string) | undefined
}

export function createProviderTaskId(
  kind: TaskKind,
  source: BrowserCryptoSource = globalThis.crypto,
): string {
  if (typeof source.randomUUID === 'function') {
    return `${kind}_${source.randomUUID()}`
  }

  const bytes = source.getRandomValues(new Uint8Array(UUID_BYTE_LENGTH))
  bytes[6] = ((bytes[6] ?? 0) % 16) + 64
  bytes[8] = ((bytes[8] ?? 0) % 64) + 128

  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(
    16,
    20,
  )}-${hex.slice(20)}`
  return `${kind}_${uuid}`
}
