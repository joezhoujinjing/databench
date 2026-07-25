import { describe, expect, test } from 'vitest'
import type { DeletedRefMetadataV2, RefMetadataV2 } from '../api/types.js'
import { filterV2Refs } from './datasets.js'

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
