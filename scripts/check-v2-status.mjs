import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (relativePath) => readFile(path.join(root, relativePath), 'utf8')
const fail = (message) => {
  throw new Error(`v2 status check failed: ${message}`)
}

const [plan, technicalDesign, statusDocument, fixtureIndexText] = await Promise.all([
  read('docs/v2/PLAN.md'),
  read('docs/v2/TECHNICAL-DESIGN.md'),
  read('docs/v2/STATUS.md'),
  read('docs/v2/fixtures/index.json'),
])

if (!plan.includes('**状态:** 已接受')) {
  fail('implementation plan is not accepted')
}
if (!technicalDesign.includes('**状态:** 已接受')) {
  fail('technical design is not accepted')
}

const metadataBlock = statusDocument.match(/<!-- v2-status\n([\s\S]*?)\n-->/)?.[1]
if (!metadataBlock) {
  fail('STATUS.md is missing the v2-status metadata block')
}

const metadata = Object.fromEntries(
  metadataBlock.split('\n').map((line) => {
    const separator = line.indexOf(':')
    if (separator < 1) {
      fail(`invalid STATUS metadata line: ${line}`)
    }
    return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()]
  }),
)

const stepNames = Array.from({ length: 18 }, (_, index) => `V${index}`)
const statusRows = [...statusDocument.matchAll(/^\| (V\d+) \|.*?\| (⬜|🔄|✅|⛔) \|/gm)]
const statusByStep = new Map(statusRows.map((match) => [match[1], match[2]]))

if (statusByStep.size !== stepNames.length) {
  fail(`STATUS.md must contain exactly ${stepNames.length} unique V0-V17 rows`)
}
for (const step of stepNames) {
  if (!statusByStep.has(step)) {
    fail(`STATUS.md is missing ${step}`)
  }
}

let firstIncompleteIndex = stepNames.length
for (let index = 0; index < stepNames.length; index += 1) {
  if (statusByStep.get(stepNames[index]) !== '✅') {
    firstIncompleteIndex = index
    break
  }
}
for (let index = firstIncompleteIndex + 1; index < stepNames.length; index += 1) {
  if (statusByStep.get(stepNames[index]) === '✅') {
    fail(`${stepNames[index]} is complete before an earlier step`)
  }
}

const inProgress = stepNames.filter((step) => statusByStep.get(step) === '🔄')
if (inProgress.length > 1) {
  fail('at most one Step may be in progress')
}

const lastCompleted =
  firstIncompleteIndex === 0 ? 'none' : stepNames[Math.min(firstIncompleteIndex - 1, 17)]
const expectedCurrent =
  firstIncompleteIndex >= stepNames.length ? 'complete' : stepNames[firstIncompleteIndex]
if (metadata.last_completed_step !== lastCompleted) {
  fail(`last_completed_step must be ${lastCompleted}`)
}
if (metadata.current_step !== expectedCurrent) {
  fail(`current_step must be ${expectedCurrent}`)
}
if (metadata.capability_enabled !== 'false') {
  fail('v2 capability must remain false until a separate post-GV-final owner decision')
}

let fixtureIndex
try {
  fixtureIndex = JSON.parse(fixtureIndexText)
} catch (error) {
  fail(`fixture index is not valid JSON: ${error.message}`)
}

if (fixtureIndex.fixture_index_version !== 1) {
  fail('fixture_index_version must be 1')
}
if (!Array.isArray(fixtureIndex.fixtures) || fixtureIndex.fixtures.length === 0) {
  fail('fixture index must contain entries')
}

const allowedFixtureStatuses = new Set(['planned', 'active', 'verified'])
const fixtureIds = new Set()
const fixturesByStep = new Map()
for (const fixture of fixtureIndex.fixtures) {
  for (const field of [
    'id',
    'step',
    'owner',
    'category',
    'path',
    'assertion',
    'source',
    'status',
  ]) {
    if (typeof fixture[field] !== 'string' || fixture[field].length === 0) {
      fail(`fixture entry is missing ${field}`)
    }
  }
  if (fixtureIds.has(fixture.id)) {
    fail(`duplicate fixture id: ${fixture.id}`)
  }
  fixtureIds.add(fixture.id)
  if (!/^V(?:[1-9]|1[0-6])$/.test(fixture.step)) {
    fail(`fixture ${fixture.id} has invalid owner Step ${fixture.step}`)
  }
  if (!allowedFixtureStatuses.has(fixture.status)) {
    fail(`fixture ${fixture.id} has invalid status ${fixture.status}`)
  }
  if (
    path.isAbsolute(fixture.path) ||
    fixture.path.split('/').includes('..') ||
    (!fixture.path.startsWith('packages/') && !fixture.path.startsWith('apps/'))
  ) {
    fail(`fixture ${fixture.id} has unsafe path ${fixture.path}`)
  }
  const entries = fixturesByStep.get(fixture.step) ?? []
  entries.push(fixture)
  fixturesByStep.set(fixture.step, entries)
}

for (let index = 1; index <= 16; index += 1) {
  const step = `V${index}`
  const fixtures = fixturesByStep.get(step)
  if (!fixtures || fixtures.length === 0) {
    fail(`fixture index has no entry for ${step}`)
  }
  if (
    statusByStep.get(step) === '✅' &&
    fixtures.some((fixture) => fixture.status !== 'verified')
  ) {
    fail(`${step} is complete but has non-verified fixture entries`)
  }
}

console.log(
  `v2 status ok: ${lastCompleted} complete, ${expectedCurrent} current, ${fixtureIds.size} fixtures indexed`,
)
