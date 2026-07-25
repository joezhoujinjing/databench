import { describe, expect, test } from 'vitest'
import { z } from 'zod'
import {
  McpCanonicalImportContractSchema,
  McpCanonicalValidationPreviewResultSchema,
  McpContractGetInputSchema,
  McpDataProcessPreparedSchema,
  McpDataProcessPreparedToolOutputSchema,
  McpDataProcessPrepareInputSchema,
  McpDataProcessPrepareToolInputSchema,
  McpDatasetExportCanonicalPreparedSchema,
} from '../src/v2/index.js'

const DIGEST = 'a'.repeat(64)

describe('MCP v2 schemas', () => {
  test('keeps the staged contract and process inputs strict', () => {
    expect(McpContractGetInputSchema.parse({ name: 'canonical-jsonl' })).toEqual({
      name: 'canonical-jsonl',
    })
    expect(() =>
      McpContractGetInputSchema.parse({ name: 'canonical-jsonl', unknown: true }),
    ).toThrow()
    expect(() => McpContractGetInputSchema.parse({ name: 'canonical-draft-import' })).toThrow()

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
    expect(() =>
      McpDataProcessPrepareInputSchema.parse({
        format: 'canonical-jsonl',
        action: 'materialize-jsonl',
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

    expect(input).toMatchObject({
      type: 'object',
      additionalProperties: false,
      oneOf: [
        {
          properties: {
            action: { const: 'validate-preview' },
            preview_records: { type: 'integer', minimum: 0, maximum: 10, default: 3 },
          },
        },
        {
          properties: { action: { const: 'import-dataset' } },
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
            response_kind: { const: 'json-preview' },
            side_effects: { type: 'array', prefixItems: [] },
          },
        },
        {
          properties: {
            action: { const: 'import-dataset' },
            response_kind: { const: 'json-ingest-result' },
            side_effects: {
              type: 'array',
              prefixItems: [{ type: 'string', const: 'dataset_publish' }],
            },
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
  })
})
