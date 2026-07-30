#!/usr/bin/env bash

set -Eeuo pipefail

update_component_count() {
  local components="$1"
  local count=1 rest="$components"
  while [[ "$rest" == *,* ]]; do
    count=$((count + 1))
    rest="${rest#*,}"
  done
  printf '%s\n' "$count"
}

update_has_component() {
  local component="$1"
  case ",${UPDATE_COMPONENTS}," in
    *",${component},"*) return 0 ;;
    *) return 1 ;;
  esac
}

update_component_image() {
  local component="$1"
  local version="$2"
  case "$component" in
    api) printf 'databench-api:%s\n' "$version" ;;
    web) printf 'databench-web:%s\n' "$version" ;;
    worker) printf 'databench-worker:%s\n' "$version" ;;
    evalscope) printf 'databench-evalscope:%s\n' "$version" ;;
    swift) printf 'databench-swift-studio:%s\n' "$version" ;;
    *) die "unsupported update component: $component" ;;
  esac
}

validate_update_components() {
  local components="$1"
  local component canonical='' matched=0
  for component in api web worker evalscope swift; do
    case ",${components}," in
      *",${component},"*)
        if [ -n "$canonical" ]; then canonical="${canonical},"; fi
        canonical="${canonical}${component}"
        matched=$((matched + 1))
        ;;
    esac
  done
  [ "$matched" -gt 0 ] || die "incremental update must contain at least one component"
  [ "$components" = "$canonical" ] ||
    die "update components must be unique and use canonical order: api,web,worker,evalscope,swift"
}

