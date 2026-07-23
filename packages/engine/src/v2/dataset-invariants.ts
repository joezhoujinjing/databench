import { IntegrityError, ValidationError } from '@databench/schema'

export interface V2RecordIdentityView {
  readonly record_id: string
  readonly record_digest: string
  readonly record_json: string
}

export class DuplicateRecordIdErrorV2 extends ValidationError {
  override readonly name = 'DuplicateRecordIdErrorV2'

  constructor(recordIndex: number | null) {
    super('Dataset contains a duplicate logical record ID', {
      issues: [
        {
          path: recordIndex === null ? '/records/*/id' : `/records/${recordIndex}/id`,
          line: null,
          code: 'duplicate_record_id',
          message: 'Logical record ID must be unique within a dataset',
        },
      ],
    })
  }
}

export class RecordDigestCollisionErrorV2 extends IntegrityError {
  override readonly name = 'RecordDigestCollisionErrorV2'

  constructor(recordDigest: string) {
    super('One record digest maps to different canonical record bytes', {
      record_digest: recordDigest,
    })
  }
}

export function assertV2RecordIdentityAvailable(
  revision: V2RecordIdentityView,
  recordIds: ReadonlySet<string>,
  canonicalByDigest: ReadonlyMap<string, string>,
  recordIndex: number | null = null,
): void {
  if (recordIds.has(revision.record_id)) {
    throw new DuplicateRecordIdErrorV2(recordIndex)
  }

  const existingCanonical = canonicalByDigest.get(revision.record_digest)
  if (existingCanonical !== undefined && existingCanonical !== revision.record_json) {
    throw new RecordDigestCollisionErrorV2(revision.record_digest)
  }
}
