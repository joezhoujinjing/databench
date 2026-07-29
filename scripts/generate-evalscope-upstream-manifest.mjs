import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, '..')
const LOCK_PATH = path.join(REPOSITORY_ROOT, 'deploy/evalscope/upstream.lock')
const CAPABILITY_MANIFEST_PATH = path.join(
  REPOSITORY_ROOT,
  'apps/web/src/evaluations/ui-capability-manifest.json',
)
const OUTPUT_PATH = path.join(REPOSITORY_ROOT, 'apps/web/src/evaluations/upstream-manifest.json')

const BRAND_SHELL_EXCLUSIONS = new Map([
  ['evalscope/web/src/App.tsx', 'standalone BrowserRouter application boot'],
  ['evalscope/web/src/main.tsx', 'standalone Vite application boot'],
  ['evalscope/web/src/components/nav/LocaleToggle.tsx', 'duplicate locale shell control'],
  ['evalscope/web/src/components/nav/ThemeToggle.tsx', 'duplicate theme shell control'],
  ['evalscope/web/src/components/nav/TopNav.tsx', 'EvalScope-branded standalone navigation'],
  ['evalscope/web/src/contexts/LocaleContext.tsx', 'replaced by Databench react-i18next shell'],
  ['evalscope/web/src/contexts/ThemeContext.tsx', 'replaced by Databench theme shell'],
])

function parseArguments(argv) {
  const upstreamIndex = argv.indexOf('--upstream')
  if (upstreamIndex === -1 || !argv[upstreamIndex + 1]) {
    throw new Error(
      'Usage: node scripts/generate-evalscope-upstream-manifest.mjs --upstream <repo>',
    )
  }
  return path.resolve(argv[upstreamIndex + 1])
}

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await listFiles(entryPath)))
    } else if (entry.isFile()) {
      files.push(entryPath)
    }
  }
  return files.sort((left, right) => left.localeCompare(right, 'en'))
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function matchesSource(pattern, sourcePath) {
  return pattern.endsWith('/**')
    ? sourcePath.startsWith(pattern.slice(0, -2))
    : sourcePath === pattern
}

function plannedTarget(sourcePath) {
  const relative = sourcePath.slice('evalscope/web/src/'.length)
  return `apps/web/src/evaluations/${relative}`
}

function sourceStatus(sourcePath) {
  if (BRAND_SHELL_EXCLUSIONS.has(sourcePath)) return 'excluded'
  if (sourcePath.includes('.test.')) return 'adapted'
  if (
    sourcePath.includes('/domain/') ||
    sourcePath.includes('/utils/') ||
    sourcePath.includes('/api/schemas/') ||
    sourcePath.includes('/api/types/')
  ) {
    return 'migrated'
  }
  return 'adapted'
}

function sourceReason(sourcePath, parityIds) {
  const exclusion = BRAND_SHELL_EXCLUSIONS.get(sourcePath)
  if (exclusion) return exclusion
  if (sourcePath.includes('.test.'))
    return 'adapt test to Databench router, API and visual primitives'
  if (parityIds.length > 0) return 'capability source tracked by the capability manifest'
  return 'supporting source; behavior is consumed by tracked page and component capabilities'
}

async function countTypeScriptLines(files) {
  let lines = 0
  for (const filePath of files) {
    if (!filePath.endsWith('.ts') && !filePath.endsWith('.tsx')) continue
    const contents = await readFile(filePath, 'utf8')
    lines +=
      contents.length === 0 ? 0 : contents.split('\n').length - (contents.endsWith('\n') ? 1 : 0)
  }
  return lines
}

const upstreamRoot = parseArguments(process.argv.slice(2))
const lock = JSON.parse(await readFile(LOCK_PATH, 'utf8'))
const capabilityManifest = JSON.parse(await readFile(CAPABILITY_MANIFEST_PATH, 'utf8'))
const actualCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: upstreamRoot,
  encoding: 'utf8',
}).trim()

if (actualCommit !== lock.commit) {
  throw new Error(`EvalScope commit mismatch: expected ${lock.commit}, received ${actualCommit}`)
}

const sourceRoot = path.join(upstreamRoot, 'evalscope/web/src')
const sourceFiles = await listFiles(sourceRoot)
const files = []

for (const filePath of sourceFiles) {
  const sourcePath = path.relative(upstreamRoot, filePath).split(path.sep).join('/')
  const parityIds = capabilityManifest.capabilities
    .filter((capability) =>
      capability.upstream_sources.some((pattern) => matchesSource(pattern, sourcePath)),
    )
    .map((capability) => capability.parity_id)
    .sort((left, right) => left.localeCompare(right, 'en'))
  const status = sourceStatus(sourcePath)
  files.push({
    upstream_path: sourcePath,
    upstream_sha256: sha256(await readFile(filePath)),
    kind: sourcePath.includes('.test.') ? 'test' : 'production',
    status,
    coverage_kind:
      status === 'excluded'
        ? 'brand-shell-exclusion'
        : parityIds.length > 0
          ? 'capability-source'
          : 'supporting-source',
    target_path: status === 'excluded' ? null : plannedTarget(sourcePath),
    reason: sourceReason(sourcePath, parityIds),
    parity_ids: parityIds,
  })
}

const manifest = {
  schema_version: 1,
  upstream: {
    repository: lock.repository,
    commit: lock.commit,
    web_root: 'evalscope/web',
    source_root: 'evalscope/web/src',
    source_file_count: files.length,
    test_file_count: files.filter((file) => file.kind === 'test').length,
    typescript_line_count: await countTypeScriptLines(sourceFiles),
    license_spdx: lock.license.spdx,
    license_sha256: lock.license.sha256,
  },
  files,
}

await writeFile(OUTPUT_PATH, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
console.log(
  `wrote ${files.length} EvalScope source entries to ${path.relative(REPOSITORY_ROOT, OUTPUT_PATH)}`,
)
