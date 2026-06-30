export const DEFAULT_API_BASE = ''
export const API_BASE_STORAGE_KEY = 'databench.api_base'
export const ORIGIN_TOKEN_NAMESPACE = '(origin)'

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export function normalizeApiBase(base: string | null | undefined): string {
  return (base ?? '').trim().replace(/\/+$/u, '')
}

export function tokenStorageKey(base: string | null | undefined): string {
  return `databench.token:${normalizeApiBase(base) || ORIGIN_TOKEN_NAMESPACE}`
}

export function getApiBaseUrl(storage = getBrowserStorage()): string {
  return (
    getStoredApiBase(storage) ||
    normalizeApiBase(import.meta.env.VITE_DATABENCH_API_BASE_URL ?? DEFAULT_API_BASE)
  )
}

export function getStoredApiBase(storage = getBrowserStorage()): string {
  return readStorage(storage, API_BASE_STORAGE_KEY, DEFAULT_API_BASE, normalizeApiBase)
}

export function setStoredApiBase(base: string, storage = getBrowserStorage()): string {
  const normalized = normalizeApiBase(base)
  writeStorage(storage, API_BASE_STORAGE_KEY, normalized)
  return normalized
}

export function getStoredToken(base: string, storage = getBrowserStorage()): string {
  return readStorage(storage, tokenStorageKey(base), '', (value) => value.trim())
}

export function setStoredToken(base: string, token: string, storage = getBrowserStorage()): string {
  const trimmed = token.trim()
  writeStorage(storage, tokenStorageKey(base), trimmed)
  return trimmed
}

export function setStoredConnection(
  base: string,
  token: string,
  storage = getBrowserStorage(),
): { base: string; token: string } {
  const normalizedBase = setStoredApiBase(base, storage)
  const trimmedToken = setStoredToken(normalizedBase, token, storage)

  return { base: normalizedBase, token: trimmedToken }
}

function getBrowserStorage(): StorageLike | undefined {
  if (typeof window === 'undefined') {
    return undefined
  }

  try {
    return window.localStorage
  } catch {
    return undefined
  }
}

function readStorage(
  storage: StorageLike | undefined,
  key: string,
  fallback: string,
  normalize: (value: string) => string,
): string {
  if (storage === undefined) {
    return fallback
  }

  try {
    return normalize(storage.getItem(key) ?? fallback)
  } catch {
    return fallback
  }
}

function writeStorage(storage: StorageLike | undefined, key: string, value: string): void {
  if (storage === undefined) {
    return
  }

  try {
    if (value === '') {
      storage.removeItem(key)
      return
    }

    storage.setItem(key, value)
  } catch {
    // Storage may be unavailable in private browsing or locked-down embeds.
  }
}
