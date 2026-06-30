import { describe, expect, test } from 'vitest'
import {
  API_BASE_STORAGE_KEY,
  getStoredApiBase,
  getStoredToken,
  normalizeApiBase,
  ORIGIN_TOKEN_NAMESPACE,
  type StorageLike,
  setStoredApiBase,
  setStoredConnection,
  setStoredToken,
  tokenStorageKey,
} from './config.js'

describe('api config', () => {
  test('normalizes API bases and stores empty base by deleting the key', () => {
    const storage = new MemoryStorage()

    expect(normalizeApiBase('  http://127.0.0.1:8000/// ')).toBe('http://127.0.0.1:8000')
    expect(setStoredApiBase(' http://api.example.test/// ', storage)).toBe(
      'http://api.example.test',
    )
    expect(storage.getItem(API_BASE_STORAGE_KEY)).toBe('http://api.example.test')

    expect(setStoredApiBase('   ', storage)).toBe('')
    expect(storage.getItem(API_BASE_STORAGE_KEY)).toBeNull()
  })

  test('keeps bearer tokens isolated per normalized base', () => {
    const storage = new MemoryStorage()

    setStoredToken('', ' origin-token ', storage)
    setStoredToken('http://api-a.test///', ' token-a ', storage)
    setStoredToken('http://api-b.test', 'token-b', storage)

    expect(tokenStorageKey('')).toBe(`databench.token:${ORIGIN_TOKEN_NAMESPACE}`)
    expect(getStoredApiBase(storage)).toBe('')
    expect(getStoredToken('', storage)).toBe('origin-token')
    expect(getStoredToken('http://api-a.test', storage)).toBe('token-a')
    expect(getStoredToken('http://api-b.test', storage)).toBe('token-b')

    setStoredToken('http://api-a.test', ' ', storage)
    expect(getStoredToken('http://api-a.test', storage)).toBe('')
    expect(getStoredToken('http://api-b.test', storage)).toBe('token-b')
  })

  test('stores connection token in the target base namespace', () => {
    const storage = new MemoryStorage()

    setStoredToken('http://api-a.test', 'token-a', storage)
    expect(setStoredConnection(' http://api-b.test/// ', ' token-b ', storage)).toEqual({
      base: 'http://api-b.test',
      token: 'token-b',
    })

    expect(getStoredApiBase(storage)).toBe('http://api-b.test')
    expect(getStoredToken('http://api-a.test', storage)).toBe('token-a')
    expect(getStoredToken('http://api-b.test', storage)).toBe('token-b')
  })
})

class MemoryStorage implements StorageLike {
  private readonly values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
}
