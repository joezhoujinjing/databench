#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"
# shellcheck source=lib/health.sh
source "${SCRIPT_DIR}/lib/health.sh"

usage() {
  printf 'Usage: %s <generation-directory-or-id> --confirm [--skip-safety-backup] [--api-already-stopped] [--keep-stopped]\n' "$0" >&2
  exit 2
}

[ "$#" -ge 2 ] || usage
GENERATION_INPUT="$1"
shift
CONFIRMED=false
SKIP_SAFETY_BACKUP=false
API_ALREADY_STOPPED=false
KEEP_STOPPED=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    --confirm) CONFIRMED=true ;;
    --skip-safety-backup) SKIP_SAFETY_BACKUP=true ;;
    --api-already-stopped) API_ALREADY_STOPPED=true ;;
    --keep-stopped) KEEP_STOPPED=true ;;
    *) usage ;;
  esac
  shift
done
[ "$CONFIRMED" = true ] || die "restore is destructive; pass --confirm"

require_root
acquire_operation_lock
if [ -d "$GENERATION_INPUT" ]; then
  BACKUP_DIR="$(cd "$GENERATION_INPUT" && pwd)"
else
  BACKUP_DIR="${DATABENCH_DATA_ROOT}/backups/${GENERATION_INPUT}"
fi
[ -d "$BACKUP_DIR" ] || die "backup generation does not exist: $GENERATION_INPUT"
verify_checksum_file "$BACKUP_DIR" "${BACKUP_DIR}/SHA256SUMS"

manifest_value() {
  local key="$1"
  local value count
  count="$(grep -Ec "^${key}=[A-Za-z0-9.:+_-]+$" "${BACKUP_DIR}/backup-manifest" || true)"
  [ "$count" -eq 1 ] || die "backup manifest has invalid $key"
  value="$(sed -n "s/^${key}=//p" "${BACKUP_DIR}/backup-manifest")"
  printf '%s\n' "$value"
}

[ "$(manifest_value schema_version)" = '1' ] || die "unsupported backup schema"
BACKUP_VERSION="$(manifest_value app_version)"
BACKUP_BUNDLE_SHA="$(manifest_value bundle_sha256)"
TARGET_RELEASE="${DATABENCH_RELEASES_DIR}/${BACKUP_VERSION}"
[ -d "$TARGET_RELEASE" ] || die "matching release is not installed: $BACKUP_VERSION"
[ "$(sed -n '1p' "${TARGET_RELEASE}/release-bundle.sha256")" = "$BACKUP_BUNDLE_SHA" ] ||
  die "matching release bundle checksum is unavailable"

CURRENT_RELEASE="$(current_release_dir)"
if [ "$SKIP_SAFETY_BACKUP" = false ]; then
  log "creating a safety backup before restore"
  DATABENCH_OPERATION_LOCK_HELD=1 "${CURRENT_RELEASE}/backup.sh"
fi

if [ "$API_ALREADY_STOPPED" = false ]; then
  stop_application_services "$CURRENT_RELEASE"
fi

log "restoring PostgreSQL"
docker exec -i databench-offline-postgres sh -ec '
  pg_restore --clean --if-exists --no-owner --no-privileges \
    --username "$POSTGRES_USER" --dbname "$POSTGRES_DB"
' < "${BACKUP_DIR}/catalog.dump"

log "restoring MinIO bucket"
compose_for_release "$TARGET_RELEASE" run --rm --no-deps \
  --volume "${BACKUP_DIR}/minio:/backup:ro" \
  --entrypoint /bin/sh minio-init -ec '
    mc alias set local http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null
    mc mirror --overwrite --remove /backup "local/$S3_BUCKET"
  '

if [ "$KEEP_STOPPED" = true ]; then
  log "restore completed with API stopped"
  exit 0
fi

compose_for_release "$TARGET_RELEASE" run --rm migrate
start_application_services "$TARGET_RELEASE" || die "application services failed after restore"
wait_application_services "$TARGET_RELEASE" ||
  die "application services did not become healthy after restore"
run_doctor "$TARGET_RELEASE" >/dev/null || die "doctor failed after restore"
DATABENCH_RELEASE_DIR="$TARGET_RELEASE" "${TARGET_RELEASE}/smoke.sh"
activate_release "$TARGET_RELEASE" "$BACKUP_VERSION"
write_state_value last-success-version "$BACKUP_VERSION"
log "restore completed: $BACKUP_VERSION"
