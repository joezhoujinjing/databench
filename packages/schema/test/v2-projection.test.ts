// biome-ignore-all lint/style/noNonNullAssertion: Fixed fixture positions are part of this policy contract.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import {
  createRecordRevisionV2,
  createRecordSummaryV2,
  deriveRecordEligibilityV2,
  deriveRecordPreviewV2,
  type PostTrainingRecordV2,
  parseCanonicalRecordV2,
  RecordEligibilityV2Schema,
  RecordSummaryV2Schema,
  TaskEligibilityV2Schema,
  V2_RECORD_PREVIEW_MAX_CODE_POINTS,
} from '../src/index.js'

const fixturePath = fileURLToPath(
  new URL('./golden/fixtures/v2/record-all-fields.input.json', import.meta.url),
)
const baseRecord = JSON.parse(readFileSync(fixturePath, 'utf8')) as PostTrainingRecordV2

function firstNonSystemContent(record: PostTrainingRecordV2) {
  const content = record.contents.find(({ role }) => role !== 'system')
  if (!content) {
    throw new Error('fixture non-system shared content is missing')
  }
  return content
}

describe('v2 shared record projection policy', () => {
  test('summarizes every documented field and accepts an immutable record revision', () => {
    const revision = createRecordRevisionV2(baseRecord)

    expect(createRecordSummaryV2(revision)).toEqual({
      record_id: baseRecord.id,
      record_digest: revision.record_digest,
      lang: 'en-US',
      candidate_count: 2,
      signal_count: 5,
      selected_count: 1,
      eligibility: {
        sft: { eligible: true, output_count: 1, reason_codes: [] },
        dpo: { eligible: true, output_count: 1, reason_codes: [] },
        rlvr_grpo: { eligible: true, output_count: 1, reason_codes: [] },
      },
      preview: 'What is the status of order 42?',
    })
  })

  test('counts every selected=true candidate for SFT and ignores false/null candidates', () => {
    const draft = structuredClone(baseRecord)
    draft.candidates[1]!.selected = true
    expect(deriveRecordEligibilityV2(parseCanonicalRecordV2(draft)).sft).toEqual({
      eligible: true,
      output_count: 2,
      reason_codes: [],
    })

    draft.candidates[0]!.selected = null
    draft.candidates[1]!.selected = false
    expect(deriveRecordEligibilityV2(parseCanonicalRecordV2(draft)).sft).toEqual({
      eligible: false,
      output_count: 0,
      reason_codes: ['selected_candidate_missing'],
    })
  })

  test('does not infer eligibility from rank, tags, signals, or directional observations', () => {
    const draft = structuredClone(baseRecord)
    draft.candidates[0]!.selected = null
    draft.candidates[1]!.selected = false
    draft.preference_relations = [
      {
        ...draft.preference_relations[0]!,
        outcome: 'left',
      },
    ]
    draft.verification = null

    expect(draft.candidates[0]!.rank).toBe(0)
    expect(draft.candidates[0]!.signals.length).toBeGreaterThan(0)
    expect(draft.tags.length).toBeGreaterThan(0)
    expect(deriveRecordEligibilityV2(parseCanonicalRecordV2(draft))).toEqual({
      sft: {
        eligible: false,
        output_count: 0,
        reason_codes: ['selected_candidate_missing'],
      },
      dpo: {
        eligible: false,
        output_count: 0,
        reason_codes: ['adjudicated_directional_preference_missing'],
      },
      rlvr_grpo: {
        eligible: false,
        output_count: 0,
        reason_codes: ['verification_missing'],
      },
    })
  })

  test('counts only current directional adjudicated preferences after supersession', () => {
    const supersededByTie = structuredClone(baseRecord)
    supersededByTie.preference_relations[2]!.outcome = 'tie'
    expect(deriveRecordEligibilityV2(parseCanonicalRecordV2(supersededByTie)).dpo).toEqual({
      eligible: false,
      output_count: 0,
      reason_codes: ['adjudicated_directional_preference_missing'],
    })

    const restoredByDirectional = structuredClone(supersededByTie)
    const activeTie = restoredByDirectional.preference_relations[2]!
    restoredByDirectional.preference_relations.push({
      ...activeTie,
      id: `pref_${'6'.repeat(64)}`,
      outcome: 'right',
      supersedes: activeTie.id,
    })
    expect(deriveRecordEligibilityV2(parseCanonicalRecordV2(restoredByDirectional)).dpo).toEqual({
      eligible: true,
      output_count: 1,
      reason_codes: [],
    })

    const twoCriteria = structuredClone(restoredByDirectional)
    const activeDirectional = twoCriteria.preference_relations[3]!
    twoCriteria.preference_relations.push({
      ...activeDirectional,
      id: `pref_${'7'.repeat(64)}`,
      criterion: 'helpfulness',
      supersedes: null,
    })
    expect(deriveRecordEligibilityV2(parseCanonicalRecordV2(twoCriteria)).dpo.output_count).toBe(2)
  })

  test('produces exactly one RLVR/GRPO output when verification exists', () => {
    const withVerification = parseCanonicalRecordV2(baseRecord)
    expect(deriveRecordEligibilityV2(withVerification).rlvr_grpo).toEqual({
      eligible: true,
      output_count: 1,
      reason_codes: [],
    })

    const withoutVerification = structuredClone(baseRecord)
    withoutVerification.verification = null
    expect(
      deriveRecordEligibilityV2(parseCanonicalRecordV2(withoutVerification)).rlvr_grpo,
    ).toEqual({
      eligible: false,
      output_count: 0,
      reason_codes: ['verification_missing'],
    })
  })

  test('system content affects neither preview selection nor training output counts', () => {
    const withSystem = structuredClone(baseRecord)
    const systemPart = withSystem.contents[0]?.parts[0]
    if (systemPart?.type !== 'text') {
      throw new Error('fixture system text part is missing')
    }
    systemPart.text = 'This system text must not become the preview.'

    const withoutSystem = structuredClone(withSystem)
    withoutSystem.contents = withoutSystem.contents.filter(({ role }) => role !== 'system')

    expect(deriveRecordPreviewV2(parseCanonicalRecordV2(withSystem))).toBe(
      'What is the status of order 42?',
    )
    expect(deriveRecordEligibilityV2(parseCanonicalRecordV2(withSystem))).toEqual(
      deriveRecordEligibilityV2(parseCanonicalRecordV2(withoutSystem)),
    )
  })

  test('uses the first non-empty shared text without rewriting whitespace', () => {
    const draft = structuredClone(baseRecord)
    firstNonSystemContent(draft).parts = [textPart(''), textPart(' \t\n'), textPart('later text')]
    expect(deriveRecordPreviewV2(parseCanonicalRecordV2(draft))).toBe(' \t\n')
  })

  test('truncates preview at 240 Unicode code points without splitting astral characters', () => {
    const draft = structuredClone(baseRecord)
    const text = ` 开头\t${'😀'.repeat(1_000_000)}结尾 `
    firstNonSystemContent(draft).parts = [textPart(''), textPart(text)]
    const preview = deriveRecordPreviewV2(draft)
    const prefix = ' 开头\t'
    const expected = `${prefix}${'😀'.repeat(
      V2_RECORD_PREVIEW_MAX_CODE_POINTS - Array.from(prefix).length,
    )}`

    expect(preview).toBe(expected)
    expect(Array.from(preview ?? '')).toHaveLength(V2_RECORD_PREVIEW_MAX_CODE_POINTS)
    expect(preview?.endsWith('\ud83d')).toBe(false)
  })

  test('returns null when shared contents have no text even if a candidate has text', () => {
    const draft = structuredClone(baseRecord)
    const content = firstNonSystemContent(draft)
    const filePart = content.parts.find((part) => part.type === 'file_data')
    if (!filePart) {
      throw new Error('fixture file_data part is missing')
    }
    content.parts = [filePart]
    expect(deriveRecordPreviewV2(parseCanonicalRecordV2(draft))).toBeNull()
  })

  test('schemas reject inconsistent eligibility, unstable reason codes, and invalid summaries', () => {
    expect(
      TaskEligibilityV2Schema.safeParse({
        eligible: true,
        output_count: 0,
        reason_codes: [],
      }).success,
    ).toBe(false)
    expect(
      RecordEligibilityV2Schema.safeParse({
        sft: {
          eligible: false,
          output_count: 0,
          reason_codes: ['verification_missing'],
        },
        dpo: {
          eligible: false,
          output_count: 0,
          reason_codes: ['adjudicated_directional_preference_missing'],
        },
        rlvr_grpo: {
          eligible: false,
          output_count: 0,
          reason_codes: ['verification_missing'],
        },
      }).success,
    ).toBe(false)

    const summary = createRecordSummaryV2(createRecordRevisionV2(baseRecord))
    expect(
      RecordSummaryV2Schema.safeParse({
        ...summary,
        selected_count: summary.selected_count + 1,
      }).success,
    ).toBe(false)
    expect(
      RecordSummaryV2Schema.safeParse({
        ...summary,
        selected_count: summary.candidate_count + 1,
        eligibility: {
          ...summary.eligibility,
          sft: {
            eligible: true,
            output_count: summary.candidate_count + 1,
            reason_codes: [],
          },
        },
      }).success,
    ).toBe(false)
    expect(
      RecordSummaryV2Schema.safeParse({
        ...summary,
        preview: '😀'.repeat(V2_RECORD_PREVIEW_MAX_CODE_POINTS + 1),
      }).success,
    ).toBe(false)
  })
})

function textPart(text: string) {
  return {
    type: 'text' as const,
    text,
    thought: false,
    thought_signature: null,
    part_metadata: {},
  }
}
