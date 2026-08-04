#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"
# shellcheck source=lib/manifest.sh
source "${SCRIPT_DIR}/lib/manifest.sh"
# shellcheck source=lib/config.sh
source "${SCRIPT_DIR}/lib/config.sh"
# shellcheck source=lib/health.sh
source "${SCRIPT_DIR}/lib/health.sh"

API_ALREADY_STOPPED=false
if [ "${1:-}" = '--api-already-stopped' ]; then
  API_ALREADY_STOPPED=true
  shift
fi
[ "$#" -eq 0 ] || die "usage: backup.sh [--api-already-stopped]"

require_root
acquire_operation_lock
validate_existing_config
validate_model_security_config
validate_backup_key
RELEASE_DIR="$(current_release_dir)"
validate_release_contract "$RELEASE_DIR"
if release_has_evalscope "$RELEASE_DIR"; then
  validate_evalscope_config
fi
if release_has_swift "$RELEASE_DIR"; then
  validate_swift_config
fi
BACKUP_SWIFT_ENABLED=false
if release_swift_enabled "$RELEASE_DIR"; then
  BACKUP_SWIFT_ENABLED=true
fi

GENERATION="$(date -u '+%Y%m%dT%H%M%SZ')-$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
FINAL_DIR="${DATABENCH_DATA_ROOT}/backups/${GENERATION}"
TEMP_DIR="${DATABENCH_DATA_ROOT}/backups/.${GENERATION}.tmp"
RESTART_API=false

cleanup() {
  local status=$?
  trap - EXIT
  if [ "$status" -ne 0 ]; then
    rm -rf "$TEMP_DIR"
  fi
  if [ "$RESTART_API" = true ]; then
    start_application_services "$RELEASE_DIR" >/dev/null || true
  fi
  exit "$status"
}
trap cleanup EXIT

[ ! -e "$FINAL_DIR" ] || die "backup generation already exists: $GENERATION"
install -d -m 0700 "$TEMP_DIR" "${TEMP_DIR}/minio"

if [ "$API_ALREADY_STOPPED" = false ]; then
  log "stopping API writes for a consistent backup"
  stop_application_services "$RELEASE_DIR"
  RESTART_API=true
fi
if release_has_swift "$RELEASE_DIR"; then
  assert_swift_session_transition_compatible \
    "$RELEASE_DIR" "$RELEASE_DIR" "$BACKUP_SWIFT_ENABLED" ||
    die "Swift Studio Session state is not compatible with this backup"
fi

wait_container_healthy databench-offline-postgres 60 || die "PostgreSQL is not healthy"
wait_container_healthy databench-offline-minio 60 || die "MinIO is not healthy"

log "dumping PostgreSQL"
docker exec databench-offline-postgres sh -ec \
  'pg_dump --format=custom --no-owner --username "$POSTGRES_USER" "$POSTGRES_DB"' \
  > "${TEMP_DIR}/catalog.dump"
[ -s "${TEMP_DIR}/catalog.dump" ] || die "PostgreSQL dump is empty"
docker exec -i databench-offline-postgres pg_restore --list \
  < "${TEMP_DIR}/catalog.dump" >/dev/null

docker exec databench-offline-postgres sh -ec \
  'psql --no-align --tuples-only --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -c \
    "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY finished_at"' \
  > "${TEMP_DIR}/prisma-migrations.txt"

log "mirroring MinIO bucket"
compose_for_release "$RELEASE_DIR" run --rm --no-deps \
  --volume "${TEMP_DIR}/minio:/backup" \
  --entrypoint /bin/sh minio-init -ec '
    mc alias set local http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null
    mc mirror --overwrite --remove "local/$S3_BUCKET" /backup
  '

if release_has_evalscope "$RELEASE_DIR"; then
  log "capturing the persistent EvalScope output and input volume"
  require_command tar
  assert_evalscope_volume_tree_safe
  tar --numeric-owner --format=posix \
    -C "${DATABENCH_DATA_ROOT}/evalscope" \
    -cpf "${TEMP_DIR}/evalscope-volume.tar" outputs inputs
  validate_evalscope_volume_archive "$RELEASE_DIR" "${TEMP_DIR}/evalscope-volume.tar"
