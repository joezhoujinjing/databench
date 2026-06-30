import { describe, expect, test } from 'vitest'
import { renderOpenApi } from '../src/index.js'

describe('openapi export', () => {
  test('renders deterministic sorted JSON with the published API surface', () => {
    const first = renderOpenApi()
    const second = renderOpenApi()

    expect(first).toBe(second)
    expect(first.endsWith('\n')).toBe(true)

    const document = JSON.parse(first) as OpenApiDocument
    expect(Object.keys(document)).toEqual(['components', 'info', 'openapi', 'paths'])
    expect(document.paths['/v1/datasets']).toBeDefined()
    expect(document.paths['/v1/datasets/{ref}/export']?.get.responses[200].content).toHaveProperty(
      'application/x-ndjson',
    )
    expect(document.components.schemas.ErrorResponse).toBeDefined()
  })
})

interface OpenApiDocument {
  readonly components: {
    readonly schemas: Record<string, unknown>
  }
  readonly paths: Record<
    string,
    {
      readonly get: {
        readonly responses: Record<
          number,
          {
            readonly content?: Record<string, unknown>
          }
        >
      }
    }
  >
}
