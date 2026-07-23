import { describe, expect, test } from 'vitest'
import { z } from 'zod'
import {
  AuditResultV2Schema,
  BadRequestDetailV2Schema,
  BadRequestErrorResponseV2Schema,
  CapabilitiesSchema,
  CapacityExceededDetailV2Schema,
  CapacityExceededErrorResponseV2Schema,
  ConverterParamsV2Schema,
  ConverterRegistryNameV2Schema,
  ConverterRegistryPageV2Schema,
  CursorPageRequestV2Schema,
  createExportPlanV2,
  createPostTrainingV2Capability,
  DatasetRecordParamsV2Schema,
  DatasetRefOrVersionParamsV2Schema,
  DatasetVersionParamsV2Schema,
  DeterminismConflictDetailV2Schema,
  DeterminismConflictErrorResponseV2Schema,
  ErrorBodyV2Schema,
  ErrorResponse409V2Schema,
  ErrorResponse422V2Schema,
  ErrorResponse500V2Schema,
  ErrorResponse503V2Schema,
  ErrorResponseV2Schema,
  FidelityErrorDetailV2Schema,
  FidelityErrorResponseV2Schema,
  ForbiddenDetailV2Schema,
  ForbiddenErrorResponseV2Schema,
  IdentityConflictDetailV2Schema,
  IdentityConflictErrorResponseV2Schema,
  IngestCanonicalV2FormSchema,
  IngestConflictErrorResponseV2Schema,
  IngestResultV2Schema,
  IntegrityErrorDetailV2Schema,
  IntegrityErrorResponseV2Schema,
  InternalErrorDetailV2Schema,
  InternalErrorResponseV2Schema,
  LayoutConflictDetailV2Schema,
  LayoutConflictErrorResponseV2Schema,
  LineagePageRequestV2Schema,
  NotFoundDetailV2Schema,
  NotFoundErrorResponseV2Schema,
  PostTrainingV2CapabilitySchema,
  RecordPageRequestV2Schema,
  RefConflictDetailV2Schema,
  RefConflictErrorResponseV2Schema,
  RefParamsV2Schema,
  ResourceLimitDetailV2Schema,
  ResourceLimitErrorResponseV2Schema,
  ServiceUnavailableDetailV2Schema,
  ServiceUnavailableErrorResponseV2Schema,
  TooManyRequestsDetailV2Schema,
  TooManyRequestsErrorResponseV2Schema,
  TransformParamsV2Schema,
  TransformRegistryPageV2Schema,
  UnauthorizedDetailV2Schema,
  UnauthorizedErrorResponseV2Schema,
  UnsupportedProfileDetailV2Schema,
  UnsupportedProfileErrorResponseV2Schema,
  ValidationErrorDetailV2Schema,
  ValidationErrorResponseV2Schema,
  ValidationOrUnsupportedProfileErrorResponseV2Schema,
} from '../src/index.js'

const VERSION = 'a'.repeat(64)
const OTHER_VERSION = 'b'.repeat(64)
const RECORD_ID = `rec_${'c'.repeat(64)}`
const CACHE_KEY = 'd'.repeat(64)
const CONVERTERS = ['canonical-jsonl', 'ms-swift', 'trl-dpo', 'trl-grpo-rlvr', 'trl-sft'] as const

const limits = {
  max_record_bytes: 16 * 1024 * 1024,
  max_snapshot_records: 100_000,
  max_canonical_bytes: 512 * 1024 * 1024,
  max_request_bytes: 1024 * 1024 * 1024,
  max_nesting_depth: 128,
  max_json_schema_bytes: 256 * 1024,
  max_json_schema_nodes: 10_000,
  max_lineage_depth: 32,
  max_lineage_nodes: 1_000,
  max_transform_inputs: 16,
  max_transform_working_set_bytes: 1024 * 1024 * 1024,
  max_concurrent_transforms: 4,
} as const

const converterDescriptor = {
  name: 'canonical-jsonl',
  version: '1.0.0',
  options_schema: { type: 'object', additionalProperties: false },
  media_type: 'application/x-ndjson',
  task_views: ['canonical'],
  export_fidelity_profile: 'databench-export-fidelity-1',
} as const

