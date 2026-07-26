#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="${DATABENCH_RELEASE_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"
# shellcheck source=lib/health.sh
source "${SCRIPT_DIR}/lib/health.sh"

log "running idempotent dataset lifecycle smoke"
compose_for_release "$SCRIPT_DIR" run --rm --no-deps \
  --volume "${SCRIPT_DIR}/smoke:/opt/databench/smoke:ro" \
  --entrypoint /bin/sh api -ec '
    if ! databench ref show system-offline-smoke-v2 >/dev/null 2>&1; then
      databench dataset ingest /opt/databench/smoke/v2.jsonl \
        --ref system-offline-smoke-v2 --message system-offline-smoke >/dev/null
    fi
    databench dataset show system-offline-smoke-v2 >/dev/null
    databench dataset records system-offline-smoke-v2 --limit 1 >/dev/null
    databench dataset audit system-offline-smoke-v2 >/dev/null
    databench dataset export system-offline-smoke-v2 \
      --output /tmp/offline-smoke-v2.jsonl >/dev/null
    test -s /tmp/offline-smoke-v2.jsonl
  '

compose_for_release "$SCRIPT_DIR" run --rm --no-deps \
  --volume "${SCRIPT_DIR}/smoke:/opt/databench/smoke:ro" \
  --entrypoint node api /opt/databench/smoke/gateway.mjs

log "running MCP and companion lifecycle smoke through Caddy"
compose_for_release "$SCRIPT_DIR" run --rm --no-deps \
  --volume "${SCRIPT_DIR}/smoke:/opt/databench/smoke:ro" \
  --volume "${SCRIPT_DIR}/smoke/mcp.mjs:/app/mcp-smoke.mjs:ro" \
  --entrypoint node api /app/mcp-smoke.mjs /opt/databench/smoke/mcp-draft.jsonl

API_STOPPED=false
restart_api_after_probe() {
  local status=$?
  trap - EXIT
  if [ "$API_STOPPED" = true ]; then
    log "restarting API after Caddy upstream failure probe"
    if ! compose_for_release "$SCRIPT_DIR" up -d api ||
      ! wait_container_healthy databench-offline-api 180; then
      status=1
    fi
  fi
  exit "$status"
}
trap restart_api_after_probe EXIT

log "verifying Caddy runtime logs redact companion bearer URLs on upstream failure"
API_STOPPED=true
compose_for_release "$SCRIPT_DIR" stop api
compose_for_release "$SCRIPT_DIR" run --rm --no-deps \
  --volume "${SCRIPT_DIR}/smoke:/opt/databench/smoke:ro" \
  --entrypoint node api /opt/databench/smoke/upstream-failure.mjs
compose_for_release "$SCRIPT_DIR" up -d api
wait_container_healthy databench-offline-api 180 || die "API did not recover after log probe"
API_STOPPED=false
trap - EXIT

PROCESS_LOG_SENTINEL="proc_$(printf 'f%.0s' {1..64})"
EXPORT_LOG_SENTINEL="exp_$(printf 'e%.0s' {1..64})"
MCP_SERVICE_LOGS="$(compose_for_release "$SCRIPT_DIR" logs web api 2>&1)"
case "$MCP_SERVICE_LOGS" in
  *"$PROCESS_LOG_SENTINEL"*|*"$EXPORT_LOG_SENTINEL"*)
    die "API or Caddy logs exposed an MCP bearer token path"
    ;;
esac
log "lifecycle smoke passed"
