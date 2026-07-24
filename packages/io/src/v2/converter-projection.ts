import type {
  FidelityChangeV2,
  FidelityV2,
  JsonObjectV2,
  JsonValueV2,
  RecordRevisionV2,
} from '@databench/schema'
import { deterministicJsonV2 } from './deterministic-json.js'

type ReadonlyRecordV2 = RecordRevisionV2['record']
type ReadonlyContentV2 = ReadonlyRecordV2['contents'][number]
type ReadonlyCandidateV2 = ReadonlyRecordV2['candidates'][number]
type ReadonlyPartV2 = ReadonlyContentV2['parts'][number]
type ReadonlyPreferenceRelationV2 = ReadonlyRecordV2['preference_relations'][number]
type ReadonlyToolV2 = ReadonlyRecordV2['tools'][number]

const CANONICAL_TOP_LEVEL_PATHS = [
  '/schema_version',
  '/id',
  '/contents',
  '/candidates',
  '/preference_relations',
  '/tools',
  '/verification',
  '/source',
  '/lang',
  '/lineage',
  '/tags',
  '/extra',
] as const

export type TrainerProjectionKindV2 = 'trl-sft' | 'trl-dpo' | 'trl-grpo-rlvr' | 'ms-swift'

export interface ConverterProjectionV2 {
  readonly outputCount: number
  readonly fidelity: FidelityV2
  readonly configHints: JsonObjectV2
}

interface RenderOptionsV2 {
  readonly includeLossScale: boolean
  readonly path: '/contents' | '/candidates'
}

interface RenderStateV2 {
  readonly calls: Map<string, { readonly name: string }>
  readonly fidelity: FidelityCollectorV2
}

export function canonicalFidelityV2(): FidelityV2 {
  return {
    preserved: [...CANONICAL_TOP_LEVEL_PATHS],
    changes: [],
  }
}

export function analyzeTrlSftV2(records: readonly RecordRevisionV2[]): ConverterProjectionV2 {
  const fidelity = createTrainerFidelity('/candidates')
  let outputCount = 0

  for (const revision of records) {
    const record = revision.record
    recordCommonTrainerChanges(record, fidelity)
    const selected = record.candidates.filter((candidate) => candidate.selected === true)
    outputCount += selected.length
    if (selected.length > 0) {
      fidelity.change('/candidates', 'transformed', 'none', 'selected_candidate_row_projection')
    } else {
      fidelity.change('', 'dropped', 'semantic', 'sft_ineligible_record_excluded')
    }
    if (selected.length !== record.candidates.length) {
      fidelity.change('/candidates', 'dropped', 'informational', 'non_selected_candidates_excluded')
      fidelity.change(
        '/candidates',
        'dropped',
        'semantic',
        'non_selected_candidate_state_not_exported',
      )
    }
    if (record.preference_relations.length > 0) {
      fidelity.change(
        '/preference_relations',
        'dropped',
        'informational',
        'preference_evidence_not_used_by_sft',
      )
      if (activeDirectionalRelations(record).length > 0) {
        fidelity.change(
          '/preference_relations',
          'dropped',
          'semantic',
          'preference_direction_not_exported',
        )
      }
    }
    if (record.verification !== null) {
      fidelity.change('/verification', 'dropped', 'informational', 'verification_not_used_by_sft')
    }

    if (selected.length > 0) {
      inspectTrlContentsFidelity(record.contents, '/contents', fidelity)
    }
    for (const candidate of selected) {
      candidateMetadataChanges(candidate, fidelity)
      inspectTrlContentsFidelity(candidate.contents, '/candidates', fidelity)
    }
  }

  return freezeProjection({
    outputCount,
    fidelity: fidelity.finish(),
    configHints: {
      dataset_format: 'conversational_prompt_completion',
      completion_only_loss: true,
      assistant_only_loss: true,
    },
  })
}

