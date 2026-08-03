import { describe, expect, test } from 'vitest'
import fixture from '../../../../test/golden/fixtures/v2/web-v2-mutations-export.fixture.json'
import type { DatasetLineageV2 } from '../../api/types.js'
import { mergeLineagePages } from './LineagePageView.js'

describe('V2 lineage continuation', () => {
  test('merges stable pages without duplicating nodes or edges', () => {
    const first = fixture.lineage as DatasetLineageV2
    const second: DatasetLineageV2 = {
      ...first,
      next_cursor: null,
      nodes: [...first.nodes],
      truncated: false,
    }
    const merged = mergeLineagePages([first, second])
    expect(merged.root_dataset_version).toBe(first.root_dataset_version)
    expect(merged.nodes).toHaveLength(1)
    expect(merged.edges).toHaveLength(1)
    expect(merged.next_cursor).toBeNull()
    expect(merged.truncated).toBe(false)
  })
})
