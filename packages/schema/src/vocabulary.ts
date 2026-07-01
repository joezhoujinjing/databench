import { hashObj } from '@databench/hashing'
import { z } from 'zod'
import { ValidationError } from './errors.js'
import { JsonObjectSchema, type Sample } from './sample.js'

export const VocabularyStatusSchema = z.enum(['draft', 'curated'])
export type VocabularyStatus = z.infer<typeof VocabularyStatusSchema>

export const ExtractorSchema = z
  .object({
    source: z.literal('assistant_json').default('assistant_json'),
    raw_key: z.string(),
    std_key: z.string(),
  })
  .meta({ id: 'Extractor' })
export type Extractor = z.infer<typeof ExtractorSchema>

export const TermSchema = z
  .object({
    canonical: z.string(),
    aliases: z.array(z.string()).default(() => []),
    meta: JsonObjectSchema.default(() => ({})),
  })
  .meta({ id: 'Term' })
export type Term = z.infer<typeof TermSchema>

export const VocabularyInputSchema = z
  .object({
    name: z.string().nullable().default(null),
    dimension: z.string(),
    status: VocabularyStatusSchema.default('curated'),
    terms: z.array(TermSchema).default(() => []),
    meta: JsonObjectSchema.default(() => ({})),
    source: z.string().nullable().default(null),
  })
  .superRefine((value, context) => {
    const issues = vocabularyInvariantIssues(value.terms)

    for (const issue of issues) {
      context.addIssue({ code: 'custom', message: issue })
    }
  })
  .meta({ id: 'VocabularyInput' })
export type VocabularyInput = z.infer<typeof VocabularyInputSchema>

export const VocabularySchema = VocabularyInputSchema.extend({
  id: z.string(),
}).meta({ id: 'Vocabulary' })
export type Vocabulary = VocabularyInput & { readonly id: string }

export const VocabularyInfoSchema = z
  .object({
    name: z.string().nullable().default(null),
    id: z.string(),
    dimension: z.string(),
    num_terms: z.number().int().nonnegative(),
    status: VocabularyStatusSchema.nullable().default(null),
  })
  .meta({ id: 'VocabularyInfo' })
export type VocabularyInfo = z.infer<typeof VocabularyInfoSchema>

export const ValidateSummarySchema = z
  .object({
    checked: z.number().int().nonnegative(),
    invalid: z.number().int().nonnegative(),
    offending_values: z.record(z.string(), z.number().int().nonnegative()).default(() => ({})),
  })
  .meta({ id: 'ValidateSummary' })
export type ValidateSummary = z.infer<typeof ValidateSummarySchema>

export interface LabelPair {
  readonly raw: string | null
  readonly std: string | null
}

export type ExtractorFn = (sample: Sample) => LabelPair

export function parseExtractor(value: unknown): Extractor {
  return ExtractorSchema.parse(value)
}

export function parseVocabularyInput(value: unknown): VocabularyInput {
  return VocabularyInputSchema.parse(value)
}

export function parseVocabulary(value: unknown): Vocabulary {
  const input = VocabularyInputSchema.parse(value)
  return withVocabularyId(input)
}

export function withVocabularyId(input: VocabularyInput): Vocabulary {
  return {
    ...input,
    id: vocabularyId(input),
  }
}

export function vocabularyId(input: VocabularyInput): string {
  return hashObj(vocabularyContent(input))
}

export function vocabularyContent(input: Pick<VocabularyInput, 'dimension' | 'terms'>): {
  readonly dimension: string
  readonly terms: Array<{ readonly canonical: string; readonly aliases: readonly string[] }>
} {
  return {
    dimension: input.dimension,
    terms: [...input.terms]
      // Sort by Unicode code point (matching Python `sorted()`), NOT
      // `localeCompare` — ICU collation depends on the host locale, so the same
      // vocabulary would hash to different ids on different machines and would
      // disagree with Python's `content_dict` ordering.
      .sort((left, right) => compareCodePoints(left.canonical, right.canonical))
      .map((term) => ({
        canonical: term.canonical,
        aliases: [...term.aliases].sort(compareCodePoints),
      })),
  }
}

export function vocabularyCanonicalSet(vocabulary: Pick<Vocabulary, 'terms'>): Set<string> {
  return new Set(vocabulary.terms.map((term) => term.canonical))
}

export function vocabularyAliasIndex(vocabulary: Pick<Vocabulary, 'terms'>): Map<string, string> {
  const index = new Map<string, string>()

  for (const term of vocabulary.terms) {
    for (const alias of term.aliases) {
      index.set(alias, term.canonical)
    }
  }

  return index
}

export function normalizeVocabularyValue(
  vocabulary: Pick<Vocabulary, 'terms'>,
  value: string,
): string | null {
  if (vocabularyCanonicalSet(vocabulary).has(value)) {
    return value
  }

  return vocabularyAliasIndex(vocabulary).get(value) ?? null
}

