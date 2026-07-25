import { PostTrainingRecordV2Schema, TransformJobV2Schema } from '@databench/schema'
import { createRoute, OpenAPIHono } from '@hono/zod-openapi'
import { describe, expect, test } from 'vitest'

describe('v2 schema OpenAPI compatibility', () => {
  test('generates the canonical record component from the runtime Zod source', () => {
    const app = new OpenAPIHono()
    const route = createRoute({
      method: 'get',
      path: '/record',
      responses: {
        200: {
          description: 'Canonical record',
          content: { 'application/json': { schema: PostTrainingRecordV2Schema } },
        },
      },
    })
    app.openapi(route, (context) => context.json({} as never, 200))

    const document = app.getOpenAPIDocument({
      openapi: '3.0.3',
      info: { title: 'v2 schema contract', version: '2.0.0' },
    })

    expect(document.components?.schemas?.PostTrainingRecordV2).toBeDefined()
    expect(document.paths['/record']?.get?.responses[200]).toBeDefined()
  })

  test('generates the transform job DTO component from the runtime Zod source', () => {
    const app = new OpenAPIHono()
    const route = createRoute({
      method: 'get',
      path: '/transform-job',
      responses: {
        200: {
          description: 'Transform job',
          content: { 'application/json': { schema: TransformJobV2Schema } },
        },
      },
    })
    app.openapi(route, (context) => context.json({} as never, 200))

    const document = app.getOpenAPIDocument({
      openapi: '3.0.3',
      info: { title: 'v2 transform job contract', version: '2.0.0' },
    })
    expect(document.components?.schemas?.TransformJobV2).toBeDefined()
  })
})
