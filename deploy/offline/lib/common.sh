#!/usr/bin/env bash

set -Eeuo pipefail

DATABENCH_INSTALL_ROOT="${DATABENCH_INSTALL_ROOT:-/opt/databench-offline}"
DATABENCH_CONFIG_DIR="${DATABENCH_CONFIG_DIR:-/etc/databench}"
DATABENCH_CONFIG_FILE="${DATABENCH_CONFIG_FILE:-${DATABENCH_CONFIG_DIR}/databench.env}"
DATABENCH_MCP_CONFIG_FILE="${DATABENCH_MCP_CONFIG_FILE:-${DATABENCH_CONFIG_DIR}/mcp.env}"
DATABENCH_EVALSCOPE_CONFIG_FILE="${DATABENCH_EVALSCOPE_CONFIG_FILE:-${DATABENCH_CONFIG_DIR}/evalscope.env}"
DATABENCH_SWIFT_CONFIG_FILE="${DATABENCH_SWIFT_CONFIG_FILE:-${DATABENCH_CONFIG_DIR}/swift.env}"
DATABENCH_BACKUP_KEY_FILE="${DATABENCH_BACKUP_KEY_FILE:-${DATABENCH_CONFIG_DIR}/backup.key}"
DATABENCH_DATA_ROOT="${DATABENCH_DATA_ROOT:-/srv/databench}"
DATABENCH_STATE_DIR="${DATABENCH_STATE_DIR:-${DATABENCH_INSTALL_ROOT}/state}"
DATABENCH_RELEASES_DIR="${DATABENCH_RELEASES_DIR:-${DATABENCH_INSTALL_ROOT}/releases}"
DATABENCH_CURRENT_LINK="${DATABENCH_CURRENT_LINK:-${DATABENCH_INSTALL_ROOT}/current}"

log() {
  printf '[databench] %s\n' "$*"
}

warn() {
  printf '[databench] WARNING: %s\n' "$*" >&2
}

die() {
  printf '[databench] ERROR: %s\n' "$*" >&2
  exit 1
}

require_root() {
  if [ "$(id -u)" -ne 0 ]; then
    die "run this command with sudo"
  fi
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command is missing: $1"
}

sha256_file() {
  local file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print $1}'
  else
    die "sha256sum or shasum is required"
  fi
}

verify_checksum_file() {
  local directory="$1"
  local checksum_file="$2"
  if command -v sha256sum >/dev/null 2>&1; then
    (cd "$directory" && sha256sum --check --strict "$(basename "$checksum_file")")
  elif command -v shasum >/dev/null 2>&1; then
    (cd "$directory" && shasum -a 256 --check "$(basename "$checksum_file")")
  else
    die "sha256sum or shasum is required"
  fi
}

verify_outer_bundle() {
  local bundle_dir="$1"
  local archive="${bundle_dir}.tar.gz"
  local checksum="${archive}.sha256"

  [ -f "$archive" ] || die "missing original bundle archive beside extracted directory: $archive"
  [ -f "$checksum" ] || die "missing outer checksum: $checksum"
  verify_checksum_file "$(dirname "$archive")" "$checksum"
}

verify_inner_bundle() {
  local bundle_dir="$1"
  [ -f "${bundle_dir}/SHA256SUMS" ] || die "missing SHA256SUMS in bundle"
  verify_checksum_file "$bundle_dir" "${bundle_dir}/SHA256SUMS"
}

version_ge() {
  local actual="$1"
  local required="$2"
  local actual_major actual_minor actual_patch required_major required_minor required_patch
  IFS=. read -r actual_major actual_minor actual_patch <<EOF
${actual%%[-+]*}
EOF
  IFS=. read -r required_major required_minor required_patch <<EOF
${required%%[-+]*}
EOF
  actual_patch="${actual_patch:-0}"
  required_patch="${required_patch:-0}"
  [ "$actual_major" -gt "$required_major" ] || {
    [ "$actual_major" -eq "$required_major" ] && {
      [ "$actual_minor" -gt "$required_minor" ] || {
        [ "$actual_minor" -eq "$required_minor" ] && [ "$actual_patch" -ge "$required_patch" ]
      }
    }
  }
}

version_gt() {
  version_ge "$1" "$2" && [ "$1" != "$2" ]
}

