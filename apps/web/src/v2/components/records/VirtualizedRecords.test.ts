import { describe, expect, test } from 'vitest'
import { virtualListScrollTarget } from './VirtualizedRecords.js'

describe('V2 record virtual-list keyboard navigation', () => {
  test('supports arrows, pages and boundaries', () => {
    const input = { clientHeight: 500, current: 600, total: 2_000 }
    expect(virtualListScrollTarget({ ...input, key: 'ArrowDown' })).toBe(680)
    expect(virtualListScrollTarget({ ...input, key: 'ArrowUp' })).toBe(520)
    expect(virtualListScrollTarget({ ...input, key: 'PageDown' })).toBe(1_100)
    expect(virtualListScrollTarget({ ...input, key: 'PageUp' })).toBe(100)
    expect(virtualListScrollTarget({ ...input, key: 'Home' })).toBe(0)
    expect(virtualListScrollTarget({ ...input, key: 'End' })).toBe(1_500)
    expect(virtualListScrollTarget({ ...input, key: 'Enter' })).toBeNull()
  })
})
