import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import test from 'node:test'

import {
  inspectGateContainer,
  optionalCommand,
  prepareEvidenceOutputRoot,
  removeAndConfirmContainer,
  sanitizeContainerLog,
} from './run-swift-s1-gpu-gate.mjs'

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, '..')
const RUNNER = path.join(REPOSITORY_ROOT, 'scripts/run-swift-s1-gpu-gate.mjs')

test('accepts the pnpm argument separator before a flag', () => {
  const result = spawnSync(process.execPath, [RUNNER, '--', '--help'], {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
  })

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, /Usage: node scripts\/run-swift-s1-gpu-gate\.mjs/)
  assert.match(result.stdout, /--preflight-only/)
})

test('falls back when the first optional executable is not installed', () => {
  const output = optionalCommand([
    ['databench-command-that-does-not-exist', '--version'],
    [process.execPath, '-e', "process.stdout.write('fallback-version')"],
  ])

  assert.equal(output, 'fallback-version')
})

test('rejects a final proof while the tracked manifest is still a candidate', () => {
  const result = spawnSync(
    process.execPath,
    [RUNNER, '--proof-stage', 'final', '--preflight-only'],
    { cwd: REPOSITORY_ROOT, encoding: 'utf8' },
  )

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /final proof requires the tracked S1-complete manifest/)
})

test('rejects an evidence root outside the ignored Swift gate directory', () => {
  const result = spawnSync(
    process.execPath,
    [RUNNER, '--output-root', path.join(REPOSITORY_ROOT, 'outside-output'), '--preflight-only'],
    { cwd: REPOSITORY_ROOT, encoding: 'utf8' },
  )

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /output-root must stay within ignored output\/swift-gpu-gate/)
})

test('rejects a symbolic-link evidence root inside the ignored directory', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'databench-swift-output-target-'))
  const link = path.join(
    REPOSITORY_ROOT,
    'output/swift-gpu-gate',
    `test-symlink-${path.basename(temporaryRoot)}`,
  )
  try {
    await mkdir(path.dirname(link), { recursive: true })
    await symlink(temporaryRoot, link)
    await assert.rejects(
      prepareEvidenceOutputRoot(link),
      /output-root must not contain symbolic-link components/,
    )
  } finally {
    await rm(link, { force: true })
    await rm(temporaryRoot, { recursive: true, force: true })
  }
})

test('requires the gate container host PID namespace and exact GPU device', () => {
  const inspect = (pidMode = 'host', deviceIds = ['0'], published = false) =>
    inspectGateContainer('exact-container', () => ({
      status: 0,
      stderr: '',
      stdout: JSON.stringify([
        {
          HostConfig: {
            PidMode: pidMode,
            DeviceRequests: [{ DeviceIDs: deviceIds }],
          },
          NetworkSettings: {
            Ports: {
              '7860/tcp': published ? [{ HostIp: '127.0.0.1', HostPort: '17860' }] : null,
              '7861/tcp': null,
            },
          },
        },
      ]),
    }))

  assert.deepEqual(inspect(), {
    pidMode: 'host',
    gpuDeviceIds: ['0'],
    productPortsPublished: false,
  })
  assert.throws(() => inspect(''), /host PID namespace/)
  assert.throws(() => inspect('host', ['1']), /exactly host GPU device 0/)
  assert.throws(() => inspect('host', ['0'], true), /must not publish product ports/)
})

test('marks exact cleanup complete only after rm and confirmed absence', () => {
  const calls = []
  const result = removeAndConfirmContainer('exact-container', (argv) => {
    calls.push(argv)
    if (argv[1] === 'rm') return { status: 0, stdout: '', stderr: '', error: undefined }
    return { status: 1, stdout: '', stderr: 'Error: No such object', error: undefined }
  })

  assert.equal(result.removed, true)
  assert.deepEqual(calls, [
    ['docker', 'rm', '-f', 'exact-container'],
    ['docker', 'container', 'inspect', 'exact-container'],
  ])
})

test('does not claim cleanup when docker rm fails', () => {
  const result = removeAndConfirmContainer('exact-container', (argv) =>
    argv[1] === 'rm'
      ? { status: 1, stdout: '', stderr: 'daemon error', error: undefined }
      : { status: 1, stdout: '', stderr: 'Error: No such object', error: undefined },
  )

  assert.equal(result.removed, false)
})

test('redacts payload-shaped lines and absolute paths from container logs', () => {
  const result = sanitizeContainerLog(
    "swift {'messages': [{'content': 'private'}]}\nprovider loaded model from /opt/private/model\n",
  )

  assert.doesNotMatch(result.text, /messages|content|private\/model/)
  assert.match(result.text, /provider loaded model from <path>/)
  assert.ok(result.redactionCount >= 2)
})
