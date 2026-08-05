import { createHash } from 'node:crypto'
import { access, readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, '..')

function inputPath(environmentName, defaultPath) {
  return process.env[environmentName]
    ? path.resolve(process.env[environmentName])
    : path.join(REPOSITORY_ROOT, defaultPath)
}

const PATHS = {
  adr: inputPath('MODEL_REGISTRY_ADR_PATH', 'docs/decisions/0019-model-registry.md'),
  design: inputPath('MODEL_REGISTRY_DESIGN_PATH', 'docs/models/TECHNICAL-DESIGN.md'),
  plan: inputPath('MODEL_REGISTRY_PLAN_PATH', 'docs/models/PLAN.md'),
  status: inputPath('MODEL_REGISTRY_STATUS_PATH', 'docs/models/STATUS.md'),
  fixtureIndex: inputPath('MODEL_REGISTRY_FIXTURE_INDEX_PATH', 'docs/models/fixtures/index.json'),
  databaseShape: inputPath(
    'MODEL_REGISTRY_DATABASE_SHAPE_PATH',
    'docs/models/fixtures/database-shape.json',
  ),
  endpointPolicy: inputPath(
    'MODEL_REGISTRY_ENDPOINT_POLICY_PATH',
    'docs/models/fixtures/model-endpoint-policy-v1.schema.json',
  ),
  endpointCases: inputPath(
    'MODEL_REGISTRY_ENDPOINT_CASES_PATH',
    'docs/models/fixtures/model-endpoint-policy-v1.cases.json',
  ),
  credentials: inputPath(
    'MODEL_REGISTRY_CREDENTIALS_PATH',
    'docs/models/fixtures/model-credentials-v1.schema.json',
  ),
  evalscopeLock: inputPath('MODEL_REGISTRY_EVALSCOPE_LOCK_PATH', 'deploy/evalscope/upstream.lock'),
  evalscopePatch: inputPath(
    'MODEL_REGISTRY_EVALSCOPE_PATCH_PATH',
    'deploy/evalscope/patches/0001-databench-runtime-boundary.patch',
  ),
  legacy: inputPath(
    'MODEL_REGISTRY_LEGACY_BASELINE_PATH',
    'docs/models/fixtures/legacy-s4-baseline.json',
  ),
  openapi: inputPath('MODEL_REGISTRY_OPENAPI_PATH', 'openapi.json'),
  package: inputPath('MODEL_REGISTRY_PACKAGE_PATH', 'package.json'),
}

function fail(message) {
  throw new Error(`Model Registry status check failed: ${message}`)
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort((left, right) => left.localeCompare(right, 'en'))
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function stableSha256(value) {
  return sha256(Buffer.from(stableJson(value), 'utf8'))
}

async function readJson(filePath, label) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'))
  } catch (error) {
    fail(`${label} is not valid JSON: ${error.message}`)
  }
}

