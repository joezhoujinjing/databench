#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, '..')
const RUNNER_PATH = fileURLToPath(import.meta.url)
const DRIVER_PATH = path.join(REPOSITORY_ROOT, 'scripts/run-swift-s1-gpu-driver.py')
const FIXTURE_PATH = path.join(REPOSITORY_ROOT, 'scripts/fixtures/swift-s1-gpu-sft.jsonl')
const CHECKER_PATH = path.join(REPOSITORY_ROOT, 'scripts/check-swift-s1-gpu-evidence.mjs')
const LOCK_PATH = path.join(REPOSITORY_ROOT, 'third_party/ms-swift/upstream.lock')
const CAPABILITY_PATH = path.join(REPOSITORY_ROOT, 'third_party/ms-swift/runtime-capabilities.json')
const SWIFT_LOCK = JSON.parse(await readFile(LOCK_PATH, 'utf8'))
const SWIFT_CAPABILITY_BYTES = await readFile(CAPABILITY_PATH)
const SWIFT_CAPABILITIES = JSON.parse(SWIFT_CAPABILITY_BYTES)
const DEFAULT_IMAGE = `${SWIFT_LOCK.runtime_target.image_repository}:${SWIFT_LOCK.runtime_target.image_tag}`
const DEFAULT_IMAGE_ID = SWIFT_LOCK.runtime_target.image_id
const DEFAULT_MODEL = 'Qwen/Qwen2.5-0.5B-Instruct'
const DEFAULT_MODEL_REVISION = '7ae557604adf67be50417f59c2c2f167def9a775'
const DEFAULT_OUTPUT_ROOT = path.join(REPOSITORY_ROOT, 'output/swift-gpu-gate')

function usage() {
  return `Usage: node scripts/run-swift-s1-gpu-gate.mjs [options]

Runs the native ms-swift S1 proof in the exact pinned image. It requires a
Linux/amd64 host, NVIDIA Container Toolkit, and one available NVIDIA GPU.

Options:
  --image <reference>           Local image tag or ID (default: ${DEFAULT_IMAGE})
  --expected-image-id <sha256>  Required docker image ID
  --model <reference>           Approved Qwen fixture model
  --model-revision <commit>     Exact Hugging Face revision
  --steps <2..5>                Completed LoRA steps (default: 2)
  --timeout-minutes <minutes>   Per long operation timeout (default: 60)
  --output-root <directory>     Directory within ignored output/swift-gpu-gate
  --proof-stage <stage>         candidate or final (default: candidate)
  --preflight-only              Validate host, image, and GPU runtime without training
  --help                        Show this help
`
}

