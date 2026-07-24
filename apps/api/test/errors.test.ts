import {
  BadInputError,
  CapacityExceededError,
  ConflictError,
  IntegrityError,
  NotFoundError,
  ResourceLimitError,
  ServiceUnavailableError,
  UnsupportedProfileError,
  ValidationError,
} from '@databench/schema'
import { createRoute } from '@hono/zod-openapi'
import { HTTPException } from 'hono/http-exception'
import { describe, expect, test } from 'vitest'
import { z } from 'zod'
import { jsonResponse } from '../src/openapi.js'
import { createTestApp } from './test-app.js'

const validationRoute = createRoute({
  method: 'get',
  path: '/_test-validation',
  request: {
    query: z.object({
      limit: z.coerce.number().int().max(500),
    }),
  },
  responses: {
    200: jsonResponse(z.object({ ok: z.literal(true) }), 'Validation test response'),
  },
})

describe('api error envelope', () => {
  test('unversioned domain routes return a not_found envelope', async () => {
    const response = await createTestApp().fetch(request('/datasets', { method: 'POST' }))

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({
      error: {
        code: 'not_found',
        message: 'Not Found',
      },
    })
  })

  test('request validation returns 422 validation_error envelope', async () => {
    const app = createTestApp()
    app.openapi(validationRoute, (context) => context.json({ ok: true }, 200))

    const response = await app.fetch(request('/_test-validation?limit=5000'))
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
    const app = createTestApp()
    installThrowRoutes(app)

    await expectError(app, '/_test-error/not-found', 404, 'not_found', 'missing dataset')
    await expectError(app, '/_test-error/conflict', 409, 'conflict', 'ref already exists')
    await expectError(
      app,
      '/_test-error/validation',
      422,
      'validation_error',
      'payload validation failed',
    )
    await expectError(app, '/_test-error/resource', 413, 'resource_limit', 'too large')
    await expectError(
      app,
      '/_test-error/unsupported-profile',
      422,
      'unsupported_profile',
      'unsupported record schema',
    )
    await expectError(app, '/_test-error/capacity', 503, 'capacity_exceeded', 'busy')
    await expectError(app, '/_test-error/integrity', 500, 'integrity_error', 'corrupt')
    await expectError(
      app,
      '/_test-error/service-unavailable',
      503,
      'service_unavailable',
      'object store unavailable',
    )
  })

  test('HTTPException status map is preserved in the envelope', async () => {
    const app = createTestApp()
    installThrowRoutes(app)

    await expectError(
      app,
      '/_test-error/http-not-found',
      404,
      'not_found',
      'unknown transform: nope',
    )
    await expectError(app, '/_test-error/http-method', 405, 'method_not_allowed', 'method blocked')
  })

  test('typed bad input is exposed while untyped errors are sanitized', async () => {
    const app = createTestApp()
    installThrowRoutes(app)

    await expectError(app, '/_test-error/bad-input', 400, 'bad_request', 'invalid JSON')
    await expectError(app, '/_test-error/type', 500, 'internal_error', 'internal server error')
    await expectError(app, '/_test-error/error', 500, 'internal_error', 'internal server error')
  })

  test('unclassified throws fall back to internal_error envelope', async () => {
    const app = createTestApp()
    installThrowRoutes(app)

    await expectError(app, '/_test-error/unknown', 500, 'internal_error', 'internal server error')
  })
})

function installThrowRoutes(app: ReturnType<typeof createApp>): void {
  app.get('/_test-error/:kind', (context) => {
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
    if (kind === 'resource') {
      throw new ResourceLimitError('too large')
    }
    if (kind === 'unsupported-profile') {
      throw new UnsupportedProfileError('unsupported record schema')
    }
    if (kind === 'capacity') {
      throw new CapacityExceededError('busy')
    }
    if (kind === 'integrity') {
      throw new IntegrityError('corrupt')
    }
    if (kind === 'service-unavailable') {
      throw new ServiceUnavailableError('object store unavailable')
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
      throw new TypeError('invalid runtime input')
    }
    if (kind === 'error') {
      throw new Error('invalid runtime state')
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
