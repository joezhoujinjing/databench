import Ajv2020 from 'ajv/dist/2020.js'
import { describe, expect, test } from 'vitest'
import { z } from 'zod'
import {
  McpCanonicalDraftImportContractSchema,
  McpCanonicalDraftValidationPreviewResultSchema,
  McpCanonicalImportContractSchema,
  McpCanonicalValidationPreviewResultSchema,
  McpContractGetInputSchema,
  McpDataProcessPreparedSchema,
  McpDataProcessPreparedToolOutputSchema,
  McpDataProcessPrepareInputSchema,
  McpDataProcessPrepareToolInputSchema,
  McpDatasetExportCanonicalPreparedSchema,
  McpImportContractSchema,
  McpImportContractToolOutputSchema,
} from '../src/v2/index.js'

const DIGEST = 'a'.repeat(64)
const REF = 'mcp-import'
const REF_INTENT = { ref: REF, expected_ref_version: null } as const

describe('MCP v2 schemas', () => {
  test('keeps the staged contract and process inputs strict', () => {
    expect(McpContractGetInputSchema.parse({ name: 'canonical-jsonl' })).toEqual({
      name: 'canonical-jsonl',
    })
    expect(() =>
      McpContractGetInputSchema.parse({ name: 'canonical-jsonl', unknown: true }),
    ).toThrow()
    expect(McpContractGetInputSchema.parse({ name: 'canonical-draft-import' })).toEqual({
      name: 'canonical-draft-import',
    })

    expect(
      McpDataProcessPrepareInputSchema.parse({
        format: 'canonical-jsonl',
        action: 'validate-preview',
      }),
    ).toEqual({
      format: 'canonical-jsonl',
      action: 'validate-preview',
      preview_records: 3,
    })
    expect(() =>
      McpDataProcessPrepareInputSchema.parse({
        format: 'canonical-jsonl',
        action: 'import-dataset',
        preview_records: 1,
      }),
    ).toThrow()
    expect(
      McpDataProcessPrepareInputSchema.parse({
        format: 'canonical-draft-jsonl-v1',
        action: 'validate-preview',
      }),
    ).toEqual({
      format: 'canonical-draft-jsonl-v1',
      action: 'validate-preview',
      preview_records: 3,
    })
    expect(
      McpDataProcessPrepareInputSchema.parse({
        format: 'canonical-draft-jsonl-v1',
        action: 'import-dataset',
        ...REF_INTENT,
        expected_input_digest: DIGEST,
      }),
    ).toEqual({
      format: 'canonical-draft-jsonl-v1',
      action: 'import-dataset',
      ...REF_INTENT,
      expected_input_digest: DIGEST,
    })
    expect(() =>
      McpDataProcessPrepareInputSchema.parse({
        format: 'canonical-draft-jsonl-v1',
        action: 'import-dataset',
      }),
    ).toThrow()
    expect(() =>
      McpDataProcessPrepareInputSchema.parse({
        format: 'canonical-jsonl',
        action: 'import-dataset',
        expected_input_digest: DIGEST,
      }),
    ).toThrow()
    expect(() =>
      McpDataProcessPrepareInputSchema.parse({
        format: 'canonical-jsonl',
        action: 'materialize-jsonl',
      }),
    ).toThrow()
    expect(
      McpDataProcessPrepareInputSchema.parse({
        format: 'canonical-draft-jsonl-v1',
        action: 'materialize-jsonl',
        expected_input_digest: DIGEST,
      }),
    ).toEqual({
      format: 'canonical-draft-jsonl-v1',
      action: 'materialize-jsonl',
      expected_input_digest: DIGEST,
    })
    expect(() =>
      McpDataProcessPrepareInputSchema.parse({
        format: 'canonical-draft-jsonl-v1',
        action: 'validate-preview',
        expected_input_digest: DIGEST,
      }),
    ).toThrow()
  })

  test('locks action-specific prepared output side effects', () => {
    const base = {
      method: 'PUT',
      put_url: 'http://databench.internal/api/mcp-files/process/proc_token',
      content_type: 'application/x-ndjson',
      max_bytes: 1024,
      expires_at: '2026-07-25T08:00:00.000Z',
      format: 'canonical-jsonl',
    } as const
    expect(
      McpDataProcessPreparedSchema.parse({
        ...base,
        action: 'validate-preview',
        response_kind: 'json-preview',
        side_effects: [],
      }),
    ).toMatchObject({ action: 'validate-preview', side_effects: [] })
    expect(() =>
      McpDataProcessPreparedSchema.parse({
        ...base,
        action: 'validate-preview',
        response_kind: 'json-preview',
        side_effects: ['dataset_publish'],
      }),
    ).toThrow()
    expect(
      McpDataProcessPreparedSchema.parse({
        ...base,
        format: 'canonical-draft-jsonl-v1',
        action: 'materialize-jsonl',
        response_kind: 'canonical-jsonl',
        side_effects: ['identity_claims'],
      }),
    ).toMatchObject({ action: 'materialize-jsonl', side_effects: ['identity_claims'] })
    expect(
      McpDataProcessPreparedSchema.parse({
        ...base,
        format: 'canonical-draft-jsonl-v1',
        action: 'validate-preview',
        response_kind: 'json-preview',
        side_effects: [],
      }),
    ).toMatchObject({ format: 'canonical-draft-jsonl-v1', side_effects: [] })
    expect(
      McpDataProcessPreparedSchema.parse({
        ...base,
        format: 'canonical-draft-jsonl-v1',
        action: 'import-dataset',
        ...REF_INTENT,
        message: null,
        response_kind: 'json-ingest-result',
        side_effects: ['identity_claims', 'dataset_publish', 'ref_update'],
      }),
    ).toMatchObject({
      format: 'canonical-draft-jsonl-v1',
      action: 'import-dataset',
      ref: REF,
      side_effects: ['identity_claims', 'dataset_publish', 'ref_update'],
    })
    expect(() =>
      McpDataProcessPreparedSchema.parse({
        ...base,
        action: 'import-dataset',
        response_kind: 'json-preview',
        side_effects: ['dataset_publish'],
      }),
    ).toThrow()
  })

  test('advertises exact action branches in SDK-compatible object schemas', () => {
    const input = z.toJSONSchema(McpDataProcessPrepareToolInputSchema)
    const output = z.toJSONSchema(McpDataProcessPreparedToolOutputSchema)
    const contractOutput = z.toJSONSchema(McpImportContractToolOutputSchema)

    expect(input).toMatchObject({
      type: 'object',
      additionalProperties: false,
      oneOf: [
        {
          properties: {
            action: { const: 'validate-preview' },
            format: {
              enum: ['canonical-jsonl', 'canonical-draft-jsonl-v1'],
            },
            preview_records: { type: 'integer', minimum: 0, maximum: 10, default: 3 },
          },
          required: ['format', 'action'],
        },
        {
          properties: {
            action: { const: 'import-dataset' },
            format: { const: 'canonical-jsonl' },
            ref: { type: 'string' },
            expected_ref_version: {
              anyOf: [{ type: 'string', pattern: '^[0-9a-f]{64}$' }, { type: 'null' }],
            },
          },
          required: ['format', 'action', 'ref', 'expected_ref_version'],
          additionalProperties: false,
        },
        {
          properties: {
            action: { const: 'import-dataset' },
            format: { const: 'canonical-draft-jsonl-v1' },
            ref: { type: 'string' },
            expected_ref_version: {
              anyOf: [{ type: 'string', pattern: '^[0-9a-f]{64}$' }, { type: 'null' }],
            },
            expected_input_digest: { type: 'string', pattern: '^[0-9a-f]{64}$' },
          },
          required: ['format', 'action', 'ref', 'expected_ref_version'],
          additionalProperties: false,
        },
        {
          properties: {
            action: { const: 'materialize-jsonl' },
            format: { const: 'canonical-draft-jsonl-v1' },
            expected_input_digest: { type: 'string', pattern: '^[0-9a-f]{64}$' },
          },
          additionalProperties: false,
        },
      ],
    })
    expect(output).toMatchObject({
      type: 'object',
      additionalProperties: false,
      oneOf: [
        {
          properties: {
            action: { const: 'validate-preview' },
            format: {
              enum: ['canonical-jsonl', 'canonical-draft-jsonl-v1'],
            },
            response_kind: { const: 'json-preview' },
            side_effects: {
              type: 'array',
              minItems: 0,
              maxItems: 0,
              items: { not: {} },
            },
          },
        },
        {
          properties: {
            action: { const: 'import-dataset' },
            format: { const: 'canonical-jsonl' },
            ref: { type: 'string' },
            response_kind: { const: 'json-ingest-result' },
            side_effects: {
              type: 'array',
              prefixItems: [
                { type: 'string', const: 'dataset_publish' },
                { type: 'string', const: 'ref_update' },
              ],
            },
          },
        },
        {
          properties: {
            action: { const: 'import-dataset' },
            format: { const: 'canonical-draft-jsonl-v1' },
            ref: { type: 'string' },
            response_kind: { const: 'json-ingest-result' },
            side_effects: {
              type: 'array',
              prefixItems: [
                { type: 'string', const: 'identity_claims' },
                { type: 'string', const: 'dataset_publish' },
                { type: 'string', const: 'ref_update' },
              ],
            },
          },
        },
        {
          properties: {
            action: { const: 'materialize-jsonl' },
            format: { const: 'canonical-draft-jsonl-v1' },
            response_kind: { const: 'canonical-jsonl' },
            side_effects: {
              type: 'array',
              minItems: 1,
              maxItems: 1,
              items: { type: 'string', const: 'identity_claims' },
            },
          },
        },
      ],
    })

    const ajv = new Ajv2020({ logger: false, strict: false })
    const validateInput = ajv.compile(input)
    expect(validateInput({ format: 'canonical-draft-jsonl-v1', action: 'validate-preview' })).toBe(
      true,
    )
    expect(validateInput({ format: 'canonical-draft-jsonl-v1', action: 'import-dataset' })).toBe(
      false,
    )
    expect(
      validateInput({
        format: 'canonical-draft-jsonl-v1',
        action: 'import-dataset',
        ...REF_INTENT,
        expected_input_digest: DIGEST,
      }),
    ).toBe(true)
    expect(
      validateInput({
        format: 'canonical-draft-jsonl-v1',
        action: 'materialize-jsonl',
        expected_input_digest: DIGEST,
      }),
    ).toBe(true)

    const validateOutput = ajv.compile(output)
    const preparedBase = {
      method: 'PUT',
      put_url: 'http://databench.internal/api/mcp-files/process/proc_token',
      content_type: 'application/x-ndjson',
      max_bytes: 1024,
      expires_at: '2026-07-25T08:00:00.000Z',
    }
    expect(
      validateOutput({
        ...preparedBase,
        format: 'canonical-draft-jsonl-v1',
        action: 'validate-preview',
        response_kind: 'json-preview',
        side_effects: [],
      }),
    ).toBe(true)
    expect(
      validateOutput({
        ...preparedBase,
        format: 'canonical-draft-jsonl-v1',
        action: 'import-dataset',
        ...REF_INTENT,
        message: null,
        response_kind: 'json-ingest-result',
        side_effects: ['identity_claims', 'dataset_publish', 'ref_update', 'ref_update'],
      }),
    ).toBe(false)
    expect(
      validateOutput({
        ...preparedBase,
        format: 'canonical-jsonl',
        action: 'import-dataset',
        ...REF_INTENT,
        message: null,
        response_kind: 'json-ingest-result',
        side_effects: [],
      }),
    ).toBe(false)
    expect(
      validateOutput({
        ...preparedBase,
        format: 'canonical-draft-jsonl-v1',
        action: 'import-dataset',
        ...REF_INTENT,
        message: null,
        response_kind: 'json-ingest-result',
        side_effects: ['identity_claims', 'dataset_publish', 'ref_update'],
      }),
    ).toBe(true)
    expect(
      validateOutput({
        ...preparedBase,
        format: 'canonical-draft-jsonl-v1',
        action: 'materialize-jsonl',
        response_kind: 'canonical-jsonl',
        side_effects: ['identity_claims'],
      }),
    ).toBe(true)
    expect(contractOutput).toMatchObject({
      type: 'object',
      additionalProperties: false,
      oneOf: [
        {
          properties: {
            name: { const: 'canonical-jsonl' },
            version: { const: '2.0.0' },
          },
        },
        {
          properties: {
            name: { const: 'canonical-draft-import' },
            version: { const: '1.0.0' },
          },
        },
      ],
    })
  })

  test('bounds preview and export results with named strict schemas', () => {
    expect(
      McpCanonicalValidationPreviewResultSchema.parse({
        format: 'canonical-jsonl',
        input_digest: DIGEST,
        record_count: 0,
        records: [],
        records_truncated: false,
      }),
    ).toMatchObject({ record_count: 0 })
    expect(() =>
      McpCanonicalValidationPreviewResultSchema.parse({
        format: 'canonical-jsonl',
        input_digest: DIGEST,
        record_count: 0,
        records: [],
        records_truncated: false,
        unknown: true,
      }),
    ).toThrow()
    expect(
      McpCanonicalDraftValidationPreviewResultSchema.parse({
        format: 'canonical-draft-jsonl-v1',
        input_digest: DIGEST,
        record_count: 1,
        records: [
          {
            draft_schema_version: '1.0.0',
            schema_version: '2.0.0',
            contents: [],
          },
        ],
        records_truncated: false,
      }),
    ).toMatchObject({ records: [{ candidates: [], extra: {} }] })
    expect(
      McpDatasetExportCanonicalPreparedSchema.parse({
        method: 'GET',
        get_url: 'http://databench.internal/api/mcp-files/export/exp_token',
        media_type: 'application/x-ndjson',
        filename: 'dataset.jsonl',
        dataset_version: DIGEST,
        expires_at: '2026-07-25T08:00:00.000Z',
      }),
    ).toMatchObject({ dataset_version: DIGEST })
  })

  test('requires exactly one SFT, DPO, and RLVR contract example', () => {
    const base = {
      name: 'canonical-jsonl',
      version: '2.0.0',
      schema: { type: 'object' },
      rules: ['one rule'],
      effective_limits: {
        max_request_bytes: 1,
        max_record_bytes: 1,
        max_snapshot_records: 1,
        max_canonical_bytes: 1,
        max_preview_response_bytes: 1,
      },
    } as const
    expect(
      McpCanonicalImportContractSchema.parse({
        ...base,
        examples: [
          { name: 'sft', jsonl: '{}\n' },
          { name: 'dpo', jsonl: '{}\n' },
          { name: 'rlvr', jsonl: '{}\n' },
        ],
      }).examples.map(({ name }) => name),
    ).toEqual(['sft', 'dpo', 'rlvr'])
    expect(() =>
      McpCanonicalImportContractSchema.parse({
        ...base,
        examples: [{ name: 'sft', jsonl: '{}\n' }],
      }),
    ).toThrow()
    expect(() =>
      McpCanonicalImportContractSchema.parse({
        ...base,
        examples: [
          { name: 'sft', jsonl: '{}\n' },
          { name: 'sft', jsonl: '{}\n' },
          { name: 'rlvr', jsonl: '{}\n' },
        ],
      }),
    ).toThrow()

    const draft = {
      ...base,
      name: 'canonical-draft-import',
      version: '1.0.0',
      examples: [
        { name: 'sft', jsonl: '{}\n' },
        { name: 'dpo', jsonl: '{}\n' },
        { name: 'rlvr', jsonl: '{}\n' },
      ],
    } as const
    expect(McpCanonicalDraftImportContractSchema.parse(draft).version).toBe('1.0.0')
    expect(McpImportContractSchema.parse(draft).name).toBe('canonical-draft-import')
    expect(() => McpImportContractSchema.parse({ ...draft, version: '2.0.0' })).toThrow()
  })
})
