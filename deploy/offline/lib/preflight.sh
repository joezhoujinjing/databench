#!/usr/bin/env bash

set -Eeuo pipefail

offline_preflight() {
  local docker_version compose_version free_kb min_free_kb published data_probe
  local workspace_free_kb min_workspace_free_kb
  [ -r /etc/os-release ] || die "cannot identify the target operating system"
  # shellcheck disable=SC1091
  source /etc/os-release
  [ "${ID:-}" = 'ubuntu' ] && [ "${VERSION_ID:-}" = '22.04' ] ||
    die "target must be Ubuntu 22.04 LTS"
  [ "$(uname -m)" = 'x86_64' ] || die "target architecture must be amd64/x86_64"

  require_command docker
  require_command openssl
  require_command od
  require_command flock
  docker info >/dev/null 2>&1 || die "Docker daemon is not available"
  docker_version="$(docker version --format '{{.Server.Version}}')"
  compose_version="$(docker compose version --short)"
  version_ge "$docker_version" '24.0.0' || die "Docker Engine 24 or newer is required"
  version_ge "$compose_version" '2.20.0' || die "Docker Compose 2.20 or newer is required"

  free_kb="$(df -Pk / | awk 'NR==2 {print $4}')"
  min_free_kb=$(( ${DATABENCH_MIN_FREE_GB:-20} * 1024 * 1024 ))
  [ "$free_kb" -ge "$min_free_kb" ] ||
    die "at least ${DATABENCH_MIN_FREE_GB:-20} GiB free disk space is required"

  data_probe="$DATABENCH_DATA_ROOT"
  while [ ! -e "$data_probe" ]; do
    data_probe="$(dirname "$data_probe")"
  done
  workspace_free_kb="$(df -Pk "$data_probe" | awk 'NR==2 {print $4}')"
  min_workspace_free_kb=$(( ${DATABENCH_MIN_WORKSPACE_FREE_GB:-4} * 1024 * 1024 ))
  [ "$workspace_free_kb" -ge "$min_workspace_free_kb" ] ||
    die "at least ${DATABENCH_MIN_WORKSPACE_FREE_GB:-4} GiB free space is required on the Databench data filesystem"

  published="$(docker ps --filter publish=80 --format '{{.Names}}' | grep -v '^databench-offline-web$' || true)"
  [ -z "$published" ] || die "TCP port 80 is already published by another container: $published"
}
