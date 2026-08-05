import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, test } from 'vitest'

interface V16Evidence {
  readonly path: string
  readonly test: string
}

interface V16Requirement {
  readonly id: string
  readonly plan_item: number
  readonly expected_outcomes: string[]
  readonly evidence: V16Evidence[]
}

interface V16Fixture {
  readonly fixture_version: number
  readonly requirements: V16Requirement[]
  readonly invariants: string[]
}

const fixture = JSON.parse(
  await readFile(
    new URL('./golden/fixtures/v2/v2-fault-security-capacity-matrix.fixture.json', import.meta.url),
    'utf8',
  ),
) as V16Fixture
const repositoryRoot = path.resolve(import.meta.dirname, '../../..')

describe('V16 fault, security, and capacity matrix', () => {
  test('binds every accepted V16 plan item to runnable evidence', async () => {
    expect(fixture.fixture_version).toBe(1)
    expect(fixture.requirements.map(({ plan_item }) => plan_item)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ])
    expect(new Set(fixture.requirements.map(({ id }) => id)).size).toBe(10)

    const allowedOutcomes = new Set(['idempotent_success', 'typed_conflict', 'typed_failure'])
    for (const requirement of fixture.requirements) {
      expect(requirement.evidence.length, requirement.id).toBeGreaterThan(0)
      expect(requirement.expected_outcomes.length, requirement.id).toBeGreaterThan(0)
      for (const outcome of requirement.expected_outcomes) {
        expect(allowedOutcomes.has(outcome), `${requirement.id}: ${outcome}`).toBe(true)
      }
      for (const evidence of requirement.evidence) {
        expect(evidence.path, requirement.id).toMatch(/^(?:apps|packages)\/.+\.test\.tsx?$/u)
        expect(evidence.path.split('/'), requirement.id).not.toContain('..')
        const source = await readFile(path.join(repositoryRoot, evidence.path), 'utf8')
        const singleQuoted = `test('${evidence.test}'`
        const doubleQuoted = `test("${evidence.test}"`
        expect(
          source.includes(singleQuoted) || source.includes(doubleQuoted),
          `${requirement.id}: ${evidence.path} must contain ${evidence.test}`,
        ).toBe(true)
      }
    }
  })

  test('locks every GV16 resource and isolation invariant', () => {
    expect(fixture.invariants).toEqual([
      'no_overwrite',
      'no_payload_in_postgres',
      'no_reader_visible_orphan',
      'no_cross_identity_cache_reuse',
      'no_temp_resource_leak',
    ])
  })
})
