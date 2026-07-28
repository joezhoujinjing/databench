import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, '..')
const CHECKER = path.join(REPOSITORY_ROOT, 'scripts/check-swift-s1-gpu-evidence.mjs')
const FIXTURE = path.join(REPOSITORY_ROOT, 'scripts/fixtures/swift-s1-gpu-sft.jsonl')
const CAPABILITY_DIGEST = 'd5d103922d96cf861bb1f4eddd8d2d2681b2c0670946aff3bee1dad6d97037ca'
const IMAGE_ID = 'sha256:09207c761906d5a2dae7e9a6dfd58fe963a6c3047cd9a2eb6f102632fc4d8108'

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
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

async function provenance() {
  const sources = {
    runner: 'scripts/run-swift-s1-gpu-gate.mjs',
    driver: 'scripts/run-swift-s1-gpu-driver.py',
    checker: 'scripts/check-swift-s1-gpu-evidence.mjs',
  }
  return Object.fromEntries(
    await Promise.all(
      Object.entries(sources).map(async ([name, relativePath]) => {
        const bytes = await readFile(path.join(REPOSITORY_ROOT, relativePath))
        return [name, { path: relativePath, bytes: bytes.byteLength, sha256: sha256(bytes) }]
      }),
    ),
  )
}

async function validEvidence(directory) {
  const fixture = await readFile(FIXTURE)
  const adapterFiles = [
    { name: 'adapter_config.json', bytes: 500, sha256: '3'.repeat(64) },
    { name: 'adapter_model.safetensors', bytes: 1024, sha256: '4'.repeat(64) },
  ]
  const adapterBundleSha256 = sha256(Buffer.from(stableJson(adapterFiles), 'utf8'))
  const logs = {}
  for (const name of [
    'training.sanitized.log',
    'stop.sanitized.log',
    'infer.sanitized.log',
    'container.sanitized.log',
  ]) {
    const bytes = Buffer.from(`validated ${name}\n`)
    await writeFile(path.join(directory, name), bytes)
    logs[name] = { bytes: bytes.byteLength, sha256: sha256(bytes), redaction_count: 0 }
  }
  return {
    schema_version: 1,
    gate_id: 'swift-s1-gpu@1',
    proof_stage: 'candidate',
    started_at: '2026-07-28T00:00:00Z',
    finished_at: '2026-07-28T00:10:00Z',
    result: 'passed',
    failure: null,
    provenance: await provenance(),
    host: {
      os: 'linux',
      arch: 'x64',
      kernel: '6.8.0',
      hostname_sha256: '1'.repeat(64),
      docker_server_version: '28.0.0',
      nvidia_container_toolkit_version: '1.17.8',
    },
    image: {
      reference: 'databench/swift-studio:4.4.2',
      expected_id: IMAGE_ID,
      id: IMAGE_ID,
      platform: 'linux/amd64',
      user: '10002:10002',
    },
    container: {
      name_sha256: '2'.repeat(64),
      pid_mode: 'host',
      gpu_device_ids: ['0'],
      product_ports_published: false,
      webui_share: false,
      removed_after_gate: true,
    },
    runtime: {
      process_uid: 10002,
      python: '3.11.15',
      torch: '2.8.0+cu128',
      cuda_runtime: '12.8',
      transformers: '4.57.6',
      gradio: '5.50.0',
      ms_swift: '4.4.2',
      gpu_available: true,
      cuda_available: true,
      capability_manifest_phase: 'S1-in-progress',
      capability_manifest_sha256: CAPABILITY_DIGEST,
    },
    gpu: {
      devices: [
        {
          index: 0,
          name: 'NVIDIA L4',
          uuid: 'GPU-00000000-0000-0000-0000-000000000000',
          driver_version: '570.00',
          memory_total_mib: 23034,
          memory_used_mib: 100,
        },
      ],
      idle_baseline_mib: 100,
      memory_release_tolerance_mib: 512,
      peak_memory_used_mib: 4096,
      host_devices: [
        {
          index: 0,
          name: 'NVIDIA L4',
          uuid: 'GPU-00000000-0000-0000-0000-000000000000',
          driver_version: '570.00',
          memory_total_mib: 23034,
        },
      ],
      container_probe: {
        passed: true,
        torch: '2.8.0+cu128',
        cuda_runtime: '12.8',
        device_count: 1,
      },
    },
    fixture: {
      name: 'swift-s1-gpu-sft.jsonl',
      record_count: 32,
      bytes: fixture.byteLength,
      sha256: sha256(fixture),
    },
    model: {
      reference: 'Qwen/Qwen2.5-0.5B-Instruct',
      revision: '7ae557604adf67be50417f59c2c2f167def9a775',
      hub: 'huggingface',
    },
    gradio: {
      root_path: '/swift-studio',
      version: '5.50.0',
      component_count: 1006,
      dependency_count: 115,
      callbacks: {
        train_local: 8,
        train_kill_task: 12,
        train_wait: 2,
        deploy_model: 77,
        send_message: 78,
        infer_kill_task: 81,
      },
      send_message_input_count: 14,
      send_message_public_input_count: 13,
      send_message_state_input_count: 1,
    },
    training: {
      callback: { api_name: 'train_local', fn_index: 8 },
      process_seen: true,
      gpu_process_seen: true,
      pid_starttime_sha256: '7'.repeat(64),
      exit_code: 0,
      terminal: 'completed',
      gate_compute_processes_after: 0,
      memory_after_mib: 125,
      parameters: {
        tuner_type: 'lora',
        rank: 8,
        max_steps: 2,
        max_length: 128,
        batch_size: 1,
        gradient_accumulation_steps: 1,
        save_steps: 1,
      },
      actual_steps: 2,
      finite_loss_count: 2,
      final_loss: 1.25,
      final_loss_step: 2,
      model_dir_revision_matched: true,
      adapter_files: adapterFiles,
      adapter_bundle_sha256: adapterBundleSha256,
    },
    stop: {
      callback: { api_name: 'kill_task', fn_index: 12 },
      runtime_log_callback: { api_name: 'wait', fn_index: 2 },
      configured_max_steps: 1000,
      process_seen: true,
      gpu_process_seen: true,
      pid_starttime_sha256: '8'.repeat(64),
      native_log_observed: true,
      process_exited: true,
      exit_signal: 9,
      gate_compute_processes_after: 0,
      memory_after_mib: 120,
      terminal: 'stopped',
    },
    infer: {
      deploy_callback: { api_name: 'deploy_model', fn_index: 77 },
      message_callback: { api_name: 'send_message', fn_index: 78 },
      kill_callback: { api_name: 'kill_task_4', fn_index: 81 },
      backend: 'transformers',
      adapter_bundle_sha256: adapterBundleSha256,
      endpoint_ready: true,
      gpu_process_seen: true,
      pid_starttime_sha256: '9'.repeat(64),
      response_char_count: 5,
      response_sha256: '6'.repeat(64),
      exit_signal: 9,
      gate_compute_processes_after: 0,
      memory_after_mib: 115,
      deployment_stopped: true,
    },
    logs,
  }
}

