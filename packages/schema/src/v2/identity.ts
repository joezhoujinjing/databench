import {
  canonicalJsonV2,
  type DatasetIdentityEnvelopeV2,
  deriveV2CandidateId,
  deriveV2PreferenceId,
  deriveV2RecordId,
  deriveV2SignalId,
  hashV2IdentityClaimKey,
  hashV2IdentityRequest,
  type IdentityClaimHashInputV1,
  type IdentityRequestHashInputV1,
  type TransformCacheIdentityV1,
  V2_IDENTITY_CLAIM_PROFILE,
  V2_IDENTITY_PROFILE,
  V2_IDENTITY_REQUEST_PROFILE,
  V2_RECORD_SCHEMA_VERSION,
} from '@databench/hashing'
import { z } from 'zod'
import { ConflictError, IntegrityError } from '../errors.js'
import { CandidateSchema, InitialCandidateV2Schema } from './candidate.js'
import {
  CandidateIdSchema,
  DigestHexSchema,
  hasDuplicate,
  NonEmptyStringSchema,
  NonNegativeSafeIntegerSchema,
  PreferenceIdSchema,
  RecordIdSchema,
  SignalIdSchema,
} from './common.js'
import { JsonObjectSchema } from './json-value.js'
import { InitialPreferenceRelationV2Schema, PreferenceRelationSchema } from './preference.js'
import { InitialPostTrainingRecordV2Schema, PostTrainingRecordV2Schema } from './record.js'
import type { DeepReadonly } from './revision.js'
import { InitialSignalV2Schema, SignalSchema } from './signal.js'

export const IDENTITY_KEY_MAX_UTF8_BYTES_V2 = 1024

export const IdentityNamespaceV2Schema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)

const IdentityStringSchema = NonEmptyStringSchema.superRefine((value, context) => {
  try {
    canonicalJsonV2(value)
  } catch (error) {
    context.addIssue({
      code: 'custom',
      message:
        error instanceof Error ? error.message : 'Identity string must contain Unicode scalars',
    })
  }
})

const IdentityKeySchema = IdentityStringSchema.refine(
  (value) => new TextEncoder().encode(value).byteLength <= IDENTITY_KEY_MAX_UTF8_BYTES_V2,
  `Identity key must be at most ${IDENTITY_KEY_MAX_UTF8_BYTES_V2} UTF-8 bytes`,
)

export const SourceRootSeedV1Schema = z.strictObject({
  namespace: IdentityNamespaceV2Schema,
  source: z.strictObject({
    name: IdentityStringSchema,
    kind: IdentityStringSchema,
    original_id: IdentityStringSchema,
  }),
})
export type SourceRootSeedV1 = z.infer<typeof SourceRootSeedV1Schema>

export const ArtifactRowSeedV1Schema = z.strictObject({
  namespace: IdentityNamespaceV2Schema,
  source_artifact_digest: DigestHexSchema,
  row_index: NonNegativeSafeIntegerSchema,
})
export type ArtifactRowSeedV1 = z.infer<typeof ArtifactRowSeedV1Schema>

export const DirectRootSeedV1Schema = z.strictObject({
  namespace: IdentityNamespaceV2Schema,
  idempotency_key_or_random_seed: IdentityKeySchema,
})
export type DirectRootSeedV1 = z.infer<typeof DirectRootSeedV1Schema>

export const DerivedRecordSeedV1Schema = z
  .strictObject({
    op: IdentityKeySchema,
    op_version: IdentityKeySchema,
    params: JsonObjectSchema,
    parent_ids: z.array(RecordIdSchema).min(1),
    output_index: NonNegativeSafeIntegerSchema,
  })
  .superRefine((seed, context) => {
    if (hasDuplicate(seed.parent_ids)) {
      context.addIssue({
        code: 'custom',
        path: ['parent_ids'],
        message: 'Derived record parent IDs must be unique',
      })
    }
  })