validate_app_version() {
  [[ "$1" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] ||
    die "application version must use numeric major.minor.patch: $1"
}

load_release_env() {
  local file="$1"
  local line key value seen='|'

  DATABENCH_VERSION=''
  DATABENCH_API_IMAGE=''
  DATABENCH_WEB_IMAGE=''
  DATABENCH_WORKER_IMAGE=''
  DATABENCH_EVALSCOPE_IMAGE=''
  DATABENCH_SWIFT_IMAGE=''
  DATABENCH_SWIFT_IMAGE_DIGEST=''
  DATABENCH_POSTGRES_IMAGE=''
  DATABENCH_MINIO_IMAGE=''
  DATABENCH_MINIO_MC_IMAGE=''

  while IFS= read -r line || [ -n "$line" ]; do
    [ -z "$line" ] && continue
    [[ "$line" =~ ^[A-Z0-9_]+=[A-Za-z0-9._/@:+-]+$ ]] || die "invalid release.env line"
    key="${line%%=*}"
    value="${line#*=}"
    case "$seen" in
      *"|${key}|"*) die "duplicate release.env key: $key" ;;
    esac
    seen="${seen}${key}|"
    case "$key" in
      DATABENCH_VERSION) DATABENCH_VERSION="$value" ;;
      DATABENCH_API_IMAGE) DATABENCH_API_IMAGE="$value" ;;
      DATABENCH_WEB_IMAGE) DATABENCH_WEB_IMAGE="$value" ;;
      DATABENCH_WORKER_IMAGE) DATABENCH_WORKER_IMAGE="$value" ;;
      DATABENCH_EVALSCOPE_IMAGE) DATABENCH_EVALSCOPE_IMAGE="$value" ;;
      DATABENCH_SWIFT_IMAGE) DATABENCH_SWIFT_IMAGE="$value" ;;
      DATABENCH_SWIFT_IMAGE_DIGEST) DATABENCH_SWIFT_IMAGE_DIGEST="$value" ;;
      DATABENCH_POSTGRES_IMAGE) DATABENCH_POSTGRES_IMAGE="$value" ;;
      DATABENCH_MINIO_IMAGE) DATABENCH_MINIO_IMAGE="$value" ;;
      DATABENCH_MINIO_MC_IMAGE) DATABENCH_MINIO_MC_IMAGE="$value" ;;
      *) die "unknown release.env key: $key" ;;
    esac
  done < "$file"

  for key in DATABENCH_VERSION DATABENCH_API_IMAGE DATABENCH_WEB_IMAGE \
    DATABENCH_POSTGRES_IMAGE DATABENCH_MINIO_IMAGE DATABENCH_MINIO_MC_IMAGE; do
    eval "value=\${$key}"
    [ -n "$value" ] || die "missing release.env key: $key"
    case "$value" in
      *latest*) die "release.env must not contain latest: $key" ;;
    esac
    export "$key=$value"
  done

  if [ -n "$DATABENCH_WORKER_IMAGE" ]; then
    case "$DATABENCH_WORKER_IMAGE" in
      *latest*) die "release.env must not contain latest: DATABENCH_WORKER_IMAGE" ;;
    esac
    export DATABENCH_WORKER_IMAGE
  else
    unset DATABENCH_WORKER_IMAGE
  fi

  if [ -n "$DATABENCH_EVALSCOPE_IMAGE" ]; then
    case "$DATABENCH_EVALSCOPE_IMAGE" in
      *latest*) die "release.env must not contain latest: DATABENCH_EVALSCOPE_IMAGE" ;;
    esac
    export DATABENCH_EVALSCOPE_IMAGE
  else
    unset DATABENCH_EVALSCOPE_IMAGE
  fi

  if [ -n "$DATABENCH_SWIFT_IMAGE" ]; then
    case "$DATABENCH_SWIFT_IMAGE" in
      *latest*) die "release.env must not contain latest: DATABENCH_SWIFT_IMAGE" ;;
    esac
    [[ "$DATABENCH_SWIFT_IMAGE_DIGEST" =~ ^[0-9a-f]{64}$ ]] ||
      die "Swift release requires a raw 64-hex DATABENCH_SWIFT_IMAGE_DIGEST"
    export DATABENCH_SWIFT_IMAGE DATABENCH_SWIFT_IMAGE_DIGEST
  else
    [ -z "$DATABENCH_SWIFT_IMAGE_DIGEST" ] ||
      die "release.env contains a Swift digest without a Swift image"
    unset DATABENCH_SWIFT_IMAGE DATABENCH_SWIFT_IMAGE_DIGEST
  fi

  validate_app_version "$DATABENCH_VERSION"
}

