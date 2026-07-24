import { afterEach, describe, expect, test, vi } from 'vitest'
import { workspaceOptions } from '../src/config.js'

describe('workspaceOptions', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  test('uses DATABENCH_ROOT for writable temporary artifacts', () => {
    vi.stubEnv('DATABENCH_V2_CURSOR_SECRET', '0123456789abcdef')
    vi.stubEnv('DATABENCH_ROOT', '/var/lib/databench')

    expect(workspaceOptions({ compact: false })).toEqual({
      cursorSecret: '0123456789abcdef',
      root: '/var/lib/databench',
    })
  })

  test('keeps the workspace default when DATABENCH_ROOT is absent', () => {
    vi.stubEnv('DATABENCH_V2_CURSOR_SECRET', '0123456789abcdef')
    vi.stubEnv('DATABENCH_ROOT', undefined)

    expect(workspaceOptions({ compact: false })).toEqual({
      cursorSecret: '0123456789abcdef',
    })
  })
})
