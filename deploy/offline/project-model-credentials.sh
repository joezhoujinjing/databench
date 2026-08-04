#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"
# shellcheck source=lib/manifest.sh
source "${SCRIPT_DIR}/lib/manifest.sh"
# shellcheck source=lib/config.sh
source "${SCRIPT_DIR}/lib/config.sh"

[ "$#" -eq 0 ] || die "usage: project-model-credentials.sh"

require_root
acquire_operation_lock
require_command docker
RELEASE_DIR="$(current_release_dir)"
validate_release_contract "$RELEASE_DIR"
validate_model_credential_document \
  "$DATABENCH_MODEL_CREDENTIALS_AUTHORITY_FILE" authority 640
docker image inspect "$DATABENCH_API_IMAGE" >/dev/null 2>&1 ||
  die "installed API image is unavailable: $DATABENCH_API_IMAGE"

log "projecting the root-owned Model credential authority into minimum consumer views"
docker run --rm \
  --network none \
  --read-only \
  --user 0:0 \
  --pids-limit 64 \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --mount "type=bind,src=${DATABENCH_MODEL_CREDENTIALS_DIR},dst=/run/model-credentials" \
  --entrypoint node \
  "$DATABENCH_API_IMAGE" \
  /app/apps/api/dist/model-credentials-project.js \
  --authority /run/model-credentials/model-credentials.json \
  --api-output /run/model-credentials/api-model-credentials.json \
  --evalscope-output /run/model-credentials/evalscope-model-credentials.json

validate_model_security_config
log "Model credential projections are valid; run 'databenchctl restart' to reload generation"