validate_images_lock() {
  local file="$1"
  local verify_loaded="${2:-false}"
  local expected_count="${3:-}"
  local line image digest platform source count=0 actual_digest actual_arch seen='|'

  if [ -z "$expected_count" ]; then
    expected_count=5
    if [ -n "${DATABENCH_WORKER_IMAGE:-}" ]; then expected_count=$((expected_count + 1)); fi
    if [ -n "${DATABENCH_EVALSCOPE_IMAGE:-}" ]; then expected_count=$((expected_count + 1)); fi
    if [ -n "${DATABENCH_SWIFT_IMAGE:-}" ]; then expected_count=$((expected_count + 1)); fi
  fi

  while IFS='|' read -r image digest platform source; do
    [ -z "$image" ] && continue
    case "$image" in \#*) continue ;; esac
    [[ "$image" =~ ^[A-Za-z0-9._/@:+-]+$ ]] || die "invalid image in images.lock"
    case "$seen" in
      *"|${image}|"*) die "duplicate image in images.lock: $image" ;;
    esac
    seen="${seen}${image}|"
    [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || die "invalid digest in images.lock: $image"
    [ "$platform" = 'linux/amd64' ] || die "unsupported platform in images.lock: $platform"
    [ -n "$source" ] || die "missing source in images.lock: $image"
    count=$((count + 1))
    if [ "$verify_loaded" = 'true' ]; then
      actual_digest="$(docker image inspect "$image" --format '{{.Id}}' 2>/dev/null)" ||
        die "bundle image was not loaded: $image"
      actual_arch="$(docker image inspect "$image" --format '{{.Os}}/{{.Architecture}}')"
      [ "$actual_digest" = "$digest" ] || die "loaded image digest mismatch: $image"
      [ "$actual_arch" = 'linux/amd64' ] || die "loaded image has wrong platform: $image ($actual_arch)"
    fi
  done < "$file"

  [ "$count" -eq "$expected_count" ] ||
    die "images.lock must contain exactly $expected_count images"
}

release_has_worker() {
  local release_dir="$1"
  grep -Eq '^DATABENCH_WORKER_IMAGE=[A-Za-z0-9._/@:+-]+$' "${release_dir}/release.env"
}

release_has_evalscope() {
  local release_dir="$1"
  grep -Eq '^DATABENCH_EVALSCOPE_IMAGE=[A-Za-z0-9._/@:+-]+$' "${release_dir}/release.env"
}

release_has_swift() {
  local release_dir="$1"
  grep -Eq '^DATABENCH_SWIFT_IMAGE=[A-Za-z0-9._/@:+-]+$' "${release_dir}/release.env" &&
    grep -Eq '^DATABENCH_SWIFT_IMAGE_DIGEST=[0-9a-f]{64}$' "${release_dir}/release.env"
}

release_swift_image_digest() {
  local release_dir="$1"
  release_has_swift "$release_dir" || return 1
  sed -n 's/^DATABENCH_SWIFT_IMAGE_DIGEST=//p' "${release_dir}/release.env"
}

release_swift_enabled() {
  local release_dir="$1"
  release_has_swift "$release_dir" &&
    [ -f "$DATABENCH_SWIFT_CONFIG_FILE" ] &&
    grep -qx 'DATABENCH_SWIFT_ENABLED=true' "$DATABENCH_SWIFT_CONFIG_FILE"
}

swift_container_exists() {
  docker inspect databench-offline-swift-studio >/dev/null 2>&1
}

swift_container_running() {
  [ "$(docker inspect --format '{{.State.Running}}' \
    databench-offline-swift-studio 2>/dev/null || true)" = 'true' ]
}

active_swift_session_binding() {
  docker exec databench-offline-postgres sh -ec '
    psql --no-align --tuples-only --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -c "
      SELECT id::text || chr(124) || image_digest
      FROM swift_studio_sessions_v2
      WHERE status IN (\$\$preparing\$\$, \$\$ready\$\$, \$\$closing\$\$)
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    "
  '
}

assert_swift_session_transition_compatible() {
  local source_release="$1"
  local target_release="$2"
  local target_enabled="$3"
  local binding session_id session_digest source_digest target_digest=''

  [ "$target_enabled" = 'true' ] || [ "$target_enabled" = 'false' ] ||
    die "target Swift enabled state must be true or false"
  release_has_swift "$source_release" || return 0

  binding="$(active_swift_session_binding)" || {
    warn "could not inspect active Swift Studio Session lineage"
    return 1
  }
  [ -n "$binding" ] || return 0
  [[ "$binding" =~ ^[0-9a-f-]{36}\|[0-9a-f]{64}$ ]] || {
    warn "active Swift Studio Session lineage has an unexpected format"
    return 1
  }

  session_id="${binding%%|*}"
  session_digest="${binding#*|}"
  source_digest="$(release_swift_image_digest "$source_release")"
  if [ "$session_digest" != "$source_digest" ]; then
    warn "active Swift Studio Session $session_id is bound to a different image digest; close it before maintenance"
    return 1
  fi
  if [ "$target_enabled" != 'true' ]; then
    warn "active Swift Studio Session $session_id must be closed before disabling or removing Swift Studio"
    return 1
  fi
  if release_has_swift "$target_release"; then
    target_digest="$(release_swift_image_digest "$target_release")"
  fi
  if [ "$target_digest" != "$session_digest" ]; then
    warn "active Swift Studio Session $session_id must be closed before changing the Swift Studio image"
    return 1
  fi
}

