import { describe, expect, test } from 'vitest'
import { clampLimit, DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from './pagination.js'

describe('pagination', () => {
  test('clamps frontend limits to the backend page contract', () => {
    expect(clampLimit(Number.NaN)).toBe(DEFAULT_PAGE_LIMIT)
    expect(clampLimit(0)).toBe(1)
    expect(clampLimit(-12)).toBe(1)
    expect(clampLimit(12.9)).toBe(12)
    expect(clampLimit(9999)).toBe(MAX_PAGE_LIMIT)
  })
})