function parseArguments(argv) {
  const argumentsToParse = argv[0] === '--' ? argv.slice(1) : argv
  const options = {
    image: DEFAULT_IMAGE,
    expectedImageId: DEFAULT_IMAGE_ID,
    model: DEFAULT_MODEL,
    modelRevision: DEFAULT_MODEL_REVISION,
    steps: 2,
    timeoutMinutes: 60,
    outputRoot: DEFAULT_OUTPUT_ROOT,
    proofStage: 'candidate',
    preflightOnly: false,
  }
  for (let index = 0; index < argumentsToParse.length; index += 1) {
    const argument = argumentsToParse[index]
    if (argument === '--help') {
      process.stdout.write(usage())
      process.exit(0)
    }
    if (argument === '--preflight-only') {
      options.preflightOnly = true
      continue
    }
    const value = argumentsToParse[index + 1]
    if (value === undefined || value.startsWith('--'))
      throw new Error(`${argument} requires a value`)
    index += 1
    if (argument === '--image') options.image = value
    else if (argument === '--expected-image-id') options.expectedImageId = value
    else if (argument === '--model') options.model = value
    else if (argument === '--model-revision') options.modelRevision = value
    else if (argument === '--steps') options.steps = Number(value)
    else if (argument === '--timeout-minutes') options.timeoutMinutes = Number(value)
    else if (argument === '--output-root') options.outputRoot = path.resolve(value)
    else if (argument === '--proof-stage') options.proofStage = value
    else throw new Error(`unknown option: ${argument}`)
  }

  if (!/^[A-Za-z0-9][A-Za-z0-9._/@:-]{0,255}$/.test(options.image))
    throw new Error('image reference has an unsupported form')
  if (!/^sha256:[a-f0-9]{64}$/.test(options.expectedImageId))
    throw new Error('expected image ID must be sha256:<64 lowercase hex>')
  const approvedModels = new Map([
    ['Qwen/Qwen2.5-0.5B-Instruct', '7ae557604adf67be50417f59c2c2f167def9a775'],
    ['Qwen/Qwen3-0.6B', 'c1899de289a04d12100db370d81485cdf75e47ca'],
  ])
  if (approvedModels.get(options.model) !== options.modelRevision)
    throw new Error('model and exact revision are not an approved S1 fixture')
  if (!Number.isSafeInteger(options.steps) || options.steps < 2 || options.steps > 5)
    throw new Error('steps must be an integer in the accepted 2..5 range')
  if (
    !Number.isSafeInteger(options.timeoutMinutes) ||
    options.timeoutMinutes < 10 ||
    options.timeoutMinutes > 240
  )
    throw new Error('timeout-minutes must be an integer in the 10..240 range')
  if (!['candidate', 'final'].includes(options.proofStage))
    throw new Error('proof-stage must be candidate or final')
  if (
    options.outputRoot !== DEFAULT_OUTPUT_ROOT &&
    !options.outputRoot.startsWith(`${DEFAULT_OUTPUT_ROOT}${path.sep}`)
  )
    throw new Error('output-root must stay within ignored output/swift-gpu-gate')
  return options
}

function pathIsWithin(parent, candidate) {
  return candidate === parent || candidate.startsWith(`${parent}${path.sep}`)
}

export async function prepareEvidenceOutputRoot(outputRoot) {
  const normalized = path.resolve(outputRoot)
  if (!pathIsWithin(DEFAULT_OUTPUT_ROOT, normalized))
    throw new Error('output-root must stay within ignored output/swift-gpu-gate')

  const relativeToRepository = path.relative(REPOSITORY_ROOT, normalized)
  if (
    relativeToRepository === '' ||
    relativeToRepository.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeToRepository)
  ) {
    throw new Error('output-root must stay within the repository evidence boundary')
  }
  let cursor = REPOSITORY_ROOT
  for (const segment of relativeToRepository.split(path.sep)) {
    cursor = path.join(cursor, segment)
    let metadata
    try {
      metadata = await lstat(cursor)
    } catch (error) {
      if (error?.code === 'ENOENT') break
      throw error
    }
    if (metadata.isSymbolicLink())
      throw new Error('output-root must not contain symbolic-link components')
    if (!metadata.isDirectory()) throw new Error('output-root components must be directories')
  }

  await mkdir(normalized, { recursive: true })
  const [defaultRealRoot, outputRealRoot] = await Promise.all([
    realpath(DEFAULT_OUTPUT_ROOT),
    realpath(normalized),
  ])
  if (!pathIsWithin(defaultRealRoot, outputRealRoot))
    throw new Error('output-root resolved outside ignored output/swift-gpu-gate')
  return outputRealRoot
}

export function command(argv, options = {}) {
  const result = spawnSync(argv[0], argv.slice(1), {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: options.timeout,
    env: options.env ?? process.env,
  })
  if (result.error && !options.allowFailure) throw result.error
  if (!options.allowFailure && result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim()
    throw new Error(`${argv[0]} failed with exit ${result.status}: ${detail.slice(-4000)}`)
  }
  return result
}

export function optionalCommand(candidates) {
  for (const argv of candidates) {
    const result = command(argv, { allowFailure: true })
    if (result.status === 0 && result.stdout.trim()) return result.stdout.trim()
  }
  return null
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function parseGpuRows(text) {
  return text
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const fields = line.split(',').map((field) => field.trim())
      if (fields.length !== 5) throw new Error('unexpected nvidia-smi GPU row')
      const [index, name, uuid, driverVersion, memoryTotalMib] = fields
      return {
        index: Number(index),
        name,
        uuid,
        driver_version: driverVersion,
        memory_total_mib: Number(memoryTotalMib),
      }
    })
}

