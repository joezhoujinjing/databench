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
  readonly lineageSequence: bigint
  readonly createdAt: Date
}

export interface CatalogRunPageV2 {
  readonly rows: readonly CatalogRunRowV2[]
  readonly nextCacheKey: string | null
}

export interface RegisterTransformResultV2 extends RegisterLayoutV2 {
  readonly run: CatalogRunInputV2
}

export interface CompleteTransformJobV2 extends RegisterTransformResultV2 {
  readonly job: TransformJobLeaseV2
  readonly outputCount: bigint
}

export interface ClearCompletedTransformJobStagingV2 {
  readonly id: string
  readonly attempt: number
  readonly outputVersion: string
  readonly inputKey: string
  readonly outputKey: string
}

export interface CompareAndSetRefV2 {
  readonly namespaceId: string
  readonly name: string
  readonly newVersion: string
  readonly expectedVersion: string | null
  readonly message: string | null
}

export interface DeleteRefV2 {
  readonly namespaceId: string
  readonly name: string
  readonly expectedVersion: string
}

export type DeleteRefResultV2 =
  | { readonly status: 'deleted' | 'already_deleted'; readonly row: CatalogRefRowV2 }
  | { readonly status: 'missing' }

export interface RestoreRefV2 {
  readonly namespaceId: string
  readonly name: string
  readonly expectedVersion: string
}

export type RestoreRefResultV2 =
  | { readonly status: 'restored' | 'already_active'; readonly row: CatalogRefRowV2 }
  | { readonly status: 'missing' }

export interface CatalogRefRowV2 {
  readonly namespaceId: string
  readonly name: string
  readonly version: string
  readonly numRecords: bigint
  readonly message: string | null
  readonly updatedAt: Date
  readonly deletedAt: Date | null
}

export interface CatalogRefPageV2 {
  readonly rows: readonly CatalogRefRowV2[]
  readonly nextName: string | null
}

export type CatalogTransformJobStatusV2 =
  | 'queued'
  | 'leased'
  | 'running'
  | 'finalizing'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface CatalogTransformJobProgressV2 {
  readonly phase: string
  readonly completedUnits: bigint
  readonly totalUnits: bigint | null
}

export interface CatalogTransformJobErrorV2 {
  readonly code: string
  readonly message: string
  readonly retryable: boolean
}

export interface CreateTransformJobV2 {
  readonly id: string
  readonly cacheKey: string
  readonly op: string
  readonly opVersion: string
  readonly params: Readonly<Record<string, CatalogJsonValueV2>>
  readonly inputVersion: string
  readonly capabilityName: string
  readonly capabilityVersion: string
  readonly inputCount: bigint
}

export interface CatalogTransformJobRowV2 extends CreateTransformJobV2 {
  readonly status: CatalogTransformJobStatusV2
  readonly attempt: number
  readonly leaseOwner: string | null
  readonly leaseToken: Uint8Array | null
  readonly leaseExpiresAt: Date | null
  readonly progress: CatalogTransformJobProgressV2 | null
  readonly inputKey: string | null
  readonly outputKey: string | null
  readonly outputCount: bigint | null
  readonly outputVersion: string | null
  readonly cacheHit: boolean
  readonly error: CatalogTransformJobErrorV2 | null
  readonly createdAt: Date
  readonly startedAt: Date | null
  readonly finishedAt: Date | null
  readonly updatedAt: Date
}

export interface CatalogTransformJobCursorV2 {
  readonly createdAt: Date
  readonly id: string
}

export interface CatalogTransformJobPageV2 {
  readonly rows: readonly CatalogTransformJobRowV2[]
  readonly nextCursor: CatalogTransformJobCursorV2 | null
}

export interface ClaimTransformJobV2 {
  readonly leaseOwner: string
  readonly leaseDurationMs: number
}

export interface TransformJobLeaseV2 {
  readonly id: string
  readonly attempt: number
  readonly leaseToken: Uint8Array
}

export interface UpdateTransformJobProgressV2 extends TransformJobLeaseV2 {
  readonly progress: CatalogTransformJobProgressV2
}

export interface SetTransformJobStagingKeysV2 extends TransformJobLeaseV2 {
  readonly inputKey: string
  readonly outputKey: string
}

export interface FailTransformJobV2 extends TransformJobLeaseV2 {
  readonly error: CatalogTransformJobErrorV2
}
