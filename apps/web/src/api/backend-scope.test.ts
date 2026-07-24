import { QueryClient } from '@tanstack/react-query'
import { describe, expect, test } from 'vitest'
import { clearPrivateConnectionQueries, createConnectionScope } from './backend.js'

describe('private connection query lifecycle', () => {
  test('aborts and removes the old base and scope before a new identity can reuse them', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const base = 'https://api.example.test'
    const scope = createConnectionScope()
    let requestSignal: AbortSignal | undefined

    const pending = client
      .fetchQuery({
        queryFn: ({ signal }) => {
          requestSignal = signal
          return new Promise<string>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
          })
        },
        queryKey: [scope, base, 'v2', 'dataset', 'version-a'],
      })
      .catch(() => undefined)

    client.setQueryData([base, 'refs'], { private: 'old-token' })
    client.setQueryData(['unrelated', 'public'], 'keep')
    await Promise.resolve()
    clearPrivateConnectionQueries(client, base, scope)

    expect(requestSignal?.aborted).toBe(true)
    expect(client.getQueryData([scope, base, 'v2', 'dataset', 'version-a'])).toBeUndefined()
    expect(client.getQueryData([base, 'refs'])).toBeUndefined()
    expect(client.getQueryData(['unrelated', 'public'])).toBe('keep')
    expect(createConnectionScope()).not.toBe(scope)
    await pending
  })
})
