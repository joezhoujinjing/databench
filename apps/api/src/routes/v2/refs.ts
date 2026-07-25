import {
  CursorPageRequestV2Schema,
  DatasetLineageV2Schema,
  DatasetRefOrVersionParamsV2Schema,
  DeletedRefPageV2Schema,
  DeleteRefRequestV2Schema,
  DeleteRefResultV2Schema,
  LineagePageRequestV2Schema,
  NotFoundError,
  PutRefRequestV2Schema,
  RefMetadataV2Schema,
  RefPageV2Schema,
  RefParamsV2Schema,
  RestoreRefRequestV2Schema,
  RestoreRefResultV2Schema,
} from '@databench/schema'
import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import type { ApiEnv } from '../../context.js'
import { getV2Workspace } from '../../context.js'
import {
  jsonResponseV2,
  V2_LINEAGE_ERROR_RESPONSES,
  V2_REF_DELETE_ERROR_RESPONSES,
  V2_REF_LIST_ERROR_RESPONSES,
  V2_REF_PUT_ERROR_RESPONSES,
  V2_REF_RESTORE_ERROR_RESPONSES,
  V2_REF_SHOW_ERROR_RESPONSES,
} from './openapi.js'
import { assertJsonContentTypeV2, readRawJsonRequestV2 } from './transport.js'

const listRefsRoute = createRoute({
  method: 'get',
  path: '/v2/refs',
  operationId: 'listRefsV2',
  tags: ['v2 refs'],
  request: { query: CursorPageRequestV2Schema },
  responses: {
    200: jsonResponseV2(RefPageV2Schema, 'Cursor-paginated V2 refs'),
    ...V2_REF_LIST_ERROR_RESPONSES,
  },
})

const listDeletedRefsRoute = createRoute({
  method: 'get',
  path: '/v2/deleted-refs',
  operationId: 'listDeletedRefsV2',
  tags: ['v2 refs'],
  request: { query: CursorPageRequestV2Schema },
  responses: {
    200: jsonResponseV2(DeletedRefPageV2Schema, 'Cursor-paginated deleted V2 refs'),
    ...V2_REF_LIST_ERROR_RESPONSES,
  },
})

const getRefRoute = createRoute({
  method: 'get',
  path: '/v2/refs/{name}',
  operationId: 'getRefV2',
  tags: ['v2 refs'],
  request: { params: RefParamsV2Schema },
  responses: {
    200: jsonResponseV2(RefMetadataV2Schema, 'V2 ref metadata'),
    ...V2_REF_SHOW_ERROR_RESPONSES,
  },
})

const putRefRoute = createRoute({
  method: 'put',
  path: '/v2/refs/{name}',
  operationId: 'putRefV2',
  tags: ['v2 refs'],
  request: {
    params: RefParamsV2Schema,
    body: {
      required: true,
      content: {
        'application/json': {
          schema: PutRefRequestV2Schema,
        },
      },
    },
  },
  responses: {
    200: jsonResponseV2(RefMetadataV2Schema, 'Updated V2 ref metadata'),
    ...V2_REF_PUT_ERROR_RESPONSES,
  },
})

const deleteRefRoute = createRoute({
  method: 'delete',
  path: '/v2/refs/{name}',
  operationId: 'deleteRefV2',
  tags: ['v2 refs'],
  request: {
    params: RefParamsV2Schema,
    body: {
      required: true,
      content: {
        'application/json': {
          schema: DeleteRefRequestV2Schema,
        },
      },
    },
  },
  responses: {
    200: jsonResponseV2(DeleteRefResultV2Schema, 'Deleted or already-deleted V2 ref'),
    ...V2_REF_DELETE_ERROR_RESPONSES,
  },
})

const restoreRefRoute = createRoute({
  method: 'post',
  path: '/v2/refs/{name}:restore',
  operationId: 'restoreRefV2',
  tags: ['v2 refs'],
  request: {
    params: RefParamsV2Schema,
    body: {
      required: true,
      content: {
        'application/json': {
          schema: RestoreRefRequestV2Schema,
        },
      },
    },
  },
  responses: {
    200: jsonResponseV2(RestoreRefResultV2Schema, 'Restored or already-active V2 ref'),
    ...V2_REF_RESTORE_ERROR_RESPONSES,
  },
})

