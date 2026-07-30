#!/usr/bin/env bash

set -Eeuo pipefail

wait_container_healthy() {
  local container="$1"
  local timeout="${2:-180}"
  local elapsed=0 status
  while [ "$elapsed" -lt "$timeout" ]; do
    status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container" 2>/dev/null || true)"
    case "$status" in
      healthy|running) return 0 ;;
      unhealthy|exited|dead) docker logs --tail 100 "$container" >&2 || true; return 1 ;;
    esac
    sleep 2
    elapsed=$((elapsed + 2))
  done
  docker logs --tail 100 "$container" >&2 || true
  return 1
}

verify_swift_gpu_runtime() {
  local release_dir="$1" image device_id
  release_swift_gpu_enabled "$release_dir" || return 0
  validate_swift_config
  image="$(sed -n 's/^DATABENCH_SWIFT_IMAGE=//p' "${release_dir}/release.env")"
  device_id="$(grep -E '^DATABENCH_SWIFT_GPU_DEVICE_ID=' "$DATABENCH_SWIFT_CONFIG_FILE" | cut -d= -f2-)"
  log "verifying NVIDIA GPU $device_id with the bundled Swift Studio image"
  timeout 180 docker run --rm --platform linux/amd64 \
    --gpus "device=${device_id}" \
    --entrypoint python "$image" -c '
import torch

assert torch.version.cuda is not None
assert torch.cuda.is_available()
assert torch.cuda.device_count() == 1
print(torch.cuda.get_device_name(0))
  ' >/dev/null || die "the bundled Swift Studio image cannot use NVIDIA GPU ${device_id}; verify the driver and NVIDIA Container Toolkit"
}

verify_swift_model_preload() {
  local release_dir="$1" model_root model_entry
  release_swift_gpu_enabled "$release_dir" || return 0
  model_root="${DATABENCH_DATA_ROOT}/swift-models"
  [ -d "$model_root" ] ||
    die "Swift Studio offline model directory is missing: $model_root"
  model_entry="$(
    find "$model_root" -xdev -mindepth 1 -maxdepth 1 \
      -type d -print -quit
  )"
  [ -n "$model_entry" ] ||
    die "Swift Studio is enabled, but no offline model is preloaded under $model_root"
}

assert_swift_idle() {
  local release_dir="$1" state
  release_has_swift "$release_dir" || return 0
  swift_container_running || return 0
  state="$(docker exec databench-offline-swift-studio python -c '
from pathlib import Path
from databench_swift_studio.sessions import _default_native_task_probe

print("active" if _default_native_task_probe(Path("/var/lib/databench-swift-studio")) else "idle")
' 2>/dev/null || true)"
  if [ "$state" != 'idle' ]; then
    warn "Swift Studio still has an active native train/infer/deploy task; stop it in the Gradio Runtime tab before maintenance"
    return 1
  fi
}

start_application_services() {
  local release_dir="$1"
  if release_has_worker "$release_dir"; then
    compose_for_release "$release_dir" up -d worker
    wait_container_healthy databench-offline-worker 240 || return 1
  fi
  if release_swift_enabled "$release_dir"; then
    compose_for_release "$release_dir" up -d swift-studio
    wait_container_healthy databench-offline-swift-studio 600 || return 1
  elif release_has_swift "$release_dir" && swift_container_exists; then
    assert_swift_session_transition_compatible \
      "$release_dir" "$release_dir" false || return 1
    assert_swift_idle "$release_dir" || return 1
    compose_for_release "$release_dir" rm --stop --force swift-studio || return 1
  fi
  compose_for_release "$release_dir" up -d api
  wait_container_healthy databench-offline-api 180 || return 1
  if release_has_evalscope "$release_dir"; then
    compose_for_release "$release_dir" up -d evalscope
    wait_container_healthy databench-offline-evalscope 240 || return 1
  fi
  compose_for_release "$release_dir" up -d web
}

