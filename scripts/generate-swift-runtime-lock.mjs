import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, '..')
const REQUIREMENTS_PATH = path.join(REPOSITORY_ROOT, 'third_party/ms-swift/runtime-requirements.in')
const PROVIDED_PATH = path.join(REPOSITORY_ROOT, 'third_party/ms-swift/runtime-provided.txt')
const OUTPUT_PATH = path.join(REPOSITORY_ROOT, 'third_party/ms-swift/runtime-requirements.lock')

function packageName(requirement) {
  const match = /^([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(requirement)
  if (!match?.[1]) throw new Error(`Invalid provided runtime requirement: ${requirement}`)
  return match[1].toLowerCase()
}

const provided = (await readFile(PROVIDED_PATH, 'utf8'))
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line.length > 0 && !line.startsWith('#'))
  .map(packageName)

if (new Set(provided).size !== provided.length) {
  throw new Error('runtime-provided.txt contains a duplicate package')
}

const arguments_ = [
  'pip',
  'compile',
  REQUIREMENTS_PATH,
  '--python-platform',
  'x86_64-manylinux_2_28',
  '--python-version',
  '3.11',
  '--generate-hashes',
  '--exclude-newer',
  '2026-07-28T00:00:00Z',
  '--custom-compile-command',
  'pnpm swift:lock:generate',
  '--output-file',
  OUTPUT_PATH,
]

for (const dependency of provided) {
  arguments_.push('--no-emit-package', dependency)
}

execFileSync('uv', arguments_, {
  cwd: REPOSITORY_ROOT,
  stdio: 'inherit',
})