export function* rowsTrlSftV2(
  records: readonly RecordRevisionV2[],
): IterableIterator<JsonObjectV2> {
  for (const revision of records) {
    const record = revision.record
    for (const candidate of record.candidates) {
      if (candidate.selected !== true) continue
      const fidelity = new FidelityCollectorV2([])
      const state = createRenderState(fidelity)
      yield {
        prompt: renderPrompt(record, state, { includeLossScale: false, path: '/contents' }),
        completion: renderContents(candidate.contents, state, {
          includeLossScale: false,
          path: '/candidates',
        }),
        tools: renderTools(record.tools),
      }
    }
  }
}

export function analyzeTrlDpoV2(records: readonly RecordRevisionV2[]): ConverterProjectionV2 {
  const fidelity = createTrainerFidelity('/preference_relations')
  let outputCount = 0

  for (const revision of records) {
    const record = revision.record
    recordCommonTrainerChanges(record, fidelity)
    const candidates = new Map(record.candidates.map((candidate) => [candidate.id, candidate]))
    const activeRelations = activeDirectionalRelations(record)
    outputCount += activeRelations.length
    if (activeRelations.length > 0) {
      fidelity.change(
        '/preference_relations',
        'transformed',
        'none',
        'preference_direction_to_chosen_rejected',
      )
    } else {
      fidelity.change('', 'dropped', 'semantic', 'dpo_ineligible_record_excluded')
    }
    if (activeRelations.length !== record.preference_relations.length) {
      fidelity.change(
        '/preference_relations',
        'dropped',
        'informational',
        'non_directional_or_superseded_preferences_excluded',
      )
    }
    if (record.verification !== null) {
      fidelity.change('/verification', 'dropped', 'informational', 'verification_not_used_by_dpo')
    }
    if (record.candidates.some((candidate) => candidate.selected !== null)) {
      fidelity.change('/candidates', 'dropped', 'semantic', 'selection_state_not_used_by_dpo')
    }

    const referencedCandidateIds = new Set<string>()
    if (activeRelations.length > 0) {
      fidelity.change(
        '/preference_relations',
        'dropped',
        'informational',
        'preference_evidence_metadata_not_exported',
      )
      inspectTrlContentsFidelity(record.contents, '/contents', fidelity)
    }
    for (const relation of activeRelations) {
      referencedCandidateIds.add(relation.left_candidate_id)
      referencedCandidateIds.add(relation.right_candidate_id)
      if (relation.criterion !== null) {
        fidelity.change(
          '/preference_relations',
          'dropped',
          'semantic',
          'preference_criterion_not_represented',
        )
      }
    }
    for (const candidateId of referencedCandidateIds) {
      const candidate = candidates.get(candidateId)
      if (!candidate) {
        throw new TypeError('DPO projection received a relation with an unresolved candidate')
      }
      candidateMetadataChanges(candidate, fidelity)
      inspectTrlContentsFidelity(candidate.contents, '/candidates', fidelity)
      if (candidate.contents.some((content) => content.role === 'user')) {
        fidelity.change(
          '/candidates',
          'dropped',
          'semantic',
          'candidate_loss_mask_not_representable_by_dpo',
        )
      }
    }
    if (record.candidates.some((candidate) => !referencedCandidateIds.has(candidate.id))) {
      fidelity.change(
        '/candidates',
        'dropped',
        'informational',
        'candidates_outside_directional_pairs_excluded',
      )
    }
  }

  return freezeProjection({
    outputCount,
    fidelity: fidelity.finish(),
    configHints: {
      dataset_format: 'conversational_preference',
    },
  })
}

