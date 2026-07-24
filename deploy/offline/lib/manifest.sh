#!/usr/bin/env bash

set -Eeuo pipefail

load_release_manifest() {
  local file="$1"
  local json pattern
  json="$(tr -d '\r\n' < "$file")"
  pattern='^\{"schema_version":1,"app_version":"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)","git_sha":"[0-9a-f]{40}","platform":"linux/amd64","min_upgrade_from":"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)","postgres_major":17,"database_migration":"(expand-only|restore-on-rollback)","rollback_mode":"(image-only|restore-backup)","object_migration":"none","images_lock_sha256":"[0-9a-f]{64}"\}$'
  [[ "$json" =~ $pattern ]] || die "release-manifest.json does not match schema version 1"

  MANIFEST_SCHEMA_VERSION=1
  MANIFEST_APP_VERSION="$(printf '%s' "$json" | sed -E 's/.*"app_version":"([^"]+)".*/\1/')"
  MANIFEST_GIT_SHA="$(printf '%s' "$json" | sed -E 's/.*"git_sha":"([^"]+)".*/\1/')"
  MANIFEST_PLATFORM='linux/amd64'
  MANIFEST_MIN_UPGRADE_FROM="$(printf '%s' "$json" | sed -E 's/.*"min_upgrade_from":"([^"]+)".*/\1/')"
  MANIFEST_POSTGRES_MAJOR=17
  MANIFEST_DATABASE_MIGRATION="$(printf '%s' "$json" | sed -E 's/.*"database_migration":"([^"]+)".*/\1/')"
  MANIFEST_ROLLBACK_MODE="$(printf '%s' "$json" | sed -E 's/.*"rollback_mode":"([^"]+)".*/\1/')"
  MANIFEST_OBJECT_MIGRATION='none'
  MANIFEST_IMAGES_LOCK_SHA256="$(printf '%s' "$json" | sed -E 's/.*"images_lock_sha256":"([^"]+)".*/\1/')"

  if [ "$MANIFEST_DATABASE_MIGRATION" = 'expand-only' ] &&
    [ "$MANIFEST_ROLLBACK_MODE" != 'image-only' ]; then
    die "expand-only migration requires image-only rollback"
  fi
  if [ "$MANIFEST_DATABASE_MIGRATION" = 'restore-on-rollback' ] &&
    [ "$MANIFEST_ROLLBACK_MODE" != 'restore-backup' ]; then
    die "restore-on-rollback migration requires restore-backup rollback"
  fi

  export MANIFEST_SCHEMA_VERSION MANIFEST_APP_VERSION MANIFEST_GIT_SHA MANIFEST_PLATFORM
  export MANIFEST_MIN_UPGRADE_FROM MANIFEST_POSTGRES_MAJOR MANIFEST_DATABASE_MIGRATION
  export MANIFEST_ROLLBACK_MODE MANIFEST_OBJECT_MIGRATION MANIFEST_IMAGES_LOCK_SHA256
}

validate_release_contract() {
  local release_dir="$1"
  local lock_sha
  load_release_env "${release_dir}/release.env"
  load_release_manifest "${release_dir}/release-manifest.json"
  [ "$DATABENCH_VERSION" = "$MANIFEST_APP_VERSION" ] ||
    die "release.env and manifest application versions differ"
  lock_sha="$(sha256_file "${release_dir}/images.lock")"
  [ "$lock_sha" = "$MANIFEST_IMAGES_LOCK_SHA256" ] || die "images.lock checksum mismatch"
  validate_images_lock "${release_dir}/images.lock" false
}
