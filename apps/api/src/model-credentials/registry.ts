import { randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { inspect, isDeepStrictEqual } from 'node:util'
import { z } from 'zod'

const MAX_CREDENTIAL_REGISTRY_BYTES = 2 * 1024 * 1024
const CredentialRefSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]{0,127}$/u)
  .refine((value) => value !== '..' && !value.includes('..'), 'credential ref is invalid')
const ConsumerSchema = z.enum(['api-health', 'evalscope'])
const UuidSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u)

const CredentialSchema = z
  .object({
    kind: z.literal('bearer'),
    secret: z
      .string()
      .min(1)
      .max(8_192)
      .refine((value) => Buffer.byteLength(value, 'utf8') <= 8_192, 'secret exceeds byte limit')
      .refine((value) => !hasControlCharacter(value), 'secret contains control characters'),
    allowed_consumers: z.array(ConsumerSchema).min(1).max(2),
    allowed_deployments: z.array(UuidSchema).min(1).max(1_024),
  })
  .strict()
  .superRefine((value, context) => {
    assertUnique(value.allowed_consumers, 'allowed_consumers', context)
    assertUnique(value.allowed_deployments, 'allowed_deployments', context)
  })

export const ModelCredentialsV1Schema = z
  .object({
    profile: z.literal('model-credentials-v1'),
    generation: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    projection_for: z.enum(['authority', 'api-health', 'evalscope']),
    credentials: z.record(CredentialRefSchema, CredentialSchema),
  })
  .strict()
  .superRefine((value, context) => {
    if (Object.keys(value.credentials).length > 256) {
      context.addIssue({ code: 'custom', path: ['credentials'], message: 'too many credentials' })
    }
  })

export type ModelCredentialConsumerV1 = z.infer<typeof ConsumerSchema>
export type ModelCredentialsV1 = z.infer<typeof ModelCredentialsV1Schema>

export class ModelCredentialRegistryError extends Error {
  readonly code: string

  constructor(code: string, message = 'Model credential registry rejected the request') {
    super(message)
    this.name = 'ModelCredentialRegistryError'
    this.code = code
  }
}

export class ModelCredentialSnapshotV1 {
  readonly credentialRef: string
  readonly generation: number
  readonly #secret: string

  constructor(credentialRef: string, generation: number, secret: string) {
    this.credentialRef = credentialRef
    this.generation = generation
    this.#secret = secret
    Object.freeze(this)
  }

  authorizationHeader(): string {
    return `Bearer ${this.#secret}`
  }

  secretForAnonymousFdHandoff(): string {
    return this.#secret
  }

  toJSON(): object {
    return { credential_ref: '[credential-ref]', generation: this.generation, secret: '[redacted]' }
  }

  [inspect.custom](): string {
    return 'ModelCredentialSnapshotV1 { credentialRef: [credential-ref], secret: [redacted] }'
  }
}

export class ModelCredentialRegistryV1 {
  readonly #path: string
  readonly #consumer: ModelCredentialConsumerV1
  readonly #requireRootOwner: boolean
  #document: Readonly<ModelCredentialsV1> | null = null

  constructor(
    path: string,
    consumer: ModelCredentialConsumerV1,
    options: { readonly requireRootOwner?: boolean } = {},
  ) {
    if (!isAbsolute(path)) throw new TypeError('Model credential projection path must be absolute')
    this.#path = path
    this.#consumer = consumer
    this.#requireRootOwner = options.requireRootOwner ?? true
  }

  get generation(): number | null {
    return this.#document?.generation ?? null
  }

