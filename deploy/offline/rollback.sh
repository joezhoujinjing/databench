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

usage() {
  printf 'Usage: %s <target-version> [--backup <generation-directory-or-id>]\n' "$0" >&2
  exit 2
}

[ "$#" -ge 1 ] || usage
TARGET_VERSION="$1"
shift
BACKUP_INPUT=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --backup)
      [ "$#" -ge 2 ] || usage
      BACKUP_INPUT="$2"
      shift
      ;;
    *) usage ;;
  esac
  shift
done

require_root
acquire_operation_lock
CURRENT_RELEASE="$(current_release_dir)"
load_release_env "${CURRENT_RELEASE}/release.env"
CURRENT_VERSION="$DATABENCH_VERSION"
[ "$TARGET_VERSION" != "$CURRENT_VERSION" ] || die "target is already current"
TARGET_RELEASE="${DATABENCH_RELEASES_DIR}/${TARGET_VERSION}"
[ -d "$TARGET_RELEASE" ] || die "target release is not installed: $TARGET_VERSION"
validate_release_contract "$TARGET_RELEASE"
load_release_manifest "${CURRENT_RELEASE}/release-manifest.json"
CURRENT_ROLLBACK_MODE="$MANIFEST_ROLLBACK_MODE"
validate_existing_config
validate_release_mcp_config_if_required "$CURRENT_RELEASE"
validate_release_mcp_config_if_required "$TARGET_RELEASE"

if [ "$CURRENT_ROLLBACK_MODE" = 'restore-backup' ] && [ -z "$BACKUP_INPUT" ]; then
  die "release $CURRENT_VERSION requires --backup for rollback"
fi

ROLLBACK_SUCCEEDED=false
DATA_WAS_RESTORED=false
SAFETY_GENERATION=''

recover_current_release() {
  local status=$?
  trap - EXIT
  if [ "$ROLLBACK_SUCCEEDED" = true ]; then
    exit "$status"
  fi
  warn "rollback failed; restoring release $CURRENT_VERSION"
  compose_for_release "$TARGET_RELEASE" stop web api >/dev/null 2>&1 || true
  if [ "$DATA_WAS_RESTORED" = true ] && [ -n "$SAFETY_GENERATION" ]; then
    DATABENCH_OPERATION_LOCK_HELD=1 "${CURRENT_RELEASE}/restore.sh" \
      "${DATABENCH_DATA_ROOT}/backups/${SAFETY_GENERATION}" --confirm \
      --skip-safety-backup --api-already-stopped --keep-stopped ||
      warn "failed to restore the pre-rollback safety backup"
  fi
  compose_for_release "$CURRENT_RELEASE" up -d api web || true
  wait_container_healthy databench-offline-api 180 || true
  exit "$status"
}

compose_for_release "$CURRENT_RELEASE" stop web api
trap recover_current_release EXIT

log "creating pre-rollback safety backup"
DATABENCH_OPERATION_LOCK_HELD=1 "${CURRENT_RELEASE}/backup.sh" --api-already-stopped
SAFETY_GENERATION="$(read_state_value last-backup-generation)"

if [ "$CURRENT_ROLLBACK_MODE" = 'restore-backup' ]; then
  log "restoring the backup required by the release manifest"
  # Restore mutates PostgreSQL before MinIO. Mark the data as changed first so
  # the failure trap restores the safety generation even after a partial failure.
  DATA_WAS_RESTORED=true
  DATABENCH_OPERATION_LOCK_HELD=1 "${CURRENT_RELEASE}/restore.sh" "$BACKUP_INPUT" --confirm \
    --skip-safety-backup --api-already-stopped --keep-stopped
fi

compose_for_release "$TARGET_RELEASE" up -d api web
wait_container_healthy databench-offline-api 180 || die "target API did not become healthy"
wait_container_healthy databench-offline-web 120 || die "target Web gateway did not start"
run_doctor "$TARGET_RELEASE" >/dev/null || die "target doctor failed"
DATABENCH_RELEASE_DIR="$TARGET_RELEASE" "${TARGET_RELEASE}/smoke.sh"

write_state_value previous-version "$CURRENT_VERSION"
activate_release "$TARGET_RELEASE" "$TARGET_VERSION"
write_state_value last-success-version "$TARGET_VERSION"
ROLLBACK_SUCCEEDED=true
trap - EXIT
log "rollback succeeded: $CURRENT_VERSION -> $TARGET_VERSION"
