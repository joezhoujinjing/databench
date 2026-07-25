import {
  BadRequestErrorResponseV2Schema,
  ErrorResponse409V2Schema,
  ErrorResponse422V2Schema,
  ErrorResponse500V2Schema,
  ErrorResponse503V2Schema,
  ForbiddenErrorResponseV2Schema,
  IngestConflictErrorResponseV2Schema,
  InternalErrorResponseV2Schema,
  NotFoundErrorResponseV2Schema,
  RefConflictErrorResponseV2Schema,
  RefStateConflictErrorResponseV2Schema,
  ResourceLimitErrorResponseV2Schema,
  ServiceUnavailableErrorResponseV2Schema,
  TooManyRequestsErrorResponseV2Schema,
  UnauthorizedErrorResponseV2Schema,
  V2BinaryResponseHeadersSchema,
  V2PrivateResponseHeadersSchema,
  ValidationErrorResponseV2Schema,
  ValidationOrUnsupportedProfileErrorResponseV2Schema,
} from '@databench/schema'
import type { z } from 'zod'

const commonAuthRateResponses = {
  401: jsonResponseV2(UnauthorizedErrorResponseV2Schema, 'Authentication is required'),
  403: jsonResponseV2(ForbiddenErrorResponseV2Schema, 'Workspace access is forbidden'),
  429: jsonResponseV2(TooManyRequestsErrorResponseV2Schema, 'Request rate limit exceeded'),
} as const

const internalResponse = {
  500: jsonResponseV2(InternalErrorResponseV2Schema, 'Unexpected internal failure'),
} as const

const dataFailureResponses = {
  500: jsonResponseV2(ErrorResponse500V2Schema, 'V2 integrity or internal failure'),
  503: jsonResponseV2(ErrorResponse503V2Schema, 'V2 capacity or dependency is unavailable'),
} as const

const dependencyFailureResponse = {
  503: jsonResponseV2(
    ServiceUnavailableErrorResponseV2Schema,
    'A required dependency is unavailable',
  ),
} as const

export const V2_INGEST_ERROR_RESPONSES = {
  400: jsonResponseV2(BadRequestErrorResponseV2Schema, 'Malformed multipart request'),
  ...commonAuthRateResponses,
  409: jsonResponseV2(IngestConflictErrorResponseV2Schema, 'Identity, layout, or Ref conflict'),
  413: jsonResponseV2(ResourceLimitErrorResponseV2Schema, 'V2 request resource limit exceeded'),
  422: jsonResponseV2(
    ValidationOrUnsupportedProfileErrorResponseV2Schema,
    'Invalid canonical record or unsupported profile',
  ),
  ...dataFailureResponses,
} as const

export const V2_DATASET_DESCRIBE_ERROR_RESPONSES = {
  ...commonAuthRateResponses,
  404: jsonResponseV2(NotFoundErrorResponseV2Schema, 'V2 dataset or record was not found'),
  422: jsonResponseV2(
    ValidationOrUnsupportedProfileErrorResponseV2Schema,
    'Invalid identifier, page request, or stored profile',
  ),
  ...dataFailureResponses,
} as const

export const V2_DATASET_READ_ERROR_RESPONSES = {
  ...V2_DATASET_DESCRIBE_ERROR_RESPONSES,
  413: jsonResponseV2(ResourceLimitErrorResponseV2Schema, 'V2 dataset resource limit exceeded'),
} as const

export const V2_AUDIT_ERROR_RESPONSES = V2_DATASET_READ_ERROR_RESPONSES

export const V2_INSPECT_EXPORT_ERROR_RESPONSES = {
  400: jsonResponseV2(BadRequestErrorResponseV2Schema, 'Malformed export inspection request'),
  ...commonAuthRateResponses,
  404: jsonResponseV2(NotFoundErrorResponseV2Schema, 'V2 dataset was not found'),
  413: jsonResponseV2(ResourceLimitErrorResponseV2Schema, 'V2 request resource limit exceeded'),
  422: jsonResponseV2(
    ValidationOrUnsupportedProfileErrorResponseV2Schema,
    'Invalid export request or unsupported profile',
  ),
  ...dataFailureResponses,
} as const

export const V2_EXPORT_ERROR_RESPONSES = {
  400: jsonResponseV2(BadRequestErrorResponseV2Schema, 'Malformed export request'),
  ...commonAuthRateResponses,
  404: jsonResponseV2(NotFoundErrorResponseV2Schema, 'Exact V2 dataset was not found'),
  413: jsonResponseV2(ResourceLimitErrorResponseV2Schema, 'V2 request resource limit exceeded'),
  422: jsonResponseV2(
    ErrorResponse422V2Schema,
    'Invalid request, unsupported profile, or fidelity approval mismatch',
  ),
  ...dataFailureResponses,
} as const

export const V2_REGISTRY_LIST_ERROR_RESPONSES = {
  ...commonAuthRateResponses,
  ...internalResponse,
} as const

export const V2_REGISTRY_SHOW_ERROR_RESPONSES = {
  ...commonAuthRateResponses,
  404: jsonResponseV2(NotFoundErrorResponseV2Schema, 'Registry entry was not found'),
  422: jsonResponseV2(ValidationErrorResponseV2Schema, 'Invalid registry name'),
  ...internalResponse,
} as const

