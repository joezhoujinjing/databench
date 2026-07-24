import { describe, expect, test } from 'vitest'
import fixture from '../../../test/golden/fixtures/v2/web-v2-record-cache-security.fixture.json'
import { keepPinnedVersion } from '../routes/dataset-detail.js'
import { nextRecordOffset, nextRefCursor } from './hooks.js'
import { v2QueryKeys } from './query-keys.js'
import type { RecordPageV2, RefPageV2 } from './types.js'

describe('V2 immutable query identity', () => {
  test('contains connection scope, base and exact version without token material', () => {
    expect(v2QueryKeys.capability('scope-a', 'https://api.test')).toEqual([
      'scope-a',
      'https://api.test',
      'v2',
      'capability',
    ])
    expect(v2QueryKeys.records('scope-a', 'https://api.test', 'version-a', 100)).toEqual([
      'scope-a',
      'https://api.test',
      'v2',
      'dataset',
      'version-a',
      'records',
      100,
    ])
    expect(v2QueryKeys.record('scope-b', '', 'version-b', 'record-1')).toEqual([
      'scope-b',
      '',
      'v2',
      'dataset',
      'version-b',
      'record',
      'record-1',
    ])
  })

  test('pins the first resolution and computes bounded page continuation', () => {
    const {
      base,
      first_version: firstVersion,
      moved_version: movedVersion,
      old_scope: scope,
    } = fixture.connection
    const pinned = keepPinnedVersion(null, firstVersion)
    expect(pinned).toBe(firstVersion)
    expect(keepPinnedVersion(pinned, movedVersion)).toBe(firstVersion)
    expect(v2QueryKeys.records(scope, base, pinned, 100)).toContain(firstVersion)
    expect(v2QueryKeys.records(scope, base, pinned, 100)).not.toContain(movedVersion)

    const recordPage = {
      dataset_version: 'version-a',
      items: [{}, {}],
      limit: 2,
      offset: 2,
      total: 5,
    } as RecordPageV2
    expect(nextRecordOffset(recordPage)).toBe(4)
    expect(nextRecordOffset({ ...recordPage, items: [], offset: 4 })).toBeUndefined()
    expect(nextRecordOffset({ ...recordPage, offset: 3 })).toBeUndefined()

    const first = { items: [], next_cursor: 'opaque-a' } satisfies RefPageV2
    const repeated = { items: [], next_cursor: 'opaque-a' } satisfies RefPageV2
    expect(nextRefCursor(first, [first])).toBe('opaque-a')
    expect(nextRefCursor(repeated, [first, repeated])).toBeUndefined()
    expect(nextRefCursor({ items: [], next_cursor: null }, [])).toBeUndefined()
  })
})