export type DerivedRecordSeedV1 = z.infer<typeof DerivedRecordSeedV1Schema>

export const CandidateSeedV1Schema = z.strictObject({
  record_id: RecordIdSchema,
  generation_run_id: IdentityKeySchema,
  output_index: NonNegativeSafeIntegerSchema,
})
export type CandidateSeedV1 = z.infer<typeof CandidateSeedV1Schema>

export const SignalEventSeedV1Schema = z.strictObject({
  owner_id: CandidateIdSchema,
  producer: IdentityKeySchema,
  producer_event_key: IdentityKeySchema,
})
export type SignalEventSeedV1 = z.infer<typeof SignalEventSeedV1Schema>

export const PreferenceEventSeedV1Schema = z.strictObject({
  owner_id: RecordIdSchema,
  producer: IdentityKeySchema,
  producer_event_key: IdentityKeySchema,
})
export type PreferenceEventSeedV1 = z.infer<typeof PreferenceEventSeedV1Schema>

export const EventSeedV1Schema = z.union([SignalEventSeedV1Schema, PreferenceEventSeedV1Schema])
export type EventSeedV1 = z.infer<typeof EventSeedV1Schema>

export const DatasetIdentityEnvelopeV2Schema: z.ZodType<DatasetIdentityEnvelopeV2> = z.strictObject(
  {
    identity_profile: z.literal(V2_IDENTITY_PROFILE),
    record_schema_version: z.literal(V2_RECORD_SCHEMA_VERSION),
    record_digests: z.array(DigestHexSchema),
  },
)

export const TransformCacheIdentityV1Schema: z.ZodType<TransformCacheIdentityV1> = z.strictObject({
  identity_profile: z.literal(V2_IDENTITY_PROFILE),
  op: IdentityKeySchema,
  op_version: IdentityKeySchema,
  input_dataset_versions: z.array(DigestHexSchema),
  params: JsonObjectSchema,
})

const SourceRootIdentityRequestV1BaseSchema = z.strictObject({
  creation_profile: z.literal('source-root-v1'),
  seed: SourceRootSeedV1Schema,
  initial_record: InitialPostTrainingRecordV2Schema,
})
const ArtifactRowIdentityRequestV1BaseSchema = z.strictObject({
  creation_profile: z.literal('artifact-row-v1'),
  seed: ArtifactRowSeedV1Schema,
  initial_record: InitialPostTrainingRecordV2Schema,
})
const DirectRootIdentityRequestV1BaseSchema = z.strictObject({
  creation_profile: z.literal('direct-root-v1'),
  seed: DirectRootSeedV1Schema,
  initial_record: InitialPostTrainingRecordV2Schema,
})
const DerivedRecordIdentityRequestV1BaseSchema = z.strictObject({
  creation_profile: z.literal('derived-record-v1'),
  seed: DerivedRecordSeedV1Schema,
  initial_record: InitialPostTrainingRecordV2Schema,
})
const CandidateIdentityRequestV1BaseSchema = z.strictObject({
  creation_profile: z.literal('candidate-v1'),
  owner_record_id: RecordIdSchema,
  seed: CandidateSeedV1Schema,
  initial_candidate: InitialCandidateV2Schema,
})
const SignalIdentityRequestV1BaseSchema = z.strictObject({
  creation_profile: z.literal('signal-event-v1'),
  owner_candidate_id: CandidateIdSchema,
  seed: SignalEventSeedV1Schema,
  initial_signal: InitialSignalV2Schema,
})
const PreferenceIdentityRequestV1BaseSchema = z.strictObject({
  creation_profile: z.literal('preference-event-v1'),
  owner_record_id: RecordIdSchema,
  seed: PreferenceEventSeedV1Schema,
  initial_preference: InitialPreferenceRelationV2Schema,
})

