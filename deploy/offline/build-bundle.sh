#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"
# shellcheck source=lib/manifest.sh
source "${SCRIPT_DIR}/lib/manifest.sh"

PLATFORM='linux/amd64'
POSTGRES_SOURCE_IMAGE="${POSTGRES_SOURCE_IMAGE:-postgres:17.6-alpine}"
MINIO_SOURCE_IMAGE="${MINIO_SOURCE_IMAGE:-minio/minio:RELEASE.2025-09-07T16-13-09Z}"
MINIO_MC_SOURCE_IMAGE="${MINIO_MC_SOURCE_IMAGE:-minio/mc:RELEASE.2025-08-13T08-35-41Z}"
MIN_UPGRADE_FROM="${MIN_UPGRADE_FROM:-0.0.0}"
DATABASE_MIGRATION="${DATABASE_MIGRATION:-expand-only}"
ROLLBACK_MODE="${ROLLBACK_MODE:-image-only}"
OUTPUT_ROOT="${DATABENCH_OFFLINE_OUTPUT_DIR:-${REPO_ROOT}/output/offline}"

usage() {
  printf 'Usage: %s <version>\n' "$0" >&2
  exit 2
}

[ "$#" -eq 1 ] || usage
VERSION="$1"
validate_app_version "$VERSION"
validate_app_version "$MIN_UPGRADE_FROM"

case "$POSTGRES_SOURCE_IMAGE $MINIO_SOURCE_IMAGE $MINIO_MC_SOURCE_IMAGE" in
  *latest*) die "third-party source images must use exact version tags or digests" ;;
esac

if [ "$DATABASE_MIGRATION" = 'expand-only' ]; then
  [ "$ROLLBACK_MODE" = 'image-only' ] || die "expand-only requires image-only rollback"
elif [ "$DATABASE_MIGRATION" = 'restore-on-rollback' ]; then
  [ "$ROLLBACK_MODE" = 'restore-backup' ] ||
    die "restore-on-rollback requires restore-backup rollback"
else
  die "unsupported DATABASE_MIGRATION: $DATABASE_MIGRATION"
fi

require_command docker
require_command git
require_command tar

docker info >/dev/null 2>&1 || die "Docker daemon is not available"
docker buildx version >/dev/null 2>&1 || die "Docker Buildx is not available"

cd "$REPO_ROOT"
[ -z "$(git status --porcelain --untracked-files=normal)" ] ||
  die "refusing to build an offline production bundle from a dirty worktree"

GIT_SHA="$(git rev-parse HEAD)"
[[ "$GIT_SHA" =~ ^[0-9a-f]{40}$ ]] || die "could not resolve a full git SHA"

IMAGE_VERSION="${VERSION//+/-}"
API_IMAGE="databench-api:${IMAGE_VERSION}"
WEB_IMAGE="databench-web:${IMAGE_VERSION}"
BUNDLE_NAME="databench-offline-${VERSION}-linux-amd64"
BUNDLE_DIR="${OUTPUT_ROOT}/${BUNDLE_NAME}"
ARCHIVE="${OUTPUT_ROOT}/${BUNDLE_NAME}.tar.gz"
OUTER_CHECKSUM="${ARCHIVE}.sha256"

[ ! -e "$BUNDLE_DIR" ] || die "bundle directory already exists: $BUNDLE_DIR"
[ ! -e "$ARCHIVE" ] || die "bundle archive already exists: $ARCHIVE"
install -d -m 0755 "$OUTPUT_ROOT"

TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/databench-offline-build.XXXXXX")"
trap 'rm -rf "$TEMP_DIR"' EXIT

log "building $API_IMAGE for $PLATFORM"
docker buildx build \
  --platform "$PLATFORM" \
  --load \
  --label "org.opencontainers.image.revision=${GIT_SHA}" \
  --label "org.opencontainers.image.version=${VERSION}" \
  --build-arg "DATABENCH_RELEASE_VERSION=${VERSION}" \
  --file deploy/offline/Dockerfile.api \
  --tag "$API_IMAGE" \
  .

log "building $WEB_IMAGE for $PLATFORM"
docker buildx build \
  --platform "$PLATFORM" \
  --load \
  --label "org.opencontainers.image.revision=${GIT_SHA}" \
  --label "org.opencontainers.image.version=${VERSION}" \
  --build-arg "VITE_DATABENCH_API_BASE_URL=/api" \
  --file deploy/offline/Dockerfile.web \
  --tag "$WEB_IMAGE" \
  .

pull_and_retag() {
  local role="$1"
  local source_image="$2"
  local source_id suffix target
  log "pulling $source_image for $PLATFORM"
  docker pull --platform "$PLATFORM" "$source_image"
  source_id="$(docker image inspect --platform "$PLATFORM" "$source_image" --format '{{.Id}}')"
  suffix="${source_id#sha256:}"
  suffix="${suffix%${suffix#????????????????}}"
  target="databench-offline/${role}:${suffix}"
  docker tag "$source_image" "$target"
  printf '%s\n' "$target"
}

POSTGRES_IMAGE="$(pull_and_retag postgres "$POSTGRES_SOURCE_IMAGE" | tail -n 1)"
MINIO_IMAGE="$(pull_and_retag minio "$MINIO_SOURCE_IMAGE" | tail -n 1)"
MINIO_MC_IMAGE="$(pull_and_retag minio-mc "$MINIO_MC_SOURCE_IMAGE" | tail -n 1)"

inspect_image() {
  local image="$1"
  local actual
  actual="$(docker image inspect --platform "$PLATFORM" "$image" --format '{{.Os}}/{{.Architecture}}')"
  [ "$actual" = "$PLATFORM" ] || die "$image has platform $actual, expected $PLATFORM"
}

