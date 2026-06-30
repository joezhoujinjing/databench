import { describe, expect, test } from 'vitest'
import { filterRefs, shouldShowCappedNote } from './datasets.index.js'

describe('datasets page helpers', () => {
  test('filters refs by name or version and sorts by name', () => {
    const rows = filterRefs(
      [
        { name: 'zeta', version: '111' },
        { name: 'alpha', version: 'abc-version' },
        { name: 'beta', version: '222' },
      ],
      'VER',
    )

    expect(rows).toEqual([{ name: 'alpha', version: 'abc-version' }])
    expect(filterRefs(rows, '')).toEqual(rows)
  })

  test('shows capped note only when backend total exceeds fetched rows', () => {
    expect(shouldShowCappedNote(201, 200)).toBe(true)
    expect(shouldShowCappedNote(200, 200)).toBe(false)
  })
})