export function* rowsTrlDpoV2(
  records: readonly RecordRevisionV2[],
): IterableIterator<JsonObjectV2> {
  for (const revision of records) {
    const record = revision.record
    const candidates = new Map(record.candidates.map((candidate) => [candidate.id, candidate]))
    for (const relation of activeDirectionalRelations(record)) {
      const left = candidates.get(relation.left_candidate_id)
      const right = candidates.get(relation.right_candidate_id)
      if (!left || !right) {
        throw new TypeError('DPO projection received a relation with an unresolved candidate')
      }
      const chosen = relation.outcome === 'left' ? left : right
      const rejected = relation.outcome === 'left' ? right : left
      const fidelity = new FidelityCollectorV2([])
      const promptState = createRenderState(fidelity)
      const prompt = renderPrompt(record, promptState, {
        includeLossScale: false,
        path: '/contents',
      })
      yield {
        prompt,
        chosen: renderContents(chosen.contents, cloneRenderStateForCandidate(promptState), {
          includeLossScale: false,
          path: '/candidates',
        }),
        rejected: renderContents(rejected.contents, cloneRenderStateForCandidate(promptState), {
          includeLossScale: false,
          path: '/candidates',
        }),
        tools: renderTools(record.tools),
      }
    }
  }
}

export function analyzeTrlGrpoRlvrV2(records: readonly RecordRevisionV2[]): ConverterProjectionV2 {
  const fidelity = createTrainerFidelity('/verification')
  let outputCount = 0

  for (const revision of records) {
    const record = revision.record
    recordCommonTrainerChanges(record, fidelity)
    if (record.candidates.length > 0) {
      fidelity.change(
        '/candidates',
        'dropped',
        'informational',
        'existing_rollouts_not_used_by_rlvr_prompt',
      )
      if (record.candidates.some((candidate) => candidate.selected !== null)) {
        fidelity.change('/candidates', 'dropped', 'semantic', 'selection_state_not_used_by_rlvr')
      }
    }
    if (record.preference_relations.length > 0) {
      fidelity.change(
        '/preference_relations',
        'dropped',
        'informational',
        'preference_evidence_not_used_by_rlvr',
      )
      if (activeDirectionalRelations(record).length > 0) {
        fidelity.change(
          '/preference_relations',
          'dropped',
          'semantic',
          'preference_direction_not_exported',
        )
      }
    }
    if (record.verification === null) {
      fidelity.change('', 'dropped', 'semantic', 'rlvr_ineligible_record_excluded')
      continue
    }
    outputCount += 1
    inspectTrlContentsFidelity(record.contents, '/contents', fidelity)
  }

  return freezeProjection({
    outputCount,
    fidelity: fidelity.finish(),
    configHints: {
      dataset_format: 'conversational_prompt',
      reward_column: 'verification',
    },
  })
}

export function* rowsTrlGrpoRlvrV2(
  records: readonly RecordRevisionV2[],
): IterableIterator<JsonObjectV2> {
  for (const revision of records) {
    const record = revision.record
    if (record.verification === null) continue
    const state = createRenderState(new FidelityCollectorV2([]))
    yield {
      prompt: renderPrompt(record, state, { includeLossScale: false, path: '/contents' }),
      tools: renderTools(record.tools),
      verification: {
        verifier: record.verification.verifier,
        verifier_version: record.verification.verifier_version,
        ground_truth: record.verification.ground_truth,
        constraint: record.verification.constraint,
        config: record.verification.config,
      },
    }
  }
}