function inspectImage(reference, expectedId) {
  const documents = JSON.parse(command(['docker', 'image', 'inspect', reference]).stdout)
  if (!Array.isArray(documents) || documents.length !== 1)
    throw new Error('image inspect was ambiguous')
  const image = documents[0]
  if (image.Id !== expectedId)
    throw new Error(`image ID mismatch: expected ${expectedId}, found ${image.Id}`)
  const platform = `${image.Os}/${image.Architecture}`
  if (platform !== 'linux/amd64')
    throw new Error(`image platform must be linux/amd64, found ${platform}`)
  if (image.Config?.User !== '10002:10002')
    throw new Error(
      `image process user must be 10002:10002, found ${image.Config?.User || '<root>'}`,
    )
  return { id: image.Id, platform, user: image.Config.User }
}

function preflight(options) {
  if (process.platform !== 'linux')
    throw new Error(`S1 GPU gate requires Linux; current platform is ${process.platform}`)
  if (process.arch !== 'x64')
    throw new Error(`S1 GPU gate requires amd64; current architecture is ${process.arch}`)

  const dockerVersion = command([
    'docker',
    'version',
    '--format',
    '{{.Server.Version}}',
  ]).stdout.trim()
  const toolkitVersion = optionalCommand([
    ['nvidia-container-toolkit', '--version'],
    ['nvidia-container-cli', '--version'],
  ])
  if (!toolkitVersion) throw new Error('NVIDIA Container Toolkit version could not be determined')
  const gpuQuery = [
    'nvidia-smi',
    '--query-gpu=index,name,uuid,driver_version,memory.total',
    '--format=csv,noheader,nounits',
  ]
  const hostGpus = parseGpuRows(command(gpuQuery).stdout)
  if (hostGpus.length === 0) throw new Error('host nvidia-smi returned no GPU')
  const image = inspectImage(options.image, options.expectedImageId)

  const probeCode = [
    'import json, torch',
    'assert torch.cuda.is_available()',
    "print(json.dumps({'torch': torch.__version__, 'cuda': torch.version.cuda, 'devices': torch.cuda.device_count()}))",
  ].join('; ')
  const probe = command([
    'docker',
    'run',
    '--rm',
    '--gpus',
    'device=0',
    '--entrypoint',
    'python',
    image.id,
    '-c',
    probeCode,
  ])
  const containerGpu = JSON.parse(probe.stdout.trim().split('\n').at(-1))
  if (containerGpu.devices !== 1)
    throw new Error(
      `GPU container probe must expose exactly one device, found ${containerGpu.devices}`,
    )

  return {
    host: {
      os: process.platform,
      arch: process.arch,
      kernel: command(['uname', '-r']).stdout.trim(),
      hostname_sha256: sha256(Buffer.from(os.hostname())),
      docker_server_version: dockerVersion,
      nvidia_container_toolkit_version: toolkitVersion.split('\n')[0].slice(0, 200),
    },
    image,
    gpu: {
      host_devices: hostGpus,
      container_probe: {
        passed: true,
        torch: containerGpu.torch,
        cuda_runtime: containerGpu.cuda,
        device_count: containerGpu.devices,
      },
    },
  }
}

