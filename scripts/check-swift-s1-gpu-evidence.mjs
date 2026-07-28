#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, '..')
function inputPath(environmentName, defaultPath) {
  return process.env[environmentName]
    ? path.resolve(process.env[environmentName])
    : path.join(REPOSITORY_ROOT, defaultPath)
}

const LOCK_PATH = inputPath('SWIFT_UPSTREAM_LOCK_PATH', 'third_party/ms-swift/upstream.lock')
const CAPABILITY_PATH = inputPath(
  'SWIFT_CAPABILITY_MANIFEST_PATH',
  'third_party/ms-swift/runtime-capabilities.json',
)
const BASELINE_PATH = inputPath(
  'SWIFT_GRADIO_BASELINE_PATH',
  'third_party/ms-swift/gradio-baseline.json',
)
const FIXTURE_PATH = path.join(REPOSITORY_ROOT, 'scripts/fixtures/swift-s1-gpu-sft.jsonl')
const rawCliArguments = process.argv.slice(2)
const cliArguments = rawCliArguments[0] === '--' ? rawCliArguments.slice(1) : rawCliArguments
const ALLOW_CANDIDATE = cliArguments.includes('--allow-candidate')
const positionalArguments = cliArguments.filter((argument) => argument !== '--allow-candidate')
const evidenceArgument = positionalArguments[0]
const EVIDENCE_PATH = evidenceArgument
  ? path.resolve(evidenceArgument)
  : process.env.SWIFT_S1_GPU_EVIDENCE_PATH
    ? path.resolve(process.env.SWIFT_S1_GPU_EVIDENCE_PATH)
    : null

if (!EVIDENCE_PATH || positionalArguments.length > 1) {
  process.stderr.write(
    'Usage: node scripts/check-swift-s1-gpu-evidence.mjs [--allow-candidate] <output/.../evidence.json>\n',
  )
  process.exit(2)
}

const errors = []

function fail(message) {
  errors.push(message)
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function isSha256(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function isDockerImageId(value) {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value)
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function isPositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0
}

function isNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0
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

function get(value, route, description) {
  let current = value
  for (const part of route.split('.')) current = current?.[part]
  if (current === undefined || current === null) fail(`${description} is missing`)
  return current
}

function walkStrings(value, visit) {
  if (typeof value === 'string') visit(value)
  else if (Array.isArray(value)) {
    for (const item of value) walkStrings(item, visit)
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) walkStrings(item, visit)
  }
}

const [evidenceBytes, lock, capabilities, baseline, fixtureBytes] = await Promise.all([
  readFile(EVIDENCE_PATH),
  readFile(LOCK_PATH, 'utf8').then(JSON.parse),
  readFile(CAPABILITY_PATH, 'utf8').then(JSON.parse),
  readFile(BASELINE_PATH, 'utf8').then(JSON.parse),
  readFile(FIXTURE_PATH),
])
const evidence = JSON.parse(evidenceBytes)
const evidenceDirectory = path.dirname(EVIDENCE_PATH)

if (sha256(await readFile(CAPABILITY_PATH)) !== lock.runtime_target.capability_manifest_sha256)
  fail('tracked capability manifest digest does not match upstream.lock')
if (
  baseline.upstream_commit !== lock.commit ||
  baseline.dependency_count !== baseline.dependencies.length ||
  baseline.dependencies_sha256 !== sha256(Buffer.from(stableJson(baseline.dependencies), 'utf8'))
)
  fail('locked Gradio dependency baseline is inconsistent')

if (evidence.schema_version !== 1) fail('evidence schema_version must be 1')
if (evidence.gate_id !== 'swift-s1-gpu@1') fail('gate_id must be swift-s1-gpu@1')
if (evidence.result !== 'passed') fail('GPU evidence result must be passed')
if (evidence.failure !== null) fail('passed GPU evidence must not retain a failure')
if (!['candidate', 'final'].includes(evidence.proof_stage))
  fail('proof_stage must be candidate or final')