export function analyzeMsSwiftV2(records: readonly RecordRevisionV2[]): ConverterProjectionV2 {
  const fidelity = createTrainerFidelity('/candidates')
  let binaryLossScale = true
  let outputCount = 0

  for (const revision of records) {
    const record = revision.record
    recordCommonTrainerChanges(record, fidelity)
    const selected = record.candidates.filter((candidate) => candidate.selected === true)
    outputCount += selected.length
    if (selected.length > 0) {
      fidelity.change('/candidates', 'transformed', 'none', 'selected_candidate_row_projection')
    } else {
      fidelity.change('', 'dropped', 'semantic', 'ms_swift_ineligible_record_excluded')
    }
    if (selected.length !== record.candidates.length) {
      fidelity.change('/candidates', 'dropped', 'informational', 'non_selected_candidates_excluded')
      fidelity.change(
        '/candidates',
        'dropped',
        'semantic',
        'non_selected_candidate_state_not_exported',
      )
    }
    if (record.preference_relations.length > 0) {
      fidelity.change(
        '/preference_relations',
        'dropped',
        'informational',
        'preference_evidence_not_used_by_ms_swift_sft',
      )
      if (activeDirectionalRelations(record).length > 0) {
        fidelity.change(
          '/preference_relations',
          'dropped',
          'semantic',
          'preference_direction_not_exported',
        )
      }
    }
    if (record.verification !== null) {
      fidelity.change(
        '/verification',
        'dropped',
        'informational',
        'verification_not_used_by_ms_swift_sft',
      )
    }

    if (selected.length > 0) {
      inspectMsSwiftContentsFidelity(record.contents, '/contents', fidelity)
      binaryLossScale =
        binaryLossScale && msSwiftContentsUseBinaryLossScale(record.contents, '/contents')
    }
    for (const candidate of selected) {
      candidateMetadataChanges(candidate, fidelity)
      inspectMsSwiftContentsFidelity(candidate.contents, '/candidates', fidelity)
      binaryLossScale =
        binaryLossScale && msSwiftContentsUseBinaryLossScale(candidate.contents, '/candidates')
    }
  }

  return freezeProjection({
    outputCount,
    fidelity: fidelity.finish(),
    configHints: {
      dataset_format: 'messages',
      minimum_version: '4.2.0',
      is_binary_loss_scale: binaryLossScale,
    },
  })
}

export function* rowsMsSwiftV2(
  records: readonly RecordRevisionV2[],
): IterableIterator<JsonObjectV2> {
  for (const revision of records) {
    const record = revision.record
    for (const candidate of record.candidates) {
      if (candidate.selected !== true) continue
      const fidelity = new FidelityCollectorV2([])
      const messages = renderMsSwiftPrompt(record, fidelity)
      messages.push(...renderMsSwiftContents(candidate.contents, '/candidates', fidelity))
      yield {
        messages,
        tools: deterministicJsonV2(renderTools(record.tools)),
      }
    }
  }
}

function renderMsSwiftPrompt(
  record: ReadonlyRecordV2,
  fidelity: FidelityCollectorV2,
): JsonObjectV2[] {
  return renderMsSwiftContents(record.contents, '/contents', fidelity)
}

function renderMsSwiftContents(
  contents: readonly ReadonlyContentV2[],
  path: '/contents' | '/candidates',
  fidelity: FidelityCollectorV2,
): JsonObjectV2[] {
  const messages: JsonObjectV2[] = []
  for (const content of contents) {
    fidelity.change(path, 'transformed', 'none', 'canonical_roles_to_ms_swift_roles')
    if (content.parts.length > 1) {
      fidelity.change(path, 'transformed', 'semantic', 'part_boundaries_not_representable')
    }
    const lossScale = resolveLossScale(content, path)
    let pendingText = ''
    let hasPendingText = false
    const flushText = (): void => {
      if (!hasPendingText) return
      messages.push({
        role: trainerMessageRole(content.role),
        content: pendingText,
        ...(content.role === 'ai' ? { loss_scale: lossScale } : {}),
      })
      pendingText = ''
      hasPendingText = false
    }

    for (const part of content.parts) {
      inspectPartFidelity(part, path, fidelity)
      if (part.type === 'text') {
        pendingText += part.text
        hasPendingText = true
        continue
      }
      flushText()
      if (part.type === 'function_call') {
        messages.push({
          role: 'tool_call',
          content: deterministicJsonV2({
            name: part.function_call.name,
            arguments: part.function_call.args,
          }),
          loss_scale: lossScale,
        })
        fidelity.change(path, 'transformed', 'none', 'function_call_to_ms_swift_tool_call')
        fidelity.change(path, 'dropped', 'semantic', 'function_call_id_not_representable')
        continue
      }
      if (part.type === 'function_response') {
        messages.push({
          role: 'tool_response',
          content: deterministicJsonV2(part.function_response.response),
        })
        fidelity.change(path, 'transformed', 'none', 'function_response_to_ms_swift_tool_response')
        fidelity.change(path, 'dropped', 'semantic', 'function_call_id_not_representable')
        if (
          content.loss_weight !== null &&
          content.loss_weight !== defaultLossWeight(content, path)
        ) {
          fidelity.change(
            path,
            'dropped',
            'semantic',
            'tool_response_loss_weight_not_representable',
          )
        }
      }
      // file_data is rejected through semantic fidelity and omitted.
    }
    flushText()

    if (content.role === 'user' && lossScale !== 0) {
      fidelity.change(path, 'dropped', 'semantic', 'user_loss_weight_not_representable')
    }
  }
  return messages
}

