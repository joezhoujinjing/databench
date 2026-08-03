import { canonicalJsonV2, hashV2ExportFidelity } from '@databench/hashing'
import { describe, expect, test } from 'vitest'
import {
  assertExportFidelityAcceptedV2,
  ConverterAnalysisV2Schema,
  ConverterDescriptorV2Schema,
  createExportPlanV2,
  ExportFidelityIdentityV1Schema,
  ExportPlanV2Schema,
  ExportPreviewV2Schema,
  ExportRequestV2Schema,
  FidelityChangeV2Schema,
  FidelityErrorV2,
  hasSemanticFidelityLossV2,
  InspectExportRequestV2Schema,
  normalizeExportFidelityIdentityV2,
  V2_EXPORT_PREVIEW_MAX_BYTES,
} from '../src/index.js'

const DATASET_VERSION = '5'.repeat(64)

const informationalChange = {
  path: '/candidates',
  action: 'dropped',
  impact: 'informational',
  reason: 'trainer_omits_candidate_provenance',
} as const

const semanticChange = {
  path: '/contents',
  action: 'dropped',
  impact: 'semantic',
  reason: 'trainer_omits_weighted_history',
} as const

const planInput = {
  export_fidelity_profile: 'databench-export-fidelity-1',
  dataset_version: DATASET_VERSION,
  converter: 'trl-sft',
  converter_version: '1.0.0',
  normalized_options: { include_tools: true },
  media_type: 'application/x-ndjson',
  suggested_filename: 'dataset-trl-sft.jsonl',
  output_count: 2,
  config_hints: { trainer: 'trl', dataset_text_field: 'messages' },
  fidelity: {
    preserved: ['tools', 'contents', 'tools'],
    changes: [informationalChange, semanticChange, informationalChange],
  },
} as const

