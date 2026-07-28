import {
  CloseSwiftStudioSessionRequestV2Schema,
  CreateSwiftStudioSessionRequestV2Schema,
  NotFoundError,
  SwiftStudioSessionPageRequestV2Schema,
  SwiftStudioSessionPageV2Schema,
  SwiftStudioSessionParamsV2Schema,
  SwiftStudioSessionV2Schema,
} from '@databench/schema'
import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import type { ApiEnv } from '../../context.js'
import { getV2Workspace } from '../../context.js'
import {
  jsonResponseV2,
  V2_SWIFT_STUDIO_SESSION_ACTION_ERROR_RESPONSES,
  V2_SWIFT_STUDIO_SESSION_CREATE_ERROR_RESPONSES,
  V2_SWIFT_STUDIO_SESSION_LIST_ERROR_RESPONSES,
  V2_SWIFT_STUDIO_SESSION_SHOW_ERROR_RESPONSES,
} from './openapi.js'
import { assertJsonContentTypeV2, readRawJsonRequestV2 } from './transport.js'

const CREATE_SESSION_MAX_BYTES = 128 * 1024
const CLOSE_SESSION_MAX_BYTES = 1024

const createSessionRoute = createRoute({
  method: 'post',
  path: '/v2/swift-studio-sessions',
  operationId: 'createSwiftStudioSessionV2',
  tags: ['v2 Swift Studio Sessions'],
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: CreateSwiftStudioSessionRequestV2Schema } },
    },
  },
  responses: {
    201: jsonResponseV2(SwiftStudioSessionV2Schema, 'Created or replayed Swift Studio Session'),
    ...V2_SWIFT_STUDIO_SESSION_CREATE_ERROR_RESPONSES,
  },
})

const listSessionsRoute = createRoute({
  method: 'get',
  path: '/v2/swift-studio-sessions',
  operationId: 'listSwiftStudioSessionsV2',
  tags: ['v2 Swift Studio Sessions'],
  request: { query: SwiftStudioSessionPageRequestV2Schema },
  responses: {
    200: jsonResponseV2(SwiftStudioSessionPageV2Schema, 'Recent Swift Studio Sessions'),
    ...V2_SWIFT_STUDIO_SESSION_LIST_ERROR_RESPONSES,
  },
})

const getSessionRoute = createRoute({
  method: 'get',
  path: '/v2/swift-studio-sessions/{session_id}',
  operationId: 'getSwiftStudioSessionV2',
  tags: ['v2 Swift Studio Sessions'],
  request: { params: SwiftStudioSessionParamsV2Schema },
  responses: {
    200: jsonResponseV2(SwiftStudioSessionV2Schema, 'Swift Studio Session'),
    ...V2_SWIFT_STUDIO_SESSION_SHOW_ERROR_RESPONSES,
  },
})

const closeSessionRoute = createRoute({
  method: 'post',
  path: '/v2/swift-studio-sessions/{session_id}:close',
  operationId: 'closeSwiftStudioSessionV2',
  tags: ['v2 Swift Studio Sessions'],
  request: {
    params: SwiftStudioSessionParamsV2Schema,
    body: {
      required: true,
      content: { 'application/json': { schema: CloseSwiftStudioSessionRequestV2Schema } },
    },
  },
  responses: {
    200: jsonResponseV2(SwiftStudioSessionV2Schema, 'Closed or replayed Swift Studio Session'),
    ...V2_SWIFT_STUDIO_SESSION_ACTION_ERROR_RESPONSES,
  },
})

export function registerV2SwiftStudioSessionRoutes(app: OpenAPIHono<ApiEnv>): void {
  for (const route of [createSessionRoute, listSessionsRoute, getSessionRoute, closeSessionRoute]) {
    app.openAPIRegistry.registerPath(route)
  }

  app.post(createSessionRoute.getRoutingPath(), async (context) => {
    assertJsonContentTypeV2(context.req.raw)
    const request = await readRawJsonRequestV2(context, CreateSwiftStudioSessionRequestV2Schema, {
      maxBytes: CREATE_SESSION_MAX_BYTES,
      maxDepth: 8,
    })
    const session = await getV2Workspace(context).createSwiftStudioSession(request, {
      signal: context.req.raw.signal,
    })
    return context.json(session, 201)
  })

  app.get(listSessionsRoute.getRoutingPath(), async (context) => {
    const request = SwiftStudioSessionPageRequestV2Schema.parse(context.req.query())
    const page = await getV2Workspace(context).listSwiftStudioSessions(request, {
      signal: context.req.raw.signal,
    })
    return context.json(page, 200)
  })

  app.get(getSessionRoute.getRoutingPath(), async (context) => {
    const { session_id } = SwiftStudioSessionParamsV2Schema.parse(context.req.param())
    const session = await getV2Workspace(context).getSwiftStudioSession(session_id, {
      signal: context.req.raw.signal,
    })
    if (session === null) {
      throw new NotFoundError('Swift Studio Session was not found', { session_id })
    }
    return context.json(session, 200)
  })

  app.post('/v2/swift-studio-sessions/:target{[^/]+:close}', async (context) => {
    const sessionId = actionTarget(context.req.param('target'), ':close')
    SwiftStudioSessionParamsV2Schema.parse({ session_id: sessionId })
    assertJsonContentTypeV2(context.req.raw)
    await readRawJsonRequestV2(context, CloseSwiftStudioSessionRequestV2Schema, {
      maxBytes: CLOSE_SESSION_MAX_BYTES,
      maxDepth: 2,
    })
    const session = await getV2Workspace(context).closeSwiftStudioSession(sessionId, {
      signal: context.req.raw.signal,
    })
    return context.json(session, 200)
  })
}

function actionTarget(value: string | undefined, suffix: `:${string}`): string {
  if (value === undefined || !value.endsWith(suffix)) return ''
  return value.slice(0, -suffix.length)
}
