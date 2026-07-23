export type V2CatalogImmutableKind = 'snapshot' | 'layout' | 'record_parents'

export class V2CatalogInputError extends Error {
  override readonly name = 'V2CatalogInputError'
}

export class V2CatalogConsistencyError extends Error {
  override readonly name = 'V2CatalogConsistencyError'

  constructor(message: string, options: ErrorOptions = {}) {
    super(message, options)
  }
}

export class V2CatalogImmutableConflictError extends Error {
  override readonly name = 'V2CatalogImmutableConflictError'
  readonly kind: V2CatalogImmutableKind
  readonly key: string

  constructor(kind: V2CatalogImmutableKind, key: string) {
    super(`Immutable V2 catalog ${kind} metadata conflicts for ${key}`)
    this.kind = kind
    this.key = key
  }
}

export class V2CatalogDeterminismConflictError extends Error {
  override readonly name = 'V2CatalogDeterminismConflictError'
  readonly cacheKey: string

  constructor(cacheKey: string) {
    super(`Immutable V2 run metadata conflicts for cache key ${cacheKey}`)
    this.cacheKey = cacheKey
  }
}

export class V2CatalogLineageCycleError extends Error {
  override readonly name = 'V2CatalogLineageCycleError'
  readonly recordId: string
  readonly recordDigest: string

  constructor(recordId: string, recordDigest: string) {
    super(`V2 record lineage would form a cycle at ${recordId}`)
    this.recordId = recordId
    this.recordDigest = recordDigest
  }
}

export class V2CatalogRefConflictError extends Error {
  override readonly name = 'V2CatalogRefConflictError'
  readonly namespaceId: string
  readonly refName: string
  readonly expectedVersion: string | null
  readonly currentVersion: string | null
  readonly newVersion: string

  constructor(input: {
    readonly namespaceId: string
    readonly refName: string
    readonly expectedVersion: string | null
    readonly currentVersion: string | null
    readonly newVersion: string
  }) {
    super(`V2 ref compare-and-set conflict for ${input.refName}`)
    this.namespaceId = input.namespaceId
    this.refName = input.refName
    this.expectedVersion = input.expectedVersion
    this.currentVersion = input.currentVersion
    this.newVersion = input.newVersion
  }
}

export class V2CatalogTargetNotCommittedError extends Error {
  override readonly name = 'V2CatalogTargetNotCommittedError'
  readonly version: string

  constructor(version: string) {
    super(`V2 ref target has no committed catalog layout: ${version}`)
    this.version = version
  }
}