describe('V11 converter wire contracts', () => {
  test('keeps the converter registry descriptor strict and bounded', () => {
    const descriptor = {
      name: 'trl-sft',
      version: '1.0.0',
      options_schema: {
        type: 'object',
        properties: { include_tools: { type: 'boolean', default: true } },
        additionalProperties: false,
      },
      media_type: 'application/x-ndjson',
      task_views: ['sft'],
      export_fidelity_profile: 'databench-export-fidelity-1',
    }
    expect(ConverterDescriptorV2Schema.parse(descriptor)).toEqual(descriptor)
    expect(
      ConverterDescriptorV2Schema.safeParse({
        ...descriptor,
        task_views: ['sft', 'sft'],
      }).success,
    ).toBe(false)
    expect(ConverterDescriptorV2Schema.safeParse({ ...descriptor, name: 'unknown' }).success).toBe(
      false,
    )
    expect(ConverterDescriptorV2Schema.safeParse({ ...descriptor, internal: true }).success).toBe(
      false,
    )
    expect(
      ConverterDescriptorV2Schema.parse({
        ...descriptor,
        name: 'evalscope-general-qa',
        task_views: ['evaluation-qa'],
      }),
    ).toMatchObject({ name: 'evalscope-general-qa', task_views: ['evaluation-qa'] })
  })

  test('validates RFC 6901 change paths and stable reason codes', () => {
    for (const path of ['', '/', '/contents/0/parts', '/a~0b/c~1d']) {
      expect(FidelityChangeV2Schema.safeParse({ ...informationalChange, path }).success).toBe(true)
    }
    for (const path of ['contents', '/dangling~', '/bad~2escape']) {
      expect(FidelityChangeV2Schema.safeParse({ ...informationalChange, path }).success).toBe(false)
    }
    expect(
      FidelityChangeV2Schema.safeParse({
        ...informationalChange,
        reason: 'Dropped candidate data for record rec_secret',
      }).success,
    ).toBe(false)
    for (const reason of [
      `record_${'a'.repeat(64)}_omitted`,
      `prefix${'b'.repeat(64)}suffix`,
      `prefix_rec_${'c'.repeat(64)}_suffix`,
    ]) {
      expect(FidelityChangeV2Schema.safeParse({ ...informationalChange, reason }).success).toBe(
        false,
      )
    }
  })

  test('accepts only strict inspect/export request envelopes', () => {
    expect(InspectExportRequestV2Schema.parse({ converter: 'ms-swift', options: {} })).toEqual({
      converter: 'ms-swift',
      options: {},
    })
    expect(
      InspectExportRequestV2Schema.parse({
        converter: 'evalscope-general-qa',
        options: { target_source: 'none' },
      }),
    ).toEqual({
      converter: 'evalscope-general-qa',
      options: { target_source: 'none' },
    })
    expect(
      InspectExportRequestV2Schema.safeParse({ converter: 'trl-sft', options: {}, extra: true })
        .success,
    ).toBe(false)
    expect(
      ExportRequestV2Schema.parse({
        converter: 'trl-dpo',
        options: {},
        accepted_fidelity_digest: null,
      }),
    ).toBeDefined()
    expect(
      ExportRequestV2Schema.safeParse({
        converter: 'trl-dpo',
        options: {},
        accepted_fidelity_digest: 'short',
      }).success,
    ).toBe(false)
  })

  test('keeps export previews strict, nullable, and bounded', () => {
    const preview = {
      plan: createExportPlanV2(planInput),
      source_record: {
        record_id: `rec_${'a'.repeat(64)}`,
        record_digest: 'b'.repeat(64),
        text: '{}',
        truncated: false,
      },
      output_record: null,
    }
    expect(ExportPreviewV2Schema.parse(preview)).toEqual(preview)
    expect(
      ExportPreviewV2Schema.safeParse({
        ...preview,
        source_record: {
          ...preview.source_record,
          text: 'x'.repeat(V2_EXPORT_PREVIEW_MAX_BYTES + 1),
        },
      }).success,
    ).toBe(false)
    expect(ExportPreviewV2Schema.safeParse({ ...preview, extra: true }).success).toBe(false)
  })

  test('validates deterministic converter analysis without hiding reported changes', () => {
    expect(
      ConverterAnalysisV2Schema.parse({
        normalized_options: {},
        media_type: 'application/x-ndjson',
        suggested_filename: 'dataset.jsonl',
        output_count: 1,
        config_hints: {},
        fidelity: { preserved: [], changes: [informationalChange] },
      }).fidelity.changes,
    ).toEqual([informationalChange])
    expect(
      ConverterAnalysisV2Schema.safeParse({
        normalized_options: {},
        media_type: 'application/x-ndjson',
        suggested_filename: '../dataset.jsonl',
        output_count: 1,
        config_hints: {},
        fidelity: { preserved: [], changes: [] },
      }).success,
    ).toBe(false)
  })
})

