import { ErrorResponseSchema } from '@databench/schema'
import type { z } from 'zod'
import type { CreateAppOptions } from './app.js'

export function jsonResponse(schema: z.ZodType, description: string) {
  return {
    description,
    content: {
      'application/json': {
        schema,
      },
    },
  }
}

export const DEFAULT_ERROR_RESPONSES = {
  default: jsonResponse(ErrorResponseSchema, 'Error response'),
} as const

export function openApiConfig(options: CreateAppOptions = {}) {
  return {
    openapi: '3.0.3',
    info: {
      title: 'databench service',
      version: options.version ?? '0.0.0',
      description: 'Post-training dataset control plane API.',
    },
  }
}