const DirectRootIdentityDraftV1Schema = z.strictObject({
  creation_profile: z.literal('direct-root-v1'),
  seed: z.strictObject({
    namespace: IdentityNamespaceV2Schema,
    idempotency_key_or_random_seed: IdentityKeySchema.nullable(),
  }),
  initial_record: InitialPostTrainingRecordV2Schema,
})
const CandidateIdentityDraftV1Schema = z.strictObject({
  creation_profile: z.literal('candidate-v1'),
  owner_record_id: RecordIdSchema,
  seed: z.strictObject({
    record_id: RecordIdSchema,
    generation_run_id: IdentityKeySchema.nullable(),
    output_index: NonNegativeSafeIntegerSchema,
  }),
  initial_candidate: InitialCandidateV2Schema,
})
const SignalIdentityDraftV1Schema = z.strictObject({
  creation_profile: z.literal('signal-event-v1'),
  owner_candidate_id: CandidateIdSchema,
  seed: z.strictObject({
    owner_id: CandidateIdSchema,
    producer: IdentityKeySchema,
    producer_event_key: IdentityKeySchema.nullable(),
  }),
  initial_signal: InitialSignalV2Schema,
})
const PreferenceIdentityDraftV1Schema = z.strictObject({
  creation_profile: z.literal('preference-event-v1'),
  owner_record_id: RecordIdSchema,
  seed: z.strictObject({
    owner_id: RecordIdSchema,
    producer: IdentityKeySchema,
    producer_event_key: IdentityKeySchema.nullable(),
  }),
  initial_preference: InitialPreferenceRelationV2Schema,
})

const IdentityAllocationDraftV1BaseSchema = z.discriminatedUnion('creation_profile', [
  SourceRootIdentityRequestV1BaseSchema,
  ArtifactRowIdentityRequestV1BaseSchema,
  DirectRootIdentityDraftV1Schema,
  DerivedRecordIdentityRequestV1BaseSchema,
  CandidateIdentityDraftV1Schema,
  SignalIdentityDraftV1Schema,
  PreferenceIdentityDraftV1Schema,
])
export type IdentityAllocationDraftV1 = z.infer<typeof IdentityAllocationDraftV1BaseSchema>
export const IdentityAllocationDraftV1Schema = IdentityAllocationDraftV1BaseSchema.superRefine(
  validateIdentityRequestConsistency,
).superRefine(validateCanonicalIdentityValue)

export const IdentityCreationRequestV1Schema = z
  .discriminatedUnion('creation_profile', [
    SourceRootIdentityRequestV1BaseSchema,
    ArtifactRowIdentityRequestV1BaseSchema,
    DirectRootIdentityRequestV1BaseSchema,
    DerivedRecordIdentityRequestV1BaseSchema,
    CandidateIdentityRequestV1BaseSchema,
    SignalIdentityRequestV1BaseSchema,
    PreferenceIdentityRequestV1BaseSchema,
  ])
  .superRefine(validateIdentityRequestConsistency)
  .superRefine(validateCanonicalIdentityValue)
export type IdentityCreationRequestV1 = z.infer<typeof IdentityCreationRequestV1Schema>
export type SourceRootIdentityRequestV1 = z.infer<typeof SourceRootIdentityRequestV1BaseSchema>
export type ArtifactRowIdentityRequestV1 = z.infer<typeof ArtifactRowIdentityRequestV1BaseSchema>
export type DirectRootIdentityRequestV1 = z.infer<typeof DirectRootIdentityRequestV1BaseSchema>
export type DerivedRecordIdentityRequestV1 = z.infer<
  typeof DerivedRecordIdentityRequestV1BaseSchema
>
export type CandidateIdentityRequestV1 = z.infer<typeof CandidateIdentityRequestV1BaseSchema>
export type SignalIdentityRequestV1 = z.infer<typeof SignalIdentityRequestV1BaseSchema>
export type PreferenceIdentityRequestV1 = z.infer<typeof PreferenceIdentityRequestV1BaseSchema>

