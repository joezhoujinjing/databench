import { describe, expect, test } from 'vitest'
import { queryKeys } from './hooks.js'

describe('query keys', () => {
  test('prefixes server-state cache keys with the active backend base', () => {
    expect(queryKeys.health('http://api-a.test')[0]).toBe('http://api-a.test')
    expect(queryKeys.refs('http://api-b.test', 200)).toEqual(['http://api-b.test', 'refs', 200])
    expect(queryKeys.samples('', 'raw', 20, 40)).toEqual(['', 'samples', 'raw', 20, 40])
    expect(queryKeys.vocabulary('http://api-c.test', 'brand')).toEqual([
      'http://api-c.test',
      'vocabulary',
      'brand',
    ])
  })
})
