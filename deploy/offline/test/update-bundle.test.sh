#!/usr/bin/env bash

set -Eeuo pipefail
export LC_ALL=C

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/databench-offline-update-test.XXXXXX")"
trap 'rm -rf "$TEMP_DIR"' EXIT

fail() {
  printf 'offline update test failed: %s\n' "$*" >&2
  exit 1
}

# shellcheck source=../lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"
# shellcheck source=../lib/manifest.sh
source "${SCRIPT_DIR}/lib/manifest.sh"
# shellcheck source=../lib/update-manifest.sh
source "${SCRIPT_DIR}/lib/update-manifest.sh"

for script in \
  "${SCRIPT_DIR}/build-update-bundle.sh" \
  "${SCRIPT_DIR}/upgrade-update.sh" \
  "${SCRIPT_DIR}/lib/update-manifest.sh"; do
  bash -n "$script"
done

grep -Fq 'docker save --platform "$PLATFORM"' "${SCRIPT_DIR}/build-update-bundle.sh" ||
  fail 'incremental builder does not save only its selected image array'
grep -Fq 'changed-images.lock' "${SCRIPT_DIR}/build-update-bundle.sh" ||
  fail 'incremental builder does not emit a changed image lock'
grep -Fq 'installed release differs from the exact base bundle' "${SCRIPT_DIR}/upgrade-update.sh" ||
  fail 'incremental upgrade does not pin the installed base bundle'
grep -Fq '"${SCRIPT_DIR}/changed-images.lock" true' "${SCRIPT_DIR}/upgrade-update.sh" ||
  fail 'incremental upgrade does not validate loaded changed images'
grep -Fq '"${TARGET_RELEASE}/images.lock" true' "${SCRIPT_DIR}/upgrade-update.sh" ||
  fail 'incremental upgrade does not validate the synthesized full release'
if grep -Fq 'docker pull' "${SCRIPT_DIR}/upgrade-update.sh"; then
  fail 'incremental target upgrade attempts to pull an image'
fi

BASE_RELEASE="${TEMP_DIR}/base-release"
UPDATE_DIR="${TEMP_DIR}/databench-offline-update-1.2.3-to-1.2.4-linux-amd64"
TARGET_RELEASE="${TEMP_DIR}/target-release"
mkdir -p "$BASE_RELEASE" "$UPDATE_DIR" "${BASE_RELEASE}/docs"

for item in \
  compose.yml compose.swift-gpu.yml env.example mcp.env.example evalscope.env.example \
  swift.env.example install.sh upgrade.sh rollback.sh backup.sh restore.sh smoke.sh \
  databenchctl Caddyfile README.zh-CN.md DEPLOYMENT-GUIDE.zh-CN.md \
  TROUBLESHOOTING.zh-CN.md MCP-AGENT-GUIDE.zh-CN.md EVALSCOPE-OPERATOR-GUIDE.zh-CN.md \
  SWIFT-STUDIO-OPERATOR-GUIDE.zh-CN.md lib minio smoke; do
  cp -a "${SCRIPT_DIR}/${item}" "${BASE_RELEASE}/${item}"
done
printf 'base docs\n' > "${BASE_RELEASE}/docs/base.md"
printf 'base release\n' > "${BASE_RELEASE}/RELEASE.txt"
printf 'placeholder\n' > "${BASE_RELEASE}/SHA256SUMS"

cat > "${BASE_RELEASE}/release.env" <<'EOF'
DATABENCH_VERSION=1.2.3
DATABENCH_API_IMAGE=databench-api:1.2.3
DATABENCH_WEB_IMAGE=databench-web:1.2.3
DATABENCH_WORKER_IMAGE=databench-worker:1.2.3
DATABENCH_EVALSCOPE_IMAGE=databench-evalscope:1.2.3
DATABENCH_SWIFT_IMAGE=databench-swift-studio:1.2.3
DATABENCH_SWIFT_IMAGE_DIGEST=5555555555555555555555555555555555555555555555555555555555555555
DATABENCH_POSTGRES_IMAGE=databench-offline/postgres:1111111111111111
DATABENCH_MINIO_IMAGE=databench-offline/minio:2222222222222222
DATABENCH_MINIO_MC_IMAGE=databench-offline/minio-mc:3333333333333333
EOF