function msSwiftContentsUseBinaryLossScale(
  contents: readonly ReadonlyContentV2[],
  path: '/contents' | '/candidates',
): boolean {
  return contents.every((content) => {
    if (content.role !== 'ai') return true
    const value = resolveLossScale(content, path)
    return value === 0 || value === 1
  })
}

export function activeDirectionalRelations(
  record: ReadonlyRecordV2,
): readonly ReadonlyPreferenceRelationV2[] {
  const superseded = new Set(
    record.preference_relations.flatMap((relation) =>
      relation.supersedes === null ? [] : [relation.supersedes],
    ),
  )
  return record.preference_relations.filter(
    (relation) =>
      !superseded.has(relation.id) &&
      relation.status === 'adjudicated' &&
      (relation.outcome === 'left' || relation.outcome === 'right'),
  )
}

function renderPrompt(
  record: ReadonlyRecordV2,
  state: RenderStateV2,
  options: RenderOptionsV2,
): JsonObjectV2[] {
  return renderContents(record.contents, state, options)
}

function renderContents(
  contents: readonly ReadonlyContentV2[],
  state: RenderStateV2,
  options: RenderOptionsV2,
): JsonObjectV2[] {
  const messages: JsonObjectV2[] = []
  for (const content of contents) {
    inspectContentFidelity(content, options, state.fidelity)
    const lossScale = resolveLossScale(content, options.path)
    let pendingText = ''
    let hasPendingText = false

    const flushText = (): void => {
      if (!hasPendingText) return
      const message: JsonObjectV2 = {
        role: trainerMessageRole(content.role),
        content: pendingText,
        ...(options.includeLossScale ? { loss_scale: lossScale } : {}),
      }
      messages.push(message)
      pendingText = ''
      hasPendingText = false
    }

    for (const part of content.parts) {
      if (part.type === 'text') {
        pendingText += part.text
        hasPendingText = true
        continue
      }
      flushText()
      if (part.type === 'function_call') {
        const call = part.function_call
        state.calls.set(call.id, { name: call.name })
        const message: JsonObjectV2 = {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: call.id,
              type: 'function',
              function: {
                name: call.name,
                arguments: call.args,
              },
            },
          ],
          ...(options.includeLossScale ? { loss_scale: lossScale } : {}),
        }
        messages.push(message)
        state.fidelity.change(
          options.path,
          'transformed',
          'none',
          'function_call_to_trainer_tool_call',
        )
        continue
      }
      if (part.type === 'function_response') {
        const response = part.function_response
        const call = state.calls.get(response.call_id)
        const message: JsonObjectV2 = {
          role: 'tool',
          content: deterministicJsonV2(response.response),
          tool_call_id: response.call_id,
          ...(call ? { name: call.name } : {}),
          ...(options.includeLossScale ? { loss_scale: lossScale } : {}),
        }
        messages.push(message)
        state.fidelity.change(
          options.path,
          'transformed',
          'none',
          'function_response_to_trainer_tool_message',
        )
      }
      // file_data has no portable trainer representation. The semantic
      // fidelity change is collected above; it is deliberately not replaced
      // with invented prompt text.
    }
    flushText()
  }
  return messages
}