const runtimeCapabilities = new Map(
  capabilities.capabilities.map((capability) => [capability.id, capability]),
)
if (evidence.proof_stage === 'candidate') {
  if (!ALLOW_CANDIDATE)
    fail('candidate evidence cannot close GS1; pass --allow-candidate explicitly')
  if (capabilities.phase !== 'S1-in-progress')
    fail('candidate evidence requires the tracked S1-in-progress manifest')
  if (lock.runtime_target.image_validation_status !== 'cpu-gateway-browser-green-gpu-pending')
    fail('candidate evidence requires the pending runtime image lock')
} else if (evidence.proof_stage === 'final') {
  if (capabilities.phase !== 'S1-complete')
    fail('final evidence requires the tracked S1-complete manifest')
  if (lock.runtime_target.image_validation_status !== 's1-gpu-green')
    fail('final evidence requires the final green runtime image lock')
  for (const id of ['runtime.qwen-small-sft-lora', 'runtime.transformers-lora-infer']) {
    const capability = runtimeCapabilities.get(id)
    if (
      capability?.runtime_installed !== true ||
      capability.runtime_validated !== true ||
      capability.status !== 'green' ||
      capability.evidence.some((entry) => entry.startsWith('planned:'))
    )
      fail(`final evidence requires a validated green capability: ${id}`)
  }
}

const started = Date.parse(evidence.started_at)
const finished = Date.parse(evidence.finished_at)
if (!Number.isFinite(started) || !Number.isFinite(finished) || finished <= started)
  fail('gate timestamps must describe a positive UTC interval')

if (get(evidence, 'host.os', 'host OS') !== 'linux') fail('host OS must be linux')
if (get(evidence, 'host.arch', 'host architecture') !== 'x64') fail('host architecture must be x64')
if (!isNonEmptyString(get(evidence, 'host.kernel', 'host kernel'))) fail('host kernel is empty')
if (!isNonEmptyString(get(evidence, 'host.docker_server_version', 'Docker server version')))
  fail('Docker server version is empty')
if (
  !isNonEmptyString(
    get(evidence, 'host.nvidia_container_toolkit_version', 'NVIDIA Container Toolkit version'),
  )
)
  fail('NVIDIA Container Toolkit version is empty')

const imageId = get(evidence, 'image.id', 'image ID')
const expectedImageId = get(evidence, 'image.expected_id', 'expected image ID')
if (!isDockerImageId(imageId) || imageId !== expectedImageId)
  fail('actual image ID must equal the exact expected sha256 image ID')
if (imageId !== lock.runtime_target.image_id)
  fail('GPU evidence image ID does not match upstream.lock runtime image')
if (get(evidence, 'image.platform', 'image platform') !== 'linux/amd64')
  fail('image platform must be linux/amd64')
if (get(evidence, 'image.user', 'image user') !== '10002:10002')
  fail('image user must be 10002:10002')
if (get(evidence, 'container.product_ports_published', 'product port state') !== false)
  fail('GPU gate container must not publish product ports')
if (get(evidence, 'container.pid_mode', 'container PID namespace') !== 'host')
  fail('GPU PID evidence requires the gate-only host PID namespace')
if (stableJson(get(evidence, 'container.gpu_device_ids', 'container GPU device IDs')) !== '["0"]')
  fail('GPU gate container must expose exactly host device 0')
if (get(evidence, 'container.webui_share', 'WEBUI_SHARE state') !== false)
  fail('GPU gate must keep WEBUI_SHARE=false')
if (get(evidence, 'container.removed_after_gate', 'container cleanup state') !== true)
  fail('GPU gate container must be removed after evidence collection')

const runtime = get(evidence, 'runtime', 'runtime evidence') ?? {}
if (runtime.process_uid !== 10002) fail('runtime process UID must be 10002')
if (runtime.gpu_available !== true || runtime.cuda_available !== true)
  fail('Provider and Torch must both report a CUDA GPU')
if (runtime.ms_swift !== '4.4.2') fail('ms-swift version must be 4.4.2')
if (runtime.gradio !== lock.runtime_target.gradio)
  fail('Gradio version does not match upstream.lock')