export function vocabularyExtractor(vocabulary: Pick<Vocabulary, 'meta'>): Extractor | null {
  const spec = vocabulary.meta.extractor
  return spec && typeof spec === 'object' && !Array.isArray(spec)
    ? ExtractorSchema.parse(spec)
    : null
}

export function extractLabelPair(sample: Sample, extractor: Extractor | ExtractorFn): LabelPair {
  return typeof extractor === 'function'
    ? extractor(sample)
    : extractAssistantJson(sample, extractor)
}

export function writeExtractedStd(sample: Sample, extractor: Extractor, value: string): Sample {
  if (sample.kind !== 'sft') {
    return sample
  }

  for (let index = sample.messages.length - 1; index >= 0; index -= 1) {
    const message = sample.messages[index]

    if (message?.role !== 'assistant' || !message.content) {
      continue
    }

    const payload = parseJsonObject(message.content)
    if (payload === null) {
      return sample
    }

    if (payload[extractor.std_key] === value) {
      return sample
    }

    const messages = [...sample.messages]
    messages[index] = {
      ...message,
      content: stringifyLikePythonJsonDumps({ ...payload, [extractor.std_key]: value }),
    }

    return { ...sample, messages }
  }

  return sample
}

export function deriveVocabulary(
  samples: Iterable<Sample>,
  options: {
    readonly dimension: string
    readonly extractor: Extractor | ExtractorFn
    readonly name?: string | null
  },
): Vocabulary {
  const canonicalCounts = new Map<string, number>()
  const seen = new Map<string, Map<string, number>>()

  for (const sample of samples) {
    const { raw, std } = extractLabelPair(sample, options.extractor)

    if (!std) {
      continue
    }

    canonicalCounts.set(std, (canonicalCounts.get(std) ?? 0) + 1)

    if (raw && raw !== std) {
      let candidates = seen.get(raw)

      if (!candidates) {
        candidates = new Map()
        seen.set(raw, candidates)
      }

      candidates.set(std, (candidates.get(std) ?? 0) + 1)
    }
  }

  const aliasesOf = new Map<string, Map<string, number>>()
  const conflictsOf = new Map<string, Map<string, AliasConflict>>()

  for (const raw of [...seen.keys()].sort()) {
    const candidates = seen.get(raw)

    if (!candidates) {
      continue
    }

    if (canonicalCounts.has(raw)) {
      setConflict(conflictsOf, raw, raw, {
        chosen: raw,
        also_seen: [...candidates.keys()].sort(),
        counts: sortedRecord(candidates),
      })
      continue
    }

    const winner = [...candidates.keys()].sort((left, right) => {
      const countDelta = (candidates.get(right) ?? 0) - (candidates.get(left) ?? 0)
      return countDelta === 0 ? left.localeCompare(right) : countDelta
    })[0]

    if (!winner) {
      continue
    }

    getOrCreateMap(aliasesOf, winner).set(raw, candidates.get(winner) ?? 0)

    if (candidates.size > 1) {
      setConflict(conflictsOf, winner, raw, {
        chosen: winner,
        also_seen: [...candidates.keys()].filter((candidate) => candidate !== winner).sort(),
        counts: sortedRecord(candidates),
      })
    }
  }

  const terms: Term[] = [...canonicalCounts.keys()].sort().map((canonical) => {
    const aliases = aliasesOf.get(canonical) ?? new Map()
    const conflicts = conflictsOf.get(canonical)
    const meta: Record<string, unknown> = {
      count: canonicalCounts.get(canonical) ?? 0,
      alias_counts: sortedRecord(aliases),
    }

    if (conflicts && conflicts.size > 0) {
      meta.alias_conflicts = sortedConflictRecord(conflicts)
    }

    return TermSchema.parse({
      canonical,
      aliases: [...aliases.keys()].sort(),
      meta,
    })
  })

  const meta: Record<string, unknown> = { derived: true }
  if (typeof options.extractor !== 'function') {
    meta.extractor = ExtractorSchema.parse(options.extractor)
  }

  return withVocabularyId(
    VocabularyInputSchema.parse({
      name: options.name ?? null,
      dimension: options.dimension,
      status: 'draft',
      terms,
      meta,
      source: null,
    }),
  )
}

export function normalizeSamples(
  samples: Iterable<Sample>,
  vocabulary: Vocabulary,
  extractor: Extractor,
): Sample[] {
  const out: Sample[] = []

  for (const sample of samples) {
    const { raw, std } = extractLabelPair(sample, extractor)

    if (!raw) {
      out.push(sample)
      continue
    }

    const mapped = normalizeVocabularyValue(vocabulary, raw)
    out.push(
      mapped !== null && mapped !== std ? writeExtractedStd(sample, extractor, mapped) : sample,
    )
  }

  return out
}