function inspectContentFidelity(
  content: ReadonlyContentV2,
  options: RenderOptionsV2,
  fidelity: FidelityCollectorV2,
): void {
  fidelity.change(options.path, 'transformed', 'none', 'canonical_roles_to_trainer_roles')
  if (content.parts.length > 1) {
    fidelity.change(options.path, 'transformed', 'semantic', 'part_boundaries_not_representable')
  }
  for (const part of content.parts) {
    inspectPartFidelity(part, options.path, fidelity)
  }
  const expectedWeight = defaultLossWeight(content, options.path)
  if (
    !options.includeLossScale &&
    content.loss_weight !== null &&
    content.loss_weight !== expectedWeight
  ) {
    fidelity.change(options.path, 'dropped', 'semantic', 'custom_loss_weight_not_representable')
  }
}

function inspectTrlContentsFidelity(
  contents: readonly ReadonlyContentV2[],
  path: '/contents' | '/candidates',
  fidelity: FidelityCollectorV2,
): void {
  for (const content of contents) {
    inspectContentFidelity(content, { includeLossScale: false, path }, fidelity)
    for (const part of content.parts) {
      if (part.type === 'function_call') {
        fidelity.change(path, 'transformed', 'none', 'function_call_to_trainer_tool_call')
      }
      if (part.type === 'function_response') {
        fidelity.change(path, 'transformed', 'none', 'function_response_to_trainer_tool_message')
      }
    }
  }
}

function inspectMsSwiftContentsFidelity(
  contents: readonly ReadonlyContentV2[],
  path: '/contents' | '/candidates',
  fidelity: FidelityCollectorV2,
): void {
  let previousToolCallLossScale: number | null = null
  for (const content of contents) {
    fidelity.change(path, 'transformed', 'none', 'canonical_roles_to_ms_swift_roles')
    if (content.parts.length > 1) {
      fidelity.change(path, 'transformed', 'semantic', 'part_boundaries_not_representable')
    }
    const lossScale = resolveLossScale(content, path)
    for (const part of content.parts) {
      inspectPartFidelity(part, path, fidelity)
      if (part.type === 'function_call') {
        fidelity.change(path, 'transformed', 'none', 'function_call_to_ms_swift_tool_call')
        fidelity.change(path, 'dropped', 'semantic', 'function_call_id_not_representable')
        if (previousToolCallLossScale !== null && previousToolCallLossScale !== lossScale) {
          fidelity.change(
            path,
            'dropped',
            'semantic',
            'consecutive_tool_call_loss_scale_not_representable',
          )
        }
        previousToolCallLossScale = lossScale
      }
      if (part.type === 'function_response') {
        fidelity.change(path, 'transformed', 'none', 'function_response_to_ms_swift_tool_response')
        fidelity.change(path, 'dropped', 'semantic', 'function_call_id_not_representable')
        if (
          content.loss_weight !== null &&
          content.loss_weight !== defaultLossWeight(content, path)
        ) {
          fidelity.change(
            path,
            'dropped',
            'semantic',
            'tool_response_loss_weight_not_representable',
          )
        }
        previousToolCallLossScale = null
      }
      if (part.type === 'text' || part.type === 'file_data') {
        previousToolCallLossScale = null
      }
    }
    if (content.role === 'user' && lossScale !== 0) {
      fidelity.change(path, 'dropped', 'semantic', 'user_loss_weight_not_representable')
    }
  }
}

