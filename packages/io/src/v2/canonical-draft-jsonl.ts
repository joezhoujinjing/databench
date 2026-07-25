import {
  type CanonicalDraftRecordV1,
  CanonicalDraftRecordV1Schema,
  type RawJsonLimitsV2,
} from '@databench/schema'
import {
  type ReadCanonicalJsonlV2Options,
  readRawCanonicalJsonlV2,
  zodPathToJsonPointer,
} from './canonical-jsonl.js'
import { CanonicalJsonlValidationErrorV2 } from './errors.js'

export interface ReadCanonicalDraftJsonlV1Options {
  readonly limits?: RawJsonLimitsV2
  readonly maxTransportBytes?: number
  readonly signal?: AbortSignal
}

/**
 * Reads canonical-draft-jsonl-v1 with the same bounded transport and strict
 * raw JSON behavior as canonical JSONL. Defaults are fully materialized before
 * each draft record is yielded.
 */
export async function* readCanonicalDraftJsonlV1(
  source: AsyncIterable<Uint8Array>,
  options: ReadCanonicalDraftJsonlV1Options = {},
): AsyncIterableIterator<CanonicalDraftRecordV1> {
  for await (const { line, value } of readRawCanonicalJsonlV2(
    source,
    options satisfies ReadCanonicalJsonlV2Options,
  )) {
    const result = CanonicalDraftRecordV1Schema.safeParse(value)
    if (!result.success) {
      throw new CanonicalJsonlValidationErrorV2(
        line,
        result.error.issues.map((issue) => ({
          path: zodPathToJsonPointer(issue.path),
          code: canonicalDraftIssueCode(issue.code, issue.message),
          message: issue.message,
        })),
        'canonical-draft',
      )
    }
    yield result.data
  }
}

function canonicalDraftIssueCode(code: string, message: string): string {
  if (code !== 'custom') return code
  if (message.endsWith('is out of range')) return 'canonical_draft.index_out_of_range'
  if (message.includes('only supersede an earlier')) {
    return 'canonical_draft.supersession_not_earlier'
  }
  return 'canonical_draft.invariant'
}
