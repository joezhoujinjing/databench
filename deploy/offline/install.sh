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
offline_preflight
acquire_operation_lock

if [ -L "$DATABENCH_CURRENT_LINK" ]; then
  INSTALLED_VERSION="$(current_version)"
  [ "$INSTALLED_VERSION" = "$TARGET_VERSION" ] ||
    die "version $INSTALLED_VERSION is already installed; use upgrade.sh for $TARGET_VERSION"
fi

ensure_install_directories
RELEASE_DIR="${DATABENCH_RELEASES_DIR}/${TARGET_VERSION}"
copy_release_assets "$SCRIPT_DIR" "$RELEASE_DIR"
record_bundle_identity "$SCRIPT_DIR" "$RELEASE_DIR"
ensure_secret_config

log "loading offline images"
docker load --input "${SCRIPT_DIR}/images.tar" >/dev/null
validate_images_lock "${SCRIPT_DIR}/images.lock" true

log "starting PostgreSQL and MinIO"
compose_for_release "$RELEASE_DIR" up -d postgres minio
wait_container_healthy databench-offline-postgres 180 || die "PostgreSQL did not become healthy"
wait_container_healthy databench-offline-minio 180 || die "MinIO did not become healthy"

log "creating the MinIO bucket and application user"
compose_for_release "$RELEASE_DIR" run --rm minio-init

log "applying Prisma migrations"
compose_for_release "$RELEASE_DIR" run --rm migrate

log "starting API and Web"
compose_for_release "$RELEASE_DIR" up -d api web
wait_container_healthy databench-offline-api 180 || die "API did not become healthy"
wait_container_healthy databench-offline-web 120 || die "Web gateway did not start"
wait_gateway "$RELEASE_DIR" 120 || die "Caddy did not proxy API health"
DATABENCH_RELEASE_DIR="$RELEASE_DIR" "${RELEASE_DIR}/smoke.sh"
run_doctor "$RELEASE_DIR" >/dev/null || die "backend doctor check failed"

if [ -L "$DATABENCH_CURRENT_LINK" ]; then
  write_state_value previous-version "$TARGET_VERSION"
else
  write_state_value stable-version "$TARGET_VERSION"
fi
activate_release "$RELEASE_DIR" "$TARGET_VERSION"
write_state_value last-success-version "$TARGET_VERSION"
ln -sfn "${DATABENCH_CURRENT_LINK}/databenchctl" /usr/local/bin/databenchctl

SERVER_ADDRESS="$(hostname -I 2>/dev/null | awk '{print $1}')"
[ -n "$SERVER_ADDRESS" ] || SERVER_ADDRESS='<server-ip-or-hostname>'
printf '\nDatabench installation succeeded\n\n'
printf 'URL: http://%s\n' "$SERVER_ADDRESS"
printf 'Configuration: %s\n' "$DATABENCH_CONFIG_FILE"
printf 'Data: %s\n' "$DATABENCH_DATA_ROOT"
printf 'Version: %s\n\n' "$TARGET_VERSION"
printf 'Management: databenchctl status | logs | doctor | backup | restart\n'
printf 'Copy %s to a separate secure location for disaster recovery.\n' "$DATABENCH_BACKUP_KEY_FILE"