const ClaimEnvelopeBaseShape = {
  claim_profile: z.literal(V2_IDENTITY_CLAIM_PROFILE),
  identity_profile: z.literal(V2_IDENTITY_PROFILE),
  namespace: IdentityNamespaceV2Schema,
} as const

export const IdentityClaimKeyV1Schema = z
  .discriminatedUnion('creation_profile', [
    z.strictObject({
      ...ClaimEnvelopeBaseShape,
      entity_kind: z.literal('record'),
      creation_profile: z.literal('source-root-v1'),
      claim_material: SourceRootSeedV1Schema,
    }),
    z.strictObject({
      ...ClaimEnvelopeBaseShape,
      entity_kind: z.literal('record'),
      creation_profile: z.literal('artifact-row-v1'),
      claim_material: ArtifactRowSeedV1Schema,
    }),
    z.strictObject({
      ...ClaimEnvelopeBaseShape,
      entity_kind: z.literal('record'),
      creation_profile: z.literal('direct-root-v1'),
      claim_material: DirectRootSeedV1Schema,
    }),
    z.strictObject({
      ...ClaimEnvelopeBaseShape,
      entity_kind: z.literal('record'),
      creation_profile: z.literal('derived-record-v1'),
      claim_material: DerivedRecordSeedV1Schema,
    }),
    z.strictObject({
      ...ClaimEnvelopeBaseShape,
      entity_kind: z.literal('candidate'),
      creation_profile: z.literal('candidate-v1'),
      claim_material: CandidateSeedV1Schema,
    }),
    z.strictObject({
      ...ClaimEnvelopeBaseShape,
      entity_kind: z.literal('signal'),
      creation_profile: z.literal('signal-event-v1'),
      claim_material: SignalEventSeedV1Schema,
    }),
    z.strictObject({
      ...ClaimEnvelopeBaseShape,
      entity_kind: z.literal('preference'),
      creation_profile: z.literal('preference-event-v1'),
      claim_material: PreferenceEventSeedV1Schema,
    }),
  ])
  .superRefine((envelope, context) => {
    switch (envelope.creation_profile) {
      case 'source-root-v1':
      case 'artifact-row-v1':
      case 'direct-root-v1':
        validateNamespaceEquality(envelope.namespace, envelope.claim_material.namespace, context, [
          'claim_material',
          'namespace',
        ])
    }
  })
export type IdentityClaimKeyV1 = z.infer<typeof IdentityClaimKeyV1Schema>

const RequestEnvelopeBaseShape = {
  request_profile: z.literal(V2_IDENTITY_REQUEST_PROFILE),
  identity_profile: z.literal(V2_IDENTITY_PROFILE),
  namespace: IdentityNamespaceV2Schema,
} as const

export const IdentityRequestDigestV1Schema = z
  .discriminatedUnion('creation_profile', [
    z.strictObject({
      ...RequestEnvelopeBaseShape,
      entity_kind: z.literal('record'),
      creation_profile: z.literal('source-root-v1'),
      normalized_request: SourceRootIdentityRequestV1BaseSchema,
    }),
    z.strictObject({
      ...RequestEnvelopeBaseShape,
      entity_kind: z.literal('record'),
      creation_profile: z.literal('artifact-row-v1'),
      normalized_request: ArtifactRowIdentityRequestV1BaseSchema,
    }),
    z.strictObject({
      ...RequestEnvelopeBaseShape,
      entity_kind: z.literal('record'),
      creation_profile: z.literal('direct-root-v1'),
      normalized_request: DirectRootIdentityRequestV1BaseSchema,
    }),
    z.strictObject({
      ...RequestEnvelopeBaseShape,
      entity_kind: z.literal('record'),
      creation_profile: z.literal('derived-record-v1'),
      normalized_request: DerivedRecordIdentityRequestV1BaseSchema,
    }),
    z.strictObject({
      ...RequestEnvelopeBaseShape,
      entity_kind: z.literal('candidate'),
      creation_profile: z.literal('candidate-v1'),
      normalized_request: CandidateIdentityRequestV1BaseSchema,
    }),
    z.strictObject({
      ...RequestEnvelopeBaseShape,
      entity_kind: z.literal('signal'),
      creation_profile: z.literal('signal-event-v1'),
      normalized_request: SignalIdentityRequestV1BaseSchema,
    }),
    z.strictObject({
      ...RequestEnvelopeBaseShape,
      entity_kind: z.literal('preference'),
      creation_profile: z.literal('preference-event-v1'),
      normalized_request: PreferenceIdentityRequestV1BaseSchema,
    }),
  ])
  .superRefine((envelope, context) => {
    validateCanonicalIdentityValue(envelope, context)
    validateIdentityRequestConsistency(envelope.normalized_request, context, ['normalized_request'])
    switch (envelope.creation_profile) {
      case 'source-root-v1':
      case 'artifact-row-v1':
      case 'direct-root-v1':
        validateNamespaceEquality(
          envelope.namespace,
          envelope.normalized_request.seed.namespace,
          context,
          ['normalized_request', 'seed', 'namespace'],
        )
    }
  })