fi

if [ "$BACKUP_SWIFT_ENABLED" = true ]; then
  log "capturing the persistent Swift Studio Session workspace"
  require_command tar
  assert_swift_volume_tree_safe
  tar --numeric-owner --format=posix \
    --exclude='./cache' \
    --exclude='./home' \
    -C "${DATABENCH_DATA_ROOT}/swift-studio" \
    -cpf "${TEMP_DIR}/swift-studio-workspace.tar" .
  validate_swift_volume_archive "${TEMP_DIR}/swift-studio-workspace.tar"
fi

openssl enc -aes-256-cbc -pbkdf2 -salt \
  -pass "file:${DATABENCH_BACKUP_KEY_FILE}" \
  -in "$DATABENCH_CONFIG_FILE" \
  -out "${TEMP_DIR}/databench.env.enc"
openssl enc -aes-256-cbc -pbkdf2 -salt \
  -pass "file:${DATABENCH_BACKUP_KEY_FILE}" \
  -in "$DATABENCH_MCP_CONFIG_FILE" \
  -out "${TEMP_DIR}/mcp.env.enc"
openssl enc -aes-256-cbc -pbkdf2 -salt \
  -pass "file:${DATABENCH_BACKUP_KEY_FILE}" \
  -in "$DATABENCH_MODEL_ENDPOINT_POLICY_FILE" \
  -out "${TEMP_DIR}/model-endpoint-policy.json.enc"
openssl enc -aes-256-cbc -pbkdf2 -salt \
  -pass "file:${DATABENCH_BACKUP_KEY_FILE}" \
  -in "$DATABENCH_MODEL_CREDENTIALS_AUTHORITY_FILE" \
  -out "${TEMP_DIR}/model-credentials.json.enc"
if release_has_evalscope "$RELEASE_DIR"; then
  openssl enc -aes-256-cbc -pbkdf2 -salt \
    -pass "file:${DATABENCH_BACKUP_KEY_FILE}" \
    -in "$DATABENCH_EVALSCOPE_CONFIG_FILE" \
    -out "${TEMP_DIR}/evalscope.env.enc"
fi
if release_has_swift "$RELEASE_DIR"; then
  openssl enc -aes-256-cbc -pbkdf2 -salt \
    -pass "file:${DATABENCH_BACKUP_KEY_FILE}" \
    -in "$DATABENCH_SWIFT_CONFIG_FILE" \
    -out "${TEMP_DIR}/swift.env.enc"
fi

BUNDLE_NAME="$(sed -n '1p' "${RELEASE_DIR}/release-bundle.name")"
BUNDLE_SHA256="$(sed -n '1p' "${RELEASE_DIR}/release-bundle.sha256")"
CREATED_AT="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
cat > "${TEMP_DIR}/backup-manifest" <<EOF
schema_version=1
generation=${GENERATION}
created_at=${CREATED_AT}
app_version=${DATABENCH_VERSION}
git_sha=${MANIFEST_GIT_SHA}
bundle_name=${BUNDLE_NAME}
bundle_sha256=${BUNDLE_SHA256}
postgres_major=${MANIFEST_POSTGRES_MAJOR}
swift_enabled=${BACKUP_SWIFT_ENABLED}
EOF

(
  cd "$TEMP_DIR"
  find . -type f ! -name SHA256SUMS -print | LC_ALL=C sort | while IFS= read -r file; do
    printf '%s  %s\n' "$(sha256_file "$file")" "$file"
  done > SHA256SUMS
)
verify_checksum_file "$TEMP_DIR" "${TEMP_DIR}/SHA256SUMS" >/dev/null
mv "$TEMP_DIR" "$FINAL_DIR"
write_state_value last-backup-generation "$GENERATION"

if [ "$RESTART_API" = true ]; then
  start_application_services "$RELEASE_DIR" >/dev/null
  wait_application_services "$RELEASE_DIR" ||
    die "application services failed to restart after backup"
  run_doctor "$RELEASE_DIR" >/dev/null || die "doctor failed after backup"
  RESTART_API=false
fi

log "backup completed; copy it and the release bundle to independent storage"
printf '%s\n' "$FINAL_DIR"