cat > "${BASE_RELEASE}/images.lock" <<'EOF'
# databench offline images lock v1
databench-api:1.2.3|sha256:1111111111111111111111111111111111111111111111111111111111111111|linux/amd64|git:1111111111111111111111111111111111111111
databench-web:1.2.3|sha256:2222222222222222222222222222222222222222222222222222222222222222|linux/amd64|git:1111111111111111111111111111111111111111
databench-worker:1.2.3|sha256:3333333333333333333333333333333333333333333333333333333333333333|linux/amd64|git:1111111111111111111111111111111111111111
databench-evalscope:1.2.3|sha256:4444444444444444444444444444444444444444444444444444444444444444|linux/amd64|evalscope:b2a62f05fd81e89ec2cf4f83b9a79ce0a5535d60
databench-swift-studio:1.2.3|sha256:5555555555555555555555555555555555555555555555555555555555555555|linux/amd64|ms-swift:f48847d23dbcd72ceb15fdbc5a1482cc7eb0359d
databench-offline/postgres:1111111111111111|sha256:6666666666666666666666666666666666666666666666666666666666666666|linux/amd64|postgres:17.6-alpine
databench-offline/minio:2222222222222222|sha256:7777777777777777777777777777777777777777777777777777777777777777|linux/amd64|minio/minio:RELEASE.2025-09-07T16-13-09Z
databench-offline/minio-mc:3333333333333333|sha256:8888888888888888888888888888888888888888888888888888888888888888|linux/amd64|minio/mc:RELEASE.2025-08-13T08-35-41Z
EOF
BASE_LOCK_SHA="$(sha256_file "${BASE_RELEASE}/images.lock")"
printf '%s\n' \
  "{\"schema_version\":1,\"app_version\":\"1.2.3\",\"git_sha\":\"1111111111111111111111111111111111111111\",\"platform\":\"linux/amd64\",\"min_upgrade_from\":\"1.0.0\",\"postgres_major\":17,\"database_migration\":\"expand-only\",\"rollback_mode\":\"image-only\",\"object_migration\":\"none\",\"images_lock_sha256\":\"${BASE_LOCK_SHA}\"}" \
  > "${BASE_RELEASE}/release-manifest.json"

cat > "${UPDATE_DIR}/changed-images.lock" <<'EOF'
# databench offline update images lock v1
databench-web:1.2.4|sha256:9999999999999999999999999999999999999999999999999999999999999999|linux/amd64|git:2222222222222222222222222222222222222222
EOF
touch "${UPDATE_DIR}/images.tar"
CHANGED_LOCK_SHA="$(sha256_file "${UPDATE_DIR}/changed-images.lock")"
printf '%s\n' \
  "{\"schema_version\":1,\"bundle_kind\":\"incremental-update\",\"base_version\":\"1.2.3\",\"target_version\":\"1.2.4\",\"git_sha\":\"2222222222222222222222222222222222222222\",\"platform\":\"linux/amd64\",\"base_bundle_sha256\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"components\":\"web\",\"database_migration\":\"expand-only\",\"rollback_mode\":\"image-only\",\"object_migration\":\"none\",\"changed_images_lock_sha256\":\"${CHANGED_LOCK_SHA}\"}" \
  > "${UPDATE_DIR}/update-manifest.json"
printf 'update archive\n' > "${UPDATE_DIR}.tar.gz"

validate_update_bundle_contract "$UPDATE_DIR"
[ "$UPDATE_BASE_VERSION" = '1.2.3' ]
[ "$UPDATE_TARGET_VERSION" = '1.2.4' ]
[ "$UPDATE_COMPONENTS" = 'web' ]

materialize_incremental_release "$UPDATE_DIR" "$BASE_RELEASE" "$TARGET_RELEASE"
validate_release_contract "$TARGET_RELEASE"
[ "$DATABENCH_VERSION" = '1.2.4' ]
[ "$DATABENCH_API_IMAGE" = 'databench-api:1.2.3' ]
[ "$DATABENCH_WEB_IMAGE" = 'databench-web:1.2.4' ]
[ "$DATABENCH_WORKER_IMAGE" = 'databench-worker:1.2.3' ]
[ "$DATABENCH_EVALSCOPE_IMAGE" = 'databench-evalscope:1.2.3' ]
[ "$DATABENCH_SWIFT_IMAGE" = 'databench-swift-studio:1.2.3' ]
[ "$(release_image_count "$TARGET_RELEASE")" -eq 8 ]
grep -Fq 'databench-web:1.2.4|sha256:9999999999999999999999999999999999999999999999999999999999999999' \
  "${TARGET_RELEASE}/images.lock" ||
  fail 'synthesized release did not replace the Web image lock'
if grep -Fq 'databench-web:1.2.3|' "${TARGET_RELEASE}/images.lock"; then
  fail 'synthesized release retained the old Web image lock'
fi
[ "$(sed -n '1p' "${TARGET_RELEASE}/release-bundle.sha256")" = \
  "$(sha256_file "${UPDATE_DIR}.tar.gz")" ] ||
  fail 'synthesized release did not record incremental bundle identity'

cp "${UPDATE_DIR}/update-manifest.json" "${TEMP_DIR}/bad-components.json"
sed -i.bak 's/"components":"web"/"components":"web,api"/' "${TEMP_DIR}/bad-components.json"
if (
  load_update_manifest "${TEMP_DIR}/bad-components.json"
) >/dev/null 2>&1; then
  fail 'update manifest accepted non-canonical component order'
fi

cp "${UPDATE_DIR}/update-manifest.json" "${TEMP_DIR}/bad-field.json"
sed -i.bak 's/"bundle_kind"/"unknown":true,"bundle_kind"/' "${TEMP_DIR}/bad-field.json"
if (
  load_update_manifest "${TEMP_DIR}/bad-field.json"
) >/dev/null 2>&1; then
  fail 'update manifest accepted an unknown field'
fi

cp "${UPDATE_DIR}/update-manifest.json" "${TEMP_DIR}/bad-base.json"
sed -i.bak 's/"target_version":"1.2.4"/"target_version":"1.2.2"/' "${TEMP_DIR}/bad-base.json"
if (
  load_update_manifest "${TEMP_DIR}/bad-base.json"
) >/dev/null 2>&1; then
  fail 'update manifest accepted a target older than its base'
fi

printf 'offline incremental update tests passed\n'
