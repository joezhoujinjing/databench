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

  test('passes the same explicit Model Repository profile into Workspace', () => {
    vi.stubEnv('DATABENCH_V2_CURSOR_SECRET', '0123456789abcdef')
    vi.stubEnv('DATABENCH_MODEL_REPOSITORY_MODE', 'connected')
    vi.stubEnv('DATABENCH_MODEL_REPOSITORY_CONFIG', '/etc/databench/model-repositories.json')
    vi.stubEnv('DATABENCH_MODEL_REPOSITORY_TIMEOUT_MS', '7000')

    expect(workspaceOptions({ compact: false })).toEqual({
      cursorSecret: '0123456789abcdef',
      modelRepository: {
        mode: 'connected',
        operatorConfigPath: '/etc/databench/model-repositories.json',
        timeoutMs: 7000,
      },
    })
  })

  test('rejects invalid Model Repository CLI environment before opening Workspace', () => {
    vi.stubEnv('DATABENCH_V2_CURSOR_SECRET', '0123456789abcdef')
    vi.stubEnv('DATABENCH_MODEL_REPOSITORY_MODE', 'public')
    expect(() => workspaceOptions({ compact: false })).toThrow(
      'DATABENCH_MODEL_REPOSITORY_MODE must be offline or connected',
    )

    vi.stubEnv('DATABENCH_MODEL_REPOSITORY_MODE', 'offline')
    vi.stubEnv('DATABENCH_MODEL_REPOSITORY_CONFIG', 'relative.json')
    expect(() => workspaceOptions({ compact: false })).toThrow(
      'DATABENCH_MODEL_REPOSITORY_CONFIG must be an absolute path',
    )
  })
})
