import { describe, expect, test } from 'vitest'
import type { DeletedRefMetadataV2, RefMetadataV2 } from '../api/types.js'
import {
  clampDatasetPageIndex,
  datasetPageCount,
  datasetPageSizeForViewportHeight,
  filterV2Refs,
  paginateV2Refs,
} from './datasets.js'

const active: RefMetadataV2 = {
  name: 'training-main',
  version: 'a'.repeat(64),
  num_records: 2,
  message: 'active set',
  updated_at: '2026-07-25T00:00:00.000Z',
}

const deleted: DeletedRefMetadataV2 = {
  name: 'training-old',
  version: 'b'.repeat(64),
  num_records: 1,
  message: 'recoverable set',
  updated_at: '2026-07-24T00:00:00.000Z',
  deleted_at: '2026-07-25T01:00:00.000Z',
}

describe('V2 dataset active/trash filtering', () => {
  test('preserves each row type while filtering names and versions', () => {
    expect(filterV2Refs([active], 'MAIN')).toEqual([active])
    expect(filterV2Refs([deleted], 'old')).toEqual([deleted])
    expect(filterV2Refs([deleted], deleted.version.slice(0, 12))).toEqual([deleted])
    expect(filterV2Refs([deleted], 'missing')).toEqual([])
  })
})

describe('V2 dataset pagination', () => {
  const rows = Array.from({ length: 23 }, (_, index) => `dataset-${index + 1}`)

  test('returns stable eight-row pages and the final remainder', () => {
    expect(datasetPageCount(rows.length)).toBe(3)
    expect(paginateV2Refs(rows, 0)).toEqual(rows.slice(0, 8))
    expect(paginateV2Refs(rows, 1)).toEqual(rows.slice(8, 16))
    expect(paginateV2Refs(rows, 2)).toEqual(rows.slice(16, 23))
  })

  test('clamps stale page state after filtering or restoring a row', () => {
    expect(clampDatasetPageIndex(5, rows.length)).toBe(2)
    expect(clampDatasetPageIndex(2, 4)).toBe(0)
    expect(clampDatasetPageIndex(-1, rows.length)).toBe(0)
    expect(datasetPageCount(0)).toBe(1)
  })

  test('uses more rows on taller desktop viewports without crowding short screens', () => {
    expect(datasetPageSizeForViewportHeight(768)).toBe(8)
    expect(datasetPageSizeForViewportHeight(879)).toBe(8)
    expect(datasetPageSizeForViewportHeight(880)).toBe(10)
    expect(datasetPageSizeForViewportHeight(999)).toBe(10)
    expect(datasetPageSizeForViewportHeight(1000)).toBe(12)
    expect(datasetPageSizeForViewportHeight(1200)).toBe(12)
  })
})