const transformDescriptor = {
  name: 'subset',
  version: '1.0.0',
  identity_mode: 'preserve',
  params_schema: { type: 'object', additionalProperties: false },
} as const

describe('V12 capability and registry wire contracts', () => {
  test('adds an optional strict disabled v2 capability with every accepted profile and limit', () => {
    const capability = createPostTrainingV2Capability({
      enabled: false,
      converters: CONVERTERS,
      limits,
    })
    const response = CapabilitiesSchema.parse({
      api_version: '1',
      min_client: '0.1.0',
      features: {
        transforms: true,
        recipes: true,
        lineage: true,
        jsonl_ingest: true,
        export: true,
        synthesis: false,
        annotation: false,
        vocabularies: true,
      },
      post_training_v2: capability,
    })

    expect(response.post_training_v2).toEqual({
      enabled: false,
      api_versions: ['2'],
      record_schema_versions: ['2.0.0'],
      identity_profiles: ['databench-v2-jcs-1'],
      layout_versions: ['record-json-v1'],
      export_fidelity_profiles: ['databench-export-fidelity-1'],
      converters: CONVERTERS,
      limits,
    })
    const { post_training_v2: _omittedCapability, ...legacyResponse } = response
    expect(CapabilitiesSchema.parse(legacyResponse)).not.toHaveProperty('post_training_v2')
    expect(
      PostTrainingV2CapabilitySchema.safeParse({ ...capability, enabled: undefined }).success,
    ).toBe(false)
    expect(
      PostTrainingV2CapabilitySchema.safeParse({
        ...capability,
        converters: [...capability.converters].reverse(),
      }).success,
    ).toBe(false)
    expect(
      PostTrainingV2CapabilitySchema.safeParse({
        ...capability,
        limits: {
          ...limits,
          max_record_bytes: 0,
          max_snapshot_records: 0,
          max_canonical_bytes: 0,
          max_request_bytes: 0,
          max_nesting_depth: 0,
          max_transform_working_set_bytes: 0,
        },
      }).success,
    ).toBe(true)
    expect(
      PostTrainingV2CapabilitySchema.safeParse({
        ...capability,
        limits: { ...limits, max_concurrent_transforms: 0 },
      }).success,
    ).toBe(false)
    expect(
      PostTrainingV2CapabilitySchema.parse({
        ...capability,
        converters: ['canonical-jsonl', 'trl-sft'],
      }).converters,
    ).toEqual(['canonical-jsonl', 'trl-sft'])
    expect(
      PostTrainingV2CapabilitySchema.safeParse({
        ...capability,
        converters: ['canonical-jsonl', 'canonical-jsonl'],
      }).success,
    ).toBe(false)
    const { max_request_bytes: _omitted, ...incompleteLimits } = limits
    expect(
      PostTrainingV2CapabilitySchema.safeParse({ ...capability, limits: incompleteLimits }).success,
    ).toBe(false)
    expect(PostTrainingV2CapabilitySchema.safeParse({ ...capability, unknown: true }).success).toBe(
      false,
    )
  })

  test('validates complete sorted converter and transform registry pages', () => {
    expect(
      ConverterRegistryPageV2Schema.parse({ items: [converterDescriptor], total: 1 }),
    ).toBeDefined()
    expect(
      TransformRegistryPageV2Schema.parse({ items: [transformDescriptor], total: 1 }),
    ).toBeDefined()
    expect(
      ConverterRegistryPageV2Schema.safeParse({ items: [converterDescriptor], total: 0 }).success,
    ).toBe(false)
    expect(
      TransformRegistryPageV2Schema.safeParse({
        items: [transformDescriptor, transformDescriptor],
        total: 2,
      }).success,
    ).toBe(false)
  })
})

