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
  compose_for_release "$release_dir" up -d api web
}

wait_application_services() {
  local release_dir="$1"
  if release_has_worker "$release_dir"; then
    wait_container_healthy databench-offline-worker 240 || return 1
  fi
  wait_container_healthy databench-offline-api 180 || return 1
  wait_container_healthy databench-offline-web 120 || return 1
}

doctor_report() {
  local release_dir="$1"
  compose_for_release "$release_dir" run --rm --no-deps \
    --entrypoint /bin/sh api -ec '
      databench ref show system-offline-smoke-v2 >/dev/null
      databench dataset audit system-offline-smoke-v2 >/dev/null
      printf "%s\n" "{\"database\":{\"ok\":true},\"store\":{\"ok\":true}}"
    '
}

run_doctor() {
  local release_dir="$1"
  local report
  report="$(doctor_report "$release_dir")" || return 1
  printf '%s\n' "$report"
  [ "$report" = '{"database":{"ok":true},"store":{"ok":true}}' ]
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
      return 0
    fi
    sleep 2
    elapsed=$((elapsed + 2))
  done
  return 1
}
