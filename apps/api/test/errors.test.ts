import {
  BadInputError,
  ConflictError,
  MAX_PAGE_LIMIT,
  NotFoundError,
  ValidationError,
} from '@databench/schema'
import { createRoute } from '@hono/zod-openapi'
import { HTTPException } from 'hono/http-exception'
import { describe, expect, test } from 'vitest'
import { z } from 'zod'
import { createApp } from '../src/app.js'
import { jsonResponse } from '../src/openapi.js'

const validationRoute = createRoute({
  method: 'get',
  path: '/v1/_test-validation',
  request: {
    query: z.object({
      limit: z.coerce.number().int().max(MAX_PAGE_LIMIT),
    }),
  },
  responses: {
    200: jsonResponse(z.object({ ok: z.literal(true) }), 'Validation test response'),
  },
})

describe('api error envelope', () => {
  test('unversioned domain routes return a not_found envelope', async () => {
    const response = await createApp().fetch(request('/datasets', { method: 'POST' }))

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({
      error: {
        code: 'not_found',
        message: 'Not Found',
      },
    })
  })

  test('request validation returns 422 validation_error envelope', async () => {
    const app = createApp()
    app.openapi(validationRoute, (context) => context.json({ ok: true }, 200))

    const response = await app.fetch(request('/v1/_test-validation?limit=5000'))
    const body = (await response.json()) as ErrorResponse

    expect(response.status).toBe(422)
    expect(body.error.code).toBe('validation_error')
    expect(body.error.message).toBe('request validation failed')
    expect(body.error.detail).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ['limit'],
        }),
      ]),
    )
  })

  test('domain and schema validation errors map to their envelopes', async () => {
    const app = createApp()
    installThrowRoutes(app)

    await expectError(app, '/v1/_test-error/not-found', 404, 'not_found', 'missing dataset')
    await expectError(app, '/v1/_test-error/conflict', 409, 'conflict', 'ref already exists')
    await expectError(
      app,
      '/v1/_test-error/validation',
      422,
      'validation_error',
      'payload validation failed',
    )
  })

  test('HTTPException status map is preserved in the envelope', async () => {
    const app = createApp()
    installThrowRoutes(app)

    await expectError(
      app,
      '/v1/_test-error/http-not-found',
      404,
      'not_found',
      'unknown transform: nope',
    )
    await expectError(
      app,
      '/v1/_test-error/http-method',
      405,
      'method_not_allowed',
      'method blocked',
    )
  })

  test('bad input, TypeError, and plain Error map to bad_request', async () => {
    const app = createApp()
    installThrowRoutes(app)

    await expectError(app, '/v1/_test-error/bad-input', 400, 'bad_request', 'invalid JSON')
    await expectError(
      app,
      '/v1/_test-error/type',
      400,
      'bad_request',
      "transform 'dedup' takes no params",
    )
    await expectError(
      app,
      '/v1/_test-error/error',
      400,
      'bad_request',
      'frame is missing required columns',
    )
  })

  test('unclassified throws fall back to internal_error envelope', async () => {
    const app = createApp()
    installThrowRoutes(app)

    await expectError(
      app,
      '/v1/_test-error/unknown',
      500,
      'internal_error',
      'internal server error',
    )
  })
})

function installThrowRoutes(app: ReturnType<typeof createApp>): void {
  app.get('/v1/_test-error/:kind', (context) => {
    const kind = context.req.param('kind')

    if (kind === 'not-found') {
      throw new NotFoundError('missing dataset')
    }
    if (kind === 'conflict') {
      throw new ConflictError('ref already exists')
    }
    if (kind === 'validation') {
      throw new ValidationError('payload validation failed', [{ path: ['samples'] }])
    }
    if (kind === 'http-not-found') {
      throw new HTTPException(404, { message: 'unknown transform: nope' })
    }
    if (kind === 'http-method') {
      throw new HTTPException(405, { message: 'method blocked' })
    }
    if (kind === 'bad-input') {
      throw new BadInputError('invalid JSON')
    }
    if (kind === 'type') {
      throw new TypeError("transform 'dedup' takes no params")
    }
    if (kind === 'error') {
      throw new Error('frame is missing required columns')
    }

    throw new UnexpectedFailure()
  })
}

class UnexpectedFailure extends Error {
  override readonly name = 'UnexpectedFailure'

  constructor() {
    super('unexpected failure')
  }
}

async function expectError(
  app: ReturnType<typeof createApp>,
  path: string,
  status: number,
  code: string,
  message: string,
): Promise<void> {
  const response = await app.fetch(request(path))
  const body = (await response.json()) as ErrorResponse

  expect(response.status).toBe(status)
  expect(body).toMatchObject({
    error: {
      code,
      message,
    },
  })
}

function request(path: string, init?: RequestInit): Request {
  return new Request(`http://localhost${path}`, init)
}

interface ErrorResponse {
  readonly error: {
    readonly code: string
    readonly message: string
    readonly detail?: unknown
  }
}