describe('V12 path and query request contracts', () => {
  test('keeps every route path parameter strict and distinguishes exact export versions', () => {
    expect(DatasetRefOrVersionParamsV2Schema.parse({ ref_or_version: 'main' })).toEqual({
      ref_or_version: 'main',
    })
    expect(DatasetRefOrVersionParamsV2Schema.parse({ ref_or_version: VERSION })).toBeDefined()
    expect(DatasetVersionParamsV2Schema.parse({ dataset_version: VERSION })).toBeDefined()
    expect(DatasetVersionParamsV2Schema.safeParse({ dataset_version: 'main' }).success).toBe(false)
    expect(
      DatasetRecordParamsV2Schema.parse({ ref_or_version: 'main', record_id: RECORD_ID }),
    ).toBeDefined()
    expect(ConverterParamsV2Schema.parse({ name: 'trl-dpo' })).toBeDefined()
    expect(ConverterParamsV2Schema.parse({ name: 'future-converter' })).toEqual({
      name: 'future-converter',
    })
    expect(ConverterRegistryNameV2Schema.safeParse('Bad Name').success).toBe(false)
    expect(ConverterRegistryNameV2Schema.safeParse('bad/name').success).toBe(false)
    expect(ConverterRegistryNameV2Schema.safeParse(`c${'x'.repeat(128)}`).success).toBe(false)
    expect(TransformParamsV2Schema.parse({ name: 'prompt-rewrite' })).toBeDefined()
    expect(RefParamsV2Schema.parse({ name: 'main' })).toBeDefined()
    expect(
      DatasetRecordParamsV2Schema.safeParse({
        ref_or_version: 'main',
        record_id: RECORD_ID,
        unknown: true,
      }).success,
    ).toBe(false)
  })

  test('coerces query strings, applies defaults, and treats an empty cursor as missing', () => {
    expect(CursorPageRequestV2Schema.parse({})).toEqual({ cursor: null, limit: 50 })
    expect(CursorPageRequestV2Schema.parse({ cursor: '', limit: '25' })).toEqual({
      cursor: null,
      limit: 25,
    })
    expect(RecordPageRequestV2Schema.parse({ offset: '7', limit: '20' })).toEqual({
      offset: 7,
      limit: 20,
    })
    expect(
      LineagePageRequestV2Schema.parse({ cursor: '', max_depth: '4', max_nodes: '80' }),
    ).toEqual({
      cursor: null,
      max_depth: 4,
      max_nodes: 80,
    })
    expect(CursorPageRequestV2Schema.safeParse({ cursor: null, limit: '501' }).success).toBe(false)
    expect(RecordPageRequestV2Schema.safeParse({ offset: '-1', limit: '20' }).success).toBe(false)
    expect(LineagePageRequestV2Schema.safeParse({ max_depth: '33' }).success).toBe(false)
  })
})

