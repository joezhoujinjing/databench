import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import {
  AddRecordsV2OptionsSchema,
  AuditResultV2Schema,
  CursorPageRequestV2Schema,
  createDatasetManifestV2,
  createRecordRevisionV2,
  createRecordSummaryV2,
  DatasetViewV2Schema,
  deriveRecordEligibilityV2,
  IngestResultV2Schema,
  type PostTrainingRecordV2,
  PutRefRequestV2Schema,
  RecordPageRequestV2Schema,
  RecordPageV2Schema,
  RecordViewV2Schema,
  RefConflictDetailV2Schema,
  RefConflictErrorV2,
  RefMetadataV2Schema,
  RefNameV2Schema,
  RefOrVersionV2Schema,
  RefPageV2Schema,
  RefUpdateResultV2Schema,
  V2_CURSOR_PAGE_DEFAULT_LIMIT,
  V2_CURSOR_PAGE_MAX_LIMIT,
  V2_RECORD_PAGE_MAX_LIMIT,
} from '../src/index.js'

const fixturePath = fileURLToPath(
  new URL('./golden/fixtures/v2/record-all-fields.input.json', import.meta.url),
)
const baseRecord = JSON.parse(readFileSync(fixturePath, 'utf8')) as PostTrainingRecordV2

const DATASET_VERSION = 'a'.repeat(64)
const OTHER_VERSION = 'b'.repeat(64)
const ARTIFACT_DIGEST = 'c'.repeat(64)

const manifest = createDatasetManifestV2({
  identity_profile: 'databench-v2-jcs-1',
  record_schema_version: '2.0.0',
  dataset_version: DATASET_VERSION,
  num_records: 1,
  layout_version: 'record-json-v1',
  artifact_digest: ARTIFACT_DIGEST,
  artifact_size_bytes: 1024,
})

describe('V9 ref and pagination contract schemas', () => {
  test.each([
    'main',
    'release.2026_07-23',
    `a${'b'.repeat(127)}`,
  ])('accepts an unambiguous ref name: %s', (name) => {
    expect(RefNameV2Schema.parse(name)).toBe(name)
    expect(RefOrVersionV2Schema.parse(name)).toBe(name)
  })

  test.each([
    '',
    '.',
    '..',
    'Main',
    'with/slash',
    'with space',
    '数据',
    'a'.repeat(129),
    DATASET_VERSION,
  ])('rejects an invalid or version-ambiguous ref name: %s', (name) => {
    expect(RefNameV2Schema.safeParse(name).success).toBe(false)
  })

  test('accepts exact versions separately from refs and rejects invalid identifiers', () => {
    expect(RefOrVersionV2Schema.parse(DATASET_VERSION)).toBe(DATASET_VERSION)
    expect(RefOrVersionV2Schema.safeParse('A'.repeat(64)).success).toBe(false)
    expect(RefOrVersionV2Schema.safeParse('with/slash').success).toBe(false)
  })

  test('materializes bounded page defaults and rejects unknown request fields', () => {
    expect(CursorPageRequestV2Schema.parse({ cursor: null })).toEqual({
      cursor: null,
      limit: V2_CURSOR_PAGE_DEFAULT_LIMIT,
    })
    expect(RecordPageRequestV2Schema.parse({})).toEqual({ offset: 0, limit: 20 })
    expect(
      CursorPageRequestV2Schema.safeParse({
        cursor: null,
        limit: V2_CURSOR_PAGE_MAX_LIMIT + 1,
      }).success,
    ).toBe(false)
    expect(
      RecordPageRequestV2Schema.safeParse({
        offset: 0,
        limit: V2_RECORD_PAGE_MAX_LIMIT + 1,
      }).success,
    ).toBe(false)
    expect(
      CursorPageRequestV2Schema.safeParse({ cursor: null, limit: 1, unknown: true }).success,
    ).toBe(false)
    expect(
      CursorPageRequestV2Schema.safeParse({ cursor: 'a'.repeat(1537), limit: 1 }).success,
    ).toBe(false)
  })

  test('keeps normalized add options strict and requires ref for expected/message', () => {
    expect(
      AddRecordsV2OptionsSchema.parse({ ref: null, expected_ref_version: null, message: null }),
    ).toEqual({ ref: null, expected_ref_version: null, message: null })
    expect(
      AddRecordsV2OptionsSchema.safeParse({
        ref: null,
        expected_ref_version: DATASET_VERSION,
        message: null,
      }).success,
    ).toBe(false)
    expect(
      AddRecordsV2OptionsSchema.safeParse({
        ref: null,
        expected_ref_version: null,
        message: 'publish',
      }).success,
    ).toBe(false)
    expect(
      AddRecordsV2OptionsSchema.safeParse({
        ref: 'main',
        expected_ref_version: null,
        message: null,
        unknown: true,
      }).success,
    ).toBe(false)
  })
})