  reload(options: { readonly allowGenerationRollback?: boolean } = {}): number {
    const next = readCredentialDocument(this.#path, this.#requireRootOwner)
    if (next.projection_for !== this.#consumer) {
      throw new ModelCredentialRegistryError('credential_projection_consumer_mismatch')
    }
    const current = this.#document
    if (
      current !== null &&
      next.generation < current.generation &&
      options.allowGenerationRollback !== true
    ) {
      throw new ModelCredentialRegistryError('credential_generation_rollback_rejected')
    }
    this.#document = freezeDocument(next)
    return next.generation
  }

  resolve(credentialRef: string, deploymentId: string): ModelCredentialSnapshotV1 {
    const ref = CredentialRefSchema.safeParse(credentialRef)
    const deployment = UuidSchema.safeParse(deploymentId)
    if (!ref.success || !deployment.success) {
      throw new ModelCredentialRegistryError('credential_reference_invalid')
    }
    const document = this.#document
    if (document === null) {
      throw new ModelCredentialRegistryError('credential_registry_not_loaded')
    }
    const credential = document.credentials[ref.data]
    if (credential === undefined) {
      throw new ModelCredentialRegistryError('credential_reference_unknown')
    }
    if (
      !credential.allowed_consumers.includes(this.#consumer) ||
      !credential.allowed_deployments.includes(deployment.data)
    ) {
      throw new ModelCredentialRegistryError('credential_reference_forbidden')
    }
    return new ModelCredentialSnapshotV1(ref.data, document.generation, credential.secret)
  }

  redact(input: string): string {
    let output = input.replace(
      /authorization\s*[:=]\s*(?:bearer\s+)?[^\s,;]+/giu,
      'authorization=[redacted]',
    )
    const document = this.#document
    if (document === null) return output
    const replacements = Object.entries(document.credentials).flatMap(([ref, value]) => [
      ref,
      value.secret,
      `Bearer ${value.secret}`,
    ])
    for (const value of replacements.sort((left, right) => right.length - left.length)) {
      output = output.replaceAll(value, '[redacted]')
    }
    return output
  }
}

export function projectModelCredentialsV1(
  authorityInput: unknown,
  consumer: ModelCredentialConsumerV1,
): Readonly<ModelCredentialsV1> {
  const authority = ModelCredentialsV1Schema.parse(authorityInput)
  if (authority.projection_for !== 'authority') {
    throw new ModelCredentialRegistryError('credential_authority_profile_required')
  }
  const credentials = Object.fromEntries(
    Object.entries(authority.credentials)
      .filter(([, credential]) => credential.allowed_consumers.includes(consumer))
      .map(([ref, credential]) => [ref, credential]),
  )
  return freezeDocument({
    profile: 'model-credentials-v1',
    generation: authority.generation,
    projection_for: consumer,
    credentials,
  })
}

export function loadModelCredentialsV1(
  path: string,
  options: { readonly requireRootOwner?: boolean } = {},
): Readonly<ModelCredentialsV1> {
  if (!isAbsolute(path)) throw new TypeError('Model credential document path must be absolute')
  return freezeDocument(readCredentialDocument(path, options.requireRootOwner ?? true))
}

export function writeModelCredentialProjectionsAtomicV1(
  authorityInput: unknown,
  paths: {
    readonly apiHealth: string
    readonly evalscope: string
  },
): number {
  const authority = ModelCredentialsV1Schema.parse(authorityInput)
  if (authority.projection_for !== 'authority') {
    throw new ModelCredentialRegistryError('credential_authority_profile_required')
  }
  if (!isAbsolute(paths.apiHealth) || !isAbsolute(paths.evalscope)) {
    throw new TypeError('Model credential projection paths must be absolute')
  }
  if (
    paths.apiHealth === paths.evalscope ||
    dirname(paths.apiHealth) !== dirname(paths.evalscope)
  ) {
    throw new TypeError('Model credential projections must use distinct files in one directory')
  }

  const projections = [
    {
      path: paths.apiHealth,
      value: projectModelCredentialsV1(authority, 'api-health'),
      consumer: 'api-health' as const,
    },
    {
      path: paths.evalscope,
      value: projectModelCredentialsV1(authority, 'evalscope'),
      consumer: 'evalscope' as const,
    },
  ]
  for (const projection of projections) {
    validateProjectionRotation(projection.path, projection.value, projection.consumer)
  }

  const staged: Array<(typeof projections)[number] & { readonly temporary: string }> = []
  try {
    for (const projection of projections) {
      staged.push({
        ...projection,
        temporary: stageModelCredentialsDocument(projection.path, projection.value, 0o444),
      })
    }
    for (const projection of staged) renameSync(projection.temporary, projection.path)
    fsyncDirectory(dirname(paths.apiHealth))
  } catch (error) {
    for (const projection of staged) unlinkIfPresent(projection.temporary)
    throw error
  }
  return authority.generation
}

export function writeModelCredentialsAtomicV1(path: string, value: unknown, mode = 0o440): void {
  if (!isAbsolute(path)) throw new TypeError('Model credential document path must be absolute')
  const document = ModelCredentialsV1Schema.parse(value)
  const temporary = stageModelCredentialsDocument(path, document, mode)
  try {
    renameSync(temporary, path)
    fsyncDirectory(dirname(path))
  } catch (error) {
    unlinkIfPresent(temporary)
    throw error
  }
}

function stageModelCredentialsDocument(
  path: string,
  document: Readonly<ModelCredentialsV1>,
  mode: number,
): string {
  if (!Number.isSafeInteger(mode) || mode < 0o400 || mode > 0o777 || (mode & 0o022) !== 0) {
    throw new TypeError('Model credential document mode must be read-only for group and others')
  }
  const temporary = join(dirname(path), `.${randomUUID()}.model-credentials.partial`)
  const fd = openSync(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    mode,
  )
  try {
    writeFileSync(fd, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
    fchmodSync(fd, mode)
    fsyncSync(fd)
  } catch (error) {
    unlinkIfPresent(temporary)
    throw error
  } finally {
    closeSync(fd)
  }
  return temporary
}

function fsyncDirectory(path: string): void {
  const directoryFd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY)
  try {
    fsyncSync(directoryFd)
  } finally {
    closeSync(directoryFd)
  }
}

function validateProjectionRotation(
  path: string,
  next: Readonly<ModelCredentialsV1>,
  consumer: ModelCredentialConsumerV1,
): void {
  if (!existsSync(path)) return
  const current = readCredentialDocument(path, false)
  if (current.projection_for !== consumer) {
    throw new ModelCredentialRegistryError('credential_projection_consumer_mismatch')
  }
  if (current.generation > next.generation) {
    throw new ModelCredentialRegistryError('credential_generation_rollback_rejected')
  }
  if (current.generation === next.generation && !isDeepStrictEqual(current, next)) {
    throw new ModelCredentialRegistryError('credential_generation_reuse_rejected')
  }
}

function unlinkIfPresent(path: string): void {
  try {
    unlinkSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

function readCredentialDocument(path: string, requireRootOwner: boolean): ModelCredentialsV1 {
  let fd: number
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch {
    throw new ModelCredentialRegistryError('credential_projection_unavailable')
  }
  try {
    const stat = fstatSync(fd)
    if (
      !stat.isFile() ||
      stat.size <= 0 ||
      stat.size > MAX_CREDENTIAL_REGISTRY_BYTES ||
      (stat.mode & 0o022) !== 0 ||
      (requireRootOwner && stat.uid !== 0)
    ) {
      throw new ModelCredentialRegistryError('credential_projection_permissions_invalid')
    }
    const raw = readFileSync(fd)
    let value: unknown
    try {
      value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw))
    } catch {
      throw new ModelCredentialRegistryError('credential_projection_invalid')
    }
    try {
      return ModelCredentialsV1Schema.parse(value)
    } catch {
      throw new ModelCredentialRegistryError('credential_projection_invalid')
    }
  } finally {
    closeSync(fd)
  }
}

function freezeDocument(value: ModelCredentialsV1): Readonly<ModelCredentialsV1> {
  return Object.freeze({
    profile: value.profile,
    generation: value.generation,
    projection_for: value.projection_for,
    credentials: Object.freeze(
      Object.fromEntries(
        Object.entries(value.credentials).map(([ref, credential]) => [
          ref,
          Object.freeze({
            kind: credential.kind,
            secret: credential.secret,
            allowed_consumers: Object.freeze([...credential.allowed_consumers]),
            allowed_deployments: Object.freeze([...credential.allowed_deployments]),
          }),
        ]),
      ),
    ),
  }) as unknown as Readonly<ModelCredentialsV1>
}

function assertUnique(values: readonly string[], field: string, context: z.RefinementCtx): void {
  if (new Set(values).size === values.length) return
  context.addIssue({ code: 'custom', path: [field], message: `${field} must be unique` })
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)
    if (codePoint !== undefined && (codePoint <= 31 || codePoint === 127)) return true
  }
  return false
}