describe('V12 typed error envelopes', () => {
  const plan = createExportPlanV2({
    export_fidelity_profile: 'databench-export-fidelity-1',
    dataset_version: VERSION,
    converter: 'trl-sft',
    converter_version: '1.0.0',
    normalized_options: {},
    media_type: 'application/x-ndjson',
    suggested_filename: 'trl-sft.jsonl',
    output_count: 1,
    config_hints: {},
    fidelity: {
      preserved: ['/contents'],
      changes: [
        {
          path: '/candidates',
          action: 'dropped',
          impact: 'semantic',
          reason: 'non_selected_candidate_state_not_exported',
        },
      ],
    },
  })

  const errorCases = [
    [
      BadRequestErrorResponseV2Schema,
      {
        error: {
          code: 'bad_request',
          message: 'Malformed JSON',
          detail: {
            issues: [{ path: '', line: null, code: 'malformed_json', message: 'Unexpected token' }],
          },
        },
      },
    ],
    [
      ValidationErrorResponseV2Schema,
      {
        error: {
          code: 'validation_error',
          message: 'Invalid query',
          detail: {
            issues: [{ path: '/limit', line: null, code: 'too_big', message: 'Must be <= 500' }],
          },
        },
      },
    ],
    [
      ResourceLimitErrorResponseV2Schema,
      {
        error: {
          code: 'resource_limit',
          message: 'Record too large',
          detail: { resource: 'record_bytes', limit: 1024, actual: '1025' },
        },
      },
    ],
    [
      CapacityExceededErrorResponseV2Schema,
      {
        error: {
          code: 'capacity_exceeded',
          message: 'Insufficient capacity',
          detail: { resource: 'working_set_bytes', limit: 1024, actual: 2048 },
        },
      },
    ],
    [
      NotFoundErrorResponseV2Schema,
      {
        error: {
          code: 'not_found',
          message: 'Converter not found',
          detail: { kind: 'converter', value: 'future-converter' },
        },
      },
    ],
    [
      IdentityConflictErrorResponseV2Schema,
      {
        error: {
          code: 'identity_conflict',
          message: 'Immutable claim conflict',
          detail: { reason: 'claim_request_mismatch' },
        },
      },
    ],
    [
      DeterminismConflictErrorResponseV2Schema,
      {
        error: {
          code: 'determinism_conflict',
          message: 'Output drifted',
          detail: {
            cache_key: CACHE_KEY,
            existing_output_version: VERSION,
            attempted_output_version: OTHER_VERSION,
            attempted_dataset_committed: true,
          },
        },
      },
    ],
    [
      LayoutConflictErrorResponseV2Schema,
      {
        error: {
          code: 'layout_conflict',
          message: 'Layout drifted',
          detail: { reason: 'layout_conflict' },
        },
      },
    ],
    [
      RefConflictErrorResponseV2Schema,
      {
        error: {
          code: 'ref_conflict',
          message: 'Ref moved',
          detail: {
            ref_name: 'main',
            expected_version: VERSION,
            current_version: OTHER_VERSION,
            new_version: VERSION,
            new_dataset_committed: true,
          },
        },
      },
    ],
    [
      UnsupportedProfileErrorResponseV2Schema,
      {
        error: {
          code: 'unsupported_profile',
          message: 'Unsupported layout',
          detail: { kind: 'layout', value: 'future-layout', supported: ['record-json-v1'] },
        },
      },
    ],
    [
      FidelityErrorResponseV2Schema,
      {
        error: {
          code: 'fidelity_error',
          message: 'Approval required',
          detail: { reason: 'semantic_loss_requires_approval', plan },
        },
      },
    ],
    [
      IntegrityErrorResponseV2Schema,
      {
        error: {
          code: 'integrity_error',
          message: 'Stored artifact is invalid',
          detail: {
            reason: 'artifact_digest_mismatch',
            dataset_version: VERSION,
            layout_version: 'record-json-v1',
          },
        },
      },
    ],
    [
      UnauthorizedErrorResponseV2Schema,
      {
        error: {
          code: 'unauthorized',
          message: 'Authentication required',
          detail: { reason: 'credentials_missing' },
        },
      },
    ],
    [
      ForbiddenErrorResponseV2Schema,
      {
        error: {
          code: 'forbidden',
          message: 'Workspace access denied',
          detail: { reason: 'workspace_access_denied' },
        },
      },
    ],
    [
      TooManyRequestsErrorResponseV2Schema,
      {
        error: {
          code: 'too_many_requests',
          message: 'Rate limit exceeded',
          detail: { retry_after_seconds: 10 },
        },
      },
    ],
    [
      ServiceUnavailableErrorResponseV2Schema,
      {
        error: {
          code: 'service_unavailable',
          message: 'Object store is unavailable',
          detail: { dependency: 'object_store', retryable: true },
        },
      },
    ],
    [
      InternalErrorResponseV2Schema,
      {
        error: {
          code: 'internal_error',
          message: 'Unexpected server error',
          detail: { reason: 'unexpected_error' },
        },
      },
    ],
  ] as const

  test('accepts every section 16 branch and the safe internal fallback', () => {
    for (const [schema, response] of errorCases) {
      expect(schema.parse(response)).toEqual(response)
      expect(ErrorResponseV2Schema.parse(response)).toEqual(response)
      expect(ErrorBodyV2Schema.parse(response.error)).toEqual(response.error)
    }
    expect(errorCases.map(([, response]) => response.error.code)).toEqual([
      'bad_request',
      'validation_error',
      'resource_limit',
      'capacity_exceeded',
      'not_found',
      'identity_conflict',
      'determinism_conflict',
      'layout_conflict',
      'ref_conflict',
      'unsupported_profile',
      'fidelity_error',
      'integrity_error',
      'unauthorized',
      'forbidden',
      'too_many_requests',
      'service_unavailable',
      'internal_error',
    ])
  })

  test('keeps same-status branches distinguishable and every detail strict', () => {
    for (const code of ['validation_error', 'unsupported_profile', 'fidelity_error']) {
      const response = errorCases.find(([, candidate]) => candidate.error.code === code)?.[1]
      expect(ErrorResponse422V2Schema.safeParse(response).success).toBe(true)
    }
    for (const code of [
      'identity_conflict',
      'determinism_conflict',
      'layout_conflict',
      'ref_conflict',
    ]) {
      const response = errorCases.find(([, candidate]) => candidate.error.code === code)?.[1]
      expect(ErrorResponse409V2Schema.safeParse(response).success).toBe(true)
    }
    for (const code of ['capacity_exceeded', 'service_unavailable']) {
      const response = errorCases.find(([, candidate]) => candidate.error.code === code)?.[1]
      expect(ErrorResponse503V2Schema.safeParse(response).success).toBe(true)
    }
    for (const code of ['integrity_error', 'internal_error']) {
      const response = errorCases.find(([, candidate]) => candidate.error.code === code)?.[1]
      expect(ErrorResponse500V2Schema.safeParse(response).success).toBe(true)
    }
    expect(
      ErrorResponse409V2Schema.safeParse(
        errorCases.find(([, candidate]) => candidate.error.code === 'validation_error')?.[1],
      ).success,
    ).toBe(false)
    expect(
      ErrorResponse503V2Schema.safeParse(
        errorCases.find(([, candidate]) => candidate.error.code === 'internal_error')?.[1],
      ).success,
    ).toBe(false)
    expect(
      CapacityExceededErrorResponseV2Schema.safeParse({
        error: {
          code: 'capacity_exceeded',
          message: 'Disk is full',
          detail: { resource: 'temp_disk_bytes', required: '2048', available: '1024' },
        },
      }).success,
    ).toBe(true)
    expect(
      ValidationErrorResponseV2Schema.safeParse({
        error: {
          code: 'bad_request',
          message: 'Wrong code',
          detail: {
            issues: [{ path: '', line: null, code: 'malformed_json', message: 'Invalid' }],
          },
        },
      }).success,
    ).toBe(false)
    expect(
      ErrorResponseV2Schema.safeParse({
        error: {
          code: 'not_found',
          message: 'Missing',
          detail: { kind: 'converter', value: 'x', secret: 'must not pass' },
        },
      }).success,
    ).toBe(false)
    expect(
      NotFoundErrorResponseV2Schema.safeParse({
        error: {
          code: 'not_found',
          message: 'Route not found',
          detail: { kind: 'route', value: '/v2/unknown' },
        },
      }).success,
    ).toBe(true)
    expect(
      ErrorResponseV2Schema.safeParse({
        error: { code: 'unauthorized', message: 'Missing detail' },
      }).success,
    ).toBe(false)
  })
})

