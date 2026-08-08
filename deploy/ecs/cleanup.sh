#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/databench}"
DATABENCH_IMAGE_REPOSITORIES="${DATABENCH_IMAGE_REPOSITORIES:-databench-api databench-evalscope}"
DATABENCH_RELEASE_ARCHIVE_PREFIXES="${DATABENCH_RELEASE_ARCHIVE_PREFIXES:-databench-release databench-api}"
DATABENCH_RELEASES_DIR="${DATABENCH_RELEASES_DIR:-${APP_DIR}/releases}"
DATABENCH_DEPLOY_CONFIG="${DATABENCH_DEPLOY_CONFIG:-${APP_DIR}/deploy.env}"
DATABENCH_DOCKER_BIN="${DATABENCH_DOCKER_BIN:-docker}"

log_cleanup() {
  printf '[databench-cleanup] %s\n' "$*"
}

config_value() {
  local key="$1"
  local fallback="$2"
  local explicit="${!key-}"
  if [[ -n "${explicit}" ]]; then
    printf '%s' "${explicit}"
    return
  fi
  if [[ ! -f "${DATABENCH_DEPLOY_CONFIG}" ]]; then
    printf '%s' "${fallback}"
    return
  fi

  local matches
  matches="$(grep -E "^${key}=" "${DATABENCH_DEPLOY_CONFIG}" || true)"
  if [[ -z "${matches}" ]]; then
    printf '%s' "${fallback}"
    return
  fi
  if [[ "${matches}" == *$'\n'* ]]; then
    echo "duplicate ${key} in ${DATABENCH_DEPLOY_CONFIG}" >&2
    return 78
  fi
  printf '%s' "${matches#*=}"
}

contains_exact() {
  local needle="$1"
  shift
  local candidate
  for candidate in "$@"; do
    if [[ "${candidate}" == "${needle}" ]]; then
      return 0
    fi
  done
  return 1
}

append_unique() {
  local array_name="$1"
  local value="$2"
  eval "local existing=(\"\${${array_name}[@]-}\")"
  if contains_exact "${value}" "${existing[@]}"; then
    return
  fi
  eval "${array_name}+=(\"\${value}\")"
}

file_mtime() {
  local path="$1"
  if stat -c '%Y' "${path}" >/dev/null 2>&1; then
    stat -c '%Y' "${path}"
  else
    stat -f '%m' "${path}"
  fi
}

remove_archive() {
  local mode="$1"
  local path="$2"
  if [[ "${mode}" == 'report' ]]; then
    log_cleanup "would remove archive ${path}"
    return
  fi
  rm -f -- "${path}"
  log_cleanup "removed archive ${path}"
}

remove_image() {
  local mode="$1"
  local image="$2"
  if [[ "${mode}" == 'report' ]]; then
    log_cleanup "would remove image ${image}"
    return
  fi
  "${DATABENCH_DOCKER_BIN}" image rm "${image}" >/dev/null
  log_cleanup "removed image ${image}"
}