export type IdentityRequestDigestV1 = z.infer<typeof IdentityRequestDigestV1Schema>

const PreparedClaimBaseShape = {
  namespace: IdentityNamespaceV2Schema,
  claim_profile: z.literal(V2_IDENTITY_CLAIM_PROFILE),
  request_profile: z.literal(V2_IDENTITY_REQUEST_PROFILE),
  claim_key_digest: DigestHexSchema,
  request_digest: DigestHexSchema,
} as const

export const PreparedIdentityClaimV2Schema = z.discriminatedUnion('creation_profile', [
  z.strictObject({
    ...PreparedClaimBaseShape,
    entity_kind: z.literal('record'),
    creation_profile: z.literal('source-root-v1'),
    entity_id: RecordIdSchema,
  }),
  z.strictObject({
    ...PreparedClaimBaseShape,
    entity_kind: z.literal('record'),
    creation_profile: z.literal('artifact-row-v1'),
    entity_id: RecordIdSchema,
  }),
  z.strictObject({
    ...PreparedClaimBaseShape,
    entity_kind: z.literal('record'),
    creation_profile: z.literal('direct-root-v1'),
    entity_id: RecordIdSchema,
  }),
  z.strictObject({
    ...PreparedClaimBaseShape,
    entity_kind: z.literal('record'),
    creation_profile: z.literal('derived-record-v1'),
    entity_id: RecordIdSchema,
  }),
  z.strictObject({
    ...PreparedClaimBaseShape,
    entity_kind: z.literal('candidate'),
    creation_profile: z.literal('candidate-v1'),
    entity_id: CandidateIdSchema,
  }),
  z.strictObject({
    ...PreparedClaimBaseShape,
    entity_kind: z.literal('signal'),
    creation_profile: z.literal('signal-event-v1'),
    entity_id: SignalIdSchema,
  }),
  z.strictObject({
    ...PreparedClaimBaseShape,
    entity_kind: z.literal('preference'),
    creation_profile: z.literal('preference-event-v1'),
    entity_id: PreferenceIdSchema,
  }),
])
export type PreparedIdentityClaimV2 = Readonly<z.infer<typeof PreparedIdentityClaimV2Schema>>

export type ExistingIdentityClaimDispositionV2 =
  | 'existing_same_request'
  | 'existing_derived_identity'

export class IdentityConflictErrorV2 extends ConflictError {
  override readonly code = 'identity_conflict'

  constructor(
    reason: 'claim_request_mismatch' | 'claim_identity_mismatch',
    message = 'Identity claim conflicts with an existing immutable claim',
  ) {
    super(message, { reason })
  }
}

export class IdentityClaimIntegrityErrorV2 extends IntegrityError {
  override readonly name = 'IdentityClaimIntegrityErrorV2'

  constructor() {
    super('Stored identity claim failed strict validation')
  }
}