release_image_count() {
  local release_dir="$1"
  local count=5
  if release_has_worker "$release_dir"; then count=$((count + 1)); fi
  if release_has_evalscope "$release_dir"; then count=$((count + 1)); fi
  if release_has_swift "$release_dir"; then count=$((count + 1)); fi
  printf '%s\n' "$count"
}

stop_application_services() {
  local release_dir="$1"
  compose_for_release "$release_dir" stop web
  if release_has_swift "$release_dir" && swift_container_running; then
    if ! assert_swift_idle "$release_dir"; then
      compose_for_release "$release_dir" up -d web >/dev/null 2>&1 || true
      return 1
    fi
  fi
  if release_has_evalscope "$release_dir"; then
    if ! drain_evalscope "$release_dir" "${DATABENCH_EVALSCOPE_DRAIN_TIMEOUT_SECONDS:-300}"; then
      compose_for_release "$release_dir" up -d web >/dev/null 2>&1 || true
      return 1
    fi
    compose_for_release "$release_dir" stop api evalscope
  else
    compose_for_release "$release_dir" stop api
  fi
  if release_has_worker "$release_dir"; then
    compose_for_release "$release_dir" stop worker
  fi
  if release_has_swift "$release_dir" && swift_container_exists; then
    compose_for_release "$release_dir" stop swift-studio
  fi
}

force_stop_application_services() {
  local release_dir="$1"
  local services=(web api)
  if release_has_evalscope "$release_dir"; then
    services+=(evalscope)
  fi
  if release_has_worker "$release_dir"; then
    services+=(worker)
  fi
  if release_has_swift "$release_dir" && swift_container_exists; then
    services+=(swift-studio)
  fi
  compose_for_release "$release_dir" stop "${services[@]}"
}

remove_application_services_absent_from_release() {
  local source_release="$1"
  local target_release="$2"
  local services=()
  if release_has_evalscope "$source_release" && ! release_has_evalscope "$target_release"; then
    services+=(evalscope)
  fi
  if release_has_worker "$source_release" && ! release_has_worker "$target_release"; then
    services+=(worker)
  fi
  if release_has_swift "$source_release" && ! release_swift_enabled "$target_release"; then
    services+=(swift-studio)
  fi
  if [ "${#services[@]}" -gt 0 ]; then
    compose_for_release "$source_release" rm --stop --force "${services[@]}"
  fi
}

compose_for_release() {
  local release_dir="$1"
  local -a compose_args
  shift
  [ -f "${release_dir}/compose.yml" ] || die "release is missing compose.yml: $release_dir"
  [ -f "$DATABENCH_CONFIG_FILE" ] || die "configuration is missing: $DATABENCH_CONFIG_FILE"
  (
    # Shell variables have higher interpolation precedence than --env-file.
    # Release-management scripts load both current and target manifests, so
    # never let a previously exported image set select the wrong release.
    unset DATABENCH_VERSION DATABENCH_API_IMAGE DATABENCH_WEB_IMAGE DATABENCH_WORKER_IMAGE
    unset DATABENCH_EVALSCOPE_IMAGE DATABENCH_SWIFT_IMAGE DATABENCH_SWIFT_IMAGE_DIGEST
    unset DATABENCH_POSTGRES_IMAGE DATABENCH_MINIO_IMAGE DATABENCH_MINIO_MC_IMAGE
    unset DATABENCH_SWIFT_ENABLED DATABENCH_SWIFT_GPU_DEVICE_ID
    compose_args=(
      --project-name databench-offline \
      --env-file "${release_dir}/release.env" \
      --env-file "$DATABENCH_CONFIG_FILE" \
    )
    if release_has_swift "$release_dir"; then
      [ -f "$DATABENCH_SWIFT_CONFIG_FILE" ] ||
        die "Swift configuration is missing: $DATABENCH_SWIFT_CONFIG_FILE"
      compose_args+=(--env-file "$DATABENCH_SWIFT_CONFIG_FILE")
      if release_swift_enabled "$release_dir"; then
        compose_args+=(--profile swift-gpu)
      fi
    fi
    docker compose "${compose_args[@]}" --file "${release_dir}/compose.yml" "$@"
  )
}