const lineageRoute = createRoute({
  method: 'get',
  path: '/v2/lineage/{ref_or_version}',
  operationId: 'getLineageV2',
  tags: ['v2 lineage'],
  request: {
    params: DatasetRefOrVersionParamsV2Schema,
    query: LineagePageRequestV2Schema,
  },
  responses: {
    200: jsonResponseV2(DatasetLineageV2Schema, 'Bounded exact V2 dataset lineage page'),
    ...V2_LINEAGE_ERROR_RESPONSES,
  },
})

export function registerV2RefRoutes(app: OpenAPIHono<ApiEnv>): void {
  for (const route of [
    listRefsRoute,
    listDeletedRefsRoute,
    getRefRoute,
    putRefRoute,
    deleteRefRoute,
    restoreRefRoute,
    lineageRoute,
  ]) {
    app.openAPIRegistry.registerPath(route)
  }

  app.get(listRefsRoute.getRoutingPath(), async (context) => {
    const request = CursorPageRequestV2Schema.parse(context.req.query())
    const page = await getV2Workspace(context).listRefs(request, {
      signal: context.req.raw.signal,
    })
    return context.json(page, 200)
  })

  app.get(listDeletedRefsRoute.getRoutingPath(), async (context) => {
    const request = CursorPageRequestV2Schema.parse(context.req.query())
    const page = await getV2Workspace(context).listDeletedRefs(request, {
      signal: context.req.raw.signal,
    })
    return context.json(page, 200)
  })

  app.get(getRefRoute.getRoutingPath(), async (context) => {
    const { name } = RefParamsV2Schema.parse(context.req.param())
    const ref = await getV2Workspace(context).getRef(name, {
      signal: context.req.raw.signal,
    })
    if (ref === null) {
      throw new NotFoundError(`V2 ref was not found: ${name}`, { ref_name: name })
    }
    return context.json(ref, 200)
  })

  app.put(putRefRoute.getRoutingPath(), async (context) => {
    assertJsonContentTypeV2(context.req.raw)
    const { name } = RefParamsV2Schema.parse(context.req.param())
    const workspace = getV2Workspace(context)
    const limits = workspace.postTrainingV2Capability().limits
    const request = await readRawJsonRequestV2(context, PutRefRequestV2Schema, {
      maxBytes: limits.max_record_bytes,
      maxDepth: limits.max_nesting_depth,
    })
    const ref = await workspace.putRef(name, request, { signal: context.req.raw.signal })
    return context.json(ref, 200)
  })

  app.delete(deleteRefRoute.getRoutingPath(), async (context) => {
    assertJsonContentTypeV2(context.req.raw)
    const { name } = RefParamsV2Schema.parse(context.req.param())
    const workspace = getV2Workspace(context)
    const limits = workspace.postTrainingV2Capability().limits
    const request = await readRawJsonRequestV2(context, DeleteRefRequestV2Schema, {
      maxBytes: limits.max_record_bytes,
      maxDepth: limits.max_nesting_depth,
    })
    const result = await workspace.deleteRef(name, request, {
      signal: context.req.raw.signal,
    })
    return context.json(result, 200)
  })

  app.post('/v2/refs/:target{[^/]+:restore}', async (context) => {
    assertJsonContentTypeV2(context.req.raw)
    const target = context.req.param('target')
    const suffix = ':restore'
    const name = target.endsWith(suffix) ? target.slice(0, -suffix.length) : target
    RefParamsV2Schema.parse({ name })
    const workspace = getV2Workspace(context)
    const limits = workspace.postTrainingV2Capability().limits
    const request = await readRawJsonRequestV2(context, RestoreRefRequestV2Schema, {
      maxBytes: limits.max_record_bytes,
      maxDepth: limits.max_nesting_depth,
    })
    const result = await workspace.restoreRef(name, request, {
      signal: context.req.raw.signal,
    })
    return context.json(result, 200)
  })

  app.get(lineageRoute.getRoutingPath(), async (context) => {
    const { ref_or_version } = DatasetRefOrVersionParamsV2Schema.parse(context.req.param())
    const request = LineagePageRequestV2Schema.parse(context.req.query())
    const lineage = await getV2Workspace(context).lineage(ref_or_version, request, {
      signal: context.req.raw.signal,
    })
    return context.json(lineage, 200)
  })
}