if (runtime.transformers !== lock.runtime_target.transformers)
  fail('Transformers version does not match upstream.lock')
if (typeof runtime.torch !== 'string' || !runtime.torch.startsWith(`${lock.runtime_target.torch}+`))
  fail('Torch version does not match upstream.lock')
if (runtime.cuda_runtime !== '12.8') fail('Torch CUDA runtime must be 12.8')
if (runtime.capability_manifest_sha256 !== lock.runtime_target.capability_manifest_sha256)
  fail('runtime capability manifest digest does not match upstream.lock')
if (runtime.capability_manifest_phase !== capabilities.phase)
  fail('Provider runtime capability phase does not match the tracked manifest')

const gpuDevices = get(evidence, 'gpu.devices', 'container GPU devices')
if (!Array.isArray(gpuDevices) || gpuDevices.length !== 1)
  fail('exactly one container GPU is required')
for (const [index, gpu] of (gpuDevices ?? []).entries()) {
  if (!isNonEmptyString(gpu.name)) fail(`GPU ${index} name is missing`)
  if (!isNonEmptyString(gpu.uuid)) fail(`GPU ${index} UUID is missing`)
  if (!isNonEmptyString(gpu.driver_version)) fail(`GPU ${index} driver is missing`)
  if (!isPositiveInteger(gpu.memory_total_mib)) fail(`GPU ${index} total memory is invalid`)
}
if (!isPositiveInteger(get(evidence, 'gpu.peak_memory_used_mib', 'peak GPU memory')))
  fail('peak GPU memory must be a positive integer')
if (!isNonNegativeInteger(get(evidence, 'gpu.idle_baseline_mib', 'idle GPU memory baseline')))
  fail('idle GPU memory baseline must be a non-negative integer')
if (evidence.gpu?.memory_release_tolerance_mib !== 512)
  fail('GPU memory release tolerance must remain 512 MiB')
if (evidence.gpu?.peak_memory_used_mib <= evidence.gpu?.idle_baseline_mib)
  fail('peak GPU memory must exceed the idle gate baseline')
if (get(evidence, 'gpu.container_probe.passed', 'container GPU probe') !== true)
  fail('NVIDIA container probe must pass')
if (evidence.gpu?.container_probe?.device_count !== 1)
  fail('NVIDIA container probe must expose exactly one GPU')

const fixtureLines = fixtureBytes.toString('utf8').trimEnd().split('\n')
if (get(evidence, 'fixture.name', 'fixture name') !== 'swift-s1-gpu-sft.jsonl')
  fail('fixture name has drifted')
if (evidence.fixture?.record_count !== 32 || evidence.fixture.record_count !== fixtureLines.length)
  fail('fixture must contain exactly 32 records')
if (evidence.fixture?.bytes !== fixtureBytes.byteLength)
  fail('fixture byte count does not match source')
if (evidence.fixture?.sha256 !== sha256(fixtureBytes)) fail('fixture digest does not match source')

const allowedModels = new Map([
  ['Qwen/Qwen2.5-0.5B-Instruct', '7ae557604adf67be50417f59c2c2f167def9a775'],
  ['Qwen/Qwen3-0.6B', 'c1899de289a04d12100db370d81485cdf75e47ca'],
])
if (allowedModels.get(evidence.model?.reference) !== evidence.model?.revision)
  fail('base model reference and exact revision are not an approved pair')
if (evidence.model?.hub !== 'huggingface')
  fail('S1 model proof must use the pinned Hugging Face revision')

const parameters = get(evidence, 'training.parameters', 'training parameters') ?? {}
if (evidence.training?.callback?.api_name !== 'train_local')
  fail('training must use the native train_local callback')
if (evidence.training?.process_seen !== true) fail('training must expose a real swift sft process')
if (evidence.training?.gpu_process_seen !== true)
  fail('training must expose the swift sft process tree as a GPU compute process')
if (!isSha256(evidence.training?.pid_starttime_sha256))
  fail('training process identity digest is invalid')
if (evidence.training?.exit_code !== 0 || evidence.training?.terminal !== 'completed')
  fail('training process must exit 0 with terminal=completed')
