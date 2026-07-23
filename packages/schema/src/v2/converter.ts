import {
  canonicalJsonV2,
  compareJcsUtf16,
  type ExportFidelityIdentityV1 as HashExportFidelityIdentityV1,
  hashV2ExportFidelity,
  V2_EXPORT_FIDELITY_PROFILE,
  V2_IDENTITY_PROFILE,
} from '@databench/hashing'
import { z } from 'zod'
import { ValidationError } from '../errors.js'
import { CanonicalMimeTypeSchema, DigestHexSchema, NonNegativeSafeIntegerSchema } from './common.js'
import { JsonObjectSchema } from './json-value.js'

export const V2_FIDELITY_MAX_PRESERVED = 256
export const V2_FIDELITY_MAX_CHANGES = 1_024

export const V2_CONVERTER_NAMES = [
  'canonical-jsonl',
  'trl-sft',
  'trl-dpo',
  'trl-grpo-rlvr',
  'ms-swift',
] as const

const CONVERTER_VERSION_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/
const CONVERTER_REGISTRY_NAME_PATTERN = /^[a-z][a-z0-9._-]{0,127}$/
const FIDELITY_REASON_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/
const IDENTITY_VALUE_IN_REASON_PATTERN = /(?:(?:rec|cand|sig|pref)_)?[0-9a-f]{64}/
const JSON_POINTER_PATTERN = /^(?:\/(?:[^~/]|~[01])*)*$/

const SuggestedFilenameV2Schema = z
  .string()
  .min(1)
  .max(255)
  .superRefine((value, context) => {
    if (value.includes('/') || value.includes('\\')) {
      context.addIssue({ code: 'custom', message: 'suggested filename cannot contain a path' })
      return
    }
    for (let index = 0; index < value.length; index += 1) {
      const codeUnit = value.charCodeAt(index)
      if (codeUnit <= 0x1f || codeUnit === 0x7f) {
        context.addIssue({ code: 'custom', message: 'suggested filename cannot contain controls' })
        return
      }
    }
  })

export const ConverterNameV2Schema = z.enum(V2_CONVERTER_NAMES).meta({ id: 'ConverterNameV2' })
export type ConverterNameV2 = z.infer<typeof ConverterNameV2Schema>

export const ConverterRegistryNameV2Schema = z
  .string()
  .regex(CONVERTER_REGISTRY_NAME_PATTERN)
  .meta({ id: 'ConverterRegistryNameV2' })
export type ConverterRegistryNameV2 = z.infer<typeof ConverterRegistryNameV2Schema>

export const ConverterTaskViewV2Schema = z.enum([
  'canonical',
  'sft',
  'dpo',
  'rlvr-grpo',
  'ms-swift',
])
export type ConverterTaskViewV2 = z.infer<typeof ConverterTaskViewV2Schema>

export const ConverterVersionV2Schema = z.string().regex(CONVERTER_VERSION_PATTERN)

export const FidelityActionV2Schema = z.enum(['transformed', 'dropped'])
export type FidelityActionV2 = z.infer<typeof FidelityActionV2Schema>

export const FidelityImpactV2Schema = z.enum(['none', 'informational', 'semantic'])
export type FidelityImpactV2 = z.infer<typeof FidelityImpactV2Schema>

export const FidelityChangeV2Schema = z
  .strictObject({
    path: z.string().max(1_024).regex(JSON_POINTER_PATTERN),
    action: FidelityActionV2Schema,
    impact: FidelityImpactV2Schema,
    reason: z
      .string()
      .max(128)
      .regex(FIDELITY_REASON_PATTERN)
      .refine((value) => !IDENTITY_VALUE_IN_REASON_PATTERN.test(value), {
        message: 'fidelity reason codes cannot contain entity IDs or digests',
      }),
  })
  .meta({ id: 'FidelityChangeV2' })
export type FidelityChangeV2 = z.infer<typeof FidelityChangeV2Schema>

export const FidelityV2Schema = z
  .strictObject({
    preserved: z.array(z.string().min(1).max(1_024)).max(V2_FIDELITY_MAX_PRESERVED),
    changes: z.array(FidelityChangeV2Schema).max(V2_FIDELITY_MAX_CHANGES),
  })
  .meta({ id: 'FidelityV2' })
export type FidelityV2 = z.infer<typeof FidelityV2Schema>

export const ConverterAnalysisV2Schema = z
  .strictObject({
    normalized_options: JsonObjectSchema,
    media_type: CanonicalMimeTypeSchema,
    suggested_filename: SuggestedFilenameV2Schema,
    output_count: NonNegativeSafeIntegerSchema,
    config_hints: JsonObjectSchema,
    fidelity: FidelityV2Schema,
  })
  .meta({ id: 'ConverterAnalysisV2' })
export type ConverterAnalysisV2 = z.infer<typeof ConverterAnalysisV2Schema>

