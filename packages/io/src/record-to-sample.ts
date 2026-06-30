import { type Kind, parseSample, type Sample } from '@databench/schema'
import { detectKind, type JsonRecord } from './detect-kind.js'
import { normalizeRecord } from './normalize.js'

export interface RecordToSampleOptions {
  readonly kind?: Kind | null
  readonly source?: string | null
}

export function recordToSample(record: JsonRecord, options: RecordToSampleOptions = {}): Sample {
  const kind = options.kind ?? detectKind(record)
  const data = normalizeRecord(record, kind)
  data.kind = kind

  if (options.source != null && !data.source) {
    data.source = options.source
  }

  return parseSample(data)
}