async function expectResult(
  mutate,
  status,
  expected,
  separator = false,
  allowCandidate = true,
  environment = {},
) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'databench-swift-gpu-evidence-'))
  try {
    const evidence = await validEvidence(directory)
    mutate(evidence)
    const evidencePath = path.join(directory, 'evidence.json')
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
    const result = spawnSync(
      process.execPath,
      [
        CHECKER,
        ...(separator ? ['--'] : []),
        ...(allowCandidate ? ['--allow-candidate'] : []),
        evidencePath,
      ],
      {
        cwd: REPOSITORY_ROOT,
        env: { ...process.env, ...environment },
        encoding: 'utf8',
      },
    )
    assert.equal(result.status, status, `${result.stdout}\n${result.stderr}`)
    assert.match(`${result.stdout}\n${result.stderr}`, expected)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test('accepts a complete S1 Linux/NVIDIA evidence bundle', async () => {
  await expectResult(() => {}, 0, /candidate evidence passed \(does not close GS1\)/)
})

test('accepts the pnpm argument separator before the evidence path', async () => {
  await expectResult(() => {}, 0, /candidate evidence passed \(does not close GS1\)/, true)
})

test('rejects candidate evidence as final without an explicit allowance', async () => {
  await expectResult(() => {}, 1, /candidate evidence cannot close GS1/, false, false)
})

test('accepts final evidence only with a tracked final manifest and image lock', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'databench-swift-gpu-final-'))
  try {
    const capability = JSON.parse(
      await readFile(
        path.join(REPOSITORY_ROOT, 'third_party/ms-swift/runtime-capabilities.json'),
        'utf8',
      ),
    )
    capability.phase = 'S1-complete'
    for (const entry of capability.capabilities) {
      if (['runtime.qwen-small-sft-lora', 'runtime.transformers-lora-infer'].includes(entry.id)) {
        entry.runtime_installed = true
        entry.runtime_validated = true
        entry.status = 'green'
        entry.evidence = ['docs/swift/evidence/S1-GPU-STUDIO.md']
      }
    }
    const capabilityText = `${JSON.stringify(capability, null, 2)}\n`
    const capabilityPath = path.join(directory, 'capabilities.json')
    await writeFile(capabilityPath, capabilityText, 'utf8')

    const lock = JSON.parse(
      await readFile(path.join(REPOSITORY_ROOT, 'third_party/ms-swift/upstream.lock'), 'utf8'),
    )
    lock.runtime_target.image_validation_status = 's1-gpu-green'
    lock.runtime_target.capability_manifest_sha256 = sha256(Buffer.from(capabilityText))
    const lockPath = path.join(directory, 'upstream.lock')
    await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`, 'utf8')

    await expectResult(
      (evidence) => {
        evidence.proof_stage = 'final'
        evidence.runtime.capability_manifest_phase = 'S1-complete'
        evidence.runtime.capability_manifest_sha256 = lock.runtime_target.capability_manifest_sha256
      },
      0,
      /final evidence passed/,
      false,
      false,
      {
        SWIFT_UPSTREAM_LOCK_PATH: lockPath,
        SWIFT_CAPABILITY_MANIFEST_PATH: capabilityPath,
      },
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('rejects CPU readiness masquerading as a GPU proof', async () => {
  await expectResult(
    (evidence) => {
      evidence.runtime.gpu_available = false
    },
    1,
    /Provider and Torch must both report a CUDA GPU/,
  )
})

test('rejects GPU PID evidence from an isolated container PID namespace', async () => {
  await expectResult(
    (evidence) => {
      evidence.container.pid_mode = ''
    },
    1,
    /host PID namespace/,
  )
})

test('rejects evidence from a different image ID', async () => {
  await expectResult(
    (evidence) => {
      evidence.image.id = `sha256:${'0'.repeat(64)}`
    },
    1,
    /actual image ID must equal the exact expected/,
  )
})

test('rejects a fixture outside the accepted 32-record proof', async () => {
  await expectResult(
    (evidence) => {
      evidence.fixture.record_count = 31
    },
    1,
    /fixture must contain exactly 32 records/,
  )
})

test('rejects LoRA rank or max-length drift', async () => {
  await expectResult(
    (evidence) => {
      evidence.training.parameters.rank = 16
      evidence.training.parameters.max_length = 256
    },
    1,
    /LoRA rank must be 8/,
  )
})

test('rejects a completed smoke outside the 2..5 step range', async () => {
  await expectResult(
    (evidence) => {
      evidence.training.parameters.max_steps = 6
      evidence.training.actual_steps = 6
    },
    1,
    /completed LoRA max_steps must remain in 2\.\.5/,
  )
})

test('rejects missing exact base-model revision proof', async () => {
  await expectResult(
    (evidence) => {
      evidence.model.revision = '0'.repeat(40)
    },
    1,
    /base model reference and exact revision are not an approved pair/,
  )
})

test('rejects a stop proof that did not use native Runtime logs', async () => {
  await expectResult(
    (evidence) => {
      evidence.stop.native_log_observed = false
    },
    1,
    /native Runtime log callback did not produce output/,
  )
})

test('rejects missing adapter safetensors', async () => {
  await expectResult(
    (evidence) => {
      evidence.training.adapter_files = evidence.training.adapter_files.slice(0, 1)
    },
    1,
    /training must record adapter config and safetensors/,
  )
})

test('rejects an empty Adapter Infer result', async () => {
  await expectResult(
    (evidence) => {
      evidence.infer.response_char_count = 0
    },
    1,
    /Adapter Infer response must be non-empty/,
  )
})

test('rejects a send_message proof that passed Gradio State as a public input', async () => {
  await expectResult(
    (evidence) => {
      evidence.gradio.send_message_public_input_count = 14
      evidence.gradio.send_message_state_input_count = 0
    },
    1,
    /send_message must expose exactly 13 public Gradio Client inputs/,
  )
})

test('rejects a training process that reached a checkpoint but exited nonzero', async () => {
  await expectResult(
    (evidence) => {
      evidence.training.exit_code = 7
    },
    1,
    /training process must exit 0 with terminal=completed/,
  )
})

test('rejects an infer kill callback that does not match the locked baseline', async () => {
  await expectResult(
    (evidence) => {
      evidence.infer.kill_callback.api_name = 'kill_task_3'
    },
    1,
    /infer kill callback does not match the exact locked Gradio dependency/,
  )
})

test('rejects an adapter bundle digest not derived from file metadata', async () => {
  await expectResult(
    (evidence) => {
      evidence.training.adapter_bundle_sha256 = '0'.repeat(64)
      evidence.infer.adapter_bundle_sha256 = '0'.repeat(64)
    },
    1,
    /adapter bundle digest does not match adapter file metadata/,
  )
})

test('rejects an unconfirmed exact container cleanup', async () => {
  await expectResult(
    (evidence) => {
      evidence.container.removed_after_gate = false
    },
    1,
    /GPU gate container must be removed after evidence collection/,
  )
})

test('rejects GPU gate source provenance drift', async () => {
  await expectResult(
    (evidence) => {
      evidence.provenance.driver.sha256 = '0'.repeat(64)
    },
    1,
    /driver provenance digest has drifted/,
  )
})

test('rejects an absolute path in a sanitized log', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'databench-swift-gpu-path-log-'))
  try {
    const evidence = await validEvidence(directory)
    const bytes = Buffer.from('swift loaded model from /opt/private/model\n')
    await writeFile(path.join(directory, 'infer.sanitized.log'), bytes)
    evidence.logs['infer.sanitized.log'] = {
      bytes: bytes.byteLength,
      sha256: sha256(bytes),
      redaction_count: 0,
    }
    const evidencePath = path.join(directory, 'evidence.json')
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`)
    const result = spawnSync(process.execPath, [CHECKER, '--allow-candidate', evidencePath], {
      cwd: REPOSITORY_ROOT,
      encoding: 'utf8',
    })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /sanitized log contains an absolute path/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('rejects credential-shaped content in a sanitized log', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'databench-swift-gpu-log-'))
  try {
    const evidence = await validEvidence(directory)
    const bytes = Buffer.from('Authorization: Bearer exposed\n')
    await writeFile(path.join(directory, 'infer.sanitized.log'), bytes)
    evidence.logs['infer.sanitized.log'] = {
      bytes: bytes.byteLength,
      sha256: sha256(bytes),
      redaction_count: 0,
    }
    const evidencePath = path.join(directory, 'evidence.json')
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`)
    const result = spawnSync(process.execPath, [CHECKER, '--allow-candidate', evidencePath], {
      cwd: REPOSITORY_ROOT,
      encoding: 'utf8',
    })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /sanitized log contains a credential-shaped token/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
