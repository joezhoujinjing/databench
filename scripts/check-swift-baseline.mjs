import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, '..')

function inputPath(environmentName, defaultPath) {
  return process.env[environmentName]
    ? path.resolve(process.env[environmentName])
    : path.join(REPOSITORY_ROOT, defaultPath)
}

const LOCK_PATH = inputPath('SWIFT_UPSTREAM_LOCK_PATH', 'third_party/ms-swift/upstream.lock')
const SOURCE_MANIFEST_PATH = inputPath(
  'SWIFT_SOURCE_MANIFEST_PATH',
  'third_party/ms-swift/upstream-manifest.json',
)
const CAPABILITY_MANIFEST_PATH = inputPath(
  'SWIFT_CAPABILITY_MANIFEST_PATH',
  'third_party/ms-swift/runtime-capabilities.json',
)
const CONFIG_BASELINE_PATH = inputPath(
  'SWIFT_GRADIO_BASELINE_PATH',
  'third_party/ms-swift/gradio-baseline.json',
)
const ROUTES_PATH = inputPath('SWIFT_GRADIO_ROUTES_PATH', 'third_party/ms-swift/gradio-routes.json')
const REQUIRE_S0_GREEN = process.argv.includes('--require-s0-green')
const errors = []

function fail(message) {
  errors.push(message)
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function isSha256(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
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

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function stableSha256(value) {
  return sha256(Buffer.from(stableJson(value), 'utf8'))
}

function manifestRelativePath(manifestPath, relativePath) {
  return path.resolve(path.dirname(manifestPath), relativePath)
}

function matchesSource(pattern, sourcePath) {
  return pattern.endsWith('/**')
    ? sourcePath.startsWith(pattern.slice(0, -2))
    : sourcePath === pattern
}

async function exists(filePath) {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

const [lock, sourceManifest, capabilities, baseline, routes] = await Promise.all(
  [
    LOCK_PATH,
    SOURCE_MANIFEST_PATH,
    CAPABILITY_MANIFEST_PATH,
    CONFIG_BASELINE_PATH,
    ROUTES_PATH,
  ].map(async (filePath) => JSON.parse(await readFile(filePath, 'utf8'))),
)

for (const [name, document] of [
  ['upstream lock', lock],
  ['source manifest', sourceManifest],
  ['capability manifest', capabilities],
  ['Gradio baseline', baseline],
  ['Gradio routes', routes],
]) {
  if (document.schema_version !== 1) fail(`${name} schema_version must be 1`)
}

for (const [name, value] of [
  ['source manifest', sourceManifest.upstream.commit],
  ['capability manifest', capabilities.upstream_commit],
  ['Gradio baseline', baseline.upstream_commit],
  ['Gradio routes', routes.upstream_commit],
]) {
  if (value !== lock.commit) fail(`${name} commit does not match upstream.lock`)
}

if (lock.tag !== 'v4.4.2') fail('upstream tag must remain v4.4.2 during S0')
if (!isSha256(lock.commit) && !/^[a-f0-9]{40}$/.test(lock.commit))
  fail('upstream commit must be a full Git commit')
if (!/^[a-f0-9]{40}$/.test(lock.tree)) fail('upstream tree must be a full Git tree')
if (lock.license.spdx !== 'Apache-2.0') fail('ms-swift license must be Apache-2.0')
if (!isSha256(lock.license.sha256)) fail('license digest is invalid')

const archivePath = manifestRelativePath(LOCK_PATH, lock.source_archive.path)
if (!(await exists(archivePath))) {
  fail(`source archive does not exist: ${archivePath}`)
} else {
  const archive = await readFile(archivePath)
  if (archive.byteLength !== lock.source_archive.bytes) fail('source archive byte count mismatch')
  if (sha256(archive) !== lock.source_archive.sha256) fail('source archive digest mismatch')
}

if (sourceManifest.upstream.tree !== lock.tree) fail('source manifest tree does not match lock')
if (sourceManifest.upstream.license_sha256 !== lock.license.sha256)
  fail('source manifest license digest does not match lock')
if (sourceManifest.upstream.tracked_file_count !== sourceManifest.files.length)
  fail('source tracked file count mismatch')
if (sourceManifest.upstream.ui_python_file_count !== 74)
  fail('locked UI Python file count must be 74')
if (sourceManifest.upstream.python_line_count !== 8454)
  fail('locked Python line count must be 8454')

const sourceByPath = new Map()
for (const source of sourceManifest.files) {
  if (!isNonEmptyString(source.upstream_path)) {
    fail('source entry has no upstream_path')
    continue
  }
  if (sourceByPath.has(source.upstream_path)) fail(`duplicate source: ${source.upstream_path}`)
  sourceByPath.set(source.upstream_path, source)
  if (!isSha256(source.upstream_sha256)) fail(`invalid source digest: ${source.upstream_path}`)
  if (!Number.isSafeInteger(source.bytes) || source.bytes < 0)
    fail(`invalid source byte count: ${source.upstream_path}`)
  if (!['runtime-source', 'build-input', 'license'].includes(source.kind))
    fail(`invalid source kind: ${source.upstream_path}`)
  if (!['vendored-in-image', 'patched-in-image'].includes(source.status))
    fail(`invalid source status: ${source.upstream_path}`)
  if (!isNonEmptyString(source.target) || !source.target.startsWith('image:/opt/ms-swift/'))
    fail(`invalid source target: ${source.upstream_path}`)
  if (!Array.isArray(source.capability_ids))
    fail(`source capability_ids must be an array: ${source.upstream_path}`)
}

const patchEntries = new Map()
for (const patch of lock.patches) {
  if (patchEntries.has(patch.path)) fail(`duplicate patch: ${patch.path}`)
  patchEntries.set(patch.path, patch)
  const patchPath = manifestRelativePath(LOCK_PATH, patch.path)
  if (!(await exists(patchPath))) {
    fail(`patch does not exist: ${patch.path}`)
    continue
  }
  if (sha256(await readFile(patchPath)) !== patch.sha256)
    fail(`patch digest mismatch: ${patch.path}`)
}

const allowedPatchedFiles = new Set([
  'swift/ui/app.py',
  'swift/ui/llm_train/dataset.py',
  'swift/ui/llm_train/hyper.py',
  'swift/ui/llm_train/runtime.py',
])
const primaryPatch = lock.patches.find(
  (patch) => patch.path === 'patches/0001-databench-session-prefill.patch',
)
if (!primaryPatch) {
  fail('required Databench Session prefill patch is missing')
} else {
  const patchContents = await readFile(manifestRelativePath(LOCK_PATH, primaryPatch.path), 'utf8')
  const touched = new Set(
    [...patchContents.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)].map((match) => match[1]),
  )
  if (touched.size !== allowedPatchedFiles.size)
    fail('downstream patch must touch exactly the four approved integration files')
  for (const filePath of touched) {
    if (!allowedPatchedFiles.has(filePath))
      fail(`downstream patch touches an unapproved file: ${filePath}`)
  }
  for (const filePath of allowedPatchedFiles) {
    if (!touched.has(filePath)) fail(`downstream patch is missing approved file: ${filePath}`)
    if (sourceByPath.get(filePath)?.status !== 'patched-in-image')
      fail(`patched source is not classified as patched-in-image: ${filePath}`)
  }
}

const capabilityById = new Map()
for (const capability of capabilities.capabilities) {
  if (!isNonEmptyString(capability.id)) {
    fail('capability has no id')
    continue
  }
  if (capabilityById.has(capability.id)) fail(`duplicate capability: ${capability.id}`)
  capabilityById.set(capability.id, capability)
  if (
    !['native-ui-surface', 'databench-integration', 'runtime-capability'].includes(capability.kind)
  )
    fail(`invalid capability kind: ${capability.id}`)
  for (const flag of ['surface_present', 'runtime_installed', 'runtime_validated']) {
    if (typeof capability[flag] !== 'boolean')
      fail(`capability ${flag} is not boolean: ${capability.id}`)
  }
  if (!['planned', 'green'].includes(capability.status))
    fail(`invalid capability status: ${capability.id}`)
  if (!Array.isArray(capability.requirements) || capability.requirements.length === 0)
    fail(`capability requirements are empty: ${capability.id}`)
  if (!Array.isArray(capability.evidence) || capability.evidence.length === 0)
    fail(`capability evidence is empty: ${capability.id}`)
  if (
    capability.runtime_validated &&
    capability.evidence.some((entry) => entry.startsWith('planned:'))
  )
    fail(`runtime-validated capability still has planned evidence: ${capability.id}`)
  for (const pattern of capability.upstream_sources) {
    const matches = sourceManifest.files.filter((source) =>
      matchesSource(pattern, source.upstream_path),
    )
    if (matches.length === 0)
      fail(`capability source matches nothing: ${capability.id} -> ${pattern}`)
    for (const source of matches) {
      if (!source.capability_ids.includes(capability.id))
        fail(`source backlink is missing: ${source.upstream_path} -> ${capability.id}`)
    }
  }
}

const requiredSurfaces = [
  'surface.shell',
  'surface.train',
  'surface.rlhf',
  'surface.grpo',
  'surface.infer',
  'surface.export',
  'surface.eval',
  'surface.sample',
]
for (const capabilityId of requiredSurfaces) {
  const capability = capabilityById.get(capabilityId)
  if (!capability) {
    fail(`required native surface is missing: ${capabilityId}`)
    continue
  }
  if (!capability.surface_present || capability.status !== 'green')
    fail(`required native surface baseline is not green: ${capabilityId}`)
}

const expectedTabs = [
  'llm_train',
  'llm_rlhf',
  'llm_grpo',
  'llm_infer',
  'llm_export',
  'llm_eval',
  'llm_sample',
]
const actualTabs = baseline.top_level_tabs.map((tab) => tab.elem_id)
if (JSON.stringify(actualTabs) !== JSON.stringify(expectedTabs))
  fail(`top-level Gradio tabs changed: ${actualTabs.join(',')}`)
if (baseline.component_count !== baseline.components.length) fail('component count mismatch')
if (baseline.dependency_count !== baseline.dependencies.length) fail('dependency count mismatch')
if (baseline.component_count !== 1005) fail('locked component count must be 1005')
if (baseline.dependency_count !== 115) fail('locked dependency count must be 115')
if (stableSha256(baseline.components) !== baseline.components_sha256)
  fail('component baseline digest mismatch')
if (stableSha256(baseline.dependencies) !== baseline.dependencies_sha256)
  fail('dependency baseline digest mismatch')
const componentTypes = Object.fromEntries(
  [...new Set(baseline.components.map((component) => component.type))]
    .sort((left, right) => left.localeCompare(right, 'en'))
    .map((type) => [
      type,
      baseline.components.filter((component) => component.type === type).length,
    ]),
)
if (stableJson(componentTypes) !== stableJson(baseline.component_type_counts))
  fail('component type counts do not match components')

const requiredCallbacks = [
  'train_local',
  'train_local_1',
  'train_local_2',
  'deploy_model',
  'export_model',
  'eval_model',
  'sample_model',
  'kill_task',
]
for (const callback of requiredCallbacks) {
  if (!baseline.api_names.includes(callback))
    fail(`required native callback is missing: ${callback}`)
}

if (routes.route_count !== routes.routes.length) fail('route count mismatch')
if (routes.route_count !== 76) fail('locked Gradio route count must be 76')
if (stableSha256(routes.routes) !== routes.routes_sha256) fail('route digest mismatch')
const routeKeys = new Set()
for (const route of routes.routes) {
  const key = `${route.methods.join(',')} ${route.path} ${route.route_type}`
  if (routeKeys.has(key)) fail(`duplicate Gradio route: ${key}`)
  routeKeys.add(key)
  if (!route.path.startsWith('/')) fail(`invalid Gradio route path: ${key}`)
  if (route.proxy_required !== true) fail(`full native route is not marked proxy-required: ${key}`)
}
for (const [method, routePath] of [
  ['GET', '/'],
  ['GET', '/config'],
  ['POST', '/gradio_api/queue/join'],
  ['GET', '/gradio_api/queue/data'],
  ['WEBSOCKET', '/gradio_api/stream/{event_id}'],
  ['POST', '/gradio_api/upload'],
  ['GET', '/gradio_api/file/{path:path}'],
]) {
  if (!routes.routes.some((route) => route.path === routePath && route.methods.includes(method)))
    fail(`required Gradio route is missing: ${method} ${routePath}`)
}

if (baseline.environment.gradio !== routes.gradio_version)
  fail('Gradio route/config environment versions do not match')
for (const [name, version] of Object.entries(lock.baseline_environment)) {
  if (baseline.environment[name] !== version) fail(`Gradio baseline environment mismatch: ${name}`)
}

let extractedRoot = null
if (await exists(archivePath)) {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'databench-swift-baseline-'))
  try {
    execFileSync('tar', ['-xzf', archivePath, '-C', temporaryRoot], { stdio: 'pipe' })
    extractedRoot = path.join(temporaryRoot, lock.source_archive.prefix.replace(/\/$/, ''))
    for (const source of sourceManifest.files) {
      const sourcePath = path.join(extractedRoot, source.upstream_path)
      if (!(await exists(sourcePath))) {
        fail(`source archive is missing tracked file: ${source.upstream_path}`)
        continue
      }
      const bytes = await readFile(sourcePath)
      if (bytes.byteLength !== source.bytes)
        fail(`source archive byte mismatch: ${source.upstream_path}`)
      if (sha256(bytes) !== source.upstream_sha256)
        fail(`source archive digest mismatch: ${source.upstream_path}`)
    }
    if (primaryPatch) {
      execFileSync(
        'git',
        ['apply', '--check', manifestRelativePath(LOCK_PATH, primaryPatch.path)],
        { cwd: extractedRoot, stdio: 'pipe' },
      )
    }
  } catch (error) {
    fail(`source archive or downstream patch verification failed: ${error.message}`)
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}
void extractedRoot

const runtimeTarget = lock.runtime_target
if (runtimeTarget.platform !== 'linux/amd64') fail('Swift runtime target must remain linux/amd64')
if (
  runtimeTarget.base_image !== 'pytorch/pytorch:2.8.0-cuda12.8-cudnn9-runtime' ||
  !isSha256(runtimeTarget.base_image_digest)
) {
  fail('Swift runtime base image tag and digest must be locked')
}
if (runtimeTarget.base_image_media_type !== 'application/vnd.docker.distribution.manifest.v2+json')
  fail('Swift runtime base image must resolve to the locked single-platform manifest')

const dependencyDocuments = [
  ['dependency input', runtimeTarget.dependency_input_path, runtimeTarget.dependency_input_sha256],
  ['runtime provided', runtimeTarget.runtime_provided_path, runtimeTarget.runtime_provided_sha256],
  ['dependency lock', runtimeTarget.dependency_lock_path, runtimeTarget.dependency_lock_sha256],
]
const runtimeDocuments = new Map()
for (const [name, relativePath, digest] of dependencyDocuments) {
  if (
    !isNonEmptyString(relativePath) ||
    path.isAbsolute(relativePath) ||
    relativePath.includes('..')
  ) {
    fail(`${name} path must be relative to upstream.lock`)
    continue
  }
  if (!isSha256(digest)) {
    fail(`${name} digest is invalid`)
    continue
  }
  const documentPath = manifestRelativePath(LOCK_PATH, relativePath)
  if (!(await exists(documentPath))) {
    fail(`${name} does not exist`)
    continue
  }
  const bytes = await readFile(documentPath)
  if (sha256(bytes) !== digest) fail(`${name} digest mismatch`)
  runtimeDocuments.set(name, bytes.toString('utf8'))
}

const dependencyLock = runtimeDocuments.get('dependency lock')
const runtimeProvided = runtimeDocuments.get('runtime provided')
if (dependencyLock) {
  if (!dependencyLock.includes('#    pnpm swift:lock:generate'))
    fail('dependency lock has an unexpected generation command')
  if (/^\s*(?:-e|--editable|https?:|git\+)/m.test(dependencyLock))
    fail('dependency lock must not contain editable, URL or Git dependencies')
  const lockedPackages = dependencyLock
    .split(/\r?\n/)
    .filter((line) => /^[A-Za-z0-9][A-Za-z0-9._-]*==/.test(line))
  if (lockedPackages.length !== runtimeTarget.dependency_lock_package_count)
    fail('dependency lock package count mismatch')
  if ((dependencyLock.match(/--hash=sha256:/g) ?? []).length < lockedPackages.length)
    fail('every locked dependency must have at least one SHA-256 hash')
  for (const [packageName, expectedVersion] of [
    ['gradio', runtimeTarget.gradio],
    ['transformers', runtimeTarget.transformers],
  ]) {
    if (!lockedPackages.some((line) => line.startsWith(`${packageName}==${expectedVersion} `)))
      fail(`${packageName} does not match runtime_target`)
  }
  if (runtimeProvided) {
    const providedNames = runtimeProvided
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'))
      .map((line) => /^([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(line)?.[1]?.toLowerCase())
      .filter(Boolean)
    for (const providedName of providedNames) {
      if (lockedPackages.some((line) => line.toLowerCase().startsWith(`${providedName}==`)))
        fail(`base-image dependency must not be duplicated in pip lock: ${providedName}`)
    }
    if (!runtimeProvided.includes(`torch==${runtimeTarget.torch}`))
      fail('runtime-provided torch does not match runtime_target')
  }
}

if (REQUIRE_S0_GREEN) {
  if (runtimeTarget.status !== 'locked') fail('S0 green requires runtime_target.status=locked')
  if (!isSha256(runtimeTarget.base_image_digest))
    fail('S0 green requires a digest-pinned Linux GPU base image')
  if (!isNonEmptyString(runtimeTarget.dependency_lock_path)) {
    fail('S0 green requires a Linux dependency lock path')
  } else {
    const dependencyLockPath = manifestRelativePath(LOCK_PATH, runtimeTarget.dependency_lock_path)
    if (!(await exists(dependencyLockPath))) fail('S0 Linux dependency lock does not exist')
  }
}

if (errors.length > 0) {
  for (const error of errors) console.error(`- ${error}`)
  process.exitCode = 1
} else {
  console.log(
    `Swift S0 baseline is consistent: ${sourceManifest.files.length} sources, ` +
      `${baseline.components.length} components, ${baseline.dependencies.length} callbacks, ` +
      `${routes.routes.length} routes.`,
  )
}
