import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const webRoot = path.resolve(import.meta.dirname, '..')
const manifest = JSON.parse(await readFile(path.join(webRoot, 'dist/.vite/manifest.json'), 'utf8'))
const entryKey = Object.keys(manifest).find((key) => manifest[key].isEntry)
if (entryKey === undefined) fail('Vite manifest has no application entry')

const initialKeys = collectStaticImports(entryKey)
const forbiddenInitial = [...initialKeys].filter(
  (key) =>
    key.startsWith('src/evaluations/api/') ||
    key.startsWith('src/evaluations/layouts/') ||
    key.startsWith('src/evaluations/routes/dashboard') ||
    key.startsWith('src/evaluations/routes/tasks') ||
    key.startsWith('src/evaluations/routes/reports') ||
    key.startsWith('src/evaluations/routes/report-detail') ||
    key.startsWith('src/evaluations/routes/compare') ||
    key.startsWith('src/evaluations/routes/performance') ||
    key.startsWith('src/evaluations/routes/benchmarks') ||
    key.startsWith('src/evaluations/routes/viewer') ||
    key.startsWith('src/evaluations/i18n/translations'),
)
if (forbiddenInitial.length > 0) {
  fail(`Evaluation route code leaked into the initial bundle: ${forbiddenInitial.join(', ')}`)
}

const requiredLazyModules = [
  'src/evaluations/layouts/EvaluationLayout.tsx',
  'src/evaluations/routes/dashboard.tsx',
  'src/evaluations/routes/tasks.tsx',
  'src/evaluations/routes/reports.tsx',
  'src/evaluations/routes/report-detail.tsx',
  'src/evaluations/routes/compare.tsx',
  'src/evaluations/routes/performance.tsx',
  'src/evaluations/routes/performance-detail.tsx',
  'src/evaluations/routes/performance-compare.tsx',
  'src/evaluations/routes/benchmarks.tsx',
  'src/evaluations/routes/viewer.tsx',
]
for (const moduleName of requiredLazyModules) {
  if (manifest[moduleName]?.isDynamicEntry !== true) {
    fail(`Evaluation route is not a dynamic entry: ${moduleName}`)
  }
}

let initialJavaScriptBytes = 0
for (const key of initialKeys) {
  const file = manifest[key]?.file
  if (typeof file === 'string' && file.endsWith('.js')) {
    initialJavaScriptBytes += (await stat(path.join(webRoot, 'dist', file))).size
  }
}
const INITIAL_JAVASCRIPT_BUDGET = 950_000
if (initialJavaScriptBytes > INITIAL_JAVASCRIPT_BUDGET) {
  fail(`Initial JavaScript ${initialJavaScriptBytes} exceeds budget ${INITIAL_JAVASCRIPT_BUDGET}`)
}

console.log(
  `Evaluation bundle boundary ok: ${initialJavaScriptBytes} initial JS bytes, ` +
    `${requiredLazyModules.length} lazy route entries`,
)

function collectStaticImports(rootKey) {
  const visited = new Set()
  const pending = [rootKey]
  while (pending.length > 0) {
    const key = pending.pop()
    if (key === undefined || visited.has(key)) continue
    visited.add(key)
    for (const dependency of manifest[key]?.imports ?? []) pending.push(dependency)
  }
  return visited
}

function fail(message) {
  console.error(`Evaluation bundle check failed: ${message}`)
  process.exit(1)
}
