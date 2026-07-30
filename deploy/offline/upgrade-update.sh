#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"
# shellcheck source=lib/manifest.sh
source "${SCRIPT_DIR}/lib/manifest.sh"
# shellcheck source=lib/update-manifest.sh
source "${SCRIPT_DIR}/lib/update-manifest.sh"
# shellcheck source=lib/config.sh
source "${SCRIPT_DIR}/lib/config.sh"
# shellcheck source=lib/health.sh
source "${SCRIPT_DIR}/lib/health.sh"
# shellcheck source=lib/preflight.sh
source "${SCRIPT_DIR}/lib/preflight.sh"

require_root
verify_outer_bundle "$SCRIPT_DIR"
verify_inner_bundle "$SCRIPT_DIR"
validate_update_bundle_contract "$SCRIPT_DIR"
TARGET_VERSION="$UPDATE_TARGET_VERSION"
TARGET_ROLLBACK_MODE="$UPDATE_ROLLBACK_MODE"

PREVIOUS_RELEASE="$(current_release_dir)"
validate_release_contract "$PREVIOUS_RELEASE"
load_release_env "${PREVIOUS_RELEASE}/release.env"
PREVIOUS_VERSION="$DATABENCH_VERSION"
[ "$PREVIOUS_VERSION" = "$UPDATE_BASE_VERSION" ] ||
  die "this update requires version $UPDATE_BASE_VERSION; installed version is $PREVIOUS_VERSION"
[ -f "${PREVIOUS_RELEASE}/release-bundle.sha256" ] ||
  die "installed base release does not record its bundle checksum"
INSTALLED_BASE_SHA256="$(sed -n '1p' "${PREVIOUS_RELEASE}/release-bundle.sha256")"
[[ "$INSTALLED_BASE_SHA256" =~ ^[0-9a-f]{64}$ ]] ||
  die "installed base release bundle checksum is invalid"
[ "$INSTALLED_BASE_SHA256" = "$UPDATE_BASE_BUNDLE_SHA256" ] ||
  die "installed release differs from the exact base bundle required by this update"

offline_preflight upgrade
acquire_operation_lock
ensure_secret_config
ensure_mcp_config
PREVIOUS_SWIFT_ENABLED=false
PREVIOUS_SWIFT_MODE='ui-only'
if [ -f "$DATABENCH_SWIFT_CONFIG_FILE" ]; then
  validate_swift_config
  PREVIOUS_SWIFT_ENABLED="$(
    grep -E '^DATABENCH_SWIFT_ENABLED=' "$DATABENCH_SWIFT_CONFIG_FILE" | cut -d= -f2-
  )"
  PREVIOUS_SWIFT_MODE="$(swift_runtime_mode)"
fi
TARGET_SWIFT_ENABLED="$(requested_swift_enabled_state)"
ensure_evalscope_config

POSTGRES_VERSION_NUM="$(docker exec databench-offline-postgres sh -ec \
  'psql --no-align --tuples-only --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -c "SHOW server_version_num"')"
[ $((POSTGRES_VERSION_NUM / 10000)) -eq 17 ] ||
  die "incremental update requires PostgreSQL major 17"

TARGET_RELEASE="${DATABENCH_RELEASES_DIR}/${TARGET_VERSION}"
materialize_incremental_release "$SCRIPT_DIR" "$PREVIOUS_RELEASE" "$TARGET_RELEASE"
ensure_evalscope_data_directories
ensure_swift_data_directories

BACKUP_GENERATION=''
UPGRADE_SUCCEEDED=false
RECOVERY_SUCCEEDED=false

