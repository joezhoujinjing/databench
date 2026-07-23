import { z } from 'zod'

export const RECORD_ID_PATTERN = /^rec_[0-9a-f]{64}$/
export const CANDIDATE_ID_PATTERN = /^cand_[0-9a-f]{64}$/
export const SIGNAL_ID_PATTERN = /^sig_[0-9a-f]{64}$/
export const PREFERENCE_ID_PATTERN = /^pref_[0-9a-f]{64}$/
export const DIGEST_PATTERN = /^[0-9a-f]{64}$/

export const NonEmptyStringSchema = z.string().min(1)
export const NullableNonEmptyStringSchema = NonEmptyStringSchema.nullable()
export const FiniteNumberSchema = z.number().finite()
export const NonNegativeSafeIntegerSchema = z.number().int().safe().nonnegative()

export const RecordIdSchema = z.string().regex(RECORD_ID_PATTERN)
export const CandidateIdSchema = z.string().regex(CANDIDATE_ID_PATTERN)
export const SignalIdSchema = z.string().regex(SIGNAL_ID_PATTERN)
export const PreferenceIdSchema = z.string().regex(PREFERENCE_ID_PATTERN)
export const DigestHexSchema = z.string().regex(DIGEST_PATTERN)

const RFC3339_UTC_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/
const RFC3339_OFFSET_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?(Z|([+-])(\d{2}):(\d{2}))$/

export const Rfc3339UtcSchema = z.string().superRefine((value, context) => {
  if (!isValidRfc3339Utc(value)) {
    context.addIssue({ code: 'custom', message: 'Expected an RFC 3339 UTC timestamp ending in Z' })
  }
})

export function normalizeRfc3339Utc(value: string): string {
  const match = RFC3339_OFFSET_PATTERN.exec(value)
  if (!match) {
    return value
  }

  const [year, month, day, hour, minute, second] = match
    .slice(1, 7)
    .map((component) => Number(component))
  if (!isValidCalendarTime(year, month, day, hour, minute, second)) {
    return value
  }

  const zone = match[8]
  if (zone === 'Z') {
    return value
  }
  const offsetHour = Number(match[10])
  const offsetMinute = Number(match[11])
  if (offsetHour > 23 || offsetMinute > 59) {
    return value
  }

  const instant = new Date(0)
  instant.setUTCFullYear(year as number, (month as number) - 1, day as number)
  instant.setUTCHours(hour as number, minute as number, second as number, 0)
  const direction = match[9] === '+' ? 1 : -1
  const shifted = new Date(
    instant.getTime() - direction * (offsetHour * 60 + offsetMinute) * 60_000,
  )
  const utcPrefix = shifted.toISOString().slice(0, 19)
  if (!/^\d{4}-/.test(utcPrefix)) {
    return value
  }
  return `${utcPrefix}${match[7] ?? ''}Z`
}

function isValidRfc3339Utc(value: string): boolean {
  const match = RFC3339_UTC_PATTERN.exec(value)
  if (!match) {
    return false
  }
  const [year, month, day, hour, minute, second] = match
    .slice(1, 7)
    .map((component) => Number(component))
  if (!isValidCalendarTime(year, month, day, hour, minute, second)) {
    return false
  }
  const instant = new Date(0)
  instant.setUTCFullYear(year as number, (month as number) - 1, day as number)
  instant.setUTCHours(hour as number, minute as number, second as number, 0)
  return (
    instant.getUTCFullYear() === year &&
    instant.getUTCMonth() === (month as number) - 1 &&
    instant.getUTCDate() === day
  )
}

function isValidCalendarTime(
  year: number | undefined,
  month: number | undefined,
  day: number | undefined,
  hour: number | undefined,
  minute: number | undefined,
  second: number | undefined,
): boolean {
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined ||
    second === undefined ||
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return false
  }
  const instant = new Date(0)
  instant.setUTCFullYear(year, month - 1, day)
  instant.setUTCHours(hour, minute, second, 0)
  return (
    instant.getUTCFullYear() === year &&
    instant.getUTCMonth() === month - 1 &&
    instant.getUTCDate() === day
  )
}

export const CanonicalMimeTypeSchema = z.string().regex(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/)

export function normalizeMimeType(value: string): string {
  return (value.split(';', 1)[0] ?? value).trim().toLowerCase()
}

export const StableUriSchema = NonEmptyStringSchema.superRefine((value, context) => {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    context.addIssue({ code: 'custom', message: 'Expected an absolute stable URI' })
    return
  }

  if (url.username || url.password) {
    context.addIssue({ code: 'custom', message: 'URI credentials are not allowed' })
  }
  if (['blob:', 'data:', 'file:', 'javascript:'].includes(url.protocol)) {
    context.addIssue({
      code: 'custom',
      message: 'Inline or executable URI schemes are not allowed',
    })
  }

  const forbiddenQueryKeys = new Set(
    [
      'access_token',
      'credential',
      'expires',
      'se',
      'sig',
      'signature',
      'token',
      'awsaccesskeyid',
      'googleaccessid',
      'ossaccesskeyid',
      'x-amz-credential',
      'x-amz-security-token',
      'x-amz-signature',
      'x-goog-credential',
      'x-goog-expires',
      'x-goog-signature',
      'x-oss-access-key-id',
      'x-oss-signature',
    ].map(normalizeSecurityKey),
  )
  for (const key of url.searchParams.keys()) {
    if (hasForbiddenKeySuffix(normalizeSecurityKey(key), forbiddenQueryKeys)) {
      context.addIssue({
        code: 'custom',
        message: 'Signed or credential-bearing URIs are not allowed',
      })
      break
    }
  }
})