export const V2_TRANSFORM_RUN_ERROR_RESPONSES = {
  400: jsonResponseV2(BadRequestErrorResponseV2Schema, 'Malformed transform request'),
  ...commonAuthRateResponses,
  404: jsonResponseV2(NotFoundErrorResponseV2Schema, 'Transform or input dataset was not found'),
  409: jsonResponseV2(ErrorResponse409V2Schema, 'Determinism, identity, layout, or Ref conflict'),
  413: jsonResponseV2(ResourceLimitErrorResponseV2Schema, 'V2 request resource limit exceeded'),
  422: jsonResponseV2(
    ValidationOrUnsupportedProfileErrorResponseV2Schema,
    'Invalid transform request or unsupported profile',
  ),
  ...dataFailureResponses,
} as const

export const V2_TRANSFORM_JOB_CREATE_ERROR_RESPONSES = V2_TRANSFORM_RUN_ERROR_RESPONSES

export const V2_TRANSFORM_JOB_LIST_ERROR_RESPONSES = {
  ...commonAuthRateResponses,
  422: jsonResponseV2(ValidationErrorResponseV2Schema, 'Invalid transform job page request'),
  ...internalResponse,
  ...dependencyFailureResponse,
} as const

export const V2_TRANSFORM_JOB_SHOW_ERROR_RESPONSES = {
  ...commonAuthRateResponses,
  404: jsonResponseV2(NotFoundErrorResponseV2Schema, 'Transform job was not found'),
  422: jsonResponseV2(ValidationErrorResponseV2Schema, 'Invalid transform job identifier'),
  ...internalResponse,
  ...dependencyFailureResponse,
} as const

export const V2_TRANSFORM_JOB_ACTION_ERROR_RESPONSES = {
  ...V2_TRANSFORM_JOB_SHOW_ERROR_RESPONSES,
  409: jsonResponseV2(ErrorResponse409V2Schema, 'Transform job state conflict'),
} as const

export const V2_REF_LIST_ERROR_RESPONSES = {
  ...commonAuthRateResponses,
  422: jsonResponseV2(ValidationErrorResponseV2Schema, 'Invalid Ref page request'),
  ...internalResponse,
  ...dependencyFailureResponse,
} as const

export const V2_REF_SHOW_ERROR_RESPONSES = {
  ...commonAuthRateResponses,
  404: jsonResponseV2(NotFoundErrorResponseV2Schema, 'V2 Ref was not found'),
  422: jsonResponseV2(ValidationErrorResponseV2Schema, 'Invalid Ref name'),
  ...internalResponse,
  ...dependencyFailureResponse,
} as const

export const V2_REF_PUT_ERROR_RESPONSES = {
  400: jsonResponseV2(BadRequestErrorResponseV2Schema, 'Malformed Ref update request'),
  ...commonAuthRateResponses,
  404: jsonResponseV2(NotFoundErrorResponseV2Schema, 'Target V2 dataset was not found'),
  409: jsonResponseV2(RefConflictErrorResponseV2Schema, 'Ref compare-and-set conflict'),
  413: jsonResponseV2(ResourceLimitErrorResponseV2Schema, 'V2 request resource limit exceeded'),
  422: jsonResponseV2(ValidationErrorResponseV2Schema, 'Invalid Ref update request'),
  ...internalResponse,
  ...dependencyFailureResponse,
} as const

export const V2_REF_DELETE_ERROR_RESPONSES = {
  400: jsonResponseV2(BadRequestErrorResponseV2Schema, 'Malformed Ref delete request'),
  ...commonAuthRateResponses,
  404: jsonResponseV2(NotFoundErrorResponseV2Schema, 'V2 Ref was not found'),
  409: jsonResponseV2(RefStateConflictErrorResponseV2Schema, 'Ref state compare-and-set conflict'),
  413: jsonResponseV2(ResourceLimitErrorResponseV2Schema, 'V2 request resource limit exceeded'),
  422: jsonResponseV2(ValidationErrorResponseV2Schema, 'Invalid Ref delete request'),
  ...internalResponse,
  ...dependencyFailureResponse,
} as const

export const V2_REF_RESTORE_ERROR_RESPONSES = V2_REF_DELETE_ERROR_RESPONSES

export const V2_LINEAGE_ERROR_RESPONSES = {
  ...commonAuthRateResponses,
  404: jsonResponseV2(NotFoundErrorResponseV2Schema, 'Lineage root dataset was not found'),
  422: jsonResponseV2(
    ValidationOrUnsupportedProfileErrorResponseV2Schema,
    'Invalid lineage request or unsupported stored profile',
  ),
  ...dataFailureResponses,
} as const

export function jsonResponseV2(schema: z.ZodType, description: string) {
  return {
    description,
    headers: V2PrivateResponseHeadersSchema,
    content: {
      'application/json': {
        schema,
      },
    },
  }
}

export function binaryResponseV2(schema: z.ZodType, description: string) {
  return {
    description,
    headers: V2BinaryResponseHeadersSchema,
    content: {
      'application/x-ndjson': {
        schema,
      },
    },
  }
}