if (evidence.training?.gate_compute_processes_after !== 0)
  fail('completed training must release its GPU compute processes')
if (
  !isNonNegativeInteger(evidence.training?.memory_after_mib) ||
  evidence.training.memory_after_mib >
    evidence.gpu.idle_baseline_mib + evidence.gpu.memory_release_tolerance_mib
)
  fail('GPU memory after completed training did not return to the accepted baseline')
if (parameters.tuner_type !== 'lora') fail('training tuner_type must be lora')
if (parameters.rank !== 8) fail('LoRA rank must be 8')
if (
  !Number.isSafeInteger(parameters.max_steps) ||
  parameters.max_steps < 2 ||
  parameters.max_steps > 5
)
  fail('completed LoRA max_steps must remain in 2..5')
if (parameters.max_length !== 128) fail('training max_length must be 128')
if (parameters.batch_size !== 1) fail('training batch size must be 1')
if (parameters.gradient_accumulation_steps !== 1) fail('gradient accumulation steps must be 1')
if (parameters.save_steps !== 1) fail('save_steps must be 1')
if (evidence.training?.actual_steps !== parameters.max_steps)
  fail('actual completed steps must equal configured max_steps')
if (!isPositiveInteger(evidence.training?.finite_loss_count))
  fail('training must record at least one finite loss')
if (!Number.isFinite(evidence.training?.final_loss)) fail('training final loss must be finite')
if (evidence.training?.final_loss_step !== evidence.training?.actual_steps)
  fail('training final loss must be recorded at the actual final step')
if (evidence.training?.model_dir_revision_matched !== true)
  fail('training args must resolve the exact model revision')

const adapterFiles = evidence.training?.adapter_files
if (!Array.isArray(adapterFiles) || adapterFiles.length < 2)
  fail('training must record adapter config and safetensors')
if (!(adapterFiles ?? []).some((file) => file.name === 'adapter_config.json'))
  fail('adapter_config.json evidence is missing')
if (!(adapterFiles ?? []).some((file) => /^adapter_model.*\.safetensors$/.test(file.name)))
  fail('adapter safetensors evidence is missing')
for (const file of adapterFiles ?? []) {
  if (!/^[A-Za-z0-9._-]+$/.test(file.name)) fail(`adapter file name is not relative: ${file.name}`)
  if (!isPositiveInteger(file.bytes)) fail(`adapter file byte count is invalid: ${file.name}`)
  if (!isSha256(file.sha256)) fail(`adapter file digest is invalid: ${file.name}`)
}
if (!isSha256(evidence.training?.adapter_bundle_sha256)) fail('adapter bundle digest is invalid')
const adapterNames = (adapterFiles ?? []).map((file) => file.name)
if (new Set(adapterNames).size !== adapterNames.length) fail('adapter file names must be unique')
if (
  stableJson(adapterNames) !==
  stableJson([...adapterNames].sort((left, right) => left.localeCompare(right, 'en')))
)
  fail('adapter files must use stable name ordering')
if (
  Array.isArray(adapterFiles) &&
  evidence.training?.adapter_bundle_sha256 !== sha256(Buffer.from(stableJson(adapterFiles), 'utf8'))
)
  fail('adapter bundle digest does not match adapter file metadata')

if (evidence.stop?.callback?.api_name !== 'kill_task')
  fail('long-task stop must use the native kill_task callback')
if (evidence.stop?.configured_max_steps <= 5)
  fail('stop proof must target a task longer than the completed smoke')
if (evidence.stop?.process_seen !== true) fail('stop proof never saw a live process')
if (evidence.stop?.gpu_process_seen !== true)
  fail('stop proof never saw the task process tree as a GPU compute process')
if (!isSha256(evidence.stop?.pid_starttime_sha256)) fail('stop process identity digest is invalid')
if (evidence.stop?.native_log_observed !== true)
  fail('native Runtime log callback did not produce output')
if (evidence.stop?.process_exited !== true || evidence.stop?.terminal !== 'stopped')
  fail('native stop did not terminate the long task')