describe('V9 dataset and ingest result contracts', () => {
  const exactView = {
    requested_ref: DATASET_VERSION,
    ref_name: null,
    dataset_version: DATASET_VERSION,
    manifest,
  }
  const refView = {
    requested_ref: 'main',
    ref_name: 'main',
    dataset_version: DATASET_VERSION,
    manifest,
  }

  test('accepts exact-version and resolved-ref dataset views', () => {
    expect(DatasetViewV2Schema.parse(exactView)).toEqual(exactView)
    expect(DatasetViewV2Schema.parse(refView)).toEqual(refView)
  })

  test('rejects dataset view version/ref mismatches and unknown fields', () => {
    expect(
      DatasetViewV2Schema.safeParse({ ...exactView, dataset_version: OTHER_VERSION }).success,
    ).toBe(false)
    expect(DatasetViewV2Schema.safeParse({ ...exactView, ref_name: 'main' }).success).toBe(false)
    expect(DatasetViewV2Schema.safeParse({ ...refView, ref_name: 'other' }).success).toBe(false)
    expect(DatasetViewV2Schema.safeParse({ ...exactView, unknown: true }).success).toBe(false)
  })

  test('accepts both ingest ref outcomes and requires all versions to agree', () => {
    const detached = {
      dataset_version: DATASET_VERSION,
      manifest,
      ref_update: { status: 'not_requested' as const },
    }
    const published = {
      dataset_version: DATASET_VERSION,
      manifest,
      ref_update: {
        status: 'updated' as const,
        ref_name: 'main',
        previous_version: OTHER_VERSION,
        current_version: DATASET_VERSION,
      },
    }
    expect(IngestResultV2Schema.parse(detached)).toEqual(detached)
    expect(IngestResultV2Schema.parse(published)).toEqual(published)

    expect(
      IngestResultV2Schema.safeParse({ ...detached, dataset_version: OTHER_VERSION }).success,
    ).toBe(false)
    expect(
      IngestResultV2Schema.safeParse({
        ...published,
        ref_update: { ...published.ref_update, current_version: OTHER_VERSION },
      }).success,
    ).toBe(false)
    expect(IngestResultV2Schema.safeParse({ ...detached, unknown: true }).success).toBe(false)
    expect(
      RefUpdateResultV2Schema.safeParse({
        status: 'not_requested',
        ref_name: 'main',
      }).success,
    ).toBe(false)
    expect(
      RefUpdateResultV2Schema.safeParse({
        status: 'updated',
        ref_name: 'main',
        previous_version: null,
        current_version: DATASET_VERSION,
        unknown: true,
      }).success,
    ).toBe(false)
  })
})

describe('V9 record page and view contracts', () => {
  const leftRevision = createRecordRevisionV2(baseRecord)
  const rightRecord = structuredClone(baseRecord)
  rightRecord.id = `rec_${'9'.repeat(64)}`
  const rightRevision = createRecordRevisionV2(rightRecord)
  const summaries = [
    createRecordSummaryV2(leftRevision),
    createRecordSummaryV2(rightRevision),
  ].sort((left, right) =>
    left.record_digest === right.record_digest
      ? asciiCompare(left.record_id, right.record_id)
      : asciiCompare(left.record_digest, right.record_digest),
  )
  const page = {
    items: summaries,
    offset: 0,
    limit: 2,
    total: 2,
    dataset_version: DATASET_VERSION,
  }

  test('accepts a complete strictly sorted page and an empty out-of-range page', () => {
    expect(RecordPageV2Schema.parse(page)).toEqual(page)
    expect(
      RecordPageV2Schema.parse({
        items: [],
        offset: 2,
        limit: 20,
        total: 2,
        dataset_version: DATASET_VERSION,
      }).items,
    ).toEqual([])
  })

  test('rejects unsorted, duplicate, incomplete, oversized, and unknown-field pages', () => {
    expect(RecordPageV2Schema.safeParse({ ...page, items: [...summaries].reverse() }).success).toBe(
      false,
    )
    expect(
      RecordPageV2Schema.safeParse({ ...page, items: [summaries[0], summaries[0]] }).success,
    ).toBe(false)
    expect(RecordPageV2Schema.safeParse({ ...page, items: [summaries[0]] }).success).toBe(false)
    expect(RecordPageV2Schema.safeParse({ ...page, limit: 1 }).success).toBe(false)
    expect(RecordPageV2Schema.safeParse({ ...page, unknown: true }).success).toBe(false)
  })

  test('accepts an exact record view and rejects digest/eligibility drift or unknown fields', () => {
    const view = {
      record: leftRevision.record,
      record_digest: leftRevision.record_digest,
      eligibility: deriveRecordEligibilityV2(leftRevision.record),
      dataset_version: DATASET_VERSION,
    }
    expect(RecordViewV2Schema.parse(view)).toEqual(view)
    expect(RecordViewV2Schema.safeParse({ ...view, record_digest: OTHER_VERSION }).success).toBe(
      false,
    )
    expect(
      RecordViewV2Schema.safeParse({
        ...view,
        eligibility: {
          ...view.eligibility,
          sft: {
            eligible: false,
            output_count: 0,
            reason_codes: ['selected_candidate_missing'],
          },
        },
      }).success,
    ).toBe(false)
    expect(RecordViewV2Schema.safeParse({ ...view, unknown: true }).success).toBe(false)
  })
})

