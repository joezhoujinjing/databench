import { describe, expect, test } from 'vitest'
import { formatDateTime } from './format.js'

describe('formatDateTime', () => {
  test('uses a compact, zero-padded local timestamp for table scanning', () => {
    const value = new Date(2026, 0, 2, 3, 4, 5).toISOString()

    expect(formatDateTime(value)).toBe('2026-01-02 03:04')
  })

  test('preserves invalid source values', () => {
    expect(formatDateTime('not-a-date')).toBe('not-a-date')
  })
})
