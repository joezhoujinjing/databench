import { describe, expect, expectTypeOf, test } from 'vitest'
import { z } from 'zod'
import {
  CanonicalDraftRecordV1Schema,
  type ContentV2,
  canonicalPreviewRecordFromDraftV1,
  type PostTrainingRecordV2,
  PostTrainingRecordV2Schema,
} from '../src/v2/index.js'

describe('canonical draft v1 schema', () => {
  test('materializes defaults without exposing managed IDs', () => {
    const draft = CanonicalDraftRecordV1Schema.parse({
      draft_schema_version: '1.0.0',
      schema_version: '2.0.0',
      contents: [content('user', 'What is 2 + 2?', 0)],
      candidates: [{ contents: [content('ai', '4', 1)] }],
    })

    expect(draft).toEqual({
      draft_schema_version: '1.0.0',
      schema_version: '2.0.0',
      contents: [content('user', 'What is 2 + 2?', 0)],
      candidates: [
        {
          contents: [content('ai', '4', 1)],
          finish_reason: null,
          rank: null,
          selected: null,
          signals: [],
          generator: null,
          token_count: null,
          avg_logprobs: null,
        },
      ],
      preference_relations: [],
      tools: [],
      verification: null,
      source: null,
      lang: null,
      lineage: null,
      tags: [],
      extra: {},
    })
    expect(JSON.stringify(draft)).not.toMatch(/"(?:id|supersedes)"/)
    const opaquePreview = canonicalPreviewRecordFromDraftV1(draft, 7)
    expectTypeOf(opaquePreview).not.toMatchTypeOf<PostTrainingRecordV2>()
    expect(PostTrainingRecordV2Schema.parse(opaquePreview)).toMatchObject({
      id: `rec_${'0'.repeat(31)}7${'0'.repeat(32)}`,
      candidates: [{ id: `cand_${'0'.repeat(31)}7${'0'.repeat(32)}` }],
    })
  })

  test('projects optional defaults for input and fully materialized preview output', () => {
    const input = z.toJSONSchema(CanonicalDraftRecordV1Schema, { io: 'input' })
    const output = z.toJSONSchema(CanonicalDraftRecordV1Schema, { io: 'output' })

    expect(input.required).toEqual(['draft_schema_version', 'schema_version', 'contents'])
    expect(output.required).toEqual([
      'draft_schema_version',
      'schema_version',
      'contents',
      'candidates',
      'preference_relations',
      'tools',
      'verification',
      'source',
      'lang',
      'lineage',
      'tags',
      'extra',
    ])
  })

  test('accepts SFT, DPO, and RLVR shapes and rejects unknown fields', () => {
    const sft = baseDraft({
      contents: [content('user', 'Question', 0)],
      candidates: [{ contents: [content('ai', 'Answer', 1)] }],
    })
    const dpo = baseDraft({
      contents: [content('user', 'Question', 0)],
      candidates: [
        { contents: [content('ai', 'Better', 1)] },
        { contents: [content('ai', 'Worse', 1)] },
      ],
      preference_relations: [
        {
          left_candidate_index: 0,
          right_candidate_index: 1,
          outcome: 'left',
          status: 'adjudicated',
          source: { type: 'imported', id: 'spreadsheet', version: '1' },
        },
      ],
    })
    const rlvr = baseDraft({
      contents: [content('user', 'Next integer after 41?', 0)],
      candidates: [
        {
          contents: [content('ai', '42', 1)],
          signals: [
            {
              name: 'exact_match',
              kind: 'verdict',
              value: { type: 'boolean', value: true },
              source: { type: 'verifier', id: 'integer-match', version: '1' },
            },
          ],
        },
      ],
      verification: {
        verifier: 'integer-match',
        verifier_version: '1',
        ground_truth: '42',
        constraint: null,
        config: {},
      },
    })

    expect(CanonicalDraftRecordV1Schema.parse(sft).candidates).toHaveLength(1)
    expect(CanonicalDraftRecordV1Schema.parse(dpo).preference_relations).toHaveLength(1)
    expect(CanonicalDraftRecordV1Schema.parse(rlvr).verification).not.toBeNull()
    expect(() =>
      CanonicalDraftRecordV1Schema.parse({ ...sft, id: `rec_${'a'.repeat(64)}` }),
    ).toThrow()
    expect(() =>
      CanonicalDraftRecordV1Schema.parse({
        ...sft,
        candidates: [{ ...sft.candidates[0], id: `cand_${'b'.repeat(64)}` }],
      }),
    ).toThrow()
  })

  test('requires references and supersession to target valid earlier indexes', () => {
    const input = baseDraft({
      contents: [content('user', 'Question', 0)],
      candidates: [
        {
          contents: [content('ai', 'A', 1)],
          signals: [signal(null), signal(0)],
        },
        { contents: [content('ai', 'B', 1)] },
      ],
      preference_relations: [preference(null), preference(0)],
    })
    expect(CanonicalDraftRecordV1Schema.parse(input)).toBeDefined()

    expect(() =>
      CanonicalDraftRecordV1Schema.parse({
        ...input,
        preference_relations: [{ ...preference(null), right_candidate_index: 2 }],
      }),
    ).toThrow(/out of range/)
    expect(() =>
      CanonicalDraftRecordV1Schema.parse({
        ...input,
        candidates: [{ ...input.candidates[0], signals: [signal(0)] }, input.candidates[1]],
      }),
    ).toThrow(/earlier signal index/)
    expect(() =>
      CanonicalDraftRecordV1Schema.parse({
        ...input,
        preference_relations: [preference(0)],
      }),
    ).toThrow(/earlier preference index/)
  })

  test('applies canonical cross-field invariants to draft records', () => {
    const invalidSystem = baseDraft({
      contents: [content('user', 'Question', 0), content('system', 'Late system', 0)],
    })
    expect(() => CanonicalDraftRecordV1Schema.parse(invalidSystem)).toThrow(
      /System content must be contents\[0\]/,
    )

    const invalidTrajectory = baseDraft({
      contents: [content('user', 'Question', 0)],
      candidates: [
        {
          contents: [
            {
              role: 'ai',
              parts: [
                {
                  type: 'function_call',
                  function_call: { id: 'call-1', name: 'missing-tool', args: {} },
                  thought: false,
                  thought_signature: null,
                  part_metadata: {},
                },
              ],
              loss_weight: 1,
            },
          ],
        },
      ],
    })
    expect(() => CanonicalDraftRecordV1Schema.parse(invalidTrajectory)).toThrow(/declared tool/)

    const invalidTags = baseDraft({ contents: [], tags: ['z', 'a'] })
    expect(() => CanonicalDraftRecordV1Schema.parse(invalidTags)).toThrow(/JCS comparator/)
  })

  test('keeps synthetic preview IDs internal and avoids lineage self-parent collisions', () => {
    const zeroId = `rec_${'0'.repeat(64)}`
    const draft = CanonicalDraftRecordV1Schema.parse(
      baseDraft({
        contents: [],
        lineage: {
          parent_refs: [{ id: zeroId, record_digest: 'a'.repeat(64) }],
          recipe: null,
          recipe_revision: null,
          run_id: null,
          steps: [],
        },
      }),
    )
    expect(
      PostTrainingRecordV2Schema.parse(canonicalPreviewRecordFromDraftV1(draft, 0)).id,
    ).not.toBe(zeroId)

    const branchingSupersession = CanonicalDraftRecordV1Schema.safeParse(
      baseDraft({
        contents: [content('user', 'Question', 0)],
        candidates: [{ contents: [content('ai', 'A', 1)] }, { contents: [content('ai', 'B', 1)] }],
        preference_relations: [preference(null), preference(0), preference(0)],
      }),
    )
    expect(branchingSupersession.success).toBe(false)
    if (!branchingSupersession.success) {
      expect(branchingSupersession.error.message).not.toMatch(
        /\b(?:cand|pref|rec|sig)_[0-9a-f]{64}\b/,
      )
      expect(branchingSupersession.error.message).toContain('[internal preview ID]')
    }
  })
})

function baseDraft(overrides: Record<string, unknown>) {
  return {
    draft_schema_version: '1.0.0',
    schema_version: '2.0.0',
    ...overrides,
  }
}

function content(role: 'ai' | 'system' | 'user', text: string, lossWeight: number): ContentV2 {
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

function signal(supersedesIndex: number | null) {
  return {
    name: 'quality',
    kind: 'rating',
    value: {
      type: 'number',
      value: 1,
      scale_min: null,
      scale_max: null,
      higher_is_better: null,
    },
    source: { type: 'human', id: 'reviewer', version: '1' },
    supersedes_index: supersedesIndex,
  }
}

function preference(supersedesIndex: number | null) {
  return {
    left_candidate_index: 0,
    right_candidate_index: 1,
    outcome: 'left',
    status: 'adjudicated',
    criterion: 'quality',
    source: { type: 'human', id: 'reviewer', version: '1' },
    supersedes_index: supersedesIndex,
  }
}