if (!isPositiveInteger(evidence.stop?.exit_signal))
  fail('native stop must record a terminating signal')
if (evidence.stop?.gate_compute_processes_after !== 0)
  fail('stopped training task must release its GPU compute process')
if (
  !isNonNegativeInteger(evidence.stop?.memory_after_mib) ||
  evidence.stop.memory_after_mib >
    evidence.gpu.idle_baseline_mib + evidence.gpu.memory_release_tolerance_mib
)
  fail('GPU memory after native stop did not return to the accepted baseline')

if (evidence.infer?.deploy_callback?.api_name !== 'deploy_model')
  fail('Adapter Infer must use the native deploy_model callback')
if (evidence.infer?.message_callback?.api_name !== 'send_message')
  fail('Adapter Infer must use the native send_message callback')
if (evidence.infer?.backend !== 'transformers')
  fail('S1 Adapter Infer backend must be transformers')
if (evidence.infer?.adapter_bundle_sha256 !== evidence.training?.adapter_bundle_sha256)
  fail('Infer did not bind the completed training adapter')
if (evidence.infer?.endpoint_ready !== true) fail('Adapter deployment never became ready')
if (evidence.infer?.gpu_process_seen !== true)
  fail('Adapter deployment must expose its process tree as a GPU compute process')
if (!isSha256(evidence.infer?.pid_starttime_sha256))
  fail('Adapter deployment process identity digest is invalid')
if (!isPositiveInteger(evidence.infer?.response_char_count))
  fail('Adapter Infer response must be non-empty')
if (!isSha256(evidence.infer?.response_sha256)) fail('Adapter Infer response digest is invalid')
if (evidence.infer?.deployment_stopped !== true)
  fail('native Adapter deployment was not stopped after inference')
if (!isPositiveInteger(evidence.infer?.exit_signal))
  fail('native Adapter kill must record a terminating signal')
if (evidence.infer?.gate_compute_processes_after !== 0)
  fail('stopped Adapter deployment must release its GPU compute process')
if (
  !isNonNegativeInteger(evidence.infer?.memory_after_mib) ||
  evidence.infer.memory_after_mib >
    evidence.gpu.idle_baseline_mib + evidence.gpu.memory_release_tolerance_mib
)
  fail('GPU memory after Adapter kill did not return to the accepted baseline')

if (evidence.gradio?.root_path !== '/swift-studio') fail('Gradio root path must be /swift-studio')
if (evidence.gradio?.component_count !== capabilities.compatibility.component_count)
  fail('Gradio component count does not match capability manifest')
if (evidence.gradio?.dependency_count !== capabilities.compatibility.dependency_count)
  fail('Gradio dependency count does not match capability manifest')
for (const callback of [
  'train_local',
  'train_kill_task',
  'train_wait',
  'deploy_model',
  'send_message',
  'infer_kill_task',
]) {
  if (!Number.isSafeInteger(evidence.gradio?.callbacks?.[callback]))
    fail(`Gradio callback evidence is missing: ${callback}`)
}
for (const [description, callback, expectedApiName, gradioKey] of [
  ['training callback', evidence.training?.callback, 'train_local', 'train_local'],
  ['training stop callback', evidence.stop?.callback, 'kill_task', 'train_kill_task'],
  ['training wait callback', evidence.stop?.runtime_log_callback, 'wait', 'train_wait'],
  ['infer deploy callback', evidence.infer?.deploy_callback, 'deploy_model', 'deploy_model'],
  ['infer message callback', evidence.infer?.message_callback, 'send_message', 'send_message'],
  ['infer kill callback', evidence.infer?.kill_callback, 'kill_task_4', 'infer_kill_task'],
]) {
  const matches = baseline.dependencies.filter(
    (dependency) => dependency.api_name === expectedApiName,
  )
  if (matches.length !== 1) {
    fail(`locked Gradio baseline has no unique ${expectedApiName} dependency`)
    continue
  }
  const expected = matches[0]
  if (callback?.api_name !== expected.api_name || callback?.fn_index !== expected.id)
    fail(`${description} does not match the exact locked Gradio dependency`)
  if (evidence.gradio?.callbacks?.[gradioKey] !== expected.id)
    fail(`${description} is not cross-bound to gradio.callbacks.${gradioKey}`)
}
if (evidence.gradio?.send_message_input_count !== 14)
  fail('send_message must retain the 14-input native dependency')
