import { describe, expect, test } from 'vitest'
import {
  DEFAULT_MCP_FILE_IDLE_TIMEOUT_MS,
  DEFAULT_MCP_FILE_TOTAL_TIMEOUT_MS,
  DEFAULT_MCP_MAX_ACTIVE_FILE_OPERATIONS,
  DEFAULT_MCP_MAX_JSON_BYTES,
  DEFAULT_MCP_MAX_PREVIEW_RESPONSE_BYTES,
  DEFAULT_MCP_MAX_TOKENS,
  DEFAULT_MCP_TOKEN_TTL_MS,
  mcpConfigFromEnv,
} from '../src/mcp/config.js'

describe('MCP runtime config', () => {
  test('is disabled by default without requiring auth or a public base', () => {
    expect(mcpConfigFromEnv({})).toEqual({ enabled: false })
    expect(mcpConfigFromEnv({ DATABENCH_MCP_ENABLED: 'false' })).toEqual({ enabled: false })
  })

  test('requires explicit anonymous mode and a trusted absolute public base', () => {
    expect(() => mcpConfigFromEnv({ DATABENCH_MCP_ENABLED: 'true' })).toThrowError(
      'DATABENCH_MCP_AUTH_MODE must be explicitly set to none',
    )
    expect(() =>
      mcpConfigFromEnv({
        DATABENCH_MCP_ENABLED: 'true',
        DATABENCH_MCP_AUTH_MODE: 'oidc',
        DATABENCH_MCP_PUBLIC_BASE_URL: 'http://databench.internal/api',
      }),
    ).toThrowError('DATABENCH_MCP_AUTH_MODE must be explicitly set to none')
    expect(() =>
      mcpConfigFromEnv({
        DATABENCH_MCP_ENABLED: 'true',
        DATABENCH_MCP_AUTH_MODE: 'none',
        DATABENCH_MCP_PUBLIC_BASE_URL: '/api',
      }),
    ).toThrowError('must be an absolute HTTP(S) URL')
    expect(() =>
      mcpConfigFromEnv({
        DATABENCH_MCP_ENABLED: 'true',
        DATABENCH_MCP_AUTH_MODE: 'none',
        DATABENCH_MCP_PUBLIC_BASE_URL: 'http://databench.internal/api/',
      }),
    ).toThrowError('must not have a trailing slash')
  })

  test('loads frozen defaults and exact deduplicated origins', () => {
    const config = mcpConfigFromEnv({
      DATABENCH_MCP_ENABLED: 'true',
      DATABENCH_MCP_AUTH_MODE: 'none',
      DATABENCH_MCP_PUBLIC_BASE_URL: 'http://databench.internal/api',
      DATABENCH_MCP_ORIGINS: 'https://agent.example, https://agent.example',
    })
    expect(config).toEqual({
      enabled: true,
      authMode: 'none',
      publicBaseUrl: 'http://databench.internal/api',
      allowedOrigins: ['https://agent.example'],
      maxJsonBytes: DEFAULT_MCP_MAX_JSON_BYTES,
      maxPreviewResponseBytes: DEFAULT_MCP_MAX_PREVIEW_RESPONSE_BYTES,
      maxTokens: DEFAULT_MCP_MAX_TOKENS,
      maxActiveFileOperations: DEFAULT_MCP_MAX_ACTIVE_FILE_OPERATIONS,
      tokenTtlMs: DEFAULT_MCP_TOKEN_TTL_MS,
      fileIdleTimeoutMs: DEFAULT_MCP_FILE_IDLE_TIMEOUT_MS,
      fileTotalTimeoutMs: DEFAULT_MCP_FILE_TOTAL_TIMEOUT_MS,
    })
    expect(Object.isFrozen(config)).toBe(true)
    if (!config.enabled) throw new Error('expected enabled MCP config')
    expect(Object.isFrozen(config.allowedOrigins)).toBe(true)
  })

  test('validates exact origins and timeout ordering', () => {
    const base = {
      DATABENCH_MCP_ENABLED: 'true',
      DATABENCH_MCP_AUTH_MODE: 'none',
      DATABENCH_MCP_PUBLIC_BASE_URL: 'http://databench.internal/api',
    }
    expect(() =>
      mcpConfigFromEnv({ ...base, DATABENCH_MCP_ORIGINS: 'https://agent.example/path' }),
    ).toThrowError('must be exact HTTP(S) origins')
    expect(() =>
      mcpConfigFromEnv({
        ...base,
        DATABENCH_MCP_FILE_IDLE_TIMEOUT_MS: '2000',
        DATABENCH_MCP_FILE_TOTAL_TIMEOUT_MS: '1000',
      }),
    ).toThrowError('total file timeout must be greater than or equal to the idle timeout')
  })
})