export function compareExistingIdentityClaimV2(
  existingInput: unknown,
  incomingInput: unknown,
): ExistingIdentityClaimDispositionV2 {
  const existing = parseStoredIdentityClaimV2(existingInput)
  const incoming = PreparedIdentityClaimV2Schema.parse(incomingInput)
  assertSameIdentityClaim(existing, incoming)

  if (existing.request_digest === incoming.request_digest) {
    return 'existing_same_request'
  }
  throw new IdentityConflictErrorV2('claim_request_mismatch')
}

export function compareExistingDerivedRevisionClaimV2(
  existingInput: unknown,
  incomingInput: unknown,
): ExistingIdentityClaimDispositionV2 {
  const existing = parseStoredIdentityClaimV2(existingInput)
  const incoming = PreparedIdentityClaimV2Schema.parse(incomingInput)
  assertSameIdentityClaim(existing, incoming)
  if (
    existing.creation_profile !== 'derived-record-v1' ||
    incoming.creation_profile !== 'derived-record-v1'
  ) {
    throw new IdentityConflictErrorV2(
      'claim_identity_mismatch',
      'Derived revision comparison requires derived-record claims',
    )
  }
  return existing.request_digest === incoming.request_digest
    ? 'existing_same_request'
    : 'existing_derived_identity'
}

function parseStoredIdentityClaimV2(input: unknown): PreparedIdentityClaimV2 {
  const result = PreparedIdentityClaimV2Schema.safeParse(input)
  if (!result.success) {
    throw new IdentityClaimIntegrityErrorV2()
  }
  return result.data
}

function assertSameIdentityClaim(
  existing: PreparedIdentityClaimV2,
  incoming: PreparedIdentityClaimV2,
): void {
  if (
    existing.namespace !== incoming.namespace ||
    existing.claim_profile !== incoming.claim_profile ||
    existing.request_profile !== incoming.request_profile ||
    existing.entity_kind !== incoming.entity_kind ||
    existing.creation_profile !== incoming.creation_profile ||
    existing.entity_id !== incoming.entity_id ||
    existing.claim_key_digest !== incoming.claim_key_digest
  ) {
    throw new IdentityConflictErrorV2(
      'claim_identity_mismatch',
      'Identity claim profile or entity ID does not match',
    )
  }
}

export function prepareIdentityClaimV2(
  namespaceInput: unknown,
  requestInput: unknown,
): PreparedIdentityClaimV2 {
  const namespace = IdentityNamespaceV2Schema.parse(namespaceInput)
  const request = IdentityCreationRequestV1Schema.parse(requestInput)
  assertRootNamespaceMatches(namespace, request)

  const entityKind = entityKindForRequest(request)
  const entityId = deriveEntityId(request)
  validateProposedEntity(request, entityId)

  const claimEnvelope: IdentityClaimHashInputV1 = IdentityClaimKeyV1Schema.parse({
    claim_profile: V2_IDENTITY_CLAIM_PROFILE,
    identity_profile: V2_IDENTITY_PROFILE,
    namespace,
    entity_kind: entityKind,
    creation_profile: request.creation_profile,
    claim_material: request.seed,
  })
  const requestEnvelope: IdentityRequestHashInputV1 = IdentityRequestDigestV1Schema.parse({
    request_profile: V2_IDENTITY_REQUEST_PROFILE,
    identity_profile: V2_IDENTITY_PROFILE,
    namespace,
    entity_kind: entityKind,
    creation_profile: request.creation_profile,
    normalized_request: request,
  })

  return Object.freeze(
    PreparedIdentityClaimV2Schema.parse({
      namespace,
      claim_profile: V2_IDENTITY_CLAIM_PROFILE,
      request_profile: V2_IDENTITY_REQUEST_PROFILE,
      entity_kind: entityKind,
      creation_profile: request.creation_profile,
      entity_id: entityId,
      claim_key_digest: hashV2IdentityClaimKey(claimEnvelope),
      request_digest: hashV2IdentityRequest(requestEnvelope),
    }),
  )
}