if (evidence.gradio?.send_message_public_input_count !== 13)
  fail('send_message must expose exactly 13 public Gradio Client inputs')
if (evidence.gradio?.send_message_state_input_count !== 1)
  fail('send_message must retain exactly one client-managed Gradio State input')

for (const [name, relativePath] of Object.entries({
  runner: 'scripts/run-swift-s1-gpu-gate.mjs',
  driver: 'scripts/run-swift-s1-gpu-driver.py',
  checker: 'scripts/check-swift-s1-gpu-evidence.mjs',
})) {
  const sourcePath = path.join(REPOSITORY_ROOT, relativePath)
  const sourceBytes = await readFile(sourcePath)
  const source = evidence.provenance?.[name]
  if (source?.path !== relativePath) fail(`${name} provenance path has drifted`)
  if (source?.bytes !== sourceBytes.byteLength) fail(`${name} provenance byte count has drifted`)
  if (source?.sha256 !== sha256(sourceBytes)) fail(`${name} provenance digest has drifted`)
}

const requiredLogs = [
  'training.sanitized.log',
  'stop.sanitized.log',
  'infer.sanitized.log',
  'container.sanitized.log',
]
for (const logName of requiredLogs) {
  const metadata = evidence.logs?.[logName]
  if (!metadata) {
    fail(`required sanitized log is missing: ${logName}`)
    continue
  }
  const bytes = await readFile(path.join(evidenceDirectory, logName)).catch(() => null)
  if (!bytes) {
    fail(`sanitized log file does not exist: ${logName}`)
    continue
  }
  if (bytes.byteLength === 0 || bytes.byteLength > 2 * 1024 * 1024)
    fail(`sanitized log size is outside the 1..2097152 byte range: ${logName}`)
  if (metadata.bytes !== bytes.byteLength) fail(`sanitized log byte count mismatch: ${logName}`)
  if (metadata.sha256 !== sha256(bytes)) fail(`sanitized log digest mismatch: ${logName}`)
  if (!isNonNegativeInteger(metadata.redaction_count))
    fail(`sanitized log redaction count is invalid: ${logName}`)
  const logText = bytes.toString('utf8')
  if (/(authorization|bearer\s|api[_-]?key|access[_-]?token|secret)/i.test(logText))
    fail(`sanitized log contains a credential-shaped token: ${logName}`)
  if (/["'](?:messages|content|prompt)["']\s*:|(?:^|\s)prompt\s*[:=]/im.test(logText))
    fail(`sanitized log contains a Dataset, prompt, or generated-text payload: ${logName}`)
  if (/(^|[\s=:(])\/(?!swift-studio(?:\/|\b))[^\s"']+/m.test(logText))
    fail(`sanitized log contains an absolute path: ${logName}`)
}

walkStrings(evidence, (value) => {
  if (value.startsWith('/') && value !== '/swift-studio')
    fail(`evidence contains an absolute path: ${value.slice(0, 80)}`)
})
const serializedEvidence = evidenceBytes.toString('utf8')
for (const forbidden of ['"messages"', 'dataset_version', 'studio_session_id', 'deployment_id']) {
  if (serializedEvidence.includes(forbidden))
    fail(`S1 evidence contains out-of-scope data: ${forbidden}`)
}

if (errors.length > 0) {
  process.stderr.write(`Swift S1 GPU evidence failed (${errors.length}):\n`)
  for (const error of errors) process.stderr.write(`- ${error}\n`)
  process.exit(1)
}

const successLabel =
  evidence.proof_stage === 'candidate'
    ? 'candidate evidence passed (does not close GS1)'
    : 'final evidence passed'
process.stdout.write(`Swift S1 GPU ${successLabel}: ${EVIDENCE_PATH}\n`)