export const ConverterDescriptorV2Schema = z
  .strictObject({
    name: ConverterNameV2Schema,
    version: ConverterVersionV2Schema,
    options_schema: JsonObjectSchema,
    media_type: CanonicalMimeTypeSchema,
    task_views: z.array(ConverterTaskViewV2Schema).min(1).max(5),
    export_fidelity_profile: z.literal(V2_EXPORT_FIDELITY_PROFILE),
  })
  .superRefine((descriptor, context) => {
    if (new Set(descriptor.task_views).size !== descriptor.task_views.length) {
      context.addIssue({
        code: 'custom',
        path: ['task_views'],
        message: 'converter task views must be unique',
      })
    }
  })
  .meta({ id: 'ConverterDescriptorV2' })
export type ConverterDescriptorV2 = z.infer<typeof ConverterDescriptorV2Schema>

export const ConverterRegistryPageV2Schema = z
  .strictObject({
    items: z.array(ConverterDescriptorV2Schema).max(V2_CONVERTER_NAMES.length),
    total: NonNegativeSafeIntegerSchema.max(V2_CONVERTER_NAMES.length),
  })
  .superRefine((page, context) => {
    validateCompleteRegistryPageV2(page, context)
  })
  .meta({ id: 'ConverterRegistryPageV2' })
export type ConverterRegistryPageV2 = z.infer<typeof ConverterRegistryPageV2Schema>

export const ConverterParamsV2Schema = z
  .strictObject({ name: ConverterRegistryNameV2Schema })
  .meta({ id: 'ConverterParamsV2' })
export type ConverterParamsV2 = z.infer<typeof ConverterParamsV2Schema>

export const InspectExportRequestV2Schema = z
  .strictObject({
    converter: ConverterNameV2Schema,
    options: JsonObjectSchema,
  })
  .meta({ id: 'InspectExportRequestV2' })
export type InspectExportRequestV2 = z.infer<typeof InspectExportRequestV2Schema>

const ExportFidelityIdentityFieldsV1Schema = z.strictObject({
  export_fidelity_profile: z.literal(V2_EXPORT_FIDELITY_PROFILE),
  identity_profile: z.literal(V2_IDENTITY_PROFILE),
  dataset_version: DigestHexSchema,
  converter: ConverterNameV2Schema,
  converter_version: ConverterVersionV2Schema,
  normalized_options: JsonObjectSchema,
  media_type: CanonicalMimeTypeSchema,
  output_count: NonNegativeSafeIntegerSchema,
  config_hints: JsonObjectSchema,
  fidelity: FidelityV2Schema,
})

export const ExportFidelityIdentityV1Schema = ExportFidelityIdentityFieldsV1Schema.superRefine(
  (identity, context) => {
    const normalized = normalizeFidelity(identity.fidelity)
    if (canonicalJsonV2(identity.fidelity) !== canonicalJsonV2(normalized)) {
      context.addIssue({
        code: 'custom',
        path: ['fidelity'],
        message: 'export fidelity identity must use normalized preserved and changes arrays',
      })
    }
  },
).meta({ id: 'ExportFidelityIdentityV1' })
export type ExportFidelityIdentityV1 = z.infer<typeof ExportFidelityIdentityV1Schema>

const ExportPlanInputV2Schema = z.strictObject({
  export_fidelity_profile: z.literal(V2_EXPORT_FIDELITY_PROFILE),
  dataset_version: DigestHexSchema,
  converter: ConverterNameV2Schema,
  converter_version: ConverterVersionV2Schema,
  normalized_options: JsonObjectSchema,
  media_type: CanonicalMimeTypeSchema,
  suggested_filename: SuggestedFilenameV2Schema,
  output_count: NonNegativeSafeIntegerSchema,
  config_hints: JsonObjectSchema,
  fidelity: FidelityV2Schema,
})
export type ExportPlanInputV2 = z.infer<typeof ExportPlanInputV2Schema>

export const ExportPlanV2Schema = ExportPlanInputV2Schema.extend({
  fidelity_digest: DigestHexSchema,
})
  .superRefine((plan, context) => {
    const identity = normalizeExportFidelityIdentityV2(exportFidelityIdentityFromPlan(plan))
    if (canonicalJsonV2(plan.fidelity) !== canonicalJsonV2(identity.fidelity)) {
      context.addIssue({
        code: 'custom',
        path: ['fidelity'],
        message: 'export plan fidelity arrays must be normalized',
      })
    }
    if (plan.fidelity_digest !== hashV2ExportFidelity(identity)) {
      context.addIssue({
        code: 'custom',
        path: ['fidelity_digest'],
        message: 'fidelity_digest must match the normalized export approval identity',
      })
    }
  })
  .meta({ id: 'ExportPlanV2' })
export type ExportPlanV2 = z.infer<typeof ExportPlanV2Schema>

export const ExportRequestV2Schema = z
  .strictObject({
    converter: ConverterNameV2Schema,
    options: JsonObjectSchema,
    accepted_fidelity_digest: DigestHexSchema.nullable(),
  })
  .meta({ id: 'ExportRequestV2' })
export type ExportRequestV2 = z.infer<typeof ExportRequestV2Schema>