export type RandomBytes32V2 = () => Uint8Array

export function materializeIdentityCreationRequestV2(
  draftInput: unknown,
  randomBytes32: RandomBytes32V2,
): DeepReadonly<IdentityCreationRequestV1> {
  let cloned: unknown
  try {
    cloned = structuredClone(draftInput)
  } catch {
    throw new TypeError('Identity creation draft must be structured-cloneable JSON data')
  }
  const draft = IdentityAllocationDraftV1Schema.parse(cloned)
  let materialized: unknown
  switch (draft.creation_profile) {
    case 'direct-root-v1':
      materialized = {
        ...draft,
        seed: {
          ...draft.seed,
          idempotency_key_or_random_seed: materializeIdentityKeyV2(
            draft.seed.idempotency_key_or_random_seed,
            randomBytes32,
          ),
        },
      }
      break
    case 'candidate-v1':
      materialized = {
        ...draft,
        seed: {
          ...draft.seed,
          generation_run_id: materializeIdentityKeyV2(draft.seed.generation_run_id, randomBytes32),
        },
      }
      break
    case 'signal-event-v1':
    case 'preference-event-v1':
      materialized = {
        ...draft,
        seed: {
          ...draft.seed,
          producer_event_key: materializeIdentityKeyV2(
            draft.seed.producer_event_key,
            randomBytes32,
          ),
        },
      }
      break
    default:
      materialized = draft
  }

  return deepFreezeIdentityRequest(IdentityCreationRequestV1Schema.parse(materialized))
}

export function materializeIdentityKeyV2(
  stableKey: unknown,
  randomBytes32: RandomBytes32V2,
): string {
  if (stableKey !== null && stableKey !== undefined) {
    return IdentityKeySchema.parse(stableKey)
  }

  const bytes = randomBytes32()
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== 32) {
    throw new TypeError('Identity random source must return exactly 32 bytes')
  }
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function validateIdentityRequestConsistency(
  request: IdentityAllocationDraftV1,
  context: z.RefinementCtx,
  pathPrefix: PropertyKey[] = [],
): void {
  const issue = (path: PropertyKey[], message: string) =>
    context.addIssue({ code: 'custom', path: [...pathPrefix, ...path], message })
  switch (request.creation_profile) {
    case 'source-root-v1': {
      const source = request.initial_record.source
      if (
        source === null ||
        source.name !== request.seed.source.name ||
        source.kind !== request.seed.source.kind ||
        source.original_id !== request.seed.source.original_id
      ) {
        issue(
          ['initial_record', 'source'],
          'Initial source tuple must exactly match the source-root seed',
        )
      }
      break
    }
    case 'derived-record-v1': {
      const parentIds = request.initial_record.lineage?.parent_refs.map((parent) => parent.id)
      if (!parentIds || !sameStringArray(parentIds, request.seed.parent_ids)) {
        issue(
          ['initial_record', 'lineage', 'parent_refs'],
          'Initial lineage parent IDs must exactly match the derived-record seed',
        )
      }
      break
    }
    case 'candidate-v1':
      if (request.owner_record_id !== request.seed.record_id) {
        issue(['owner_record_id'], 'Candidate owner record ID must match the candidate seed')
      }
      break
    case 'signal-event-v1':
      if (request.owner_candidate_id !== request.seed.owner_id) {
        issue(['owner_candidate_id'], 'Signal owner candidate ID must match the event seed')
      }
      if (request.initial_signal.source.id !== request.seed.producer) {
        issue(['initial_signal', 'source', 'id'], 'Signal source ID must match the event producer')
      }
      break
    case 'preference-event-v1':
      if (request.owner_record_id !== request.seed.owner_id) {
        issue(['owner_record_id'], 'Preference owner record ID must match the event seed')
      }
      if (request.initial_preference.source.id !== request.seed.producer) {
        issue(
          ['initial_preference', 'source', 'id'],
          'Preference source ID must match the event producer',
        )
      }
      break
    case 'artifact-row-v1':
    case 'direct-root-v1':
      if (
        request.initial_record.source !== null &&
        request.initial_record.source.original_id !== null
      ) {
        issue(
          ['initial_record', 'source', 'original_id'],
          'Artifact-row and direct-root creation require source.original_id to be null',
        )
      }
      break
  }
}