wait_application_services() {
  local release_dir="$1"
  if release_has_worker "$release_dir"; then
    wait_container_healthy databench-offline-worker 240 || return 1
  fi
  if release_swift_enabled "$release_dir"; then
    wait_container_healthy databench-offline-swift-studio 600 || return 1
  fi
  wait_container_healthy databench-offline-api 180 || return 1
  if release_has_evalscope "$release_dir"; then
    wait_container_healthy databench-offline-evalscope 240 || return 1
  fi
  wait_container_healthy databench-offline-web 120 || return 1
}

evalscope_operator_request() {
  local method="$1" path="$2"
  case "$method $path" in
    'POST /internal/v1/operator/drain'|'POST /internal/v1/operator/resume'|'GET /internal/v1/operator/status') ;;
    *) die "invalid internal EvalScope operator request" ;;
  esac
  docker exec databench-offline-evalscope /app/.venv/bin/python -c '
import json
import os
import sys
import urllib.request

method, path = sys.argv[1:]
request = urllib.request.Request(
    "http://127.0.0.1:9000" + path,
    method=method,
    headers={"Authorization": "Bearer " + os.environ["EVALSCOPE_OPERATOR_TOKEN"]},
)
with urllib.request.urlopen(request, timeout=5) as response:
    body = json.load(response)
print(json.dumps(body, separators=(",", ":"), sort_keys=True))
' "$method" "$path"
}

drain_evalscope() {
  local release_dir="$1" timeout="$2" elapsed=0 state
  release_has_evalscope "$release_dir" || return 0
  [[ "$timeout" =~ ^[1-9][0-9]*$ ]] || die "EvalScope drain timeout must be a positive integer"
  log "draining EvalScope before stopping services"
  evalscope_operator_request POST /internal/v1/operator/drain >/dev/null || return 1
  while [ "$elapsed" -lt "$timeout" ]; do
    state="$(evalscope_operator_request GET /internal/v1/operator/status)" || return 1
    if [ "$state" = '{"active_tasks":0,"draining":true,"ready":false}' ]; then
      return 0
    fi
    sleep 2
    elapsed=$((elapsed + 2))
  done
  warn "EvalScope still has active tasks after ${timeout}s; maintenance was cancelled"
  evalscope_operator_request POST /internal/v1/operator/resume >/dev/null || true
  return 1
}

assert_evalscope_volume_tree_safe() {
  local unsafe
  unsafe="$(find \
    "${DATABENCH_DATA_ROOT}/evalscope/outputs" \
    "${DATABENCH_DATA_ROOT}/evalscope/inputs" \
    -xdev \( -type l -o \( ! -type d ! -type f \) -o \( -type f -links +1 \) \) \
    -print -quit)"
  [ -z "$unsafe" ] || die "EvalScope volume contains an unsupported link or special file"
}

assert_swift_volume_tree_safe() {
  local root unsafe preserved
  root="${DATABENCH_DATA_ROOT}/swift-studio"
  [ -d "$root" ] || die "Swift Studio data root is missing: $root"
  for preserved in cache home; do
    if [ -e "${root}/${preserved}" ] || [ -L "${root}/${preserved}" ]; then
      [ -d "${root}/${preserved}" ] && [ ! -L "${root}/${preserved}" ] ||
        die "Swift Studio preserved ${preserved} path must be a real directory"
    fi
  done
  unsafe="$(find "$root" -xdev \
    \( -path "${root}/cache" -o -path "${root}/home" \) -prune -o \
    \( -type l -o \( ! -type d ! -type f \) -o \( -type f -links +1 \) \) \
    -print -quit)"
  [ -z "$unsafe" ] || die "Swift Studio workspace contains an unsupported link or special file"
}

validate_swift_volume_archive() {
  local archive="$1"
  [ -f "$archive" ] || die "Swift Studio workspace archive is missing: $archive"
  tar -tf "$archive" | awk '
    /^\// { exit 1 }
    /(^|\/)\.\.(\/|$)/ { exit 1 }
    /^(\.\/)?(cache|home)(\/|$)/ { exit 1 }
    END { if (NR == 0) exit 1 }
  ' || die "Swift Studio workspace archive contains an unsafe path"
  tar -tvf "$archive" | awk '
    $1 !~ /^[d-]/ { exit 1 }
    END { if (NR == 0) exit 1 }
  ' || die "Swift Studio workspace archive contains an unsupported link or special file"
}

