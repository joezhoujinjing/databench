import {
  type McpCanonicalImportContract,
  McpCanonicalImportContractSchema,
  PostTrainingRecordV2Schema,
  type PostTrainingV2Capability,
} from '@databench/schema'
import { z } from 'zod'

const CONTRACT_RULES = Object.freeze([
  'Use UTF-8 JSON Lines: one canonical PostTrainingRecordV2 object per non-blank line.',
  'The current record schema_version is exactly 2.0.0; unknown fields are rejected.',
  'Canonical rec_*, cand_*, sig_*, and pref_* IDs are required and must not be invented for raw tabular data.',
  'UTF-8 BOM, duplicate JSON keys, invalid UTF-8, excessive nesting, and oversized records are rejected.',
  'At most one shared system content may appear first; it must contain one text part with loss_weight 0.',
  'Candidate, signal, preference, tool trajectory, verification, lineage, and supersession invariants are validated across each complete record.',
  'The whole file and dataset-level uniqueness/resource limits must pass before a dataset is published.',
])

let cachedSchema: Record<string, unknown> | undefined

export function createCanonicalImportContract(
  capability: Readonly<PostTrainingV2Capability>,
  maxPreviewResponseBytes: number,
): Readonly<McpCanonicalImportContract> {
  const limits = capability.limits
  return deepFreeze(
    McpCanonicalImportContractSchema.parse({
      name: 'canonical-jsonl',
      version: '2.0.0',
      schema: canonicalRecordJsonSchema(),
      rules: CONTRACT_RULES,
      examples: canonicalExamples(),
      effective_limits: {
        max_request_bytes: limits.max_request_bytes,
        max_record_bytes: limits.max_record_bytes,
        max_snapshot_records: limits.max_snapshot_records,
        max_canonical_bytes: limits.max_canonical_bytes,
        max_preview_response_bytes: maxPreviewResponseBytes,
      },
    }),
  )
}

function canonicalRecordJsonSchema(): Record<string, unknown> {
  if (cachedSchema === undefined) {
    const projected = z.toJSONSchema(PostTrainingRecordV2Schema, {
      target: 'draft-2020-12',
      unrepresentable: 'any',
    }) as Record<string, unknown>
    // Zod may attach non-enumerable schema metadata. The wire contract must be
    // ordinary JSON data; this serialization is not used for identity hashing.
    cachedSchema = deepFreeze(JSON.parse(JSON.stringify(projected)) as Record<string, unknown>)
  }
  return cachedSchema
}

function canonicalExamples() {
  return [
    { name: 'sft', jsonl: exampleJsonl(sftExample()) },
    { name: 'dpo', jsonl: exampleJsonl(dpoExample()) },
    { name: 'rlvr', jsonl: exampleJsonl(rlvrExample()) },
  ] as const
}

function exampleJsonl(input: unknown): string {
  return `${JSON.stringify(PostTrainingRecordV2Schema.parse(input))}\n`
}

function sftExample(): unknown {
  return {
    schema_version: '2.0.0',
    id: id('rec', '1'),
    contents: [
      content('system', 'Answer accurately and concisely.', 0),
      content('user', 'What is 2 + 2?', 0),
    ],
    candidates: [candidate('2', '4', 0, true, [])],
    preference_relations: [],
    tools: [],
    verification: null,
    source: null,
    lang: 'en',
    lineage: null,
    tags: ['task:sft'],
    extra: {},
  }
}

function dpoExample(): unknown {
  const leftId = id('cand', '4')
  const rightId = id('cand', '5')
  return {
    schema_version: '2.0.0',
    id: id('rec', '3'),
    contents: [content('user', 'Explain overfitting in one sentence.', 0)],
    candidates: [
      candidate(
        '4',
        'Overfitting is learning training noise that does not generalize.',
        0,
        true,
        [],
      ),
      candidate('5', 'Overfitting means a model is always too small.', 1, false, []),
    ],
    preference_relations: [
      {
        id: id('pref', '6'),
        left_candidate_id: leftId,
        right_candidate_id: rightId,
        outcome: 'left',
        status: 'adjudicated',
        criterion: 'correctness',
        source: { type: 'imported', id: 'canonical-contract-example', version: '1' },
        rationale: null,
        created_at: null,
        supersedes: null,
      },
    ],
    tools: [],
    verification: null,
    source: null,
    lang: 'en',
    lineage: null,
    tags: ['task:dpo'],
    extra: {},
  }
}

function rlvrExample(): unknown {
  return {
    schema_version: '2.0.0',
    id: id('rec', '7'),
    contents: [content('user', 'Return the next integer after 41.', 0)],
    candidates: [
      candidate('8', '42', 0, true, [
        {
          id: id('sig', '9'),
          name: 'exact_match',
          kind: 'verdict',
          value: { type: 'boolean', value: true },
          source: { type: 'verifier', id: 'integer-exact-match', version: '1' },
          rationale: null,
          created_at: null,
          supersedes: null,
        },
      ]),
    ],
    preference_relations: [],
    tools: [],
    verification: {
      verifier: 'integer-exact-match',
      verifier_version: '1',
      ground_truth: '42',
      constraint: null,
      config: {},
    },
    source: null,
    lang: 'en',
    lineage: null,
    tags: ['task:rlvr'],
    extra: {},
  }
}

function candidate(
  hex: string,
  text: string,
  rank: number,
  selected: boolean,
  signals: readonly unknown[],
): unknown {
  return {
    id: id('cand', hex),
    contents: [content('ai', text, 1)],
    finish_reason: 'stop',
    rank,
    selected,
    signals,
    generator: null,
    token_count: null,
    avg_logprobs: null,
  }
}

function content(role: 'ai' | 'system' | 'user', text: string, lossWeight: number): unknown {
  return {
    role,
    parts: [
      {
        type: 'text',
        text,
        thought: false,
        thought_signature: null,
        part_metadata: {},
      },
    ],
    loss_weight: lossWeight,
  }
}

function id(prefix: 'cand' | 'pref' | 'rec' | 'sig', hex: string): string {
  return `${prefix}_${hex.repeat(64)}`
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}