for image in "$API_IMAGE" "$WEB_IMAGE" "$POSTGRES_IMAGE" "$MINIO_IMAGE" "$MINIO_MC_IMAGE"; do
  inspect_image "$image"
done

log "running amd64 image executable smoke"
docker run --rm --platform "$PLATFORM" "$API_IMAGE" databench help --compact >/dev/null
docker run --rm --platform "$PLATFORM" "$WEB_IMAGE" caddy validate --config /etc/caddy/Caddyfile
docker run --rm --platform "$PLATFORM" "$POSTGRES_IMAGE" postgres --version >/dev/null
docker run --rm --platform "$PLATFORM" "$MINIO_IMAGE" minio --version >/dev/null
docker run --rm --platform "$PLATFORM" "$MINIO_MC_IMAGE" --version >/dev/null

install -d -m 0755 "$BUNDLE_DIR"
cp -a \
  deploy/offline/compose.yml \
  deploy/offline/env.example \
  deploy/offline/mcp.env.example \
  deploy/offline/Caddyfile \
  deploy/offline/install.sh \
  deploy/offline/upgrade.sh \
  deploy/offline/rollback.sh \
  deploy/offline/backup.sh \
  deploy/offline/restore.sh \
  deploy/offline/smoke.sh \
  deploy/offline/databenchctl \
  deploy/offline/README.zh-CN.md \
  deploy/offline/DEPLOYMENT-GUIDE.zh-CN.md \
  deploy/offline/TROUBLESHOOTING.zh-CN.md \
  deploy/offline/MCP-AGENT-GUIDE.zh-CN.md \
  "$BUNDLE_DIR/"
cp -a deploy/offline/lib deploy/offline/minio deploy/offline/smoke "$BUNDLE_DIR/"
install -d -m 0755 "${BUNDLE_DIR}/docs"
cp -a docs/deployment/offline-single-host-plan.zh-CN.md "${BUNDLE_DIR}/docs/"
cp -a docs/decisions/0012-offline-single-host-deployment.md \
  "${BUNDLE_DIR}/docs/ADR-0012.md"
chmod 0755 "$BUNDLE_DIR"/*.sh "$BUNDLE_DIR/databenchctl"

cat > "${BUNDLE_DIR}/release.env" <<EOF
DATABENCH_VERSION=${VERSION}
DATABENCH_API_IMAGE=${API_IMAGE}
DATABENCH_WEB_IMAGE=${WEB_IMAGE}
DATABENCH_POSTGRES_IMAGE=${POSTGRES_IMAGE}
DATABENCH_MINIO_IMAGE=${MINIO_IMAGE}
DATABENCH_MINIO_MC_IMAGE=${MINIO_MC_IMAGE}
EOF

write_lock_line() {
  local image="$1"
  local source="$2"
  local digest
  digest="$(docker image inspect --platform "$PLATFORM" "$image" --format '{{.Id}}')"
  printf '%s|%s|%s|%s\n' "$image" "$digest" "$PLATFORM" "$source"
}

{
  printf '# databench offline images lock v1\n'
  write_lock_line "$API_IMAGE" "git:${GIT_SHA}"
  write_lock_line "$WEB_IMAGE" "git:${GIT_SHA}"
  write_lock_line "$POSTGRES_IMAGE" "$POSTGRES_SOURCE_IMAGE"
  write_lock_line "$MINIO_IMAGE" "$MINIO_SOURCE_IMAGE"
  write_lock_line "$MINIO_MC_IMAGE" "$MINIO_MC_SOURCE_IMAGE"
} > "${BUNDLE_DIR}/images.lock"

IMAGES_LOCK_SHA256="$(sha256_file "${BUNDLE_DIR}/images.lock")"
printf '%s\n' \
  "{\"schema_version\":1,\"app_version\":\"${VERSION}\",\"git_sha\":\"${GIT_SHA}\",\"platform\":\"linux/amd64\",\"min_upgrade_from\":\"${MIN_UPGRADE_FROM}\",\"postgres_major\":17,\"database_migration\":\"${DATABASE_MIGRATION}\",\"rollback_mode\":\"${ROLLBACK_MODE}\",\"object_migration\":\"none\",\"images_lock_sha256\":\"${IMAGES_LOCK_SHA256}\"}" \
  > "${BUNDLE_DIR}/release-manifest.json"

BUILD_TIME="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
cat > "${BUNDLE_DIR}/RELEASE.txt" <<EOF
bundle=${BUNDLE_NAME}.tar.gz
application_version=${VERSION}
git_sha=${GIT_SHA}
platform=${PLATFORM}
build_time=${BUILD_TIME}
docker_version=$(docker version --format '{{.Client.Version}}')
buildx_version=$(docker buildx version | awk '{print $2}')
EOF

log "saving five images"
docker save --platform "$PLATFORM" --output "${BUNDLE_DIR}/images.tar" \
  "$API_IMAGE" "$WEB_IMAGE" "$POSTGRES_IMAGE" "$MINIO_IMAGE" "$MINIO_MC_IMAGE"

(
  cd "$BUNDLE_DIR"
  find . -type f ! -name SHA256SUMS -print | LC_ALL=C sort | while IFS= read -r file; do
    printf '%s  %s\n' "$(sha256_file "$file")" "$file"
  done > SHA256SUMS
)

validate_release_contract "$BUNDLE_DIR"
verify_inner_bundle "$BUNDLE_DIR"

tar -C "$OUTPUT_ROOT" -czf "$ARCHIVE" "$BUNDLE_NAME"
printf '%s  %s\n' "$(sha256_file "$ARCHIVE")" "$(basename "$ARCHIVE")" > "$OUTER_CHECKSUM"

log "offline bundle created"
printf '%s\n%s\n' "$ARCHIVE" "$OUTER_CHECKSUM"
