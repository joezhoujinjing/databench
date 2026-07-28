import { describe, expect, test } from 'vitest'
import { resolvePerformanceProvider } from './provider.js'

describe('performance provider resolution', () => {
  test('prefers metadata, then known host, then Custom while keeping protocol independent', () => {
    expect(
      resolvePerformanceProvider({
        basic_info: { 'API URL': 'https://api.openai.com/v1', Protocol: 'Responses' },
        provider: 'Operator alias',
      }),
    ).toEqual({ protocol: 'Responses', provider: 'Operator alias', source: 'metadata' })
    expect(resolvePerformanceProvider({ api_host: 'cn.dashscope.aliyuncs.com' }).provider).toBe(
      'DashScope',
    )
    expect(resolvePerformanceProvider({ api_host: 'model.internal' })).toMatchObject({
      protocol: 'OpenAI-compatible',
      provider: 'Custom',
    })
  })
})
