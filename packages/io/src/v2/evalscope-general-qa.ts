import {
  datasetVersionForSortedRecordRevisionsV2,
  type FidelityChangeV2,
  type FidelityV2,
  type JsonObjectV2,
  type RecordRevisionV2,
} from '@databench/schema'
import { z } from 'zod'

export const EVALSCOPE_GENERAL_QA_TARGET_SOURCES = [
  'selected-candidate',
  'verification-ground-truth',
  'none',
] as const

export type EvalScopeGeneralQaTargetSourceV2 = (typeof EVALSCOPE_GENERAL_QA_TARGET_SOURCES)[number]

export const EvalScopeGeneralQaOptionsV2Schema = z.strictObject({
  target_source: z.enum(EVALSCOPE_GENERAL_QA_TARGET_SOURCES),
})

export type EvalScopeGeneralQaOptionsV2 = z.infer<typeof EvalScopeGeneralQaOptionsV2Schema>

export const EVALSCOPE_GENERAL_QA_EXCLUSION_REASONS = [
  'prompt_empty',
  'prompt_not_user_terminated',
  'prompt_not_text_only',
  'tools_not_supported',
  'selected_candidate_missing',
  'selected_candidate_not_text_only',
  'verification_missing',
  'verification_ground_truth_not_string',
] as const

export type EvalScopeGeneralQaExclusionReasonV2 =
  (typeof EVALSCOPE_GENERAL_QA_EXCLUSION_REASONS)[number]

export interface EvalScopeGeneralQaProjectionV2 {
  readonly outputCount: number
  readonly fidelity: FidelityV2
  readonly configHints: JsonObjectV2
}

type ReadonlyRecordV2 = RecordRevisionV2['record']
type ReadonlyCandidateV2 = ReadonlyRecordV2['candidates'][number]
type CompatibleCandidateV2 = ReadonlyCandidateV2 & {
  readonly contents: readonly [
    ReadonlyCandidateV2['contents'][number] & {
      readonly role: 'ai'
      readonly parts: readonly [
        Extract<
          ReadonlyCandidateV2['contents'][number]['parts'][number],
          { readonly type: 'text' }
        >,
      ]
    },
  ]
}

interface EligibilityV2 {
  readonly reason: EvalScopeGeneralQaExclusionReasonV2 | null
  readonly compatibleSelected: readonly CompatibleCandidateV2[]
  readonly incompatibleSelectedCount: number
}

export function analyzeEvalScopeGeneralQaV2(
  records: readonly RecordRevisionV2[],
  options: EvalScopeGeneralQaOptionsV2,
): EvalScopeGeneralQaProjectionV2 {
  const exclusionCounts = new Map<EvalScopeGeneralQaExclusionReasonV2, number>()
  const fidelity = new FidelityCollectorV2(['/contents'])
  let outputCount = 0
  let excludedRecords = 0

  recordProjectionFidelity(records, options.target_source, fidelity)
  for (const revision of records) {
    const eligibility = inspectEligibility(revision.record, options.target_source)
    if (eligibility.reason !== null) {
      excludedRecords += 1
      exclusionCounts.set(eligibility.reason, (exclusionCounts.get(eligibility.reason) ?? 0) + 1)
      fidelity.change('', 'dropped', 'semantic', 'evalscope_ineligible_record_excluded')
      continue
    }

    outputCount +=
      options.target_source === 'selected-candidate' ? eligibility.compatibleSelected.length : 1
    if (eligibility.incompatibleSelectedCount > 0) {
      fidelity.change(
        '/candidates',
        'dropped',
        'semantic',
        'selected_candidate_not_text_only_excluded',
      )
    }
  }

  const excludedByReason: Record<string, number> = {}
  for (const reason of EVALSCOPE_GENERAL_QA_EXCLUSION_REASONS) {
    const count = exclusionCounts.get(reason)
    if (count !== undefined) excludedByReason[reason] = count
  }

  return deepFreeze({
    outputCount,
    fidelity: fidelity.finish(),
    configHints: {
      evalscope: {
        benchmark: 'general_qa',
        subset: 'databench',
        total_records: records.length,
        output_count: outputCount,
        excluded_records: excludedRecords,
        excluded_by_reason: excludedByReason,
      },
    },
  })
}

