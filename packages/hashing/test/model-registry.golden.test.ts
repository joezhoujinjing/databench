import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createBLAKE3 } from 'hash-wasm'
import { describe, expect, test } from 'vitest'
import {
  canonicalJsonV2,
  hashV2ModelCreate,
  hashV2ModelRegistrationPlanArtifact,
  hashV2ModelRegistrationPlanRepository,
  hashV2ModelRegistrationPlanService,
  hashV2ModelSourceFingerprintArtifact,
  hashV2ModelSourceFingerprintRepository,
  hashV2ModelSourceFingerprintService,
  hashV2ModelVersionCreateArtifact,
  hashV2ModelVersionCreateRepository,
  hashV2ModelVersionCreateService,
} from '../src/index.js'

interface Fixture {
  readonly profile: string
  readonly domain_utf8_hex: string
  readonly input: Record<string, unknown>
  readonly canonical: string
  readonly digest: string
  readonly independent_digest: string
}

const hashByProfile: Record<string, (input: never) => string> = {
  'model-create-v1': hashV2ModelCreate,
  'model-source-fingerprint-artifact-v1': hashV2ModelSourceFingerprintArtifact,
  'model-source-fingerprint-repository-v1': hashV2ModelSourceFingerprintRepository,
  'model-source-fingerprint-service-v1': hashV2ModelSourceFingerprintService,
  'model-version-create-artifact-v1': hashV2ModelVersionCreateArtifact,
  'model-version-create-repository-v1': hashV2ModelVersionCreateRepository,
  'model-version-create-service-v1': hashV2ModelVersionCreateService,
  'model-registration-plan-artifact-v1': hashV2ModelRegistrationPlanArtifact,
  'model-registration-plan-repository-v1': hashV2ModelRegistrationPlanRepository,
  'model-registration-plan-service-v1': hashV2ModelRegistrationPlanService,
}
const fixtureNames = Object.keys(hashByProfile)
const readFixture = (name: string): Fixture =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL(`./fixtures/${name}.json`, import.meta.url)), 'utf8'),
  ) as Fixture

describe('Model registry identity fixed vectors', () => {
  test.each(fixtureNames)('%s locks its domain, canonical bytes, and digest', async (name) => {
    const fixture = readFixture(name)
    const domain = Buffer.from(fixture.domain_utf8_hex, 'hex')
    const canonical = canonicalJsonV2(fixture.input)
    const independent = await createBLAKE3()
    expect(fixture.profile).toBe(name)
    expect(canonical).toBe(fixture.canonical)
    expect(hashByProfile[name]?.(fixture.input as never)).toBe(fixture.digest)
    expect(
      independent
        .init()
        .update(Buffer.concat([domain, Buffer.from(canonical, 'utf8')]))
        .digest('hex'),
    ).toBe(fixture.independent_digest)
    expect(fixture.independent_digest).toBe(fixture.digest)
  })

  test.each(fixtureNames)('%s is invariant to object insertion order', (name) => {
    const fixture = readFixture(name)
    expect(hashByProfile[name]?.(reverseObjectOrder(fixture.input) as never)).toBe(fixture.digest)
  })

  test('source fingerprints exclude Model ID and label while Version digests bind both', () => {
    const source = readFixture('model-source-fingerprint-repository-v1')
    expect(
      hashV2ModelSourceFingerprintRepository({
        ...source.input,
        model_id: 'aaaaaaaa-aaaa-8aaa-aaaa-aaaaaaaaaaaa',
        version_label: 'ignored',
      } as never),
    ).toBe(source.digest)

    const version = readFixture('model-version-create-repository-v1')
    expect(
      hashV2ModelVersionCreateRepository({ ...version.input, version_label: 'repo-r2' } as never),
    ).not.toBe(version.digest)
    expect(
      hashV2ModelVersionCreateRepository({
        ...version.input,
        model_id: 'aaaaaaaa-aaaa-8aaa-aaaa-aaaaaaaaaaaa',
      } as never),
    ).not.toBe(version.digest)
  })

  test('all independently named profiles are domain-separated', () => {
    const digests = fixtureNames.map((name) => readFixture(name).digest)
    expect(new Set(digests).size).toBe(digests.length)
  })
})

function reverseObjectOrder(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseObjectOrder)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .reverse()
      .map(([key, child]) => [key, reverseObjectOrder(child)]),
  )
}
