#!/usr/bin/env bash

set -Eeuo pipefail

offline_preflight() {
  local docker_version compose_version free_kb min_free_kb published data_probe cpu_count
  local memory_kb min_memory_kb
  local workspace_free_kb min_workspace_free_kb
  local min_cpus min_memory_gb min_free_gb min_workspace_free_gb
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

  min_cpus="${DATABENCH_MIN_CPUS:-8}"
  min_memory_gb="${DATABENCH_MIN_MEMORY_GB:-30}"
  min_free_gb="${DATABENCH_MIN_FREE_GB:-40}"
  min_workspace_free_gb="${DATABENCH_MIN_WORKSPACE_FREE_GB:-4}"
  for value in "$min_cpus" "$min_memory_gb" "$min_free_gb" "$min_workspace_free_gb"; do
    [[ "$value" =~ ^[1-9][0-9]*$ ]] || die "preflight minimums must be positive integers"
  done

  cpu_count="$(getconf _NPROCESSORS_ONLN)"
  [ "$cpu_count" -ge "$min_cpus" ] ||
    die "at least $min_cpus logical CPUs are required for the offline Worker"
  memory_kb="$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)"
  [[ "$memory_kb" =~ ^[0-9]+$ ]] || die "cannot determine total system memory"
  min_memory_kb=$((min_memory_gb * 1024 * 1024))
  [ "$memory_kb" -ge "$min_memory_kb" ] ||
    die "at least $min_memory_gb GiB RAM is required for the offline Worker"

  free_kb="$(df -Pk / | awk 'NR==2 {print $4}')"
  min_free_kb=$((min_free_gb * 1024 * 1024))
  [ "$free_kb" -ge "$min_free_kb" ] ||
    die "at least $min_free_gb GiB free disk space is required"

  data_probe="$DATABENCH_DATA_ROOT"
  while [ ! -e "$data_probe" ]; do
    data_probe="$(dirname "$data_probe")"
  done
  workspace_free_kb="$(df -Pk "$data_probe" | awk 'NR==2 {print $4}')"
  min_workspace_free_kb=$((min_workspace_free_gb * 1024 * 1024))
  [ "$workspace_free_kb" -ge "$min_workspace_free_kb" ] ||
    die "at least $min_workspace_free_gb GiB free space is required on the Databench data filesystem"

  published="$(docker ps --filter publish=80 --format '{{.Names}}' | grep -v '^databench-offline-web$' || true)"
  [ -z "$published" ] || die "TCP port 80 is already published by another container: $published"
}