export function* rowsEvalScopeGeneralQaV2(
  records: readonly RecordRevisionV2[],
  options: EvalScopeGeneralQaOptionsV2,
): IterableIterator<JsonObjectV2> {
  const datasetVersion = datasetVersionForSortedRecordRevisionsV2(records)
  for (const revision of records) {
    const eligibility = inspectEligibility(revision.record, options.target_source)
    if (eligibility.reason !== null) continue

    const messages = revision.record.contents.map((content) => {
      const part = content.parts[0]
      if (part?.type !== 'text') {
        throw new TypeError('EvalScope general_qa eligibility drifted while rendering prompt')
      }
      return {
        role: content.role === 'ai' ? 'assistant' : content.role,
        content: part.text,
      }
    })
    const locator = {
      dataset_version: datasetVersion,
      record_id: revision.record.id,
      record_digest: revision.record_digest,
    }

    if (options.target_source === 'selected-candidate') {
      for (const candidate of eligibility.compatibleSelected) {
        yield {
          messages,
          response: candidate.contents[0].parts[0].text,
          _databench: { ...locator, candidate_id: candidate.id },
        }
      }
      continue
    }

    if (options.target_source === 'verification-ground-truth') {
      const groundTruth = revision.record.verification?.ground_truth
      if (typeof groundTruth !== 'string') {
        throw new TypeError('EvalScope general_qa eligibility drifted while rendering ground truth')
      }
      yield { messages, response: groundTruth, _databench: locator }
      continue
    }

    yield { messages, _databench: locator }
  }
}

function inspectEligibility(
  record: ReadonlyRecordV2,
  targetSource: EvalScopeGeneralQaTargetSourceV2,
): EligibilityV2 {
  const commonReason = inspectCommonEligibility(record)
  if (commonReason !== null) {
    return { reason: commonReason, compatibleSelected: [], incompatibleSelectedCount: 0 }
  }

  if (targetSource === 'selected-candidate') {
    const selected = record.candidates.filter((candidate) => candidate.selected === true)
    const compatibleSelected = selected.filter(isCompatibleSelectedCandidate)
    return {
      reason:
        compatibleSelected.length > 0
          ? null
          : selected.length === 0
            ? 'selected_candidate_missing'
            : 'selected_candidate_not_text_only',
      compatibleSelected,
      incompatibleSelectedCount: selected.length - compatibleSelected.length,
    }
  }

  if (targetSource === 'verification-ground-truth') {
    if (record.verification === null) {
      return {
        reason: 'verification_missing',
        compatibleSelected: [],
        incompatibleSelectedCount: 0,
      }
    }
    if (typeof record.verification.ground_truth !== 'string') {
      return {
        reason: 'verification_ground_truth_not_string',
        compatibleSelected: [],
        incompatibleSelectedCount: 0,
      }
    }
  }

  return { reason: null, compatibleSelected: [], incompatibleSelectedCount: 0 }
}

function inspectCommonEligibility(
  record: ReadonlyRecordV2,
): EvalScopeGeneralQaExclusionReasonV2 | null {
  if (record.contents.length === 0) return 'prompt_empty'
  if (record.contents.at(-1)?.role !== 'user') return 'prompt_not_user_terminated'
  if (!record.contents.every(isPlainTextContent)) return 'prompt_not_text_only'
  if (record.tools.length > 0) return 'tools_not_supported'
  return null
}

function isPlainTextContent(content: ReadonlyRecordV2['contents'][number]): boolean {
  const part = content.parts[0]
  return content.parts.length === 1 && part?.type === 'text' && part.thought === false
}

function isCompatibleSelectedCandidate(
  candidate: ReadonlyCandidateV2,
): candidate is CompatibleCandidateV2 {
  const content = candidate.contents[0]
  const part = content?.parts[0]
  return (
    candidate.contents.length === 1 &&
    content?.role === 'ai' &&
    content.parts.length === 1 &&
    part?.type === 'text' &&
    part.thought === false
  )
}