function inspectPartFidelity(
  part: ReadonlyPartV2,
  path: '/contents' | '/candidates',
  fidelity: FidelityCollectorV2,
): void {
  if (part.type === 'file_data') {
    fidelity.change(path, 'dropped', 'semantic', 'file_data_not_representable')
  }
  if (part.thought) {
    fidelity.change(path, 'dropped', 'semantic', 'thought_marker_not_representable')
  }
  if (part.thought_signature !== null) {
    fidelity.change(path, 'dropped', 'informational', 'thought_signature_not_exported')
  }
  if (Object.keys(part.part_metadata).length > 0) {
    fidelity.change(path, 'dropped', 'informational', 'part_metadata_not_exported')
  }
}

function defaultLossWeight(content: ReadonlyContentV2, path: '/contents' | '/candidates'): number {
  if (path === '/contents') return 0
  return content.role === 'ai' ? 1 : 0
}

function resolveLossScale(content: ReadonlyContentV2, path: '/contents' | '/candidates'): number {
  return content.loss_weight ?? defaultLossWeight(content, path)
}

function renderTools(tools: readonly ReadonlyToolV2[]): JsonValueV2[] {
  return tools.map((tool) => {
    const fn: JsonObjectV2 = {
      name: tool.name,
      parameters: tool.input_schema,
      ...(tool.description !== null ? { description: tool.description } : {}),
    }
    return {
      type: 'function',
      function: fn,
    }
  })
}

function recordCommonTrainerChanges(record: ReadonlyRecordV2, fidelity: FidelityCollectorV2): void {
  for (const path of [
    '/schema_version',
    '/id',
    '/source',
    '/lang',
    '/lineage',
    '/tags',
    '/extra',
  ] as const) {
    if (recordFieldHasInformation(record, path)) {
      fidelity.change(path, 'dropped', 'informational', 'canonical_metadata_not_exported')
    }
  }
  if (record.tools.length > 0) {
    fidelity.change('/tools', 'transformed', 'none', 'canonical_tools_to_trainer_tools')
  }
}

function recordFieldHasInformation(
  record: ReadonlyRecordV2,
  path: '/schema_version' | '/id' | '/source' | '/lang' | '/lineage' | '/tags' | '/extra',
): boolean {
  switch (path) {
    case '/schema_version':
    case '/id':
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

function candidateMetadataChanges(
  candidate: ReadonlyCandidateV2,
  fidelity: FidelityCollectorV2,
): void {
  if (
    candidate.finish_reason !== null ||
    candidate.rank !== null ||
    candidate.generator !== null ||
    candidate.token_count !== null ||
    candidate.avg_logprobs !== null
  ) {
    fidelity.change('/candidates', 'dropped', 'informational', 'candidate_metadata_not_exported')
  }
  if (candidate.signals.length > 0) {
    fidelity.change('/candidates', 'dropped', 'informational', 'candidate_signals_not_exported')
  }
}

function createTrainerFidelity(primaryPreserved: string): FidelityCollectorV2 {
  return new FidelityCollectorV2(['/contents', primaryPreserved, '/tools'])
}

function trainerMessageRole(role: ReadonlyContentV2['role']): 'assistant' | 'system' | 'user' {
  return role === 'ai' ? 'assistant' : role
}

function createRenderState(fidelity: FidelityCollectorV2): RenderStateV2 {
  return { calls: new Map(), fidelity }
}

function cloneRenderStateForCandidate(state: RenderStateV2): RenderStateV2 {
  return { calls: new Map(state.calls), fidelity: state.fidelity }
}

class FidelityCollectorV2 {
  readonly #preserved = new Set<string>()
  readonly #changes = new Map<string, FidelityChangeV2>()

  constructor(preserved: readonly string[]) {
    for (const path of preserved) {
      this.#preserved.add(path)
    }
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

function freezeProjection(projection: {
  outputCount: number
  fidelity: FidelityV2
  configHints: JsonObjectV2
}): ConverterProjectionV2 {
  return deepFreeze({
    outputCount: projection.outputCount,
    fidelity: projection.fidelity,
    configHints: projection.configHints,
  })
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
