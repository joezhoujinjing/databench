#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="${DATABENCH_RELEASE_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

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
log "lifecycle smoke passed"