function asciiCompare(left: string, right: string): number {
  if (left === right) return 0
  return left < right ? -1 : 1
}

describe('V9 audit and ref DTO contracts', () => {
  const audit = {
    dataset_version: DATASET_VERSION,
    layout_version: 'record-json-v1' as const,
    artifact_digest: ARTIFACT_DIGEST,
    artifact_size_bytes: 1024,
    checks: {
      manifest: 'ok' as const,
      artifact_digest: 'ok' as const,
      parquet_schema: 'ok' as const,
      record_digests: 'ok' as const,
      dataset_version: 'ok' as const,
    },
  }
  const ref = {
    name: 'main',
    version: DATASET_VERSION,
    num_records: 12,
    message: 'publish',
    updated_at: '2026-07-23T08:00:00Z',
  }

  test('accepts only an all-ok exact audit result', () => {
    expect(AuditResultV2Schema.parse(audit)).toEqual(audit)
    expect(
      AuditResultV2Schema.safeParse({
        ...audit,
        checks: { ...audit.checks, artifact_digest: 'failed' },
      }).success,
    ).toBe(false)
    expect(AuditResultV2Schema.safeParse({ ...audit, artifact_size_bytes: -1 }).success).toBe(false)
    expect(AuditResultV2Schema.safeParse({ ...audit, unknown: true }).success).toBe(false)
    expect(
      AuditResultV2Schema.safeParse({
        ...audit,
        checks: { ...audit.checks, unknown: 'ok' },
      }).success,
    ).toBe(false)
  })

  test('keeps ref metadata, pages, and mutations strict', () => {
    expect(RefMetadataV2Schema.parse(ref)).toEqual(ref)
    expect(RefPageV2Schema.parse({ items: [ref], next_cursor: 'opaque' })).toEqual({
      items: [ref],
      next_cursor: 'opaque',
    })
    expect(
      PutRefRequestV2Schema.parse({
        new_version: DATASET_VERSION,
        expected_version: OTHER_VERSION,
        message: 'move',
      }),
    ).toEqual({
      new_version: DATASET_VERSION,
      expected_version: OTHER_VERSION,
      message: 'move',
    })

    expect(RefMetadataV2Schema.safeParse({ ...ref, updated_at: 'not-a-time' }).success).toBe(false)
    expect(RefMetadataV2Schema.safeParse({ ...ref, unknown: true }).success).toBe(false)
    expect(
      RefPageV2Schema.safeParse({ items: [ref], next_cursor: null, unknown: true }).success,
    ).toBe(false)
    expect(
      RefPageV2Schema.safeParse({
        items: [
          { ...ref, name: 'z-ref' },
          { ...ref, name: 'a-ref' },
        ],
        next_cursor: null,
      }).success,
    ).toBe(false)
    expect(RefPageV2Schema.safeParse({ items: [ref, ref], next_cursor: null }).success).toBe(false)
    expect(
      PutRefRequestV2Schema.safeParse({
        new_version: DATASET_VERSION,
        expected_version: null,
        message: '',
      }).success,
    ).toBe(false)
    expect(
      PutRefRequestV2Schema.safeParse({
        new_version: DATASET_VERSION,
        expected_version: null,
        message: null,
        unknown: true,
      }).success,
    ).toBe(false)
  })

  test('strictly validates and snapshots typed ref conflict details', () => {
    const detail = {
      ref_name: 'main',
      expected_version: OTHER_VERSION,
      current_version: DATASET_VERSION,
      new_version: ARTIFACT_DIGEST,
      new_dataset_committed: true,
    }
    expect(RefConflictDetailV2Schema.parse(detail)).toEqual(detail)

    const error = new RefConflictErrorV2(detail)
    expect(error).toMatchObject({
      name: 'RefConflictErrorV2',
      code: 'ref_conflict',
      message: 'V2 ref compare-and-set conflict for main',
      detail,
    })
    expect(Object.isFrozen(error.detail)).toBe(true)

    detail.ref_name = 'caller-mutated'
    expect(error.detail).toEqual({
      ref_name: 'main',
      expected_version: OTHER_VERSION,
      current_version: DATASET_VERSION,
      new_version: ARTIFACT_DIGEST,
      new_dataset_committed: true,
    })

    expect(
      RefConflictDetailV2Schema.safeParse({
        ...detail,
        ref_name: 'main',
        unknown: true,
      }).success,
    ).toBe(false)
    expect(
      RefConflictDetailV2Schema.safeParse({
        ...detail,
        ref_name: 'main',
        new_version: 'invalid',
      }).success,
    ).toBe(false)
    expect(
      () =>
        new RefConflictErrorV2({
          ...detail,
          ref_name: 'main',
          unknown: true,
        } as never),
    ).toThrow()
  })
})