describe('V11 export fidelity identity and plan', () => {
  test('normalizes sets without mutating input and locks canonical bytes/digest', () => {
    const before = structuredClone(planInput)
    const plan = createExportPlanV2(planInput)
    expect(planInput).toEqual(before)
    expect(plan.fidelity).toEqual({
      preserved: ['contents', 'tools'],
      changes: [informationalChange, semanticChange],
    })
    expect(plan.fidelity_digest).toBe(
      '1e7f6015ffbe122d517ffa3b65a1a403a2ea4e2afcba9dba9f90f5eb947ec7fb',
    )

    const identity = normalizeExportFidelityIdentityV2({
      export_fidelity_profile: plan.export_fidelity_profile,
      identity_profile: 'databench-v2-jcs-1',
      dataset_version: plan.dataset_version,
      converter: plan.converter,
      converter_version: plan.converter_version,
      normalized_options: plan.normalized_options,
      media_type: plan.media_type,
      output_count: plan.output_count,
      config_hints: plan.config_hints,
      fidelity: plan.fidelity,
    })
    expect(canonicalJsonV2(identity)).toBe(
      '{"config_hints":{"dataset_text_field":"messages","trainer":"trl"},"converter":"trl-sft","converter_version":"1.0.0","dataset_version":"5555555555555555555555555555555555555555555555555555555555555555","export_fidelity_profile":"databench-export-fidelity-1","fidelity":{"changes":[{"action":"dropped","impact":"informational","path":"/candidates","reason":"trainer_omits_candidate_provenance"},{"action":"dropped","impact":"semantic","path":"/contents","reason":"trainer_omits_weighted_history"}],"preserved":["contents","tools"]},"identity_profile":"databench-v2-jcs-1","media_type":"application/x-ndjson","normalized_options":{"include_tools":true},"output_count":2}',
    )
    expect(hashV2ExportFidelity(identity)).toBe(plan.fidelity_digest)
    expect(ExportFidelityIdentityV1Schema.parse(identity)).toEqual(identity)
    expect(ExportPlanV2Schema.parse(plan)).toEqual(plan)
  })

  test('excludes suggested filename but binds every semantic plan field', () => {
    const plan = createExportPlanV2(planInput)
    expect(
      createExportPlanV2({ ...planInput, suggested_filename: 'display-only.jsonl' })
        .fidelity_digest,
    ).toBe(plan.fidelity_digest)

    const variants = [
      { ...planInput, dataset_version: '6'.repeat(64) },
      { ...planInput, converter: 'ms-swift' as const },
      { ...planInput, converter_version: '1.0.1' },
      { ...planInput, normalized_options: { include_tools: false } },
      { ...planInput, media_type: 'application/json' },
      { ...planInput, output_count: 3 },
      { ...planInput, config_hints: { trainer: 'other' } },
      { ...planInput, fidelity: { preserved: ['contents'], changes: [semanticChange] } },
    ]
    for (const variant of variants) {
      expect(createExportPlanV2(variant).fidelity_digest).not.toBe(plan.fidelity_digest)
    }
  })

  test('rejects non-normalized or drifted plans', () => {
    const plan = createExportPlanV2(planInput)
    expect(
      ExportPlanV2Schema.safeParse({
        ...plan,
        fidelity: planInput.fidelity,
      }).success,
    ).toBe(false)
    expect(ExportPlanV2Schema.safeParse({ ...plan, fidelity_digest: '0'.repeat(64) }).success).toBe(
      false,
    )
  })

  test('requires exact approval only for semantic loss and any supplied digest drift', () => {
    const semanticPlan = createExportPlanV2(planInput)
    expect(hasSemanticFidelityLossV2(semanticPlan.fidelity)).toBe(true)
    expect(() => assertExportFidelityAcceptedV2(semanticPlan, null)).toThrowError(FidelityErrorV2)
    try {
      assertExportFidelityAcceptedV2(semanticPlan, null)
    } catch (error) {
      expect(error).toMatchObject({
        code: 'fidelity_error',
        detail: { reason: 'semantic_loss_requires_approval', plan: semanticPlan },
      })
      expect(Object.isFrozen((error as FidelityErrorV2).detail)).toBe(true)
      expect(Object.isFrozen((error as FidelityErrorV2).detail.plan)).toBe(true)
    }
    expect(() =>
      assertExportFidelityAcceptedV2(semanticPlan, semanticPlan.fidelity_digest),
    ).not.toThrow()
    expect(() => assertExportFidelityAcceptedV2(semanticPlan, '0'.repeat(64))).toThrowError(
      expect.objectContaining({
        code: 'fidelity_error',
        detail: expect.objectContaining({ reason: 'fidelity_digest_mismatch' }),
      }),
    )

    const informationalPlan = createExportPlanV2({
      ...planInput,
      fidelity: { preserved: [], changes: [informationalChange] },
    })
    expect(hasSemanticFidelityLossV2(informationalPlan.fidelity)).toBe(false)
    expect(() => assertExportFidelityAcceptedV2(informationalPlan, null)).not.toThrow()
    expect(() => assertExportFidelityAcceptedV2(informationalPlan, '0'.repeat(64))).toThrowError(
      FidelityErrorV2,
    )
  })
})
