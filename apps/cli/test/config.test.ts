import { afterEach, describe, expect, test, vi } from 'vitest'
import { v2WorkspaceOptions } from '../src/config.js'

describe('v2WorkspaceOptions', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  test('uses DATABENCH_ROOT for writable v2 temporary artifacts', () => {
    vi.stubEnv('DATABENCH_V2_CURSOR_SECRET', '0123456789abcdef')
    vi.stubEnv('DATABENCH_ROOT', '/var/lib/databench')

    expect(v2WorkspaceOptions({ compact: false })).toEqual({
      cursorSecret: '0123456789abcdef',
      root: '/var/lib/databench',
    })
  })

  test('keeps the workspace default when DATABENCH_ROOT is absent', () => {
    vi.stubEnv('DATABENCH_V2_CURSOR_SECRET', '0123456789abcdef')
    vi.stubEnv('DATABENCH_ROOT', undefined)

    expect(v2WorkspaceOptions({ compact: false })).toEqual({
      cursorSecret: '0123456789abcdef',
    })
  })
})
