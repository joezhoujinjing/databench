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
# shellcheck source=lib/preflight.sh
source "${SCRIPT_DIR}/lib/preflight.sh"

require_root
verify_outer_bundle "$SCRIPT_DIR"
verify_inner_bundle "$SCRIPT_DIR"
validate_release_contract "$SCRIPT_DIR"
TARGET_VERSION="$DATABENCH_VERSION"
TARGET_ROLLBACK_MODE="$MANIFEST_ROLLBACK_MODE"
TARGET_MIN_UPGRADE_FROM="$MANIFEST_MIN_UPGRADE_FROM"
offline_preflight
acquire_operation_lock
validate_existing_config
ensure_mcp_config

PREVIOUS_RELEASE="$(current_release_dir)"
load_release_env "${PREVIOUS_RELEASE}/release.env"
PREVIOUS_VERSION="$DATABENCH_VERSION"
version_gt "$TARGET_VERSION" "$PREVIOUS_VERSION" ||
  die "target version $TARGET_VERSION must be newer than installed version $PREVIOUS_VERSION"
version_ge "$PREVIOUS_VERSION" "$TARGET_MIN_UPGRADE_FROM" ||
  die "version $PREVIOUS_VERSION is below min_upgrade_from $TARGET_MIN_UPGRADE_FROM"

POSTGRES_VERSION_NUM="$(docker exec databench-offline-postgres sh -ec \
  'psql --no-align --tuples-only --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -c "SHOW server_version_num"')"
[ $((POSTGRES_VERSION_NUM / 10000)) -eq 17 ] || die "ordinary upgrade requires PostgreSQL major 17"

TARGET_RELEASE="${DATABENCH_RELEASES_DIR}/${TARGET_VERSION}"
copy_release_assets "$SCRIPT_DIR" "$TARGET_RELEASE"
record_bundle_identity "$SCRIPT_DIR" "$TARGET_RELEASE"

BACKUP_GENERATION=''
UPGRADE_SUCCEEDED=false
RECOVERY_SUCCEEDED=false

recover_previous_release() {
  local status=$?
  trap - EXIT
  if [ "$UPGRADE_SUCCEEDED" = true ]; then
    exit "$status"
  fi

  warn "upgrade failed; restoring release $PREVIOUS_VERSION"
  compose_for_release "$TARGET_RELEASE" stop web api >/dev/null 2>&1 || true

  if [ "$TARGET_ROLLBACK_MODE" = 'restore-backup' ] && [ -n "$BACKUP_GENERATION" ]; then
    if ! DATABENCH_OPERATION_LOCK_HELD=1 "${PREVIOUS_RELEASE}/restore.sh" \
      "${DATABENCH_DATA_ROOT}/backups/${BACKUP_GENERATION}" --confirm \
      --skip-safety-backup --api-already-stopped --keep-stopped; then
      warn "automatic database restore failed"
    fi
  fi

  if compose_for_release "$PREVIOUS_RELEASE" up -d api web &&
    wait_container_healthy databench-offline-api 180 &&
    run_doctor "$PREVIOUS_RELEASE" >/dev/null; then
    RECOVERY_SUCCEEDED=true
    warn "previous release $PREVIOUS_VERSION is serving again"
  else
    warn "automatic recovery failed; data and both releases were preserved"
    printf 'Manual recovery:\n' >&2
    if [ "$TARGET_ROLLBACK_MODE" = 'restore-backup' ] && [ -n "$BACKUP_GENERATION" ]; then
      printf '  sudo %s/restore.sh %s --confirm --skip-safety-backup\n' \
        "$PREVIOUS_RELEASE" "${DATABENCH_DATA_ROOT}/backups/${BACKUP_GENERATION}" >&2
    fi
    printf '  sudo docker compose --project-name databench-offline --env-file %s/release.env --env-file %s -f %s/compose.yml up -d\n' \
      "$PREVIOUS_RELEASE" "$DATABENCH_CONFIG_FILE" "$PREVIOUS_RELEASE" >&2
  fi
  exit "$status"
}

log "stopping API writes for upgrade"
compose_for_release "$PREVIOUS_RELEASE" stop web api
trap recover_previous_release EXIT

log "creating pre-upgrade backup"
DATABENCH_OPERATION_LOCK_HELD=1 "${PREVIOUS_RELEASE}/backup.sh" --api-already-stopped
BACKUP_GENERATION="$(read_state_value last-backup-generation)"
[ -n "$BACKUP_GENERATION" ] || die "backup generation marker was not written"

log "loading target images"
docker load --input "${SCRIPT_DIR}/images.tar" >/dev/null
validate_images_lock "${SCRIPT_DIR}/images.lock" true

log "ensuring MinIO application policy"
compose_for_release "$TARGET_RELEASE" run --rm minio-init

log "applying target migrations"
compose_for_release "$TARGET_RELEASE" run --rm migrate

log "starting target release"
compose_for_release "$TARGET_RELEASE" up -d api web
wait_container_healthy databench-offline-api 180 || die "target API did not become healthy"
wait_container_healthy databench-offline-web 120 || die "target Web gateway did not start"
run_doctor "$TARGET_RELEASE" >/dev/null || die "target doctor check failed"
wait_gateway "$TARGET_RELEASE" 120 || die "target gateway proxy check failed"
DATABENCH_RELEASE_DIR="$TARGET_RELEASE" "${TARGET_RELEASE}/smoke.sh"

write_state_value previous-version "$PREVIOUS_VERSION"
activate_release "$TARGET_RELEASE" "$TARGET_VERSION"
write_state_value last-success-version "$TARGET_VERSION"
UPGRADE_SUCCEEDED=true
trap - EXIT

log "upgrade succeeded: $PREVIOUS_VERSION -> $TARGET_VERSION"
printf 'Pre-upgrade backup: %s\n' "${DATABENCH_DATA_ROOT}/backups/${BACKUP_GENERATION}"
