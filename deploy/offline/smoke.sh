#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="${DATABENCH_RELEASE_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

log "running idempotent v1/v2 lifecycle smoke"
compose_for_release "$SCRIPT_DIR" run --rm --no-deps \
  --volume "${SCRIPT_DIR}/smoke:/opt/databench/smoke:ro" \
  --entrypoint /bin/sh api -ec '
    databench dataset add /opt/databench/smoke/v1.jsonl \
      --name system-offline-smoke-v1 --source system-offline-smoke >/dev/null
    databench dataset show system-offline-smoke-v1 >/dev/null
    databench dataset export system-offline-smoke-v1 --out /tmp/offline-smoke-v1.jsonl >/dev/null
    test -s /tmp/offline-smoke-v1.jsonl

    if ! databench v2 ref show system-offline-smoke-v2 >/dev/null 2>&1; then
      databench v2 dataset ingest /opt/databench/smoke/v2.jsonl \
        --ref system-offline-smoke-v2 --message system-offline-smoke >/dev/null
    fi
    databench v2 dataset show system-offline-smoke-v2 >/dev/null
    databench v2 dataset records system-offline-smoke-v2 --limit 1 >/dev/null
    databench v2 dataset export system-offline-smoke-v2 \
      --output /tmp/offline-smoke-v2.jsonl >/dev/null
    test -s /tmp/offline-smoke-v2.jsonl
  '

compose_for_release "$SCRIPT_DIR" exec -T api node -e "
  const paths = ['/health', '/version', '/capabilities', '/v1/refs', '/v2/refs?limit=1'];
  for (const path of paths) {
    const response = await fetch('http://web' + path);
    if (!response.ok) throw new Error(path + ' returned ' + response.status);
  }
"
log "lifecycle smoke passed"