cleanup_archives() {
  local mode="$1"
  local keep_count="$2"
  local incoming_archive="$3"
  mkdir -p "${DATABENCH_RELEASES_DIR}"

  local partial prefix
  for prefix in ${DATABENCH_RELEASE_ARCHIVE_PREFIXES}; do
    for partial in "${DATABENCH_RELEASES_DIR}/${prefix}-"*.tar.gz.part; do
      [[ -f "${partial}" ]] || continue
      remove_archive "${mode}" "${partial}"
    done
  done

  local entries=()
  local archive
  for prefix in ${DATABENCH_RELEASE_ARCHIVE_PREFIXES}; do
    for archive in "${DATABENCH_RELEASES_DIR}/${prefix}-"*.tar.gz; do
      [[ -f "${archive}" ]] || continue
      entries+=("$(file_mtime "${archive}")"$'\t'"${archive}")
    done
  done
  if [[ ${#entries[@]} -eq 0 ]]; then
    return
  fi

  local sorted=()
  local entry
  while IFS= read -r entry; do
    [[ -n "${entry}" ]] && sorted+=("${entry}")
  done < <(printf '%s\n' "${entries[@]}" | sort -t $'\t' -k1,1nr -k2,2)

  local kept=()
  if [[ -n "${incoming_archive}" && -f "${incoming_archive}" ]]; then
    kept+=("${incoming_archive}")
  fi

  local path
  for entry in "${sorted[@]}"; do
    path="${entry#*$'\t'}"
    if contains_exact "${path}" "${kept[@]}"; then
      continue
    fi
    if [[ ${#kept[@]} -lt ${keep_count} ]]; then
      kept+=("${path}")
    fi
  done

  for entry in "${sorted[@]}"; do
    path="${entry#*$'\t'}"
    if ! contains_exact "${path}" "${kept[@]}"; then
      remove_archive "${mode}" "${path}"
    fi
  done
}

cleanup_images() {
  local mode="$1"
  local keep_count="$2"
  local incoming_tag="$3"
  local repository="$4"

  local image_entries=()
  local image
  while IFS= read -r image; do
    [[ -n "${image}" ]] || continue
    local inspected
    inspected="$("${DATABENCH_DOCKER_BIN}" image inspect --format '{{.Created}}|{{.Id}}' "${image}")"
    image_entries+=("${inspected}|${image}")
  done < <("${DATABENCH_DOCKER_BIN}" image ls --format '{{.Repository}}:{{.Tag}}' "${repository}" | sort -u)
  if [[ ${#image_entries[@]} -eq 0 ]]; then
    return
  fi

  local sorted=()
  local entry
  while IFS= read -r entry; do
    [[ -n "${entry}" ]] && sorted+=("${entry}")
  done < <(printf '%s\n' "${image_entries[@]}" | sort -r)

  local protected_ids=()
  local container
  while IFS= read -r container; do
    [[ -n "${container}" ]] || continue
    append_unique protected_ids "$("${DATABENCH_DOCKER_BIN}" inspect --format '{{.Image}}' "${container}")"
  done < <("${DATABENCH_DOCKER_BIN}" ps -aq)

  if [[ -n "${incoming_tag}" ]]; then
    local incoming_ref="${repository}:${incoming_tag}"
    if "${DATABENCH_DOCKER_BIN}" image inspect "${incoming_ref}" >/dev/null 2>&1; then
      append_unique protected_ids "$("${DATABENCH_DOCKER_BIN}" image inspect --format '{{.Id}}' "${incoming_ref}")"
    fi
  fi

  local retained_ids=()
  local rest
  local image_id
  for entry in "${sorted[@]}"; do
    rest="${entry#*|}"
    image_id="${rest%%|*}"
    if contains_exact "${image_id}" "${protected_ids[@]}"; then
      append_unique retained_ids "${image_id}"
    fi
  done
  for entry in "${sorted[@]}"; do
    rest="${entry#*|}"
    image_id="${rest%%|*}"
    if contains_exact "${image_id}" "${retained_ids[@]}"; then
      continue
    fi
    if [[ ${#retained_ids[@]} -lt ${keep_count} ]]; then
      retained_ids+=("${image_id}")
    fi
  done

  for entry in "${sorted[@]}"; do
    rest="${entry#*|}"
    image_id="${rest%%|*}"
    image="${rest#*|}"
    if ! contains_exact "${image_id}" "${retained_ids[@]}"; then
      remove_image "${mode}" "${image}"
    fi
  done
}

check_free_space() {
  local minimum_mib="$1"
  local available_kib
  available_kib="$(df -Pk "${APP_DIR}" | awk 'NR == 2 {print $4}')"
  if [[ -z "${available_kib}" ]]; then
    echo "could not determine free space for ${APP_DIR}" >&2
    return 70
  fi
  local available_mib=$((available_kib / 1024))
  log_cleanup "available disk after cleanup: ${available_mib} MiB (minimum ${minimum_mib} MiB)"
  if (( available_mib < minimum_mib )); then
    echo "insufficient free disk for deployment: ${available_mib} MiB available, ${minimum_mib} MiB required" >&2
    return 70
  fi
}

cleanup_databench_releases() {
  local incoming_tag="${1:-}"
  local incoming_archive="${2:-}"
  local phase="${3:-manual}"
  local mode
  local keep_count
  local minimum_mib
  mode="$(config_value DATABENCH_DEPLOY_CLEANUP_MODE auto)"
  keep_count="$(config_value DATABENCH_DEPLOY_KEEP_RELEASES 3)"
  minimum_mib="$(config_value DATABENCH_DEPLOY_MIN_FREE_MIB 4096)"

  if [[ "${mode}" != 'auto' && "${mode}" != 'report' && "${mode}" != 'off' ]]; then
    echo "DATABENCH_DEPLOY_CLEANUP_MODE must be auto, report, or off" >&2
    return 78
  fi
  if [[ ! "${keep_count}" =~ ^[0-9]+$ ]] || (( keep_count < 2 || keep_count > 20 )); then
    echo "DATABENCH_DEPLOY_KEEP_RELEASES must be an integer from 2 through 20" >&2
    return 78
  fi
  if [[ ! "${minimum_mib}" =~ ^[0-9]+$ ]] || (( minimum_mib < 512 )); then
    echo "DATABENCH_DEPLOY_MIN_FREE_MIB must be an integer of at least 512" >&2
    return 78
  fi
  if [[ -n "${incoming_tag}" && ! "${incoming_tag}" =~ ^[0-9a-f]{7,64}$ ]]; then
    echo "incoming release tag must be a 7-64 character lowercase hexadecimal Git revision" >&2
    return 64
  fi

  log_cleanup "phase=${phase} mode=${mode} keep=${keep_count}"
  if [[ "${mode}" != 'off' ]]; then
    cleanup_archives "${mode}" "${keep_count}" "${incoming_archive}"
    local repository
    for repository in ${DATABENCH_IMAGE_REPOSITORIES}; do
      cleanup_images "${mode}" "${keep_count}" "${incoming_tag}" "${repository}"
    done
  else
    log_cleanup 'cleanup disabled; disk admission still applies'
  fi
  check_free_space "${minimum_mib}"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  cleanup_databench_releases "${1:-}" "${2:-}" "${3:-manual}"
fi