export function validateSamples(
  samples: Iterable<Sample>,
  vocabulary: Vocabulary,
  extractor: Extractor | ExtractorFn,
): { readonly samples: Sample[]; readonly summary: ValidateSummary } {
  const canonical = vocabularyCanonicalSet(vocabulary)
  const signalKey = `vocab_${vocabulary.dimension}_valid`
  const out: Sample[] = []
  const offending = new Map<string, number>()
  let checked = 0

  for (const sample of samples) {
    const { std } = extractLabelPair(sample, extractor)

    if (std === null) {
      out.push(sample)
      continue
    }

    const isValid = canonical.has(std)
    checked += 1

    if (!isValid) {
      offending.set(std, (offending.get(std) ?? 0) + 1)
    }

    out.push({
      ...sample,
      signals: {
        ...sample.signals,
        [signalKey]: isValid,
      },
    })
  }

  return {
    samples: out,
    summary: ValidateSummarySchema.parse({
      checked,
      invalid: [...offending.values()].reduce((sum, count) => sum + count, 0),
      offending_values: sortedRecord(offending),
    }),
  }
}

export interface AliasConflict {
  readonly chosen: string
  readonly also_seen: readonly string[]
  readonly counts: Record<string, number>
}

function vocabularyInvariantIssues(terms: readonly Term[]): string[] {
  const issues: string[] = []
  const canonicals = new Set<string>()

  for (const term of terms) {
    if (canonicals.has(term.canonical)) {
      issues.push(`duplicate canonical term: ${JSON.stringify(term.canonical)}`)
    }

    canonicals.add(term.canonical)
  }

  const aliases = new Map<string, string>()
  for (const term of terms) {
    for (const alias of term.aliases) {
      if (canonicals.has(alias)) {
        issues.push(
          `alias ${JSON.stringify(alias)} is also a canonical term (aliases and canonicals must be disjoint)`,
        )
      }

      const existing = aliases.get(alias)
      if (existing !== undefined && existing !== term.canonical) {
        issues.push(
          `alias ${JSON.stringify(alias)} maps to both ${JSON.stringify(existing)} and ${JSON.stringify(term.canonical)}`,
        )
      }

      aliases.set(alias, term.canonical)
    }
  }

  return issues
}

function extractAssistantJson(sample: Sample, extractor: Extractor): LabelPair {
  if (sample.kind !== 'sft') {
    return { raw: null, std: null }
  }

  for (let index = sample.messages.length - 1; index >= 0; index -= 1) {
    const message = sample.messages[index]

    if (message?.role !== 'assistant' || !message.content) {
      continue
    }

    const payload = parseJsonObject(message.content)
    if (payload === null) {
      return { raw: null, std: null }
    }

    return {
      raw: readNonEmptyString(payload[extractor.raw_key]),
      std: readNonEmptyString(payload[extractor.std_key]),
    }
  }

  return { raw: null, std: null }
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function stringifyLikePythonJsonDumps(value: unknown): string {
  if (value === null) {
    return 'null'
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stringifyLikePythonJsonDumps(item)).join(', ')}]`
  }

  switch (typeof value) {
    case 'string':
      return JSON.stringify(value)
    case 'number':
      return Number.isFinite(value) ? String(value) : String(value)
    case 'boolean':
      return value ? 'true' : 'false'
    case 'object':
      return stringifyObjectLikePythonJsonDumps(value)
    default:
      return JSON.stringify(String(value))
  }
}

function stringifyObjectLikePythonJsonDumps(value: object): string {
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort(compareCodePoints)
    .map((key) => `${JSON.stringify(key)}: ${stringifyLikePythonJsonDumps(record[key])}`)
    .join(', ')}}`
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function compareCodePoints(left: string, right: string): number {
  const leftCodePoints = Array.from(left)
  const rightCodePoints = Array.from(right)
  const length = Math.min(leftCodePoints.length, rightCodePoints.length)

  for (let index = 0; index < length; index += 1) {
    const leftCodePoint = leftCodePoints[index]?.codePointAt(0) ?? 0
    const rightCodePoint = rightCodePoints[index]?.codePointAt(0) ?? 0

    if (leftCodePoint !== rightCodePoint) {
      return leftCodePoint - rightCodePoint
    }
  }

  return leftCodePoints.length - rightCodePoints.length
}

function getOrCreateMap<TKey, TValue>(
  records: Map<TKey, Map<string, TValue>>,
  key: TKey,
): Map<string, TValue> {
  let record = records.get(key)

  if (!record) {
    record = new Map()
    records.set(key, record)
  }

  return record
}

function setConflict(
  records: Map<string, Map<string, AliasConflict>>,
  canonical: string,
  alias: string,
  conflict: AliasConflict,
): void {
  getOrCreateMap(records, canonical).set(alias, conflict)
}

function sortedRecord(records: ReadonlyMap<string, number>): Record<string, number> {
  return Object.fromEntries(
    [...records.entries()].sort(([left], [right]) => left.localeCompare(right)),
  )
}

function sortedConflictRecord(
  records: ReadonlyMap<string, AliasConflict>,
): Record<string, AliasConflict> {
  return Object.fromEntries(
    [...records.entries()].sort(([left], [right]) => left.localeCompare(right)),
  )
}

export function assertVocabularyInput(value: unknown): VocabularyInput {
  try {
    return VocabularyInputSchema.parse(value)
  } catch (error) {
    throw new ValidationError('invalid vocabulary', error)
  }
}
