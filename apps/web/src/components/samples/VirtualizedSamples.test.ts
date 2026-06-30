import { describe, expect, test } from 'vitest'
import {
  filterSamplesByKind,
  selectVirtualRows,
  shouldFetchNextSamplePage,
} from './VirtualizedSamples.js'

describe('VirtualizedSamples helpers', () => {
  test('only selects virtual rows from a large loaded sample set', () => {
    const rows = Array.from({ length: 1_000 }, (_, index) => ({ kind: 'sft', index }))
    const visible = selectVirtualRows(rows, [{ index: 0 }, { index: 12 }, { index: 999 }])

    expect(visible).toHaveLength(3)
    expect(visible.map((row) => row.index)).toEqual([0, 12, 999])
  })

  test('fetches the next page only when the viewport reaches the loaded tail', () => {
    expect(
      shouldFetchNextSamplePage({
        hasNextPage: true,
        isFetchingNextPage: false,
        lastIndex: 19,
        loaded: 20,
      }),
    ).toBe(true)
    expect(
      shouldFetchNextSamplePage({
        hasNextPage: true,
        isFetchingNextPage: false,
        lastIndex: 18,
        loaded: 20,
      }),
    ).toBe(false)
  })

  test('filters loaded samples by kind for the detail tabs', () => {
    const rows = [
      { kind: 'sft', messages: [] },
      { kind: 'preference', chosen: '', rejected: '' },
      { kind: 'sft', messages: [] },
    ] as never[]

    expect(filterSamplesByKind(rows, null)).toHaveLength(3)
    expect(filterSamplesByKind(rows, 'sft')).toHaveLength(2)
    expect(filterSamplesByKind(rows, 'preference')).toHaveLength(1)
  })
})
