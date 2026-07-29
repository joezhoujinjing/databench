const ROUTE_KEY = /^[A-Za-z0-9_-]{2,2731}$/u
const RELATIVE_LOCATOR = /^[^\\]{1,2048}$/u
const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder('utf-8', { fatal: true })

export type ReportRouteKey = string & { readonly __reportRouteKey: unique symbol }

export function encodeReportKey(locator: string): ReportRouteKey {
  assertRelativeLocator(locator)
  const bytes = textEncoder.encode(locator)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '') as ReportRouteKey
}

export function decodeReportKey(key: string): string {
  if (!ROUTE_KEY.test(key)) throw new TypeError('Malformed report route key')
  const base64 = key.replaceAll('-', '+').replaceAll('_', '/')
  const padded = `${base64}${'='.repeat((4 - (base64.length % 4)) % 4)}`
  let binary: string
  try {
    binary = atob(padded)
  } catch {
    throw new TypeError('Malformed report route key')
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
  let locator: string
  try {
    locator = textDecoder.decode(bytes)
  } catch {
    throw new TypeError('Malformed report route key')
  }
  assertRelativeLocator(locator)
  if (encodeReportKey(locator) !== key) throw new TypeError('Non-canonical report route key')
  return locator
}

function assertRelativeLocator(locator: string): void {
  if (
    !RELATIVE_LOCATOR.test(locator) ||
    textEncoder.encode(locator).byteLength > 2048 ||
    containsControlCharacter(locator) ||
    locator.startsWith('/') ||
    locator.split('/').includes('..') ||
    /^[A-Za-z]:/u.test(locator) ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(locator)
  ) {
    throw new TypeError('Report locator must be a bounded relative value')
  }
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)
    if (codePoint !== undefined && (codePoint <= 31 || codePoint === 127)) return true
  }
  return false
}
