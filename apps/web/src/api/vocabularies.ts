import { type FetchLike, requestJson } from './client.js'
import { clampLimit } from './pagination.js'
import type {
  DatasetManifest,
  Extractor,
  ValidateResponse,
  VocabulariesPage,
  Vocabulary,
  VocabularyInput,
} from './types.js'

export interface VocabulariesRequestOptions {
  base: string
  fetch?: FetchLike
  limit?: number
  offset?: number
  token: string
}

export interface VocabularyRequestOptions {
  base: string
  fetch?: FetchLike
  name: string
  token: string
}

export interface DeriveVocabularyOptions extends VocabularyRequestOptions {
  dataset: string
  dimension: string
  extractor?: Extractor
}

export interface SaveVocabularyOptions extends VocabularyRequestOptions {
  payload: VocabularyInput
}

export interface ApplyVocabularyOptions extends VocabularyRequestOptions {
  dataset: string
  extractor?: Extractor
  ref?: string
}

export function listVocabularies(options: VocabulariesRequestOptions): Promise<VocabulariesPage> {
  const { limit, offset, ...requestOptions } = options

  return requestJson<VocabulariesPage>('/v1/vocabularies', {
    ...requestOptions,
    query: { limit: clampLimit(limit ?? 500), offset: offset ?? 0 },
  })
}

export function getVocabulary(options: VocabularyRequestOptions): Promise<Vocabulary> {
  const { name, ...requestOptions } = options

  return requestJson<Vocabulary>(`/v1/vocabularies/${encodeURIComponent(name)}`, requestOptions)
}

export function deriveVocabulary(options: DeriveVocabularyOptions): Promise<Vocabulary> {
  const { dataset, dimension, extractor, name, ...requestOptions } = options

  return requestJson<Vocabulary>(`/v1/vocabularies/${encodeURIComponent(name)}:derive`, {
    ...requestOptions,
    ...extractorBody(extractor),
    method: 'POST',
    query: { dataset, dimension },
  })
}

export function saveVocabulary(options: SaveVocabularyOptions): Promise<Vocabulary> {
  const { name, payload, ...requestOptions } = options

  return requestJson<Vocabulary>(`/v1/vocabularies/${encodeURIComponent(name)}`, {
    ...requestOptions,
    body: JSON.stringify(payload),
    headers: { 'Content-Type': 'application/json' },
    method: 'PUT',
  })
}

export function normalizeVocabulary(options: ApplyVocabularyOptions): Promise<DatasetManifest> {
  const { dataset, extractor, name, ref, ...requestOptions } = options

  return requestJson<DatasetManifest>(`/v1/vocabularies/${encodeURIComponent(name)}:normalize`, {
    ...requestOptions,
    ...extractorBody(extractor),
    method: 'POST',
    query: { dataset, ref: blankToUndefined(ref) },
  })
}

export function validateVocabulary(options: ApplyVocabularyOptions): Promise<ValidateResponse> {
  const { dataset, extractor, name, ref, ...requestOptions } = options

  return requestJson<ValidateResponse>(`/v1/vocabularies/${encodeURIComponent(name)}:validate`, {
    ...requestOptions,
    ...extractorBody(extractor),
    method: 'POST',
    query: { dataset, ref: blankToUndefined(ref) },
  })
}

function extractorBody(extractor: Extractor | undefined): Pick<RequestInit, 'body' | 'headers'> {
  if (extractor === undefined) {
    return {}
  }

  return {
    body: JSON.stringify(extractor),
    headers: { 'Content-Type': 'application/json' },
  }
}

function blankToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed === '' ? undefined : trimmed
}
