import { describe, expect, test } from 'vitest'
import { formatBytes, formatDateTime } from './format.js'

describe('formatBytes', () => {
  test('adds a compact unit while retaining useful precision', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1_023)).toBe('1,023 B')
    expect(formatBytes(1_024)).toBe('1 KB')
    expect(formatBytes(2_166)).toBe('2.1 KB')
    expect(formatBytes(1_048_576)).toBe('1 MB')
  })
})

describe('formatDateTime', () => {
  test('uses a compact, zero-padded local timestamp for table scanning', () => {
    const value = new Date(2026, 0, 2, 3, 4, 5).toISOString()

    expect(formatDateTime(value)).toBe('2026-01-02 03:04')
  })

  test('preserves invalid source values', () => {
    expect(formatDateTime('not-a-date')).toBe('not-a-date')
  })
})
