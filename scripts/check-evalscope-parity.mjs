import { access, readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, '..')
function inputPath(environmentName, defaultPath) {
  return process.env[environmentName]
    ? path.resolve(process.env[environmentName])
    : path.join(REPOSITORY_ROOT, defaultPath)
}

const SOURCE_MANIFEST_PATH = inputPath(
  'EVALSCOPE_SOURCE_MANIFEST_PATH',
  'apps/web/src/evaluations/upstream-manifest.json',
)
const CAPABILITY_MANIFEST_PATH = inputPath(
  'EVALSCOPE_CAPABILITY_MANIFEST_PATH',
  'apps/web/src/evaluations/ui-capability-manifest.json',
)
const IMPLEMENTED_CAPABILITIES_PATH = inputPath(
  'EVALSCOPE_IMPLEMENTED_CAPABILITIES_PATH',
  'apps/web/src/evaluations/implemented-capabilities.json',
)
const LOCK_PATH = inputPath('EVALSCOPE_UPSTREAM_LOCK_PATH', 'deploy/evalscope/upstream.lock')
const ROUTES_PATH = inputPath('EVALSCOPE_ROUTES_PATH', 'deploy/evalscope/api-routes.json')
const BENCHMARK_FIXTURE_PATH = inputPath(
  'EVALSCOPE_BENCHMARK_FIXTURE_PATH',
  'apps/web/src/evaluations/fixtures/benchmarks-five-categories.json',
)
const REQUIRE_GREEN = process.argv.includes('--require-green')
const errors = []