export const FidelityErrorReasonV2Schema = z.enum([
  'semantic_loss_requires_approval',
  'fidelity_digest_mismatch',
])
export type FidelityErrorReasonV2 = z.infer<typeof FidelityErrorReasonV2Schema>

export const FidelityErrorDetailV2Schema = z
  .strictObject({
    reason: FidelityErrorReasonV2Schema,
    plan: ExportPlanV2Schema,
  })
  .meta({ id: 'FidelityErrorDetailV2' })
export type FidelityErrorDetailV2 = z.infer<typeof FidelityErrorDetailV2Schema>

export class FidelityErrorV2 extends ValidationError {
  override readonly name = 'FidelityErrorV2'
  override readonly code = 'fidelity_error'

  constructor(detailInput: FidelityErrorDetailV2) {
    const detail = deepFreeze(FidelityErrorDetailV2Schema.parse(detailInput))
    super(fidelityErrorMessage(detail.reason), detail)
  }
}

export function normalizeExportFidelityIdentityV2(
  input: HashExportFidelityIdentityV1,
): ExportFidelityIdentityV1 {
  const parsed = ExportFidelityIdentityFieldsV1Schema.parse(input)
  return ExportFidelityIdentityV1Schema.parse({
    ...parsed,
    fidelity: normalizeFidelity(parsed.fidelity),
  })
}

export function createExportPlanV2(input: ExportPlanInputV2): ExportPlanV2 {
  const parsed = ExportPlanInputV2Schema.parse(input)
  const identity = normalizeExportFidelityIdentityV2(exportFidelityIdentityFromPlan(parsed))
  return ExportPlanV2Schema.parse({
    ...parsed,
    fidelity: identity.fidelity,
    fidelity_digest: hashV2ExportFidelity(identity),
  })
}

export function hasSemanticFidelityLossV2(fidelity: FidelityV2): boolean {
  return FidelityV2Schema.parse(fidelity).changes.some((change) => change.impact === 'semantic')
}

export function assertExportFidelityAcceptedV2(
  planInput: ExportPlanV2,
  acceptedFidelityDigest: string | null,
): void {
  const plan = ExportPlanV2Schema.parse(planInput)
  if (acceptedFidelityDigest !== null && acceptedFidelityDigest !== plan.fidelity_digest) {
    throw new FidelityErrorV2({ reason: 'fidelity_digest_mismatch', plan })
  }
  if (acceptedFidelityDigest === null && hasSemanticFidelityLossV2(plan.fidelity)) {
    throw new FidelityErrorV2({ reason: 'semantic_loss_requires_approval', plan })
  }
}

function exportFidelityIdentityFromPlan(plan: ExportPlanInputV2): HashExportFidelityIdentityV1 {
  return {
    export_fidelity_profile: plan.export_fidelity_profile,
    identity_profile: V2_IDENTITY_PROFILE,
    dataset_version: plan.dataset_version,
    converter: plan.converter,
    converter_version: plan.converter_version,
    normalized_options: plan.normalized_options,
    media_type: plan.media_type,
    output_count: plan.output_count,
    config_hints: plan.config_hints,
    fidelity: plan.fidelity,
  }
}

function normalizeFidelity(fidelityInput: FidelityV2): FidelityV2 {
  const fidelity = FidelityV2Schema.parse(fidelityInput)
  const preserved = [...new Set(fidelity.preserved)].sort(compareJcsUtf16)
  const changesByCanonicalValue = new Map(
    fidelity.changes.map((change) => [canonicalJsonV2(change), change] as const),
  )
  const changes = [...changesByCanonicalValue.values()].sort(compareFidelityChanges)
  return FidelityV2Schema.parse({ preserved, changes })
}

function compareFidelityChanges(left: FidelityChangeV2, right: FidelityChangeV2): number {
  for (const key of ['path', 'action', 'impact', 'reason'] as const) {
    const result = compareJcsUtf16(left[key], right[key])
    if (result !== 0) return result
  }
  return 0
}

function validateCompleteRegistryPageV2(
  page: { readonly items: readonly ConverterDescriptorV2[]; readonly total: number },
  context: z.RefinementCtx,
): void {
  if (page.total !== page.items.length) {
    context.addIssue({
      code: 'custom',
      path: ['total'],
      message: 'registry total must equal the complete item count',
    })
  }
  for (let index = 1; index < page.items.length; index += 1) {
    const previous = page.items[index - 1]
    const current = page.items[index]
    if (previous && current && previous.name >= current.name) {
      context.addIssue({
        code: 'custom',
        path: ['items', index, 'name'],
        message: 'registry items must be strictly ASCII name sorted and unique',
      })
    }
  }
}

function fidelityErrorMessage(reason: FidelityErrorReasonV2): string {
  return reason === 'semantic_loss_requires_approval'
    ? 'V2 export semantic fidelity loss requires exact approval'
    : 'V2 export fidelity approval no longer matches the current plan'
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) {
      deepFreeze(child)
    }
    Object.freeze(value)
  }
  return value
}
