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

start_application_services() {
  local release_dir="$1"
  if release_has_worker "$release_dir"; then
    compose_for_release "$release_dir" up -d worker
    wait_container_healthy databench-offline-worker 240 || return 1
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
  if release_has_evalscope "$release_dir"; then
    compose_for_release "$release_dir" run --rm --no-deps \
      --entrypoint /bin/sh api -ec '
      databench ref show system-offline-smoke-v2 >/dev/null
      databench dataset audit system-offline-smoke-v2 >/dev/null
      node -e "fetch(\"http://evalscope:9000/health\").then(async response=>{const body=await response.json();process.exit(response.ok&&body.ready===true?0:1)}).catch(()=>process.exit(1))"
      printf "%s\n" "{\"database\":{\"ok\":true},\"evalscope\":{\"ok\":true},\"store\":{\"ok\":true}}"
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
  local report
  report="$(doctor_report "$release_dir")" || return 1
  printf '%s\n' "$report"
  if release_has_evalscope "$release_dir"; then
    [ "$report" = '{"database":{"ok":true},"evalscope":{"ok":true},"store":{"ok":true}}' ]
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
        return 0
      fi
    fi
    sleep 2
    elapsed=$((elapsed + 2))
  done
  return 1
}