function recordProjectionFidelity(
  records: readonly RecordRevisionV2[],
  targetSource: EvalScopeGeneralQaTargetSourceV2,
  fidelity: FidelityCollectorV2,
): void {
  fidelity.change('/contents', 'transformed', 'none', 'canonical_roles_to_evalscope_roles')
  fidelity.change('/id', 'transformed', 'none', 'canonical_identity_to_databench_locator')
  for (const revision of records) {
    const record = revision.record
    for (const path of [
      '/schema_version',
      '/source',
      '/lang',
      '/lineage',
      '/tags',
      '/extra',
    ] as const) {
      if (recordFieldHasInformation(record, path)) {
        fidelity.change(
          path,
          'dropped',
          'informational',
          'canonical_metadata_not_used_by_evaluation',
        )
      }
    }
    if (
      record.contents.some(
        (content) =>
          content.loss_weight !== null ||
          content.parts.some(
            (part) => part.thought_signature !== null || Object.keys(part.part_metadata).length > 0,
          ),
      )
    ) {
      fidelity.change(
        '/contents',
        'dropped',
        'informational',
        'training_metadata_not_used_by_evaluation',
      )
    }
  }

  if (targetSource === 'selected-candidate') {
    fidelity.preserve('/candidates')
    fidelity.change(
      '/candidates',
      'transformed',
      'none',
      'selected_candidate_text_to_evalscope_response',
    )
    recordCandidateMetadataFidelity(records, fidelity)
    if (
      records.some(({ record }) =>
        record.candidates.some((candidate) => candidate.selected !== true),
      )
    ) {
      fidelity.change(
        '/candidates',
        'dropped',
        'semantic',
        'non_selected_candidates_not_used_as_reference',
      )
    }
    if (records.some(({ record }) => record.verification !== null)) {
      fidelity.change('/verification', 'dropped', 'semantic', 'verification_not_used_as_reference')
    }
  } else if (targetSource === 'verification-ground-truth') {
    fidelity.preserve('/verification')
    fidelity.change(
      '/verification',
      'transformed',
      'none',
      'verification_ground_truth_to_evalscope_response',
    )
    if (records.some(({ record }) => record.verification !== null)) {
      fidelity.change(
        '/verification',
        'dropped',
        'informational',
        'verification_metadata_not_used_by_evaluation',
      )
    }
    if (records.some(({ record }) => record.candidates.length > 0)) {
      fidelity.change('/candidates', 'dropped', 'semantic', 'candidates_not_used_as_reference')
    }
  } else {
    fidelity.change('', 'dropped', 'semantic', 'reference_omitted_requires_judge')
    if (records.some(({ record }) => record.candidates.length > 0)) {
      fidelity.change('/candidates', 'dropped', 'semantic', 'candidates_not_used_as_reference')
    }
    if (records.some(({ record }) => record.verification !== null)) {
      fidelity.change('/verification', 'dropped', 'semantic', 'verification_not_used_as_reference')
    }
  }

  if (records.some(({ record }) => record.preference_relations.length > 0)) {
    fidelity.change(
      '/preference_relations',
      'dropped',
      'semantic',
      'preference_relations_not_interpreted_as_qa_reference',
    )
  }
  if (records.some(({ record }) => record.tools.length > 0)) {
    fidelity.change('/tools', 'dropped', 'semantic', 'tools_not_supported_by_general_qa')
  }
}

function recordCandidateMetadataFidelity(
  records: readonly RecordRevisionV2[],
  fidelity: FidelityCollectorV2,
): void {
  if (
    records.some(({ record }) =>
      record.candidates.some(
        (candidate) =>
          candidate.finish_reason !== null ||
          candidate.rank !== null ||
          candidate.signals.length > 0 ||
          candidate.generator !== null ||
          candidate.token_count !== null ||
          candidate.avg_logprobs !== null ||
          candidate.contents.some(
            (content) =>
              content.loss_weight !== null ||
              content.parts.some(
                (part) =>
                  part.thought_signature !== null || Object.keys(part.part_metadata).length > 0,
              ),
          ),
      ),
    )
  ) {
    fidelity.change(
      '/candidates',
      'dropped',
      'informational',
      'candidate_training_metadata_not_used_by_evaluation',
    )
  }
}

function recordFieldHasInformation(
  record: ReadonlyRecordV2,
  path: '/schema_version' | '/source' | '/lang' | '/lineage' | '/tags' | '/extra',
): boolean {
  switch (path) {
    case '/schema_version':
      return true
    case '/source':
      return record.source !== null
    case '/lang':
      return record.lang !== null
    case '/lineage':
      return record.lineage !== null
    case '/tags':
      return record.tags.length > 0
    case '/extra':
      return Object.keys(record.extra).length > 0
  }
}

class FidelityCollectorV2 {
  readonly #preserved = new Set<string>()
  readonly #changes = new Map<string, FidelityChangeV2>()

  constructor(preserved: readonly string[]) {
    for (const path of preserved) this.#preserved.add(path)
  }

  preserve(path: string): void {
    this.#preserved.add(path)
  }

  change(
    path: FidelityChangeV2['path'],
    action: FidelityChangeV2['action'],
    impact: FidelityChangeV2['impact'],
    reason: FidelityChangeV2['reason'],
  ): void {
    const change = { path, action, impact, reason }
    this.#changes.set(`${path}\0${action}\0${impact}\0${reason}`, change)
  }

  finish(): FidelityV2 {
    return {
      preserved: [...this.#preserved],
      changes: [...this.#changes.values()],
    }
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}
