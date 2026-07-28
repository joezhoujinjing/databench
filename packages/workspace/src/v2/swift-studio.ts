import type { CatalogSwiftStudioSessionRowV2 } from '@databench/catalog'
import {
  hashV2SwiftStudioSessionCreate,
  V2_SWIFT_STUDIO_SESSION_CREATE_PROFILE,
} from '@databench/hashing'
import {
  IntegrityError,
  SwiftStudioProviderSessionIdV2Schema,
  type SwiftStudioSessionV2,
  SwiftStudioSessionV2Schema,
} from '@databench/schema'

export const SWIFT_STUDIO_PATH_V2 = '/swift-studio/' as const

export function swiftStudioProviderSessionIdForDigestV2(createDigest: string): string {
  if (!/^[0-9a-f]{64}$/u.test(createDigest)) {
    throw new TypeError('Swift Studio Session create digest must be lowercase 64-hex')
  }
  return SwiftStudioProviderSessionIdV2Schema.parse(
    `sws_${Buffer.from(createDigest, 'hex').toString('base64url')}`,
  )
}

export function swiftStudioSessionFromCatalogV2(
  row: CatalogSwiftStudioSessionRowV2,
): SwiftStudioSessionV2 {
  const recomputedDigest = hashV2SwiftStudioSessionCreate({
    swift_studio_session_create_profile: V2_SWIFT_STUDIO_SESSION_CREATE_PROFILE,
    namespace: row.namespaceId,
    dataset_version: row.datasetVersion,
    converter: row.converter,
    converter_version: row.converterVersion,
    normalized_options: row.normalizedOptions,
    fidelity_digest: row.fidelityDigest,
    output_count: storedBigIntToSafeNumber(row.exportOutputCount, 'export_output_count'),
    provider: row.provider,
    upstream_commit: row.upstreamCommit,
    image_digest: row.imageDigest,
    runtime_capability_digest: row.runtimeCapabilityDigest,
  })
  if (recomputedDigest !== row.createDigest) {
    throw new IntegrityError('Stored Swift Studio Session create digest is inconsistent', {
      reason: 'swift_studio_session_create_digest_mismatch',
      session_id: row.id,
    })
  }
  const expectedProviderSessionId = swiftStudioProviderSessionIdForDigestV2(row.createDigest)
  if (row.providerSessionId !== expectedProviderSessionId) {
    throw new IntegrityError('Stored Swift Studio Provider locator is inconsistent', {
      reason: 'swift_studio_provider_locator_mismatch',
      session_id: row.id,
    })
  }
  return SwiftStudioSessionV2Schema.parse({
    id: row.id,
    create_digest: row.createDigest,
    status: row.status,
    dataset_version: row.datasetVersion,
    display_ref: row.displayRef,
    converter: row.converter,
    converter_version: row.converterVersion,
    normalized_options: row.normalizedOptions,
    fidelity_digest: row.fidelityDigest,
    output_count: storedBigIntToSafeNumber(row.exportOutputCount, 'export_output_count'),
    export_digest: row.exportDigest,
    export_size_bytes:
      row.exportSizeBytes === null
        ? null
        : storedBigIntToSafeNumber(row.exportSizeBytes, 'export_size_bytes'),
    provider: row.provider,
    upstream_commit: row.upstreamCommit,
    image_digest: row.imageDigest,
    runtime_capability_digest: row.runtimeCapabilityDigest,
    failure: row.failure,
    studio_path: row.status === 'ready' ? SWIFT_STUDIO_PATH_V2 : null,
    created_at: row.createdAt.toISOString(),
    ready_at: row.readyAt?.toISOString() ?? null,
    closed_at: row.closedAt?.toISOString() ?? null,
    updated_at: row.updatedAt.toISOString(),
  })
}

function storedBigIntToSafeNumber(value: bigint, field: string): number {
  const converted = Number(value)
  if (!Number.isSafeInteger(converted) || converted < 0) {
    throw new IntegrityError('Stored Swift Studio Session quantity is outside the wire range', {
      reason: 'swift_studio_session_quantity_invalid',
      field,
    })
  }
  return converted
}