recover_previous_release() {
  local status=$?
  trap - EXIT
  if [ "$UPGRADE_SUCCEEDED" = true ]; then
    exit "$status"
  fi

  warn "incremental update failed; restoring release $PREVIOUS_VERSION"
  if ! stop_application_services "$TARGET_RELEASE" >/dev/null 2>&1; then
    warn "target services did not stop gracefully; forcing them to stop"
    force_stop_application_services "$TARGET_RELEASE" >/dev/null 2>&1 ||
      warn "one or more target services could not be stopped"
  fi
  if [ -f "$DATABENCH_SWIFT_CONFIG_FILE" ]; then
    set_swift_enabled_state "$PREVIOUS_SWIFT_ENABLED" >/dev/null 2>&1 ||
      warn "failed to restore the previous Swift enabled state"
    set_swift_runtime_mode_state "$PREVIOUS_SWIFT_MODE" >/dev/null 2>&1 ||
      warn "failed to restore the previous Swift runtime mode"
  fi

  if [ "$TARGET_ROLLBACK_MODE" = 'restore-backup' ] && [ -n "$BACKUP_GENERATION" ]; then
    if ! DATABENCH_OPERATION_LOCK_HELD=1 "${PREVIOUS_RELEASE}/restore.sh" \
      "${DATABENCH_DATA_ROOT}/backups/${BACKUP_GENERATION}" --confirm \
      --skip-safety-backup --api-already-stopped --keep-stopped; then
      warn "automatic database restore failed"
    fi
  fi

  if start_application_services "$PREVIOUS_RELEASE" &&
    wait_application_services "$PREVIOUS_RELEASE" &&
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
    printf '  sudo %s/databenchctl restart\n' "$PREVIOUS_RELEASE" >&2
  fi
  exit "$status"
}

log "stopping API writes for incremental update"
stop_application_services "$PREVIOUS_RELEASE"
trap recover_previous_release EXIT
assert_swift_session_transition_compatible \
  "$PREVIOUS_RELEASE" "$TARGET_RELEASE" "$TARGET_SWIFT_ENABLED" ||
  die "close the active Swift Studio Session before changing this runtime"

log "creating pre-update backup"
DATABENCH_OPERATION_LOCK_HELD=1 "${PREVIOUS_RELEASE}/backup.sh" --api-already-stopped
BACKUP_GENERATION="$(read_state_value last-backup-generation)"
[ -n "$BACKUP_GENERATION" ] || die "backup generation marker was not written"

ensure_swift_config
ensure_evalscope_config

log "loading changed images: $UPDATE_COMPONENTS"
docker load --input "${SCRIPT_DIR}/images.tar" >/dev/null
validate_images_lock \
  "${SCRIPT_DIR}/changed-images.lock" true "$(update_component_count "$UPDATE_COMPONENTS")"
validate_images_lock \
  "${TARGET_RELEASE}/images.lock" true "$(release_image_count "$TARGET_RELEASE")"
if release_swift_gpu_enabled "$TARGET_RELEASE"; then
  verify_swift_model_preload "$TARGET_RELEASE"
  verify_swift_gpu_runtime "$TARGET_RELEASE"
fi

log "ensuring MinIO application policy"
compose_for_release "$TARGET_RELEASE" run --rm minio-init

log "applying target migrations"
compose_for_release "$TARGET_RELEASE" run --rm migrate

log "starting target release"
start_application_services "$TARGET_RELEASE" || die "target application services did not start"
wait_application_services "$TARGET_RELEASE" ||
  die "target application services did not become healthy"
run_doctor "$TARGET_RELEASE" >/dev/null || die "target doctor check failed"
wait_gateway "$TARGET_RELEASE" 120 || die "target gateway proxy check failed"
DATABENCH_RELEASE_DIR="$TARGET_RELEASE" "${TARGET_RELEASE}/smoke.sh"

write_state_value previous-version "$PREVIOUS_VERSION"
activate_release "$TARGET_RELEASE" "$TARGET_VERSION"
write_state_value last-success-version "$TARGET_VERSION"
UPGRADE_SUCCEEDED=true
trap - EXIT

log "incremental update succeeded: $PREVIOUS_VERSION -> $TARGET_VERSION"
printf 'Changed components: %s\n' "$UPDATE_COMPONENTS"
printf 'Pre-update backup: %s\n' "${DATABENCH_DATA_ROOT}/backups/${BACKUP_GENERATION}"