load_update_manifest() {
  local file="$1"
  local json pattern
  json="$(tr -d '\r\n' < "$file")"
  pattern='^\{"schema_version":1,"bundle_kind":"incremental-update","base_version":"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)","target_version":"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)","git_sha":"[0-9a-f]{40}","platform":"linux/amd64","base_bundle_sha256":"[0-9a-f]{64}","components":"(api|web|worker|evalscope|swift)(,(api|web|worker|evalscope|swift))*","database_migration":"(expand-only|restore-on-rollback)","rollback_mode":"(image-only|restore-backup)","object_migration":"none","changed_images_lock_sha256":"[0-9a-f]{64}"\}$'
  [[ "$json" =~ $pattern ]] || die "update-manifest.json does not match schema version 1"

  UPDATE_SCHEMA_VERSION=1
  UPDATE_BUNDLE_KIND='incremental-update'
  UPDATE_BASE_VERSION="$(printf '%s' "$json" | sed -E 's/.*"base_version":"([^"]+)".*/\1/')"
  UPDATE_TARGET_VERSION="$(printf '%s' "$json" | sed -E 's/.*"target_version":"([^"]+)".*/\1/')"
  UPDATE_GIT_SHA="$(printf '%s' "$json" | sed -E 's/.*"git_sha":"([^"]+)".*/\1/')"
  UPDATE_PLATFORM='linux/amd64'
  UPDATE_BASE_BUNDLE_SHA256="$(
    printf '%s' "$json" | sed -E 's/.*"base_bundle_sha256":"([^"]+)".*/\1/'
  )"
  UPDATE_COMPONENTS="$(printf '%s' "$json" | sed -E 's/.*"components":"([^"]+)".*/\1/')"
  UPDATE_DATABASE_MIGRATION="$(
    printf '%s' "$json" | sed -E 's/.*"database_migration":"([^"]+)".*/\1/'
  )"
  UPDATE_ROLLBACK_MODE="$(printf '%s' "$json" | sed -E 's/.*"rollback_mode":"([^"]+)".*/\1/')"
  UPDATE_OBJECT_MIGRATION='none'
  UPDATE_CHANGED_IMAGES_LOCK_SHA256="$(
    printf '%s' "$json" | sed -E 's/.*"changed_images_lock_sha256":"([^"]+)".*/\1/'
  )"

  validate_app_version "$UPDATE_BASE_VERSION"
  validate_app_version "$UPDATE_TARGET_VERSION"
  version_gt "$UPDATE_TARGET_VERSION" "$UPDATE_BASE_VERSION" ||
    die "incremental update target must be newer than its base version"
  validate_update_components "$UPDATE_COMPONENTS"

  if [ "$UPDATE_DATABASE_MIGRATION" = 'expand-only' ] &&
    [ "$UPDATE_ROLLBACK_MODE" != 'image-only' ]; then
    die "expand-only migration requires image-only rollback"
  fi
  if [ "$UPDATE_DATABASE_MIGRATION" = 'restore-on-rollback' ] &&
    [ "$UPDATE_ROLLBACK_MODE" != 'restore-backup' ]; then
    die "restore-on-rollback migration requires restore-backup rollback"
  fi

  export UPDATE_SCHEMA_VERSION UPDATE_BUNDLE_KIND UPDATE_BASE_VERSION UPDATE_TARGET_VERSION
  export UPDATE_GIT_SHA UPDATE_PLATFORM UPDATE_BASE_BUNDLE_SHA256 UPDATE_COMPONENTS
  export UPDATE_DATABASE_MIGRATION UPDATE_ROLLBACK_MODE UPDATE_OBJECT_MIGRATION
  export UPDATE_CHANGED_IMAGES_LOCK_SHA256
}

changed_image_for_component() {
  local update_dir="$1"
  local component="$2"
  local expected
  expected="$(update_component_image "$component" "$UPDATE_TARGET_VERSION")"
  awk -F '|' -v expected="$expected" '
    $1 == expected { matches += 1; image = $1 }
    END {
      if (matches == 1) {
        print image
        exit 0
      }
      exit 1
    }
  ' "${update_dir}/changed-images.lock" ||
    die "changed image is not locked exactly once for component: $component"
}

changed_image_line_for_component() {
  local update_dir="$1"
  local component="$2"
  local expected
  expected="$(update_component_image "$component" "$UPDATE_TARGET_VERSION")"
  awk -F '|' -v expected="$expected" '
    $1 == expected { matches += 1; line = $0 }
    END {
      if (matches == 1) {
        print line
        exit 0
      }
      exit 1
    }
  ' "${update_dir}/changed-images.lock" ||
    die "changed image lock line is missing for component: $component"
}

changed_image_digest_for_component() {
  local update_dir="$1"
  local component="$2"
  changed_image_line_for_component "$update_dir" "$component" |
    awk -F '|' '{ sub(/^sha256:/, "", $2); print $2 }'
}

validate_update_bundle_contract() {
  local update_dir="$1"
  local lock_sha component expected_count
  [ -f "${update_dir}/images.tar" ] || die "incremental update is missing images.tar"
  [ ! -e "${update_dir}/install.sh" ] ||
    die "incremental update must not contain install.sh"
  load_update_manifest "${update_dir}/update-manifest.json"
  lock_sha="$(sha256_file "${update_dir}/changed-images.lock")"
  [ "$lock_sha" = "$UPDATE_CHANGED_IMAGES_LOCK_SHA256" ] ||
    die "changed-images.lock checksum mismatch"
  expected_count="$(update_component_count "$UPDATE_COMPONENTS")"
  validate_images_lock "${update_dir}/changed-images.lock" false "$expected_count"
  for component in api web worker evalscope swift; do
    if update_has_component "$component"; then
      changed_image_for_component "$update_dir" "$component" >/dev/null
    fi
  done
}

write_installed_release_checksums() {
  local release_dir="$1"
  (
    cd "$release_dir"
    find . -type f ! -name SHA256SUMS -print | LC_ALL=C sort | while IFS= read -r file; do
      printf '%s  %s\n' "$(sha256_file "$file")" "$file"
    done > SHA256SUMS
  )
}

materialize_incremental_release() {
  local update_dir="$1"
  local previous_release="$2"
  local target_release="$3"
  local old_api old_web old_worker old_evalscope old_swift
  local target_api target_web target_worker target_evalscope target_swift target_swift_digest
  local component old_image replacement temp_lock lock_sha

  validate_release_contract "$previous_release"
  [ "$(release_image_count "$previous_release")" -eq 8 ] ||
    die "incremental updates require an eight-image base release"
  load_release_env "${previous_release}/release.env"
  old_api="$DATABENCH_API_IMAGE"
  old_web="$DATABENCH_WEB_IMAGE"
  old_worker="$DATABENCH_WORKER_IMAGE"
  old_evalscope="$DATABENCH_EVALSCOPE_IMAGE"
  old_swift="$DATABENCH_SWIFT_IMAGE"
  target_api="$old_api"
  target_web="$old_web"
  target_worker="$old_worker"
  target_evalscope="$old_evalscope"
  target_swift="$old_swift"
  target_swift_digest="$DATABENCH_SWIFT_IMAGE_DIGEST"

  if update_has_component api; then
    target_api="$(changed_image_for_component "$update_dir" api)"
  fi
  if update_has_component web; then
    target_web="$(changed_image_for_component "$update_dir" web)"
  fi
  if update_has_component worker; then
    target_worker="$(changed_image_for_component "$update_dir" worker)"
  fi
  if update_has_component evalscope; then
    target_evalscope="$(changed_image_for_component "$update_dir" evalscope)"
  fi
  if update_has_component swift; then
    target_swift="$(changed_image_for_component "$update_dir" swift)"
    target_swift_digest="$(changed_image_digest_for_component "$update_dir" swift)"
  fi

  copy_release_assets "$previous_release" "$target_release"
  cat > "${target_release}/release.env" <<EOF
DATABENCH_VERSION=${UPDATE_TARGET_VERSION}
DATABENCH_API_IMAGE=${target_api}
DATABENCH_WEB_IMAGE=${target_web}
DATABENCH_WORKER_IMAGE=${target_worker}
DATABENCH_EVALSCOPE_IMAGE=${target_evalscope}
DATABENCH_SWIFT_IMAGE=${target_swift}
DATABENCH_SWIFT_IMAGE_DIGEST=${target_swift_digest}
DATABENCH_POSTGRES_IMAGE=${DATABENCH_POSTGRES_IMAGE}
DATABENCH_MINIO_IMAGE=${DATABENCH_MINIO_IMAGE}
DATABENCH_MINIO_MC_IMAGE=${DATABENCH_MINIO_MC_IMAGE}
EOF

  cp "${previous_release}/images.lock" "${target_release}/images.lock"
  for component in api web worker evalscope swift; do
    update_has_component "$component" || continue
    case "$component" in
      api) old_image="$old_api" ;;
      web) old_image="$old_web" ;;
      worker) old_image="$old_worker" ;;
      evalscope) old_image="$old_evalscope" ;;
      swift) old_image="$old_swift" ;;
    esac
    replacement="$(changed_image_line_for_component "$update_dir" "$component")"
    temp_lock="${target_release}/.images.lock.$$"
    awk -F '|' -v old="$old_image" -v replacement="$replacement" '
      $1 == old { matches += 1; print replacement; next }
      { print }
      END { if (matches != 1) exit 1 }
    ' "${target_release}/images.lock" > "$temp_lock" ||
      die "base image lock is missing component: $component"
    mv "$temp_lock" "${target_release}/images.lock"
  done

  lock_sha="$(sha256_file "${target_release}/images.lock")"
  printf '%s\n' \
    "{\"schema_version\":1,\"app_version\":\"${UPDATE_TARGET_VERSION}\",\"git_sha\":\"${UPDATE_GIT_SHA}\",\"platform\":\"linux/amd64\",\"min_upgrade_from\":\"${UPDATE_BASE_VERSION}\",\"postgres_major\":17,\"database_migration\":\"${UPDATE_DATABASE_MIGRATION}\",\"rollback_mode\":\"${UPDATE_ROLLBACK_MODE}\",\"object_migration\":\"none\",\"images_lock_sha256\":\"${lock_sha}\"}" \
    > "${target_release}/release-manifest.json"

  cat > "${target_release}/RELEASE.txt" <<EOF
bundle=$(basename "${update_dir}").tar.gz
application_version=${UPDATE_TARGET_VERSION}
git_sha=${UPDATE_GIT_SHA}
platform=linux/amd64
bundle_kind=incremental-update
base_version=${UPDATE_BASE_VERSION}
components=${UPDATE_COMPONENTS}
EOF

  record_bundle_identity "$update_dir" "$target_release"
  write_installed_release_checksums "$target_release"
  validate_release_contract "$target_release"
  verify_inner_bundle "$target_release"
}