current_release_dir() {
  [ -L "$DATABENCH_CURRENT_LINK" ] || die "Databench is not installed"
  readlink -f "$DATABENCH_CURRENT_LINK"
}

current_version() {
  local release_dir
  release_dir="$(current_release_dir)"
  load_release_env "${release_dir}/release.env"
  printf '%s\n' "$DATABENCH_VERSION"
}

activate_release() {
  local release_dir="$1"
  local version="$2"
  local temp_link="${DATABENCH_INSTALL_ROOT}/.current.$$"
  ln -s "$release_dir" "$temp_link"
  mv -Tf "$temp_link" "$DATABENCH_CURRENT_LINK"
  printf '%s\n' "$version" > "${DATABENCH_STATE_DIR}/current-version"
}

record_bundle_identity() {
  local source_dir="$1"
  local release_dir="$2"
  local archive="${source_dir}.tar.gz"
  printf '%s\n' "$(basename "$archive")" > "${release_dir}/release-bundle.name"
  sha256_file "$archive" > "${release_dir}/release-bundle.sha256"
}

copy_release_assets() {
  local source_dir="$1"
  local release_dir="$2"
  local item
  install -d -m 0755 "$release_dir"
  for item in compose.yml release.env release-manifest.json images.lock SHA256SUMS RELEASE.txt \
    env.example mcp.env.example evalscope.env.example swift.env.example install.sh upgrade.sh rollback.sh backup.sh \
    restore.sh smoke.sh \
    databenchctl Caddyfile README.zh-CN.md DEPLOYMENT-GUIDE.zh-CN.md \
    TROUBLESHOOTING.zh-CN.md MCP-AGENT-GUIDE.zh-CN.md EVALSCOPE-OPERATOR-GUIDE.zh-CN.md \
    SWIFT-STUDIO-OPERATOR-GUIDE.zh-CN.md \
    docs lib minio smoke; do
    [ -e "${source_dir}/${item}" ] || die "bundle asset is missing: $item"
    rm -rf "${release_dir:?}/${item}"
    cp -a "${source_dir}/${item}" "${release_dir}/${item}"
  done
  chmod 0755 "${release_dir}"/*.sh "${release_dir}/databenchctl"
}

ensure_install_directories() {
  install -d -m 0755 "$DATABENCH_INSTALL_ROOT" "$DATABENCH_RELEASES_DIR" "$DATABENCH_STATE_DIR"
  install -d -m 0700 "$DATABENCH_CONFIG_DIR"
  install -d -m 0750 "$DATABENCH_DATA_ROOT" "${DATABENCH_DATA_ROOT}/backups"
  install -d -m 0700 "${DATABENCH_DATA_ROOT}/postgres" "${DATABENCH_DATA_ROOT}/minio"
  install -d -o 1000 -g 1000 -m 0750 "${DATABENCH_DATA_ROOT}/workspace"
  ensure_evalscope_data_directories
  if [ -n "${DATABENCH_SWIFT_IMAGE:-}" ]; then
    ensure_swift_data_directories
  fi
}

ensure_evalscope_data_directories() {
  install -d -o 10001 -g 10001 -m 0750 \
    "${DATABENCH_DATA_ROOT}/evalscope" \
    "${DATABENCH_DATA_ROOT}/evalscope/outputs" \
    "${DATABENCH_DATA_ROOT}/evalscope/inputs"
}

ensure_swift_data_directories() {
  install -d -o 10002 -g 10002 -m 0750 "${DATABENCH_DATA_ROOT}/swift-studio"
  install -d -o root -g root -m 0755 "${DATABENCH_DATA_ROOT}/swift-models"
}

write_state_value() {
  local name="$1"
  local value="$2"
  local temp="${DATABENCH_STATE_DIR}/.${name}.$$"
  printf '%s\n' "$value" > "$temp"
  mv -f "$temp" "${DATABENCH_STATE_DIR}/${name}"
}

acquire_operation_lock() {
  if [ "${DATABENCH_OPERATION_LOCK_HELD:-0}" = '1' ]; then
    return
  fi
  require_command flock
  install -d -m 0755 /run/lock
  exec 9>/run/lock/databench-offline.lock
  flock -n 9 || die "another Databench install/upgrade/backup/restore operation is running"
  export DATABENCH_OPERATION_LOCK_HELD=1
}

read_state_value() {
  local name="$1"
  [ -f "${DATABENCH_STATE_DIR}/${name}" ] || return 1
  sed -n '1p' "${DATABENCH_STATE_DIR}/${name}"
}