validate_evalscope_volume_archive() {
  local release_dir="$1" archive="$2" archive_dir archive_name
  release_has_evalscope "$release_dir" || die "release does not contain EvalScope"
  [ -f "$archive" ] || die "EvalScope volume archive is missing: $archive"
  archive_dir="$(cd "$(dirname "$archive")" && pwd)"
  archive_name="$(basename "$archive")"
  compose_for_release "$release_dir" run --rm --no-deps \
    --volume "${archive_dir}:/backup:ro" \
    --entrypoint /app/.venv/bin/python evalscope -c '
import sys
from pathlib import Path
from databench_evalscope.volume_backup import validate_volume_archive

validate_volume_archive(Path(sys.argv[1]))
' "/backup/${archive_name}" >/dev/null
}

doctor_report() {
  local release_dir="$1"
  local swift_gpu_required=false
  if release_swift_gpu_enabled "$release_dir"; then
    swift_gpu_required=true
  fi
  if release_has_evalscope "$release_dir" && release_swift_enabled "$release_dir"; then
    compose_for_release "$release_dir" run --rm --no-deps \
      --env "DATABENCH_DOCTOR_SWIFT_GPU_REQUIRED=${swift_gpu_required}" \
      --entrypoint /bin/sh api -ec '
      databench ref show system-offline-smoke-v2 >/dev/null
      databench dataset audit system-offline-smoke-v2 >/dev/null
      node -e "Promise.all([
        fetch(\"http://evalscope:9000/health\").then(async response=>{const body=await response.json();if(!response.ok||body.ready!==true)throw new Error()}),
        fetch(\"http://swift-studio:7861/runtime\").then(async response=>{const body=await response.json();if(!response.ok||body.ready!==true||(process.env.DATABENCH_DOCTOR_SWIFT_GPU_REQUIRED===\"true\"&&body.gpu_available!==true))throw new Error()}),
        fetch(\"http://swift-studio:7860/config\").then(async response=>{const body=await response.json();const root=new URL(body.root,\"http://swift-studio\").pathname.replace(/\\/$/,\"\");if(!response.ok||root!==\"/swift-studio\")throw new Error()}),
      ]).then(()=>process.exit(0)).catch(()=>process.exit(1))"
      printf "%s\n" "{\"database\":{\"ok\":true},\"evalscope\":{\"ok\":true},\"store\":{\"ok\":true},\"swift\":{\"gpu\":$DATABENCH_DOCTOR_SWIFT_GPU_REQUIRED,\"ok\":true}}"
      '
  elif release_has_evalscope "$release_dir"; then
    compose_for_release "$release_dir" run --rm --no-deps \
      --entrypoint /bin/sh api -ec '
      databench ref show system-offline-smoke-v2 >/dev/null
      databench dataset audit system-offline-smoke-v2 >/dev/null
      node -e "fetch(\"http://evalscope:9000/health\").then(async response=>{const body=await response.json();process.exit(response.ok&&body.ready===true?0:1)}).catch(()=>process.exit(1))"
      printf "%s\n" "{\"database\":{\"ok\":true},\"evalscope\":{\"ok\":true},\"store\":{\"ok\":true}}"
      '
  elif release_swift_enabled "$release_dir"; then
    compose_for_release "$release_dir" run --rm --no-deps \
      --env "DATABENCH_DOCTOR_SWIFT_GPU_REQUIRED=${swift_gpu_required}" \
      --entrypoint /bin/sh api -ec '
        databench ref show system-offline-smoke-v2 >/dev/null
        databench dataset audit system-offline-smoke-v2 >/dev/null
        node -e "Promise.all([
          fetch(\"http://swift-studio:7861/runtime\").then(async response=>{const body=await response.json();if(!response.ok||body.ready!==true||(process.env.DATABENCH_DOCTOR_SWIFT_GPU_REQUIRED===\"true\"&&body.gpu_available!==true))throw new Error()}),
          fetch(\"http://swift-studio:7860/config\").then(async response=>{const body=await response.json();const root=new URL(body.root,\"http://swift-studio\").pathname.replace(/\\/$/,\"\");if(!response.ok||root!==\"/swift-studio\")throw new Error()}),
        ]).then(()=>process.exit(0)).catch(()=>process.exit(1))"
        printf "%s\n" "{\"database\":{\"ok\":true},\"store\":{\"ok\":true},\"swift\":{\"gpu\":$DATABENCH_DOCTOR_SWIFT_GPU_REQUIRED,\"ok\":true}}"
      '
  else
    compose_for_release "$release_dir" run --rm --no-deps \
      --entrypoint /bin/sh api -ec '
        databench ref show system-offline-smoke-v2 >/dev/null
        databench dataset audit system-offline-smoke-v2 >/dev/null
        printf "%s\n" "{\"database\":{\"ok\":true},\"store\":{\"ok\":true}}"
      '
  fi
}

run_doctor() {
  local release_dir="$1"
  local report swift_gpu_required=false
  if release_swift_gpu_enabled "$release_dir"; then
    swift_gpu_required=true
  fi
  report="$(doctor_report "$release_dir")" || return 1
  printf '%s\n' "$report"
  if release_has_evalscope "$release_dir" && release_swift_enabled "$release_dir"; then
    [ "$report" = "{\"database\":{\"ok\":true},\"evalscope\":{\"ok\":true},\"store\":{\"ok\":true},\"swift\":{\"gpu\":${swift_gpu_required},\"ok\":true}}" ]
  elif release_has_evalscope "$release_dir"; then
    [ "$report" = '{"database":{"ok":true},"evalscope":{"ok":true},"store":{"ok":true}}' ]
  elif release_swift_enabled "$release_dir"; then
    [ "$report" = "{\"database\":{\"ok\":true},\"store\":{\"ok\":true},\"swift\":{\"gpu\":${swift_gpu_required},\"ok\":true}}" ]
  else
    [ "$report" = '{"database":{"ok":true},"store":{"ok":true}}' ]
  fi
}

wait_gateway() {
  local release_dir="$1"
  local timeout="${2:-120}"
  local elapsed=0
  while [ "$elapsed" -lt "$timeout" ]; do
    if compose_for_release "$release_dir" exec -T api node -e '
      fetch("http://web/api/health")
        .then(async (response) => {
          if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) {
            process.exit(1)
          }
          const body = await response.json()
          process.exit(body?.status === "ok" ? 0 : 1)
        })
        .catch(() => process.exit(1))
    '; then
      if ! release_has_evalscope "$release_dir" || compose_for_release "$release_dir" exec -T api node -e '
        Promise.all([
          fetch("http://web/evalscope-api/health").then(async response => {
            const body = await response.json()
            if (!response.ok || body?.service !== "evalscope-backend" || body?.ready !== true) throw new Error()
          }),
          fetch("http://web/evalscope-api/api/v1/config").then(async response => {
            const text = await response.text()
            if (!response.ok || /(?:\/var\/|\/srv\/|\/app\/|[A-Za-z]:\\\\)/.test(text)) throw new Error()
          }),
        ]).then(() => process.exit(0)).catch(() => process.exit(1))
      '; then
        if ! release_swift_enabled "$release_dir" || compose_for_release "$release_dir" exec -T api node -e '
          Promise.all([
            fetch("http://web/swift-studio-runtime/runtime").then(async response => {
              const body = await response.json()
              if (!response.ok || body?.ready !== true) throw new Error()
            }),
            fetch("http://web/swift-studio/config").then(async response => {
              const body = await response.json()
              const root = new URL(body?.root, "http://swift-studio").pathname.replace(/\/$/, "")
              if (!response.ok || root !== "/swift-studio") throw new Error()
            }),
          ]).then(() => process.exit(0)).catch(() => process.exit(1))
        '; then
          return 0
        fi
      fi
    fi
    sleep 2
    elapsed=$((elapsed + 2))
  done
  return 1
}
