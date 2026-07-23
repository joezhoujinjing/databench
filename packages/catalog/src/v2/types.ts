export type CatalogEntityKindV2 = 'record' | 'candidate' | 'signal' | 'preference'

export type CatalogCreationProfileV2 =
  | 'source-root-v1'
  | 'artifact-row-v1'
  | 'direct-root-v1'
  | 'derived-record-v1'
  | 'candidate-v1'
  | 'signal-event-v1'
  | 'preference-event-v1'

export type CatalogJsonValueV2 =
  | null
  | boolean
  | number
  | string
  | readonly CatalogJsonValueV2[]
  | { readonly [key: string]: CatalogJsonValueV2 }

export interface CatalogIdentityClaimInputV2 {
  readonly namespaceId: string
  readonly entityKind: CatalogEntityKindV2
  readonly claimKeyDigest: string
  readonly claimProfile: 'databench-identity-claim-v1'
  readonly requestProfile: 'databench-identity-request-v1'
  readonly creationProfile: CatalogCreationProfileV2
  readonly entityId: string
  readonly requestDigest: string
}

export interface CatalogIdentityClaimRowV2 extends CatalogIdentityClaimInputV2 {
  readonly createdAt: Date
}

export type CatalogIdentityClaimResultV2 =
  | { readonly status: 'created'; readonly row: CatalogIdentityClaimRowV2 }
  | { readonly status: 'existing_claim'; readonly row: CatalogIdentityClaimRowV2 }
  | { readonly status: 'existing_entity'; readonly row: CatalogIdentityClaimRowV2 }

export interface CatalogSnapshotInputV2 {
  readonly version: string
  readonly identityProfile: string
  readonly recordSchemaVersion: string
  readonly numRecords: bigint
}

export interface CatalogSnapshotRowV2 extends CatalogSnapshotInputV2 {
  readonly createdAt: Date
}

export interface CatalogLayoutInputV2 {
  readonly datasetVersion: string
  readonly layoutVersion: string
  readonly artifactDigest: string
  readonly artifactSizeBytes: bigint
  readonly manifestKey: string
  readonly columns: readonly string[]
}

export interface CatalogLayoutRowV2 extends CatalogLayoutInputV2 {
  readonly committedAt: Date
}

export interface CatalogParentRevisionV2 {
  readonly recordId: string
  readonly recordDigest: string
}

export interface CatalogRecordRevisionV2 {
  readonly recordId: string
  readonly recordDigest: string
  readonly parents: readonly CatalogParentRevisionV2[]
}

export interface CatalogRecordParentRowV2 {
  readonly position: number
  readonly parentRecordId: string
  readonly parentRecordDigest: string
}

export interface RegisterLayoutV2 {
  readonly snapshot: CatalogSnapshotInputV2
  readonly layout: CatalogLayoutInputV2
  readonly revisions: readonly CatalogRecordRevisionV2[]
}

export interface CatalogRunInputV2 {
  readonly id: string
  readonly cacheKey: string
  readonly op: string
  readonly opVersion: string
  readonly params: Readonly<Record<string, CatalogJsonValueV2>>
  readonly inputVersions: readonly string[]
  readonly outputVersion: string
}

export interface CatalogRunRowV2 extends CatalogRunInputV2 {
  readonly createdAt: Date
}

export interface RegisterTransformResultV2 extends RegisterLayoutV2 {
  readonly run: CatalogRunInputV2
}

export interface CompareAndSetRefV2 {
  readonly namespaceId: string
  readonly name: string
  readonly newVersion: string
  readonly expectedVersion: string | null
  readonly message: string | null
}

export interface CatalogRefRowV2 {
  readonly namespaceId: string
  readonly name: string
  readonly version: string
  readonly message: string | null
  readonly updatedAt: Date
}

export interface CatalogRefPageV2 {
  readonly rows: readonly CatalogRefRowV2[]
  readonly nextName: string | null
}
