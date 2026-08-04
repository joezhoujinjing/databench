import { chmodSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspect } from 'node:util'
import { describe, expect, test } from 'vitest'
import {
  ModelCredentialRegistryV1,
  ModelCredentialsV1Schema,
  projectModelCredentialsV1,
  writeModelCredentialProjectionsAtomicV1,
  writeModelCredentialsAtomicV1,
} from '../src/model-credentials/index.js'

const DEPLOYMENT_A = '123e4567-e89b-42d3-a456-426614174000'
const DEPLOYMENT_B = '223e4567-e89b-42d3-a456-426614174000'
const SECRET = 'exact-secret-value-that-must-never-be-logged'

function authority(generation = 1) {
  return {
    profile: 'model-credentials-v1' as const,
    generation,
    projection_for: 'authority' as const,
    credentials: {
      'deployment-a': {
        kind: 'bearer' as const,
        secret: SECRET,
        allowed_consumers: ['api-health', 'evalscope'] as const,
        allowed_deployments: [DEPLOYMENT_A],
      },
      'evalscope-only': {
        kind: 'bearer' as const,
        secret: 'evalscope-only-secret-value',
        allowed_consumers: ['evalscope'] as const,
        allowed_deployments: [DEPLOYMENT_B],
      },
    },
  }
}

describe('model-credentials-v1', () => {
  test('strict parser and minimal projection preserve consumer/deployment ACLs', () => {
    const parsed = ModelCredentialsV1Schema.parse(authority())
    expect(() => ModelCredentialsV1Schema.parse({ ...parsed, extra: true })).toThrow()
    const api = projectModelCredentialsV1(parsed, 'api-health')
    expect(api.projection_for).toBe('api-health')
    expect(Object.keys(api.credentials)).toEqual(['deployment-a'])
    const evalscope = projectModelCredentialsV1(parsed, 'evalscope')
    expect(Object.keys(evalscope.credentials)).toEqual(['deployment-a', 'evalscope-only'])
  })

  test('loads an atomic read-only projection, resolves exact ACL, rotates, and rejects rollback', () => {
    const root = mkdtempSync(join(tmpdir(), 'databench-model-credentials-'))
    const path = join(root, 'api-model-credentials.json')
    writeModelCredentialsAtomicV1(path, projectModelCredentialsV1(authority(1), 'api-health'))
    chmodSync(path, 0o440)
    const registry = new ModelCredentialRegistryV1(path, 'api-health', {
      requireRootOwner: false,
    })
    expect(registry.reload()).toBe(1)
    const snapshot = registry.resolve('deployment-a', DEPLOYMENT_A)
    expect(snapshot.authorizationHeader()).toBe(`Bearer ${SECRET}`)
    expect(() => registry.resolve('deployment-a', DEPLOYMENT_B)).toThrowError(
      expect.objectContaining({ code: 'credential_reference_forbidden' }),
    )
    expect(() => registry.resolve('unknown-ref', DEPLOYMENT_A)).toThrowError(
      expect.objectContaining({ code: 'credential_reference_unknown' }),
    )

    writeModelCredentialsAtomicV1(path, projectModelCredentialsV1(authority(2), 'api-health'))
    expect(registry.reload()).toBe(2)
    writeModelCredentialsAtomicV1(path, projectModelCredentialsV1(authority(1), 'api-health'))
    expect(() => registry.reload()).toThrowError(
      expect.objectContaining({ code: 'credential_generation_rollback_rejected' }),
    )
    expect(registry.reload({ allowGenerationRollback: true })).toBe(1)
  })

  test('snapshot inspection, JSON, and centralized redaction never expose secret/ref/header', () => {
    const root = mkdtempSync(join(tmpdir(), 'databench-model-credentials-redact-'))
    const path = join(root, 'api-model-credentials.json')
    writeModelCredentialsAtomicV1(path, projectModelCredentialsV1(authority(), 'api-health'))
    const registry = new ModelCredentialRegistryV1(path, 'api-health', {
      requireRootOwner: false,
    })
    registry.reload()
    const snapshot = registry.resolve('deployment-a', DEPLOYMENT_A)
    for (const value of [inspect(snapshot), JSON.stringify(snapshot)]) {
      expect(value).not.toContain(SECRET)
      expect(value).not.toContain('deployment-a')
    }
    const redacted = registry.redact(
      `credential_ref=deployment-a Authorization: Bearer ${SECRET} secret=${SECRET}`,
    )
    expect(redacted).not.toContain(SECRET)
    expect(redacted).not.toContain('deployment-a')
    expect(redacted).not.toContain('Bearer')
  })

  test('writer produces valid JSON without temporary-file residue', () => {
    const root = mkdtempSync(join(tmpdir(), 'databench-model-credentials-write-'))
    const path = join(root, 'projection.json')
    writeModelCredentialsAtomicV1(path, projectModelCredentialsV1(authority(), 'api-health'))
    expect(ModelCredentialsV1Schema.parse(JSON.parse(readFileSync(path, 'utf8')))).toBeTruthy()
  })

  test('operator projection writer prepares one minimal read-only generation and fences reuse/rollback', () => {
    const root = mkdtempSync(join(tmpdir(), 'databench-model-credential-projections-'))
    const apiPath = join(root, 'api-model-credentials.json')
    const evalscopePath = join(root, 'evalscope-model-credentials.json')
    expect(
      writeModelCredentialProjectionsAtomicV1(authority(1), {
        apiHealth: apiPath,
        evalscope: evalscopePath,
      }),
    ).toBe(1)

    const api = ModelCredentialsV1Schema.parse(JSON.parse(readFileSync(apiPath, 'utf8')))
    const evalscope = ModelCredentialsV1Schema.parse(
      JSON.parse(readFileSync(evalscopePath, 'utf8')),
    )
    expect(api.projection_for).toBe('api-health')
    expect(Object.keys(api.credentials)).toEqual(['deployment-a'])
    expect(evalscope.projection_for).toBe('evalscope')
    expect(Object.keys(evalscope.credentials)).toEqual(['deployment-a', 'evalscope-only'])
    expect(statSync(apiPath).mode & 0o777).toBe(0o444)
    expect(statSync(evalscopePath).mode & 0o777).toBe(0o444)

    const changedAtSameGeneration = structuredClone(authority(1))
    changedAtSameGeneration.credentials['deployment-a'].secret = 'rotated-without-generation'
    expect(() =>
      writeModelCredentialProjectionsAtomicV1(changedAtSameGeneration, {
        apiHealth: apiPath,
        evalscope: evalscopePath,
      }),
    ).toThrowError(expect.objectContaining({ code: 'credential_generation_reuse_rejected' }))

    expect(
      writeModelCredentialProjectionsAtomicV1(authority(2), {
        apiHealth: apiPath,
        evalscope: evalscopePath,
      }),
    ).toBe(2)
    expect(() =>
      writeModelCredentialProjectionsAtomicV1(authority(1), {
        apiHealth: apiPath,
        evalscope: evalscopePath,
      }),
    ).toThrowError(expect.objectContaining({ code: 'credential_generation_rollback_rejected' }))
    expect(readdirSync(root).filter((name) => name.endsWith('.partial'))).toEqual([])
  })
})