describe('V12 reusable component generation', () => {
  test('emits stable strict component sources for requests, successes and typed errors', () => {
    const components = [
      ['PostTrainingV2Capability', PostTrainingV2CapabilitySchema],
      ['ConverterRegistryPageV2', ConverterRegistryPageV2Schema],
      ['TransformRegistryPageV2', TransformRegistryPageV2Schema],
      ['DatasetRefOrVersionParamsV2', DatasetRefOrVersionParamsV2Schema],
      ['DatasetVersionParamsV2', DatasetVersionParamsV2Schema],
      ['DatasetRecordParamsV2', DatasetRecordParamsV2Schema],
      ['ConverterParamsV2', ConverterParamsV2Schema],
      ['TransformParamsV2', TransformParamsV2Schema],
      ['RefParamsV2', RefParamsV2Schema],
      ['CursorPageRequestV2', CursorPageRequestV2Schema],
      ['RecordPageRequestV2', RecordPageRequestV2Schema],
      ['LineagePageRequestV2', LineagePageRequestV2Schema],
      ['IngestCanonicalV2Form', IngestCanonicalV2FormSchema],
      ['IngestResultV2', IngestResultV2Schema],
      ['AuditResultV2', AuditResultV2Schema],
      ['BadRequestDetailV2', BadRequestDetailV2Schema],
      ['ValidationErrorDetailV2', ValidationErrorDetailV2Schema],
      ['ResourceLimitDetailV2', ResourceLimitDetailV2Schema],
      ['CapacityExceededDetailV2', CapacityExceededDetailV2Schema],
      ['NotFoundDetailV2', NotFoundDetailV2Schema],
      ['IdentityConflictDetailV2', IdentityConflictDetailV2Schema],
      ['DeterminismConflictDetailV2', DeterminismConflictDetailV2Schema],
      ['LayoutConflictDetailV2', LayoutConflictDetailV2Schema],
      ['RefConflictDetailV2', RefConflictDetailV2Schema],
      ['UnsupportedProfileDetailV2', UnsupportedProfileDetailV2Schema],
      ['FidelityErrorDetailV2', FidelityErrorDetailV2Schema],
      ['IntegrityErrorDetailV2', IntegrityErrorDetailV2Schema],
      ['UnauthorizedDetailV2', UnauthorizedDetailV2Schema],
      ['ForbiddenDetailV2', ForbiddenDetailV2Schema],
      ['TooManyRequestsDetailV2', TooManyRequestsDetailV2Schema],
      ['ServiceUnavailableDetailV2', ServiceUnavailableDetailV2Schema],
      ['InternalErrorDetailV2', InternalErrorDetailV2Schema],
      ['ErrorBodyV2', ErrorBodyV2Schema],
      ['ErrorResponseV2', ErrorResponseV2Schema],
      ['ErrorResponse409V2', ErrorResponse409V2Schema],
      ['ErrorResponse422V2', ErrorResponse422V2Schema],
      ['ErrorResponse500V2', ErrorResponse500V2Schema],
      ['ErrorResponse503V2', ErrorResponse503V2Schema],
      ['IngestConflictErrorResponseV2', IngestConflictErrorResponseV2Schema],
      [
        'ValidationOrUnsupportedProfileErrorResponseV2',
        ValidationOrUnsupportedProfileErrorResponseV2Schema,
      ],
      ['BadRequestErrorResponseV2', BadRequestErrorResponseV2Schema],
      ['ValidationErrorResponseV2', ValidationErrorResponseV2Schema],
      ['ResourceLimitErrorResponseV2', ResourceLimitErrorResponseV2Schema],
      ['CapacityExceededErrorResponseV2', CapacityExceededErrorResponseV2Schema],
      ['NotFoundErrorResponseV2', NotFoundErrorResponseV2Schema],
      ['IdentityConflictErrorResponseV2', IdentityConflictErrorResponseV2Schema],
      ['RefConflictErrorResponseV2', RefConflictErrorResponseV2Schema],
      ['FidelityErrorResponseV2', FidelityErrorResponseV2Schema],
      ['UnsupportedProfileErrorResponseV2', UnsupportedProfileErrorResponseV2Schema],
      ['DeterminismConflictErrorResponseV2', DeterminismConflictErrorResponseV2Schema],
      ['LayoutConflictErrorResponseV2', LayoutConflictErrorResponseV2Schema],
      ['IntegrityErrorResponseV2', IntegrityErrorResponseV2Schema],
      ['UnauthorizedErrorResponseV2', UnauthorizedErrorResponseV2Schema],
      ['ForbiddenErrorResponseV2', ForbiddenErrorResponseV2Schema],
      ['TooManyRequestsErrorResponseV2', TooManyRequestsErrorResponseV2Schema],
      ['ServiceUnavailableErrorResponseV2', ServiceUnavailableErrorResponseV2Schema],
      ['InternalErrorResponseV2', InternalErrorResponseV2Schema],
    ] as const
    const registry = z.registry<{ id: string }>()

    for (const [id, schema] of components) {
      expect(schema.meta()?.id).toBe(id)
      registry.add(schema, { id })
    }
    const generated = z.toJSONSchema(registry, { target: 'draft-7' }) as {
      readonly schemas: Readonly<Record<string, { readonly additionalProperties?: boolean }>>
    }

    expect(Object.keys(generated.schemas)).toEqual(
      expect.arrayContaining(components.map(([id]) => id)),
    )
    const unionComponents = new Set([
      'CapacityExceededDetailV2',
      'ErrorBodyV2',
      'ErrorResponse409V2',
      'ErrorResponse422V2',
      'ErrorResponse500V2',
      'ErrorResponse503V2',
      'IngestConflictErrorResponseV2',
      'ValidationOrUnsupportedProfileErrorResponseV2',
    ])
    for (const [id] of components) {
      if (unionComponents.has(id)) continue
      expect(generated.schemas[id]?.additionalProperties, id).toBe(false)
    }
  })
})
