import {
  BadInputError,
  DatasetResponseSchema,
  EXTRACTOR_PRESETS,
  type Extractor,
  ExtractorSchema,
  PaginationQuerySchema,
  parseVocabularyInput,
  resolveExtractor,
  ValidateResponseSchema,
  VocabulariesPageSchema,
  VocabularyRequestSchema,
  VocabularyResponseSchema,
} from '@databench/schema'
import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import { z } from 'zod'
import type { ApiEnv } from '../context.js'
import { getWorkspace } from '../context.js'
import { DEFAULT_ERROR_RESPONSES, jsonResponse } from '../openapi.js'

const DeriveVocabularyQuerySchema = z.object({
  dataset: z.string(),
  dimension: z.string(),
})

const ApplyVocabularyQuerySchema = z.object({
  dataset: z.string(),
  ref: z.string().nullable().optional(),
})

const listVocabulariesRoute = createRoute({
  method: 'get',
  path: '/v1/vocabularies',
  request: {
    query: PaginationQuerySchema,
  },
  responses: {
    200: jsonResponse(VocabulariesPageSchema, 'Paginated vocabularies'),
    ...DEFAULT_ERROR_RESPONSES,
  },
})

const getVocabularyRoute = createRoute({
  method: 'get',
  path: '/v1/vocabularies/{name}',
  responses: {
    200: jsonResponse(VocabularyResponseSchema, 'Vocabulary'),
    ...DEFAULT_ERROR_RESPONSES,
  },
})

const putVocabularyRoute = createRoute({
  method: 'put',
  path: '/v1/vocabularies/{name}',
  request: {
    body: {
      content: {
        'application/json': {
          schema: VocabularyRequestSchema,
        },
      },
    },
  },
  responses: {
    200: jsonResponse(VocabularyResponseSchema, 'Vocabulary'),
    ...DEFAULT_ERROR_RESPONSES,
  },
})

const deriveVocabularyRoute = createRoute({
  method: 'post',
  path: '/v1/vocabularies/{name}:derive',
  request: {
    query: DeriveVocabularyQuerySchema,
  },
  responses: {
    200: jsonResponse(VocabularyResponseSchema, 'Derived vocabulary'),
    ...DEFAULT_ERROR_RESPONSES,
  },
})

const normalizeVocabularyRoute = createRoute({
  method: 'post',
  path: '/v1/vocabularies/{name}:normalize',
  request: {
    query: ApplyVocabularyQuerySchema,
  },
  responses: {
    200: jsonResponse(DatasetResponseSchema, 'Normalized dataset manifest'),
    ...DEFAULT_ERROR_RESPONSES,
  },
})

const validateVocabularyRoute = createRoute({
  method: 'post',
  path: '/v1/vocabularies/{name}:validate',
  request: {
    query: ApplyVocabularyQuerySchema,
  },
  responses: {
    200: jsonResponse(ValidateResponseSchema, 'Validation result and annotated dataset'),
    ...DEFAULT_ERROR_RESPONSES,
  },
})

export function registerVocabularyRoutes(app: OpenAPIHono<ApiEnv>): void {
  app.openapi(listVocabulariesRoute, async (context) => {
    const { limit, offset } = context.req.valid('query')
    const all = await getWorkspace(context).listVocabularies()

    return context.json(
      {
        total: all.length,
        limit,
        offset,
        items: all.slice(offset, offset + limit),
      },
      200,
    )
  })

  app.openapi(getVocabularyRoute, async (context) => {
    const vocabulary = await getWorkspace(context).getVocabulary(
      requiredName(context.req.param('name')),
    )

    return context.json(vocabulary, 200)
  })

  app.openapi(putVocabularyRoute, async (context) => {
    const name = requiredName(context.req.param('name'))
    const input = parseVocabularyInput(await context.req.json())
    const vocabulary = await getWorkspace(context).saveVocabulary({
      ...input,
      name,
    })

    return context.json(vocabulary, 200)
  })

  app.openAPIRegistry.registerPath(deriveVocabularyRoute)
  app.openAPIRegistry.registerPath(normalizeVocabularyRoute)
  app.openAPIRegistry.registerPath(validateVocabularyRoute)

  app.post('/v1/vocabularies/*', async (context) => {
    const action = actionParts(context.req.url)

    if (action.action === 'derive') {
      const query = DeriveVocabularyQuerySchema.parse(context.req.query())
      const override = await readOptionalExtractor(context.req.raw)
      const extractor = override ?? EXTRACTOR_PRESETS[query.dimension]

      if (!extractor) {
        throw new BadInputError(
          `no extractor preset for dimension ${JSON.stringify(query.dimension)}; supply an extractor in the request body`,
        )
      }

      const vocabulary = await getWorkspace(context).deriveVocabulary(query.dataset, {
        name: action.name,
        dimension: query.dimension,
        extractor,
      })

      return context.json(vocabulary, 200)
    }

    if (action.action === 'normalize') {
      const query = ApplyVocabularyQuerySchema.parse(context.req.query())
      const vocabulary = await getWorkspace(context).getVocabulary(action.name)
      const extractor = resolveExtractor(vocabulary, await readOptionalExtractor(context.req.raw))
      const dataset = await getWorkspace(context).normalizeVocabulary(query.dataset, vocabulary, {
        extractor,
        ref: query.ref ?? null,
      })

      return context.json(dataset.manifest, 200)
    }

    const query = ApplyVocabularyQuerySchema.parse(context.req.query())
    const vocabulary = await getWorkspace(context).getVocabulary(action.name)
    const extractor = resolveExtractor(vocabulary, await readOptionalExtractor(context.req.raw))
    const result = await getWorkspace(context).validateVocabulary(query.dataset, vocabulary, {
      extractor,
      ref: query.ref ?? null,
    })

    return context.json(
      {
        summary: result.summary,
        dataset: result.dataset.manifest,
      },
      200,
    )
  })
}

function requiredName(value: string | undefined): string {
  if (!value) {
    throw new BadInputError('vocabulary name is required')
  }

  return value
}

function actionParts(url: string): {
  readonly action: 'derive' | 'normalize' | 'validate'
  readonly name: string
} {
  const pathname = new URL(url).pathname
  const match = /^\/v1\/vocabularies\/(.+):(derive|normalize|validate)$/.exec(pathname)
  const value = match?.[1]
  const action = match?.[2]

  if (!value || !action) {
    throw new BadInputError('unknown vocabulary action')
  }

  return {
    action: action as 'derive' | 'normalize' | 'validate',
    name: decodeURIComponent(value),
  }
}

async function readOptionalExtractor(request: Request): Promise<Extractor | null> {
  const text = await request.text()

  if (text.trim() === '') {
    return null
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch {
    throw new BadInputError('invalid JSON body')
  }

  return parsed === null ? null : ExtractorSchema.parse(parsed)
}
