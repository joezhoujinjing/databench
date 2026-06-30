export const SCHEMA_VERSION = '1'
export const API_VERSION = 'v1'
export const MIN_CLIENT = '0.1.0'

export const DEFAULT_PAGE_LIMIT = 20
export const MAX_PAGE_LIMIT = 500

export const KINDS = ['sft', 'preference', 'rl', 'trajectory'] as const
export type Kind = (typeof KINDS)[number]

export const COLUMNS = ['id', 'row_digest', 'kind', 'source', 'payload', 'meta', 'signals'] as const
export type ColumnName = (typeof COLUMNS)[number]
