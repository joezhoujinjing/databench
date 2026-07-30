import { describe, expect, it, vi } from 'vitest'
import { createProviderTaskId } from './id.js'

describe('provider task IDs', () => {
  it('prefers crypto.randomUUID when the browser exposes it', () => {
    const getRandomValues = vi.fn((values: Uint8Array) => values)
    const randomUUID = vi.fn(() => '123e4567-e89b-42d3-a456-426614174000')

    expect(createProviderTaskId('eval', { getRandomValues, randomUUID })).toBe(
      'eval_123e4567-e89b-42d3-a456-426614174000',
    )
    expect(randomUUID).toHaveBeenCalledOnce()
    expect(getRandomValues).not.toHaveBeenCalled()
  })

  it('formats a UUID v4 with getRandomValues when randomUUID is unavailable', () => {
    const getRandomValues = vi.fn((values: Uint8Array) => {
      values.set(Array.from({ length: 16 }, (_, index) => index))
      return values
    })

    expect(createProviderTaskId('perf', { getRandomValues })).toBe(
      'perf_00010203-0405-4607-8809-0a0b0c0d0e0f',
    )
    expect(getRandomValues).toHaveBeenCalledOnce()
  })
})