async function waitForProvider(containerName, timeoutSeconds = 180) {
  const deadline = Date.now() + timeoutSeconds * 1000
  const probe = [
    'import urllib.request',
    "urllib.request.urlopen('http://127.0.0.1:7861/health', timeout=3).read()",
  ].join('; ')
  while (Date.now() < deadline) {
    const result = command(['docker', 'exec', containerName, 'python', '-c', probe], {
      allowFailure: true,
    })
    if (result.status === 0) return
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
  throw new Error('Swift Studio Provider did not become healthy')
}

const SENSITIVE_LOG =
  /(authorization|bearer\s|api[_-]?key|access[_-]?token|secret|["'](?:messages|content|prompt)["']\s*:|(?:^|\s)prompt\s*[:=])/i
const USEFUL_CONTAINER_LOG =
  /(swift|gradio|provider|train|step|loss|adapter|lora|cuda|gpu|memory|model|server|started|running|ready|loaded|saving|checkpoint|error|exception)/i

function sanitizeDiagnostic(raw) {
  if (SENSITIVE_LOG.test(raw)) return '<sensitive diagnostic redacted>'
  return raw
    .replaceAll('/var/lib/databench-swift-studio', '<workspace>')
    .replace(/(^|[\s=:(])\/(?!swift-studio(?:\/|\b))[^\s"']+/gm, '$1<path>')
    .replace(/((?:token|password|secret|api[_-]?key)\s*[=:]\s*)\S+/gi, '$1<redacted>')
    .slice(-4000)
}

export function sanitizeContainerLog(raw) {
  let redactionCount = 0
  const lines = []
  for (const original of raw.split('\n').slice(-4000)) {
    if (!original) continue
    if (SENSITIVE_LOG.test(original)) {
      redactionCount += 1
      continue
    }
    if (!USEFUL_CONTAINER_LOG.test(original)) continue
    let line = original.replaceAll('/var/lib/databench-swift-studio', '<workspace>')
    if (line !== original) redactionCount += 1
    line = line.replace(/(^|[\s=:(])\/(?!swift-studio(?:\/|\b))[^\s"']+/g, (...parts) => {
      redactionCount += 1
      return `${parts[1]}<path>`
    })
    line = line.replace(
      /((?:token|password|secret|api[_-]?key)\s*[=:]\s*)\S+/gi,
      (_match, prefix) => {
        redactionCount += 1
        return `${prefix}<redacted>`
      },
    )
    lines.push(line.slice(0, 2000))
    if (lines.length === 1000) break
  }
  return { text: `${lines.join('\n')}\n`, redactionCount }
}

async function sourceProvenance() {
  const sources = {
    runner: ['scripts/run-swift-s1-gpu-gate.mjs', RUNNER_PATH],
    driver: ['scripts/run-swift-s1-gpu-driver.py', DRIVER_PATH],
    checker: ['scripts/check-swift-s1-gpu-evidence.mjs', CHECKER_PATH],
  }
  return Object.fromEntries(
    await Promise.all(
      Object.entries(sources).map(async ([name, [relativePath, filePath]]) => {
        const bytes = await readFile(filePath)
        return [name, { path: relativePath, bytes: bytes.byteLength, sha256: sha256(bytes) }]
      }),
    ),
  )
}

function containerIsConfirmedAbsent(result) {
  return (
    !result.error &&
    result.status !== 0 &&
    /No such (?:object|container)/i.test(`${result.stderr ?? ''}\n${result.stdout ?? ''}`)
  )
}

export function removeAndConfirmContainer(containerName, execute = command) {
  const removal = execute(['docker', 'rm', '-f', containerName], { allowFailure: true })
  const inspection = execute(['docker', 'container', 'inspect', containerName], {
    allowFailure: true,
  })
  return {
    removed: removal.status === 0 && containerIsConfirmedAbsent(inspection),
    removalStatus: removal.status,
    inspectionStatus: inspection.status,
  }
}

export function inspectGateContainer(containerName, execute = command) {
  const result = execute(['docker', 'container', 'inspect', containerName])
  const documents = JSON.parse(result.stdout)
  if (!Array.isArray(documents) || documents.length !== 1)
    throw new Error('gate container inspect was ambiguous')
  const container = documents[0]
  if (container.HostConfig?.PidMode !== 'host')
    throw new Error('GPU PID proof requires the gate-only container to use the host PID namespace')
  const deviceRequests = container.HostConfig?.DeviceRequests
  if (
    !Array.isArray(deviceRequests) ||
    deviceRequests.length !== 1 ||
    JSON.stringify(deviceRequests[0]?.DeviceIDs) !== JSON.stringify(['0'])
  ) {
    throw new Error('gate container must request exactly host GPU device 0')
  }
  const productPortsPublished = Object.values(container.NetworkSettings?.Ports ?? {}).some(
    (bindings) => Array.isArray(bindings) && bindings.length > 0,
  )
  if (productPortsPublished) throw new Error('gate container must not publish product ports')
  return {
    pidMode: 'host',
    gpuDeviceIds: ['0'],
    productPortsPublished: false,
  }
}

function appendError(primary, label, error) {
  if (!error) return primary
  const detail = sanitizeDiagnostic(error instanceof Error ? error.message : String(error))
  return primary
    ? new Error(`${sanitizeDiagnostic(primary.message)}\n${label}: ${detail}`)
    : new Error(`${label}: ${detail}`)
}

async function collectContainerEvidence(containerName, outputDirectory) {
  const logs = command(['docker', 'logs', containerName], { allowFailure: true })
  if (logs.status !== 0 || logs.error)
    throw new Error(`docker logs failed with exit ${logs.status ?? 'spawn-error'}`)
  const sanitized = sanitizeContainerLog(`${logs.stdout}\n${logs.stderr}`)
  await writeFile(path.join(outputDirectory, 'container.sanitized.log'), sanitized.text, 'utf8')
  if (!(await readFile(path.join(outputDirectory, 'driver-evidence.json')).catch(() => null))) {
    const copy = command(
      [
        'docker',
        'cp',
        `${containerName}:/var/lib/databench-swift-studio/evidence/gs1-gpu-gate/.`,
        outputDirectory,
      ],
      { allowFailure: true },
    )
    if (copy.status !== 0 || copy.error)
      throw new Error(`final evidence collection failed with exit ${copy.status ?? 'spawn-error'}`)
  }
  return sanitized.redactionCount
}

function validateProofStage(stage) {
  if (sha256(SWIFT_CAPABILITY_BYTES) !== SWIFT_LOCK.runtime_target.capability_manifest_sha256)
    throw new Error('tracked capability manifest digest does not match upstream.lock')
  const runtimeCapabilities = new Map(
    SWIFT_CAPABILITIES.capabilities.map((capability) => [capability.id, capability]),
  )
  if (stage === 'candidate') {
    if (
      SWIFT_CAPABILITIES.phase !== 'S1-in-progress' ||
      SWIFT_LOCK.runtime_target.image_validation_status !== 'cpu-gateway-browser-green-gpu-pending'
    )
      throw new Error(
        'candidate proof requires the tracked S1-in-progress manifest and pending image',
      )
    return
  }
  if (
    SWIFT_CAPABILITIES.phase !== 'S1-complete' ||
    SWIFT_LOCK.runtime_target.image_validation_status !== 's1-gpu-green'
  )
    throw new Error(
      'final proof requires the tracked S1-complete manifest and final green image lock',
    )
  for (const id of ['runtime.qwen-small-sft-lora', 'runtime.transformers-lora-infer']) {
    const capability = runtimeCapabilities.get(id)
    if (
      capability?.runtime_installed !== true ||
      capability.runtime_validated !== true ||
      capability.status !== 'green' ||
      capability.evidence.some((entry) => entry.startsWith('planned:'))
    )
      throw new Error(`final proof requires a validated green capability: ${id}`)
  }
}

function evidenceMarkdown(evidence) {
  const gpu = evidence.gpu?.devices?.[0]
  return `# Swift S1 GPU gate

- Result: \`${evidence.result}\`
- Proof stage: \`${evidence.proof_stage}\`
- Gate: \`${evidence.gate_id}\`
- Started: \`${evidence.started_at}\`
- Finished: \`${evidence.finished_at}\`
- Image: \`${evidence.image?.id ?? 'unavailable'}\`
- GPU: \`${gpu?.name ?? 'unavailable'}\` / driver \`${gpu?.driver_version ?? 'unavailable'}\`
- Model: \`${evidence.model?.reference ?? 'unavailable'}@${evidence.model?.revision ?? 'unavailable'}\`
- Fixture: \`${evidence.fixture?.record_count ?? 0}\` records / \`${evidence.fixture?.sha256 ?? 'unavailable'}\`
- LoRA: \`${evidence.training?.actual_steps ?? 0}\` steps / adapter \`${evidence.training?.adapter_bundle_sha256 ?? 'unavailable'}\`
- Native stop: \`${evidence.stop?.terminal ?? 'unavailable'}\`
- Adapter Infer response: \`${evidence.infer?.response_char_count ?? 0}\` chars / \`${evidence.infer?.response_sha256 ?? 'unavailable'}\`

This artifact intentionally omits Dataset payloads, prompts, generated text, absolute paths, credentials, and raw argv.
`
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  validateProofStage(options.proofStage)
  const realOutputRoot = await prepareEvidenceOutputRoot(options.outputRoot)
  const preflightEvidence = preflight(options)
  if (options.preflightOnly) {
    process.stdout.write(
      `${JSON.stringify({ gate_id: 'swift-s1-gpu@1', preflight: 'passed', ...preflightEvidence }, null, 2)}\n`,
    )
    return
  }

  const fixture = await readFile(FIXTURE_PATH)
  if (fixture.toString('utf8').trimEnd().split('\n').length !== 32)
    throw new Error('committed GPU fixture must contain exactly 32 records')

  const runId = `${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${randomBytes(4).toString('hex')}`
  const containerName = `databench-swift-s1-gpu-${randomBytes(6).toString('hex')}`
  const outputDirectory = path.join(options.outputRoot, runId)
  await mkdir(outputDirectory)
  const realOutputDirectory = await realpath(outputDirectory)
  if (!pathIsWithin(realOutputRoot, realOutputDirectory))
    throw new Error('run evidence directory resolved outside the approved output root')
  const provenance = await sourceProvenance()
  let containerCreationAttempted = false
  let containerCreated = false
  let containerRemoved = false
  let containerRuntime = null
  let containerLogRedactionCount = null
  let driverResult = null
  let primaryError = null
  try {
    containerCreationAttempted = true
    command([
      'docker',
      'run',
      '-d',
      '--name',
      containerName,
      '--gpus',
      'device=0',
      '--pid',
      'host',
      '--init',
      '--label',
      'io.databench.gate=swift-s1-gpu@1',
      '--env',
      'USE_HF=1',
      '--env',
      'WEBUI_SHARE=false',
      '--env',
      `DATABENCH_SWIFT_GATE_MODEL=${options.model}`,
      '--env',
      `DATABENCH_SWIFT_GATE_MODEL_REVISION=${options.modelRevision}`,
      '--env',
      `DATABENCH_SWIFT_GATE_STEPS=${options.steps}`,
      '--env',
      `DATABENCH_SWIFT_GATE_TIMEOUT_SECONDS=${options.timeoutMinutes * 60}`,
      '--mount',
      `type=bind,src=${DRIVER_PATH},dst=/opt/databench-gate/run-swift-s1-gpu-driver.py,readonly`,
      '--mount',
      `type=bind,src=${FIXTURE_PATH},dst=/var/lib/databench-swift-studio/inputs/gs1-sft.jsonl,readonly`,
      preflightEvidence.image.id,
    ])
    containerCreated = true
    containerRuntime = inspectGateContainer(containerName)
    await waitForProvider(containerName)
    driverResult = command(
      ['docker', 'exec', containerName, 'python', '/opt/databench-gate/run-swift-s1-gpu-driver.py'],
      {
        allowFailure: true,
        timeout: (options.timeoutMinutes * 3 + 30) * 60 * 1000,
      },
    )
    command([
      'docker',
      'cp',
      `${containerName}:/var/lib/databench-swift-studio/evidence/gs1-gpu-gate/.`,
      outputDirectory,
    ])
    if (driverResult.status !== 0) {
      throw new Error(`in-container GPU proof failed: ${driverResult.stderr.slice(-4000)}`)
    }
  } catch (error) {
    primaryError = error
  } finally {
    let collectionError = null
    let cleanupError = null
    const beforeCleanup = containerCreationAttempted
      ? command(['docker', 'container', 'inspect', containerName], { allowFailure: true })
      : null
    const containerExists = beforeCleanup?.status === 0
    if (containerExists) {
      try {
        containerLogRedactionCount = await collectContainerEvidence(containerName, outputDirectory)
      } catch (error) {
        collectionError = error
      } finally {
        const cleanup = removeAndConfirmContainer(containerName)
        containerRemoved = cleanup.removed
        if (!containerRemoved)
          cleanupError = new Error(
            `exact container cleanup was not confirmed (rm=${cleanup.removalStatus ?? 'spawn-error'}, inspect=${cleanup.inspectionStatus ?? 'spawn-error'})`,
          )
      }
    } else if (beforeCleanup && containerIsConfirmedAbsent(beforeCleanup)) {
      containerRemoved = true
      if (containerCreated)
        cleanupError = new Error('created gate container disappeared before evidence collection')
    } else if (containerCreationAttempted) {
      cleanupError = new Error('gate container state could not be inspected during cleanup')
    }
    primaryError = appendError(primaryError, 'evidence collection failed', collectionError)
    primaryError = appendError(primaryError, 'container cleanup failed', cleanupError)
  }

  const driverPath = path.join(outputDirectory, 'driver-evidence.json')
  const driverEvidenceBytes = await readFile(driverPath).catch(() => null)
  const containerLog = await readFile(path.join(outputDirectory, 'container.sanitized.log')).catch(
    () => null,
  )
  if (driverEvidenceBytes && containerLog && Number.isSafeInteger(containerLogRedactionCount)) {
    const evidence = JSON.parse(driverEvidenceBytes)
    evidence.proof_stage = options.proofStage
    evidence.provenance = provenance
    evidence.host = preflightEvidence.host
    evidence.image = {
      reference: options.image,
      expected_id: options.expectedImageId,
      ...preflightEvidence.image,
    }
    evidence.gpu = {
      ...evidence.gpu,
      host_devices: preflightEvidence.gpu.host_devices,
      container_probe: preflightEvidence.gpu.container_probe,
    }
    evidence.container = {
      name_sha256: sha256(Buffer.from(containerName)),
      pid_mode: containerRuntime?.pidMode ?? null,
      gpu_device_ids: containerRuntime?.gpuDeviceIds ?? null,
      product_ports_published: containerRuntime?.productPortsPublished ?? null,
      webui_share: false,
      removed_after_gate: containerRemoved,
    }
    evidence.logs['container.sanitized.log'] = {
      bytes: containerLog.byteLength,
      sha256: sha256(containerLog),
      redaction_count: containerLogRedactionCount,
    }
    await writeFile(
      path.join(outputDirectory, 'evidence.json'),
      `${JSON.stringify(evidence, null, 2)}\n`,
      'utf8',
    )
    await writeFile(path.join(outputDirectory, 'README.md'), evidenceMarkdown(evidence), 'utf8')
    if (!primaryError && evidence.result === 'passed') {
      command([
        process.execPath,
        CHECKER_PATH,
        ...(options.proofStage === 'candidate' ? ['--allow-candidate'] : []),
        path.join(outputDirectory, 'evidence.json'),
      ])
    }
  } else if (!primaryError) {
    primaryError = new Error('GPU driver produced no complete structured evidence bundle')
  }

  if (primaryError) {
    throw new Error(
      `${sanitizeDiagnostic(primaryError.message)}\nPartial evidence: ${outputDirectory}`,
    )
  }
  const stageMessage =
    options.proofStage === 'candidate' ? 'candidate passed (does not close GS1)' : 'final passed'
  process.stdout.write(`Swift S1 GPU gate ${stageMessage}: ${outputDirectory}\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`Swift S1 GPU gate failed: ${sanitizeDiagnostic(error.message)}\n`)
    process.exitCode = 1
  })
}