function fail(message) {
  errors.push(message)
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function hasPlannedLocator(values) {
  return values.some((value) => value.startsWith('planned:'))
}

function fileLocatorPath(locator, prefix) {
  if (!locator.startsWith(prefix)) return null
  return locator.slice(prefix.length).split('#', 1)[0]
}

function matchesSource(pattern, sourcePath) {
  return pattern.endsWith('/**')
    ? sourcePath.startsWith(pattern.slice(0, -2))
    : sourcePath === pattern
}

async function pathExists(relativePath) {
  try {
    await access(path.join(REPOSITORY_ROOT, relativePath))
    return true
  } catch {
    return false
  }
}

const [
  sourceManifest,
  capabilityManifest,
  implementedCapabilities,
  lock,
  routesManifest,
  benchmarkFixture,
] = await Promise.all(
  [
    SOURCE_MANIFEST_PATH,
    CAPABILITY_MANIFEST_PATH,
    IMPLEMENTED_CAPABILITIES_PATH,
    LOCK_PATH,
    ROUTES_PATH,
    BENCHMARK_FIXTURE_PATH,
  ].map(async (filePath) => JSON.parse(await readFile(filePath, 'utf8'))),
)

if (sourceManifest.schema_version !== 1) fail('source manifest schema_version must be 1')
if (capabilityManifest.schema_version !== 1) fail('capability manifest schema_version must be 1')
if (sourceManifest.upstream.commit !== lock.commit)
  fail('source manifest commit does not match upstream.lock')
if (capabilityManifest.upstream_commit !== lock.commit) {
  fail('capability manifest commit does not match upstream.lock')
}
if (routesManifest.upstream_commit !== lock.commit) {
  fail('route manifest commit does not match upstream.lock')
}
if (benchmarkFixture.upstream_commit !== lock.commit) {
  fail('Benchmark fixture commit does not match upstream.lock')
}
if (implementedCapabilities.upstream_commit !== lock.commit) {
  fail('implemented capability registry commit does not match upstream.lock')
}
if (sourceManifest.upstream.source_file_count !== lock.web.source_file_count) {
  fail('source file count does not match upstream.lock')
}
if (sourceManifest.upstream.test_file_count !== lock.web.test_file_count) {
  fail('test file count does not match upstream.lock')
}
if (sourceManifest.upstream.typescript_line_count !== lock.web.typescript_line_count) {
  fail('TypeScript line count does not match upstream.lock')
}
if (sourceManifest.upstream.license_sha256 !== lock.license.sha256) {
  fail('source license digest does not match upstream.lock')
}
if (!/^[a-f0-9]{64}$/.test(lock.plotly.sha256) || lock.plotly.bytes <= 0) {
  fail('Plotly lock evidence is invalid')
}

const sourceByPath = new Map()
for (const source of sourceManifest.files) {
  if (!isNonEmptyString(source.upstream_path)) {
    fail('source entry has no upstream_path')
    continue
  }
  if (sourceByPath.has(source.upstream_path)) fail(`duplicate source: ${source.upstream_path}`)
  sourceByPath.set(source.upstream_path, source)
  if (!/^[a-f0-9]{64}$/.test(source.upstream_sha256)) {
    fail(`invalid source digest: ${source.upstream_path}`)
  }
  if (!['production', 'test'].includes(source.kind))
    fail(`invalid source kind: ${source.upstream_path}`)
  if (!['migrated', 'adapted', 'replaced', 'excluded'].includes(source.status)) {
    fail(`invalid source status: ${source.upstream_path}`)
  }
  if (
    !['capability-source', 'supporting-source', 'brand-shell-exclusion'].includes(
      source.coverage_kind,
    )
  ) {
    fail(`invalid coverage kind: ${source.upstream_path}`)
  }
  if (!isNonEmptyString(source.reason)) fail(`source reason is empty: ${source.upstream_path}`)
  if (source.status === 'excluded' && source.coverage_kind !== 'brand-shell-exclusion') {
    fail(`excluded source is not a brand-shell exclusion: ${source.upstream_path}`)
  }
  if (source.status !== 'excluded' && !isNonEmptyString(source.target_path)) {
    fail(`non-excluded source has no planned target: ${source.upstream_path}`)
  }
  if (!Array.isArray(source.parity_ids))
    fail(`source parity_ids is not an array: ${source.upstream_path}`)
}

if (routesManifest.default !== 'blocked') fail('route manifest default must be blocked')
const validRouteClassifications = new Set([
  'allowed',
  'allowed-patched',
  'blocked',
  'blocked-replaced',
  'databench-generated',
])
const routeKeys = new Set()
for (const route of routesManifest.routes) {
  const key = `${route.method} ${route.path}`
  if (routeKeys.has(key)) fail(`duplicate route classification: ${key}`)
  routeKeys.add(key)
  if (!['GET', 'POST'].includes(route.method)) fail(`unsupported route method: ${key}`)
  if (!isNonEmptyString(route.path) || !route.path.startsWith('/'))
    fail(`invalid route path: ${key}`)
  if (!validRouteClassifications.has(route.classification))
    fail(`invalid route classification: ${key}`)
  if (
    route.path.includes('{path}') &&
    !['blocked', 'blocked-replaced'].includes(route.classification)
  ) {
    fail(`wildcard route is not blocked: ${key}`)
  }
}
for (const requiredBlockedRoute of [
  'POST /api/v1/eval/resume/invoke',
  'GET /api/v1/reports/scan',
  'GET /',
  'GET /{path}',
]) {
  const route = routesManifest.routes.find(
    (candidate) => `${candidate.method} ${candidate.path}` === requiredBlockedRoute,
  )
  if (!route?.classification.startsWith('blocked')) {
    fail(`required blocked route is missing: ${requiredBlockedRoute}`)
  }
}
for (const requiredGeneratedRoute of [
  'GET /generated-documents/{opaque_id}',
  'GET /generated-assets/plotly-{sha256}.min.js',
]) {
  const route = routesManifest.routes.find(
    (candidate) => `${candidate.method} ${candidate.path}` === requiredGeneratedRoute,
  )
  if (route?.classification !== 'databench-generated') {
    fail(`safe generated route is missing: ${requiredGeneratedRoute}`)
  }
}

const expectedBenchmarkCategories = {
  text: 'llm',
  multimodal: 'vlm',
  agent: 'agent',
  aigc: 'aigc',
}
let benchmarkTotal = 0
for (const [bucket, category] of Object.entries(expectedBenchmarkCategories)) {
  const entries = benchmarkFixture.response[bucket]
  if (!Array.isArray(entries) || entries.length === 0) {
    fail(`Benchmark fixture bucket is empty: ${bucket}`)
    continue
  }
  benchmarkTotal += entries.length
  if (entries.some((entry) => entry.category !== category)) {
    fail(`Benchmark fixture category mismatch: ${bucket}`)
  }
  if (benchmarkFixture.expected_tabs[bucket] !== entries.length) {
    fail(`Benchmark fixture tab count mismatch: ${bucket}`)
  }
}
if (benchmarkFixture.expected_tabs.all !== benchmarkTotal) {
  fail('Benchmark fixture all count does not equal category aggregate')
}

if (sourceManifest.upstream.source_file_count !== sourceManifest.files.length) {
  fail('source_file_count does not match source entries')
}
if (
  sourceManifest.upstream.test_file_count !==
  sourceManifest.files.filter((source) => source.kind === 'test').length
) {
  fail('test_file_count does not match test entries')
}

const validClassifications = new Set([
  'upstream-parity',
  'security-replacement',
  'databench-extension',
  'brand-shell-exclusion',
])
const capabilityById = new Map()

for (const capability of capabilityManifest.capabilities) {
  const id = capability.parity_id
  if (!isNonEmptyString(id)) {
    fail('capability has no parity_id')
    continue
  }
  if (capabilityById.has(id)) fail(`duplicate capability: ${id}`)
  capabilityById.set(id, capability)
  if (!validClassifications.has(capability.classification)) fail(`invalid classification: ${id}`)
  if (!isNonEmptyString(capability.capability)) fail(`capability kind is empty: ${id}`)
  if (!isNonEmptyString(capability.contract)) fail(`capability contract is empty: ${id}`)
  if (!isNonEmptyString(capability.default_or_rule)) fail(`default/rule is empty: ${id}`)
  if (!isNonEmptyString(capability.responsive_a11y)) fail(`responsive/a11y is empty: ${id}`)
  if (!Array.isArray(capability.api_operations)) fail(`api_operations is not an array: ${id}`)
  if (!Array.isArray(capability.upstream_sources)) fail(`upstream_sources is not an array: ${id}`)
  if (!Array.isArray(capability.tests) || capability.tests.length === 0)
    fail(`tests are empty: ${id}`)
  if (!Array.isArray(capability.browser_evidence) || capability.browser_evidence.length === 0) {
    fail(`browser evidence is empty: ${id}`)
  }

  const countsAsUpstream = ['upstream-parity', 'security-replacement'].includes(
    capability.classification,
  )
  if (capability.upstream_coverage !== countsAsUpstream) {
    fail(`upstream coverage classification mismatch: ${id}`)
  }
  if (
    capability.classification === 'databench-extension' &&
    capability.upstream_sources.length > 0
  ) {
    fail(`Databench extension must not claim upstream sources: ${id}`)
  }
  if (
    capability.classification !== 'brand-shell-exclusion' &&
    !isNonEmptyString(capability.target)
  ) {
    fail(`capability has no target: ${id}`)
  }

  for (const pattern of capability.upstream_sources) {
    const matches = sourceManifest.files.filter((source) =>
      matchesSource(pattern, source.upstream_path),
    )
    if (matches.length === 0) fail(`capability source pattern matches nothing: ${id} -> ${pattern}`)
    for (const source of matches) {
      if (!source.parity_ids.includes(id))
        fail(`source/capability backlink is missing: ${source.upstream_path} -> ${id}`)
    }
  }

  if (REQUIRE_GREEN) {
    if (capability.status !== 'green') fail(`capability is not green: ${id}`)
    if (hasPlannedLocator(capability.tests)) fail(`capability still has planned tests: ${id}`)
    if (hasPlannedLocator(capability.browser_evidence))
      fail(`capability still has planned evidence: ${id}`)
    for (const testLocator of capability.tests) {
      const testPath = fileLocatorPath(testLocator, 'test-file:')
      if (!testPath) {
        fail(`green capability has a non-file test locator: ${id} -> ${testLocator}`)
      } else if (!(await pathExists(testPath))) {
        fail(`green capability test file does not exist: ${id} -> ${testPath}`)
      }
    }
    const browserFiles = capability.browser_evidence
      .map((locator) => fileLocatorPath(locator, 'browser-file:'))
      .filter(Boolean)
    if (browserFiles.length === 0) fail(`green capability has no browser evidence file: ${id}`)
    for (const browserFile of browserFiles) {
      if (!(await pathExists(browserFile))) {
        fail(`green capability browser evidence does not exist: ${id} -> ${browserFile}`)
      }
    }
    if (isNonEmptyString(capability.target) && !(await pathExists(capability.target))) {
      fail(`green capability target does not exist: ${id} -> ${capability.target}`)
    }
  } else if (!['planned', 'green'].includes(capability.status)) {
    fail(`baseline capability has invalid status: ${id}`)
  }
}

if (!Array.isArray(implementedCapabilities.capability_ids)) {
  fail('implemented capability registry must contain capability_ids')
} else {
  const implementedIds = new Set()
  for (const id of implementedCapabilities.capability_ids) {
    if (implementedIds.has(id)) fail(`duplicate implemented capability: ${id}`)
    implementedIds.add(id)
    const capability = capabilityById.get(id)
    if (!capability) {
      fail(`orphan implemented capability: ${id}`)
    } else if (capability.classification === 'brand-shell-exclusion') {
      fail(`brand shell exclusion cannot be an implemented capability: ${id}`)
    } else if (capability.status !== 'green') {
      fail(`implemented capability is not green: ${id}`)
    }
  }
  for (const capability of capabilityManifest.capabilities) {
    if (
      capability.status === 'green' &&
      capability.classification !== 'brand-shell-exclusion' &&
      !implementedIds.has(capability.parity_id)
    ) {
      fail(
        `green target capability is missing from implementation registry: ${capability.parity_id}`,
      )
    }
  }
}

for (const source of sourceManifest.files) {
  for (const id of source.parity_ids) {
    const capability = capabilityById.get(id)
    if (!capability) {
      fail(`source refers to unknown capability: ${source.upstream_path} -> ${id}`)
      continue
    }
    if (
      !capability.upstream_sources.some((pattern) => matchesSource(pattern, source.upstream_path))
    ) {
      fail(`capability/source backlink is missing: ${id} -> ${source.upstream_path}`)
    }
  }
  if (source.coverage_kind === 'capability-source' && source.parity_ids.length === 0) {
    fail(`capability source has no capability: ${source.upstream_path}`)
  }
  if (source.coverage_kind === 'brand-shell-exclusion') {
    const hasBrandExclusion = source.parity_ids.some(
      (id) => capabilityById.get(id)?.classification === 'brand-shell-exclusion',
    )
    if (!hasBrandExclusion)
      fail(`brand shell source has no exclusion capability: ${source.upstream_path}`)
  }
}

if (errors.length > 0) {
  console.error(`EvalScope parity check failed with ${errors.length} error(s):`)
  for (const error of errors) console.error(`- ${error}`)
  process.exit(1)
}

const classCounts = Object.groupBy(
  capabilityManifest.capabilities,
  (capability) => capability.classification,
)
const summary = Object.entries(classCounts)
  .map(([classification, capabilities]) => `${classification}=${capabilities.length}`)
  .join(', ')
console.log(
  `EvalScope parity baseline ok: ${sourceManifest.files.length} files, ` +
    `${capabilityManifest.capabilities.length} capabilities (${summary})` +
    (REQUIRE_GREEN ? ', GE7 green mode' : ', E0 baseline mode'),
)