function validateProposedEntity(
  request: IdentityCreationRequestV1,
  entityId: PreparedIdentityClaimV2['entity_id'],
): void {
  switch (request.creation_profile) {
    case 'source-root-v1':
    case 'artifact-row-v1':
    case 'direct-root-v1':
    case 'derived-record-v1':
      PostTrainingRecordV2Schema.parse({ id: entityId, ...request.initial_record })
      return
    case 'candidate-v1':
      CandidateSchema.parse({ id: entityId, ...request.initial_candidate })
      return
    case 'signal-event-v1':
      if (request.initial_signal.supersedes === entityId) {
        throw new TypeError('A signal cannot supersede its proposed logical ID')
      }
      SignalSchema.parse({ id: entityId, ...request.initial_signal })
      return
    case 'preference-event-v1':
      if (request.initial_preference.supersedes === entityId) {
        throw new TypeError('A preference cannot supersede its proposed logical ID')
      }
      PreferenceRelationSchema.parse({ id: entityId, ...request.initial_preference })
      return
  }
}

function validateNamespaceEquality(
  namespace: string,
  seedNamespace: string,
  context: z.RefinementCtx,
  path: PropertyKey[],
): void {
  if (namespace !== seedNamespace) {
    context.addIssue({
      code: 'custom',
      path,
      message: 'Root seed namespace must match the identity envelope namespace',
    })
  }
}

function validateCanonicalIdentityValue(value: unknown, context: z.RefinementCtx): void {
  try {
    canonicalJsonV2(value)
  } catch (error) {
    context.addIssue({
      code: 'custom',
      message:
        error instanceof Error ? error.message : 'Identity value must be canonical JSON data',
    })
  }
}

function assertRootNamespaceMatches(namespace: string, request: IdentityCreationRequestV1): void {
  if (
    (request.creation_profile === 'source-root-v1' ||
      request.creation_profile === 'artifact-row-v1' ||
      request.creation_profile === 'direct-root-v1') &&
    request.seed.namespace !== namespace
  ) {
    throw new TypeError('Root seed namespace must match the active identity namespace')
  }
}

function entityKindForRequest(
  request: IdentityCreationRequestV1,
): PreparedIdentityClaimV2['entity_kind'] {
  switch (request.creation_profile) {
    case 'source-root-v1':
    case 'artifact-row-v1':
    case 'direct-root-v1':
    case 'derived-record-v1':
      return 'record'
    case 'candidate-v1':
      return 'candidate'
    case 'signal-event-v1':
      return 'signal'
    case 'preference-event-v1':
      return 'preference'
  }
}

function deriveEntityId(request: IdentityCreationRequestV1): PreparedIdentityClaimV2['entity_id'] {
  switch (request.creation_profile) {
    case 'source-root-v1':
    case 'artifact-row-v1':
    case 'direct-root-v1':
    case 'derived-record-v1':
      return deriveV2RecordId(request.seed)
    case 'candidate-v1':
      return deriveV2CandidateId(request.seed)
    case 'signal-event-v1':
      return deriveV2SignalId(request.seed)
    case 'preference-event-v1':
      return deriveV2PreferenceId(request.seed)
  }
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function deepFreezeIdentityRequest<T>(value: T): DeepReadonly<T> {
  if (value === null || typeof value !== 'object') {
    return value as DeepReadonly<T>
  }
  for (const nested of Object.values(value)) {
    deepFreezeIdentityRequest(nested)
  }
  return Object.freeze(value) as DeepReadonly<T>
}