export const Bcp47LanguageTagSchema = z.string().superRefine((value, context) => {
  if (!isBcp47LanguageTag(value)) {
    context.addIssue({ code: 'custom', message: 'Expected a valid BCP-47 language tag' })
  }
})

const GRANDFATHERED_LANGUAGE_TAGS = new Set([
  'art-lojban',
  'cel-gaulish',
  'en-gb-oed',
  'i-ami',
  'i-bnn',
  'i-default',
  'i-enochian',
  'i-hak',
  'i-klingon',
  'i-lux',
  'i-mingo',
  'i-navajo',
  'i-pwn',
  'i-tao',
  'i-tay',
  'i-tsu',
  'no-bok',
  'no-nyn',
  'sgn-be-fr',
  'sgn-be-nl',
  'sgn-ch-de',
  'zh-guoyu',
  'zh-hakka',
  'zh-min',
  'zh-min-nan',
  'zh-xiang',
])

function isBcp47LanguageTag(value: string): boolean {
  const lower = value.toLowerCase()
  if (GRANDFATHERED_LANGUAGE_TAGS.has(lower)) {
    return true
  }
  const subtags = value.split('-')
  if (subtags.some((subtag) => !/^[A-Za-z0-9]{1,8}$/.test(subtag))) {
    return false
  }
  if (subtags[0]?.toLowerCase() === 'x') {
    return subtags.length > 1
  }

  let index = 0
  const language = subtags[index]
  if (!language || !/^[A-Za-z]{2,8}$/.test(language)) {
    return false
  }
  index += 1
  if (language.length <= 3) {
    let extlangs = 0
    while (extlangs < 3 && /^[A-Za-z]{3}$/.test(subtags[index] ?? '')) {
      index += 1
      extlangs += 1
    }
  }
  if (/^[A-Za-z]{4}$/.test(subtags[index] ?? '')) {
    index += 1
  }
  if (/^(?:[A-Za-z]{2}|\d{3})$/.test(subtags[index] ?? '')) {
    index += 1
  }

  const variants = new Set<string>()
  while (/^(?:[A-Za-z0-9]{5,8}|\d[A-Za-z0-9]{3})$/.test(subtags[index] ?? '')) {
    const variant = (subtags[index] as string).toLowerCase()
    if (variants.has(variant)) {
      return false
    }
    variants.add(variant)
    index += 1
  }

  const extensions = new Set<string>()
  while (/^[0-9A-WY-Za-wy-z]$/.test(subtags[index] ?? '')) {
    const singleton = (subtags[index] as string).toLowerCase()
    if (extensions.has(singleton)) {
      return false
    }
    extensions.add(singleton)
    index += 1
    const start = index
    while (/^[A-Za-z0-9]{2,8}$/.test(subtags[index] ?? '')) {
      index += 1
    }
    if (index === start) {
      return false
    }
  }

  if (subtags[index]?.toLowerCase() === 'x') {
    index += 1
    const start = index
    while (/^[A-Za-z0-9]{1,8}$/.test(subtags[index] ?? '')) {
      index += 1
    }
    if (index === start) {
      return false
    }
  }
  return index === subtags.length
}

export function addIssue(context: z.RefinementCtx, path: PropertyKey[], message: string): void {
  context.addIssue({ code: 'custom', path, message })
}

export function hasDuplicate(values: readonly string[]): boolean {
  return new Set(values).size !== values.length
}

const CREDENTIAL_KEYS = new Set([
  'access_key',
  'access_key_id',
  'access_token',
  'api_key',
  'apikey',
  'authorization',
  'bearer_token',
  'client_secret',
  'cookie',
  'credentials',
  'password',
  'passwd',
  'private_key',
  'refresh_token',
  'secret',
  'secret_access_key',
])

export function findForbiddenJsonKey(
  value: unknown,
  extraForbiddenKeys: ReadonlySet<string> = new Set(),
): readonly PropertyKey[] | null {
  const stack: Array<{ value: unknown; path: PropertyKey[] }> = [{ value, path: [] }]
  while (stack.length > 0) {
    const current = stack.pop()
    if (!current || typeof current.value !== 'object' || current.value === null) {
      continue
    }
    if (Array.isArray(current.value)) {
      current.value.forEach((child, index) => {
        stack.push({ value: child, path: [...current.path, index] })
      })
      continue
    }
    for (const [key, child] of Object.entries(current.value)) {
      const normalizedKey = normalizeSecurityKey(key)
      const path = [...current.path, key]
      if (
        hasForbiddenKeySuffix(normalizedKey, CREDENTIAL_KEYS) ||
        hasForbiddenKeySuffix(normalizedKey, extraForbiddenKeys)
      ) {
        return path
      }
      stack.push({ value: child, path })
    }
  }
  return null
}

function normalizeSecurityKey(key: string): string {
  return key
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

function hasForbiddenKeySuffix(value: string, forbidden: ReadonlySet<string>): boolean {
  const compactValue = value.replaceAll('_', '')
  for (const candidate of forbidden) {
    const normalizedCandidate = normalizeSecurityKey(candidate)
    const compactCandidate = normalizedCandidate.replaceAll('_', '')
    if (
      value === normalizedCandidate ||
      value.endsWith(`_${normalizedCandidate}`) ||
      compactValue === compactCandidate ||
      compactValue.endsWith(compactCandidate)
    ) {
      return true
    }
  }
  return false
}
