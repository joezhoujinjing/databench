export { dedup } from './dedup.js'
export { enrichLength } from './enrich-length.js'
export {
  filterBySignal,
  type SignalFilterParams,
  SignalFilterParamsSchema,
} from './filter-by-signal.js'
export { type SampleNParams, SampleNParamsSchema, sampleN } from './sample-n.js'
export { messageText, pythonWordCount, sampleText } from './text.js'

import type { Transform } from '@databench/engine'
import { dedup } from './dedup.js'
import { enrichLength } from './enrich-length.js'
import { filterBySignal } from './filter-by-signal.js'
import { sampleN } from './sample-n.js'

export const BUILTIN_TRANSFORMS = {
  dedup,
  enrich_length: enrichLength,
  filter_by_signal: filterBySignal,
  sample_n: sampleN,
} satisfies Record<string, Transform>
