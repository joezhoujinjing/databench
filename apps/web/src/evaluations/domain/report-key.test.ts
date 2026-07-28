import { describe, expect, test } from 'vitest'
import { decodeReportKey, encodeReportKey } from './report-key.js'

describe('opaque report route keys', () => {
  test.each([
    'run-2026-07-28',
    'nested/report.json',
    '模型/评测.json',
  ])('round trips %s', (value) => {
    const key = encodeReportKey(value)
    expect(key).toMatch(/^[A-Za-z0-9_-]+$/u)
    expect(decodeReportKey(key)).toBe(value)
  })

  test.each([
    '/srv/report.json',
    '../report.json',
    'a/../report.json',
    'file:report',
  ])('rejects unsafe locator %s', (value) =>
    expect(() => encodeReportKey(value)).toThrow(TypeError))

  test.each(['=', '***', 'YQ==', 'wA'])('rejects malformed or non-canonical key %s', (key) => {
    expect(() => decodeReportKey(key)).toThrow(TypeError)
  })
})
