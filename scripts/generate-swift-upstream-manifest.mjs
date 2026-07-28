import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, '..')
const LOCK_PATH = path.join(REPOSITORY_ROOT, 'third_party/ms-swift/upstream.lock')
const OUTPUT_PATH = path.join(REPOSITORY_ROOT, 'third_party/ms-swift/upstream-manifest.json')

const EXTRA_SOURCES = [
  'LICENSE',
  'requirements/framework.txt',
  'requirements/install_all.sh',
  'setup.py',
  'swift/arguments/webui_args.py',
  'swift/cli/web_ui.py',
]

const PATCHED_SOURCES = new Set([
  'setup.py',
  'swift/ui/app.py',
  'swift/ui/llm_train/dataset.py',
  'swift/ui/llm_train/hyper.py',
  'swift/ui/llm_train/runtime.py',
])

const CAPABILITY_PREFIXES = [
  ['swift/ui/llm_train/', 'surface.train'],
  ['swift/ui/llm_rlhf/', 'surface.rlhf'],
  ['swift/ui/llm_grpo/', 'surface.grpo'],
  ['swift/ui/llm_infer/', 'surface.infer'],
  ['swift/ui/llm_export/', 'surface.export'],
  ['swift/ui/llm_eval/', 'surface.eval'],
  ['swift/ui/llm_sample/', 'surface.sample'],
]

function parseArguments(arguments_) {
  const upstreamRoot = arguments_[0]
  if (!upstreamRoot) {
    throw new Error('Usage: node scripts/generate-swift-upstream-manifest.mjs <ms-swift-root>')
  }
  return path.resolve(upstreamRoot)
}

async function listFiles(root) {
  const files = []
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name)
      if (entry.isDirectory()) await visit(entryPath)
      else if (entry.isFile() && entry.name.endsWith('.py')) files.push(entryPath)
    }
  }
  await visit(root)
  return files.sort((left, right) => left.localeCompare(right, 'en'))
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function capabilityIds(sourcePath) {
  const match = CAPABILITY_PREFIXES.find(([prefix]) => sourcePath.startsWith(prefix))
  if (match) return [match[1]]
  if (
    sourcePath === 'swift/ui/app.py' ||
    sourcePath === 'swift/ui/base.py' ||
    sourcePath === 'swift/ui/__init__.py' ||
    sourcePath === 'swift/arguments/webui_args.py' ||
    sourcePath === 'swift/cli/web_ui.py'
  ) {
    return ['surface.shell']
  }
  return []
}

function sourceKind(sourcePath) {
  if (sourcePath === 'LICENSE') return 'license'
  if (sourcePath.startsWith('requirements/') || sourcePath === 'setup.py') return 'build-input'
  return 'runtime-source'
}

async function lineCount(filePath) {
  const contents = await readFile(filePath, 'utf8')
  if (contents.length === 0) return 0
  return contents.split('\n').length - (contents.endsWith('\n') ? 1 : 0)
}

const upstreamRoot = parseArguments(process.argv.slice(2))
const lock = JSON.parse(await readFile(LOCK_PATH, 'utf8'))
const actualCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: upstreamRoot,
  encoding: 'utf8',
}).trim()

if (actualCommit !== lock.commit) {
  throw new Error(`ms-swift commit mismatch: expected ${lock.commit}, received ${actualCommit}`)
}

const uiFiles = await listFiles(path.join(upstreamRoot, 'swift/ui'))
const sourcePaths = [
  ...uiFiles.map((filePath) => path.relative(upstreamRoot, filePath).split(path.sep).join('/')),
  ...EXTRA_SOURCES,
].sort((left, right) => left.localeCompare(right, 'en'))

const files = []
let pythonLineCount = 0
for (const sourcePath of sourcePaths) {
  const filePath = path.join(upstreamRoot, sourcePath)
  const lines = sourcePath.endsWith('.py') ? await lineCount(filePath) : null
  if (lines !== null) pythonLineCount += lines
  const capabilities = capabilityIds(sourcePath)
  files.push({
    upstream_path: sourcePath,
    upstream_sha256: sha256(await readFile(filePath)),
    bytes: (await readFile(filePath)).byteLength,
    python_lines: lines,
    kind: sourceKind(sourcePath),
    status: PATCHED_SOURCES.has(sourcePath) ? 'patched-in-image' : 'vendored-in-image',
    target: `image:/opt/ms-swift/${sourcePath}`,
    capability_ids: capabilities,
    reason:
      capabilities.length > 0
        ? 'source for a tracked native Gradio surface'
        : 'locked build, license, or supporting runtime input',
  })
}

const manifest = {
  schema_version: 1,
  upstream: {
    repository: lock.repository,
    tag: lock.tag,
    commit: lock.commit,
    tree: lock.tree,
    ui_root: 'swift/ui',
    tracked_file_count: files.length,
    ui_python_file_count: uiFiles.length,
    python_line_count: pythonLineCount,
    license_spdx: lock.license.spdx,
    license_sha256: lock.license.sha256,
  },
  files,
}

await writeFile(OUTPUT_PATH, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
console.log(
  `wrote ${files.length} ms-swift source entries to ${path.relative(REPOSITORY_ROOT, OUTPUT_PATH)}`,
)