async function exists(filePath) {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

function assertString(value, message) {
  if (typeof value !== 'string' || value.trim().length === 0) fail(message)
}

function assertSafeRepositoryPath(value, label) {
  assertString(value, `${label} must be a non-empty path`)
  if (path.isAbsolute(value) || value.split('/').includes('..')) {
    fail(`${label} is unsafe: ${value}`)
  }
}

function sameMembers(actual, expected) {
  return stableJson([...actual].sort()) === stableJson([...expected].sort())
}

function includesTuple(collection, tuple) {
  return collection.some((candidate) => stableJson(candidate) === stableJson(tuple))
}

async function checkMarkdown(linkBase, contents, label) {
  const lines = contents.split('\n')
  if (lines.some((line) => /[ \t]+$/.test(line))) fail(`${label} contains trailing whitespace`)
  if (lines.filter((line) => /^\s*```/.test(line)).length % 2 !== 0) {
    fail(`${label} contains an unclosed fenced block`)
  }

  const links = [...contents.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)].map((match) => match[1])
  for (const link of links) {
    if (/^(?:https?:|mailto:|#)/.test(link)) continue
    const target = link.split('#', 1)[0]
    if (!(await exists(path.resolve(linkBase, target)))) {
      fail(`${label} contains a broken link: ${link}`)
    }
  }
}

const [adr, design, plan, status] = await Promise.all(
  [PATHS.adr, PATHS.design, PATHS.plan, PATHS.status].map((filePath) => readFile(filePath, 'utf8')),
)

await Promise.all([
  checkMarkdown(path.join(REPOSITORY_ROOT, 'docs/decisions'), adr, 'ADR 0019'),
  checkMarkdown(path.join(REPOSITORY_ROOT, 'docs/models'), design, 'technical design'),
  checkMarkdown(path.join(REPOSITORY_ROOT, 'docs/models'), plan, 'implementation plan'),
  checkMarkdown(path.join(REPOSITORY_ROOT, 'docs/models'), status, 'STATUS.md'),
])

for (const [label, document] of [
  ['ADR 0019', adr],
  ['technical design', design],
  ['implementation plan', plan],
]) {
  if (!/\*\*状态[:：]\*\*\s*Accepted/.test(document.slice(0, 1_500))) {
    fail(`${label} is not Accepted`)
  }
  if (!document.includes('2026-08-04') || !document.includes('下一步叭')) {
    fail(`${label} does not record the owner acceptance evidence`)
  }
}
if (!status.includes('2026-08-04') || !status.includes('下一步叭')) {
  fail('STATUS.md does not record the owner acceptance evidence')
}

const metadataBlock = status.match(/<!-- model-registry-status\n([\s\S]*?)\n-->/)?.[1]
if (!metadataBlock) fail('STATUS.md is missing the model-registry-status metadata block')
const metadata = Object.fromEntries(
  metadataBlock.split('\n').map((line) => {
    const separator = line.indexOf(':')
    if (separator < 1) fail(`invalid STATUS metadata line: ${line}`)
    return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()]
  }),
)

const stepNames = Array.from({ length: 9 }, (_, index) => `MR${index}`)
const statusRows = [...status.matchAll(/^\| (MR\d+) \|.*?\| (⬜|🔄|✅|⛔) \|/gm)]
const statusByStep = new Map(statusRows.map((match) => [match[1], match[2]]))
if (statusRows.length !== stepNames.length || statusByStep.size !== stepNames.length) {
  fail('STATUS.md must contain exactly one row for every MR0-MR8 Step')
}
for (const step of stepNames) {
  if (!statusByStep.has(step)) fail(`STATUS.md is missing ${step}`)
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
    fail(`${stepNames[index]} is complete before an earlier Step`)
  }
}
const inProgress = stepNames.filter((step) => statusByStep.get(step) === '🔄')
if (inProgress.length > 1) fail('at most one Model Registry Step may be in progress')

const expectedLastCompleted =
  firstIncompleteIndex === 0 ? 'none' : stepNames[Math.min(firstIncompleteIndex - 1, 8)]
const expectedCurrent =
  firstIncompleteIndex === stepNames.length ? 'complete' : stepNames[firstIncompleteIndex]
if (metadata.last_completed_step !== expectedLastCompleted) {
  fail(`last_completed_step must be ${expectedLastCompleted}`)
}
if (metadata.current_step !== expectedCurrent) fail(`current_step must be ${expectedCurrent}`)
if (inProgress.length === 1 && inProgress[0] !== expectedCurrent) {
  fail(`only the current Step ${expectedCurrent} may be in progress`)
}

for (const field of ['capability_enabled', 'runtime_implemented', 'public_network_activation']) {
  if (!['false', 'true'].includes(metadata[field])) fail(`${field} must be false or true`)
}
const lastCompletedIndex =
  expectedLastCompleted === 'none' ? -1 : stepNames.indexOf(expectedLastCompleted)
if (metadata.capability_enabled === 'true' && lastCompletedIndex < 2) {
  fail('capability_enabled must remain false until MR2 is complete')
}
if (metadata.runtime_implemented === 'true' && lastCompletedIndex < 1) {
  fail('runtime_implemented must remain false until MR1 is complete')
}
if (
  metadata.public_network_activation === 'true' &&
  metadata.hosted_secret_backend === 'undecided-d3'
) {
  fail('public_network_activation must remain false while D3 is undecided')
}
if (metadata.gpu_gate !== 'deferred')
  fail('gpu_gate must remain deferred by the Model Registry plan')
if (!status.includes('V16/V17') || !status.includes('不自动完成 V16/V17')) {
  fail('STATUS.md must preserve the explicit V16/V17 non-activation statement')
}

const [
  fixtureIndex,
  databaseShape,
  endpointPolicy,
  endpointCases,
  credentials,
  legacy,
  openapi,
  pkg,
] = await Promise.all([
  readJson(PATHS.fixtureIndex, 'fixture index'),
  readJson(PATHS.databaseShape, 'database shape fixture'),
  readJson(PATHS.endpointPolicy, 'endpoint policy schema'),
  readJson(PATHS.endpointCases, 'endpoint policy cases'),
  readJson(PATHS.credentials, 'credential registry schema'),
  readJson(PATHS.legacy, 'legacy S4 baseline'),
  readJson(PATHS.openapi, 'OpenAPI document'),
  readJson(PATHS.package, 'package.json'),
])

if (fixtureIndex.fixture_index_version !== 1) fail('fixture_index_version must be 1')
if (fixtureIndex.decision !== 'ADR-0019') fail('fixture index decision must be ADR-0019')
if (fixtureIndex.identity_profile !== 'databench-v2-jcs-1') {
  fail('fixture index identity profile must be databench-v2-jcs-1')
}
if (!Array.isArray(fixtureIndex.fixtures) || fixtureIndex.fixtures.length === 0) {
  fail('fixture index must contain fixtures')
}

const fixtureIds = new Set()
const fixturesByStep = new Map()
const indexedFixturePaths = new Set()
const allowedFixtureStatuses = new Set(['planned', 'active', 'verified'])
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
    assertString(fixture[field], `fixture entry is missing ${field}`)
  }
  if (fixtureIds.has(fixture.id)) fail(`duplicate fixture id: ${fixture.id}`)
  fixtureIds.add(fixture.id)
  if (!stepNames.includes(fixture.step))
    fail(`fixture ${fixture.id} has invalid Step ${fixture.step}`)
  if (!allowedFixtureStatuses.has(fixture.status)) {
    fail(`fixture ${fixture.id} has invalid status ${fixture.status}`)
  }
  assertSafeRepositoryPath(fixture.path, `fixture ${fixture.id} path`)
  if (!/^(?:docs|packages|apps|workers)\//.test(fixture.path)) {
    fail(`fixture ${fixture.id} path must stay in a fixture-owning repository directory`)
  }
  if (indexedFixturePaths.has(fixture.path) && fixture.profile === undefined) {
    fail(`duplicate non-profile fixture path: ${fixture.path}`)
  }
  indexedFixturePaths.add(fixture.path)
  if (fixture.profile !== undefined)
    assertString(fixture.profile, `fixture ${fixture.id} profile is empty`)
  if (fixture.status === 'verified' && !(await exists(path.join(REPOSITORY_ROOT, fixture.path)))) {
    fail(`verified fixture does not exist: ${fixture.path}`)
  }
  const stepFixtures = fixturesByStep.get(fixture.step) ?? []
  stepFixtures.push(fixture)
  fixturesByStep.set(fixture.step, stepFixtures)
}

for (let index = 0; index < stepNames.length; index += 1) {
  const step = stepNames[index]
  const fixtures = fixturesByStep.get(step) ?? []
  if (
    statusByStep.get(step) === '✅' &&
    fixtures.some((fixture) => fixture.status !== 'verified')
  ) {
    fail(`${step} is complete but has non-verified fixture entries`)
  }
}

const requiredFixtures = new Map([
  ['mr0-legacy-s4-baseline', null],
  ['mr0-database-shape', null],
  ['mr0-endpoint-policy-schema', 'model-endpoint-policy-v1'],
  ['mr0-endpoint-policy-cases', 'model-endpoint-policy-v1'],
  ['mr0-credential-registry-schema', 'model-credentials-v1'],
  ['mr1-model-create-v1', 'model-create-v1'],
  ['mr1-source-fingerprint-artifact-v1', 'model-source-fingerprint-artifact-v1'],
  ['mr1-source-fingerprint-repository-v1', 'model-source-fingerprint-repository-v1'],
  ['mr1-source-fingerprint-service-v1', 'model-source-fingerprint-service-v1'],
  ['mr1-version-create-artifact-v1', 'model-version-create-artifact-v1'],
  ['mr1-version-create-repository-v1', 'model-version-create-repository-v1'],
  ['mr1-version-create-service-v1', 'model-version-create-service-v1'],
  ['mr1-registration-plan-artifact-v1', 'model-registration-plan-artifact-v1'],
  ['mr1-registration-plan-repository-v1', 'model-registration-plan-repository-v1'],
  ['mr1-registration-plan-service-v1', 'model-registration-plan-service-v1'],
  ['mr2-deployment-adoption-v1', 'model-deployment-adoption-v1'],
  ['mr3-repository-source-evidence-v1', 'model-source-evidence-v1'],
  ['mr5-model-deployment-create-v2', 'model-deployment-create-v2'],
  ['mr6-evaluation-run-create-v5', 'evaluation-run-create-v5'],
  ['mr6-evaluation-run-create-v6', 'evaluation-run-create-v6'],
])
for (const [id, profile] of requiredFixtures) {
  const fixture = fixtureIndex.fixtures.find((candidate) => candidate.id === id)
  if (!fixture) fail(`fixture index is missing required fixture ${id}`)
  if (profile !== null && fixture.profile !== profile) {
    fail(`fixture ${id} must register profile ${profile}`)
  }
}
const registeredProfiles = new Set(
  [...requiredFixtures.values()].filter((profile) => profile !== null),
)
for (const fixture of fixtureIndex.fixtures) {
  if (fixture.profile !== undefined && !registeredProfiles.has(fixture.profile)) {
    fail(`fixture index contains an unplanned profile: ${fixture.profile}`)
  }
}
const legacyFixture = fixtureIndex.fixtures.find(
  (fixture) => fixture.id === 'mr0-legacy-s4-baseline',
)
if (legacyFixture.step !== 'MR0' || legacyFixture.status !== 'verified') {
  fail('the MR0 legacy baseline fixture must be verified and owned by MR0')
}

const fixtureDirectory = path.join(REPOSITORY_ROOT, 'docs/models/fixtures')
const fixtureFiles = (await readdir(fixtureDirectory, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name !== 'index.json')
  .map((entry) => `docs/models/fixtures/${entry.name}`)
for (const fixturePath of fixtureFiles) {
  if (!indexedFixturePaths.has(fixturePath)) fail(`orphan Model Registry fixture: ${fixturePath}`)
}
for (const fixture of fixtureIndex.fixtures.filter((entry) =>
  entry.path.startsWith('docs/models/fixtures/'),
)) {
  if (!(await exists(path.join(REPOSITORY_ROOT, fixture.path)))) {
    fail(`indexed MR0 design fixture does not exist: ${fixture.path}`)
  }
}

const requiredTables = [
  'models_v2',
  'model_versions_v2',
  'model_version_artifact_sources_v2',
  'model_version_repository_sources_v2',
  'model_version_service_sources_v2',
  'model_source_evidence_v2',
  'model_aliases_v2',
  'model_registration_claims_v2',
  'model_version_deployment_adoptions_v2',
]
if (
  !Array.isArray(databaseShape.core_tables) ||
  !sameMembers(databaseShape.core_tables, requiredTables)
) {
  fail('database shape core tables have drifted')
}
const requiredVersionUniqueKeys = [
  ['namespace_id', 'id'],
  ['namespace_id', 'model_id', 'id'],
  ['namespace_id', 'model_id', 'version_label'],
  ['namespace_id', 'model_id', 'source_fingerprint'],
]
if (
  !Array.isArray(databaseShape.model_version_unique_keys) ||
  requiredVersionUniqueKeys.some(
    (key) => !includesTuple(databaseShape.model_version_unique_keys, key),
  )
) {
  fail('database shape is missing a required Model Version unique key')
}
if (
  databaseShape.source_xor?.mechanism !== 'deferred_constraint_trigger' ||
  databaseShape.source_xor?.cardinality !== 'exactly_one' ||
  databaseShape.source_xor?.selector !== 'model_versions_v2.source_kind' ||
  !sameMembers(databaseShape.source_xor?.source_tables ?? [], requiredTables.slice(2, 5))
) {
  fail('database shape source XOR invariant has drifted')
}
if (
  databaseShape.deployment_profiles?.['artifact-bound-v1']?.model_version_id !== 'null' ||
  databaseShape.deployment_profiles?.['artifact-bound-v1']?.artifact_id !== 'required' ||
  databaseShape.deployment_profiles?.['model-version-v1']?.model_version_id !== 'required'
) {
  fail('database shape must preserve separate legacy and Model Version deployment profiles')
}
const requiredEvaluationForeignKeys = [
  {
    columns: ['namespace_id', 'model_id', 'model_version_id'],
    references: ['model_versions_v2', 'namespace_id', 'model_id', 'id'],
  },
  {
    columns: ['namespace_id', 'model_version_id', 'model_deployment_id', 'model_deployment_digest'],
    references: ['model_deployments_v2', 'namespace_id', 'model_version_id', 'id', 'create_digest'],
  },
  {
    columns: ['namespace_id', 'model_version_id', 'source_evidence_digest'],
    references: ['model_source_evidence_v2', 'namespace_id', 'model_version_id', 'evidence_digest'],
  },
]
if (
  !Array.isArray(databaseShape.evaluation_v5_v6_foreign_keys) ||
  requiredEvaluationForeignKeys.some(
    (required) =>
      !databaseShape.evaluation_v5_v6_foreign_keys.some(
        (candidate) =>
          stableJson(candidate.columns) === stableJson(required.columns) &&
          stableJson(candidate.references) === stableJson(required.references),
      ),
  ) ||
  !databaseShape.evaluation_v5_v6_foreign_keys.some(
    (candidate) => candidate.condition === 'model_artifact_id_is_not_null',
  )
) {
  fail('database shape is missing a required Evaluation v5/v6 foreign key')
}
if (
  databaseShape.status !== 'implemented-through-mr6' ||
  databaseShape.last_implemented_migration !== '0019_model_version_evaluations_v2' ||
  databaseShape.evaluation_v5_v6_status !== 'implemented-mr6' ||
  databaseShape.evaluation_v5_v6_source_binding?.mechanism !== 'deferred_constraint_trigger' ||
  databaseShape.evaluation_v5_v6_source_binding?.artifact_source?.artifact_id !==
    'exact_primary_artifact' ||
  databaseShape.evaluation_v5_v6_source_binding?.source_observed_at !== 'database_clock_required'
) {
  fail('database shape does not record the implemented MR6 Evaluation binding')
}
if (
  databaseShape.migration_rules?.additive !== true ||
  databaseShape.migration_rules?.foreign_key_action !== 'RESTRICT' ||
  databaseShape.migration_rules?.automatic_backfill !== false ||
  databaseShape.migration_rules?.historical_identity_rewrite !== false
) {
  fail('database migration invariants have drifted')
}

function assertStrictSchema(schema, label) {
  const visit = (node, location) => {
    if (node === null || typeof node !== 'object') return
    if (node.type === 'object') {
      if (node.properties !== undefined) {
        if (node.additionalProperties !== false) fail(`${label} ${location} is not strict`)
        const propertyNames = Object.keys(node.properties)
        if (!Array.isArray(node.required) || !sameMembers(node.required, propertyNames)) {
          fail(`${label} ${location} must require every declared property`)
        }
      } else if (node.additionalProperties === undefined) {
        fail(`${label} ${location} has unconstrained object properties`)
      }
    }
    for (const [key, value] of Object.entries(node)) visit(value, `${location}/${key}`)
  }
  visit(schema, '#')
}

assertStrictSchema(endpointPolicy, 'endpoint policy schema')
assertStrictSchema(credentials, 'credential registry schema')
if (
  endpointPolicy.properties?.profile?.const !== 'model-endpoint-policy-v1' ||
  endpointPolicy.properties?.private_network?.maxItems !== 256 ||
  endpointPolicy.properties?.public_network?.maxItems !== 256
) {
  fail('endpoint policy schema profile or bounds have drifted')
}
if (
  credentials.properties?.profile?.const !== 'model-credentials-v1' ||
  credentials.properties?.credentials?.maxProperties !== 256 ||
  credentials.$defs?.credential?.properties?.kind?.const !== 'bearer' ||
  credentials.$defs?.credential?.properties?.secret?.maxLength !== 8192
) {
  fail('credential registry schema profile or bounds have drifted')
}
if (stableJson(credentials).includes('sk-') || stableJson(credentials).includes('Bearer ')) {
  fail('credential registry schema must not contain a secret value')
}

const requiredEndpointCases = [
  'public-https-global-v4',
  'public-https-global-v6',
  'public-cgnat',
  'public-cloud-metadata',
  'dns-rebinding-second-resolution',
  'dual-stack-one-address-denied',
  'ipv4-mapped-ipv6-bypass',
  'idna-or-trailing-dot-confusion',
  'idna-unicode-confusion',
  'ipv6-zone-id',
  'ambient-proxy-present',
  'redirect',
  'offline-public-network',
]
if (
  endpointCases.fixture_version !== 2 ||
  endpointCases.profile !== 'model-endpoint-policy-v1' ||
  !Array.isArray(endpointCases.required_cases)
) {
  fail('endpoint policy cases header is invalid')
}
const caseIds = endpointCases.required_cases.map((entry) => entry.id)
if (new Set(caseIds).size !== caseIds.length) fail('endpoint policy cases contain duplicate IDs')
for (const id of requiredEndpointCases) {
  if (!caseIds.includes(id)) fail(`endpoint policy cases are missing ${id}`)
}
for (const entry of endpointCases.required_cases) {
  if (!['private_network', 'public_network', 'both'].includes(entry.scope)) {
    fail(`endpoint policy case ${entry.id} has invalid scope`)
  }
  if (
    ![
      'allow',
      'allow-connected-only',
      'deny',
      'deny-on-second-connection',
      'ignore-proxy',
      'registered-unavailable',
    ].includes(entry.expected)
  ) {
    fail(`endpoint policy case ${entry.id} has invalid expectation`)
  }
}

const evalscopeLock = await readJson(PATHS.evalscopeLock, 'EvalScope upstream lock')
const evalscopePatch = await readFile(PATHS.evalscopePatch)
const lockedEvalscopePatch = evalscopeLock.patches?.find(
  (entry) => entry.path === 'patches/0001-databench-runtime-boundary.patch',
)
if (lockedEvalscopePatch?.sha256 !== sha256(evalscopePatch)) {
  fail('EvalScope runtime boundary patch digest does not match upstream.lock')
}
const evalscopePatchSource = evalscopePatch.toString('utf8')
for (const requiredFence of [
  'install_pinned_socket_transport_v1',
  'follow_redirects=False',
  'trust_env=False',
  'Databench-Credential-Fd',
  'DupFd',
  'read_anonymous_credential_fd_v1',
]) {
  if (!evalscopePatchSource.includes(requiredFence)) {
    fail(`EvalScope runtime boundary patch is missing ${requiredFence}`)
  }
}

if (
  legacy.baseline_version !== 2 ||
  legacy.source_commit !== 'owner-amendment-2026-08-05' ||
  legacy.public_mutation_auth !== 'deferred_to_rbac' ||
  legacy.internal_resolve_auth !== 'service_bearer'
) {
  fail('legacy S4 baseline version or source commit has drifted')
}
if (legacy.identity?.profile !== 'model-deployment-create-v1') {
  fail('legacy identity profile must remain model-deployment-create-v1')
}
if (!/^[a-f0-9]{64}$/.test(legacy.identity?.blake3_hex ?? '')) {
  fail('legacy identity digest is invalid')
}
let canonicalIdentity
try {
  canonicalIdentity = JSON.parse(legacy.identity.canonical_json)
} catch (error) {
  fail(`legacy canonical identity is invalid JSON: ${error.message}`)
}
if (canonicalIdentity.model_deployment_create_profile !== legacy.identity.profile) {
  fail('legacy canonical identity profile does not match the baseline profile')
}

assertSafeRepositoryPath(legacy.database?.migration, 'legacy migration path')
const migrationPath = process.env.MODEL_REGISTRY_MIGRATION_PATH
  ? path.resolve(process.env.MODEL_REGISTRY_MIGRATION_PATH)
  : path.join(REPOSITORY_ROOT, legacy.database.migration)
const migrationBytes = await readFile(migrationPath)
if (sha256(migrationBytes) !== legacy.database.sha256) fail('legacy migration digest mismatch')
if (
  legacy.database.artifact_id_nullable !== false ||
  legacy.database.provider !== 'openai_compatible' ||
  legacy.database.auth_mode !== 'none' ||
  !sameMembers(legacy.database.statuses ?? [], ['active', 'disabled'])
) {
  fail('legacy database semantics have drifted')
}

if (legacy.openapi?.algorithm !== 'sha256-sorted-json-v1') {
  fail('legacy OpenAPI digest algorithm must be sha256-sorted-json-v1')
}
for (const [operation, expectedDigest] of Object.entries(legacy.openapi.operations ?? {})) {
  const separator = operation.indexOf(' ')
  const method = operation.slice(0, separator).toLowerCase()
  const route = operation.slice(separator + 1)
  const value = openapi.paths?.[route]?.[method]
  if (!value) fail(`legacy OpenAPI operation is missing: ${operation}`)
  if (stableSha256(value) !== expectedDigest) fail(`legacy OpenAPI operation drift: ${operation}`)
}
for (const [schemaName, expectedDigest] of Object.entries(legacy.openapi.schemas ?? {})) {
  const value = openapi.components?.schemas?.[schemaName]
  if (!value) fail(`legacy OpenAPI schema is missing: ${schemaName}`)
  if (stableSha256(value) !== expectedDigest) fail(`legacy OpenAPI schema drift: ${schemaName}`)
}
if (Object.keys(legacy.openapi.operations ?? {}).length !== 5) {
  fail('legacy OpenAPI baseline must lock exactly five operations')
}
if (Object.keys(legacy.openapi.schemas ?? {}).length !== 3) {
  fail('legacy OpenAPI baseline must lock exactly three schemas')
}

const internal = legacy.internal_v1
if (internal?.route !== '/internal/v1/model-deployments/{deployment_id}:resolve') {
  fail('legacy internal resolver route has drifted')
}
for (const sourcePath of [internal.api_source, internal.consumer_source]) {
  assertSafeRepositoryPath(sourcePath, 'legacy internal source path')
}
const [apiSource, consumerSource, schemaSource, goldenSource, hashingTypes, hashingDomains] =
  await Promise.all([
    readFile(path.join(REPOSITORY_ROOT, internal.api_source), 'utf8'),
    readFile(path.join(REPOSITORY_ROOT, internal.consumer_source), 'utf8'),
    readFile(path.join(REPOSITORY_ROOT, 'packages/schema/src/v2/model-deployment.ts'), 'utf8'),
    readFile(path.join(REPOSITORY_ROOT, legacy.identity.source), 'utf8'),
    readFile(path.join(REPOSITORY_ROOT, 'packages/hashing/src/v2/types.ts'), 'utf8'),
    readFile(path.join(REPOSITORY_ROOT, 'packages/hashing/src/v2/domains.ts'), 'utf8'),
  ])
const apiRoute = '/internal/v1/model-deployments/:target{[^/]+:resolve}'
if (!apiSource.includes(`'${apiRoute}'`) || !consumerSource.includes(internal.route)) {
  fail('legacy internal resolver route is not preserved by both producer and consumer')
}

const schemaBlock = schemaSource
  .slice(schemaSource.indexOf('export const ResolvedModelDeploymentV2Schema'))
  .match(/\.strictObject\(\{([\s\S]*?)\n {2}\}\)/)?.[1]
if (!schemaBlock) fail('cannot locate ResolvedModelDeploymentV2Schema fields')
const schemaFields = [...schemaBlock.matchAll(/^ {4}([a-z_]+):/gm)].map((match) => match[1])
const consumerBlock = consumerSource.match(/expected_fields = \{([\s\S]*?)\n {8}\}/)?.[1]
if (!consumerBlock) fail('cannot locate EvalScope internal v1 expected fields')
const consumerFields = [...consumerBlock.matchAll(/'([a-z_]+)'/g)].map((match) => match[1])
if (
  !sameMembers(internal.fields ?? [], schemaFields) ||
  !sameMembers(internal.fields ?? [], consumerFields)
) {
  fail('legacy internal v1 fields have drifted between baseline, schema, and consumer')
}
for (const [field, value] of Object.entries(internal.constants ?? {})) {
  if (!internal.fields.includes(field)) fail(`legacy internal constant field is unknown: ${field}`)
  if (!schemaSource.includes(`'${value}'`) || !consumerSource.includes(`'${value}'`)) {
    fail(`legacy internal v1 constant has drifted: ${field}`)
  }
}
if (
  !hashingTypes.includes(`'${legacy.identity.profile}' as const`) ||
  !hashingDomains.includes(legacy.identity.profile) ||
  !goldenSource.includes(legacy.identity.canonical_json) ||
  !goldenSource.includes(legacy.identity.blake3_hex)
) {
  fail('legacy identity fixed vector or hashing profile has drifted')
}

if (pkg.scripts?.['models:status:check'] !== 'node scripts/check-model-registry-status.mjs') {
  fail('package.json is missing models:status:check')
}
if (
  pkg.scripts?.['models:status:test'] !== 'node --test scripts/check-model-registry-status.test.mjs'
) {
  fail('package.json is missing models:status:test')
}

console.log(
  `Model Registry status ok: ${expectedLastCompleted} complete, ${expectedCurrent} current, ${fixtureIds.size} fixtures indexed`,
)
