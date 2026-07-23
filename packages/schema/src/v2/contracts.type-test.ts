import type { PostTrainingRecordV2, RecordRevisionV2 } from '../index.js'

const record = {} as PostTrainingRecordV2
const revisionShape = {
  record,
  record_json: '{}',
  record_digest: '0'.repeat(64),
}

// @ts-expect-error Record revisions require the package-private brand produced by the factory.
const forgedRevision: RecordRevisionV2 = revisionShape
void forgedRevision

declare const revision: RecordRevisionV2
// @ts-expect-error Revision records are recursively readonly.
revision.record.tags.push('mutation')

// @ts-expect-error Spreading a valid revision loses the private nominal brand.
const spreadForgery: RecordRevisionV2 = {
  ...revision,
  record_json: '{}',
  record_digest: '0'.repeat(64),
}
void spreadForgery
