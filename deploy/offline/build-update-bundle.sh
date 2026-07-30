#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"
# shellcheck source=lib/update-manifest.sh
source "${SCRIPT_DIR}/lib/update-manifest.sh"

PLATFORM='linux/amd64'
OUTPUT_ROOT="${DATABENCH_OFFLINE_OUTPUT_DIR:-${REPO_ROOT}/output/offline}"
DATABASE_MIGRATION="${DATABASE_MIGRATION:-expand-only}"
ROLLBACK_MODE="${ROLLBACK_MODE:-image-only}"
EXPLICIT_COMPONENTS=''
BASE_REF=''
BASE_CHECKSUM_FILE=''

usage() {
  cat >&2 <<EOF
Usage: $0 <base-version> <target-version> [options]

Options:
  --components api,web,worker,evalscope,swift
  --base-ref <git-ref>
  --base-checksum <path-to-base-bundle.sha256>

Without --components, changed runtime components are detected from the base Git revision.
EOF
  exit 2
}

[ "$#" -ge 2 ] || usage
BASE_VERSION="$1"
TARGET_VERSION="$2"
shift 2
while [ "$#" -gt 0 ]; do
  case "$1" in
    --components)
      [ "$#" -ge 2 ] || usage
      EXPLICIT_COMPONENTS="$2"
      shift
      ;;
    --base-ref)
      [ "$#" -ge 2 ] || usage
      BASE_REF="$2"
      shift
      ;;
    --base-checksum)
      [ "$#" -ge 2 ] || usage
      BASE_CHECKSUM_FILE="$2"
      shift
      ;;
    *) usage ;;
  esac
  shift
done

validate_app_version "$BASE_VERSION"
validate_app_version "$TARGET_VERSION"
version_gt "$TARGET_VERSION" "$BASE_VERSION" ||
  die "target version must be newer than base version"
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
  die "refusing to build an offline update from a dirty worktree"
GIT_SHA="$(git rev-parse HEAD)"
[[ "$GIT_SHA" =~ ^[0-9a-f]{40}$ ]] || die "could not resolve a full git SHA"

resolve_base_checksum_file() {
  local full_candidate matches count
  if [ -n "$BASE_CHECKSUM_FILE" ]; then
    [ -f "$BASE_CHECKSUM_FILE" ] || die "base checksum does not exist: $BASE_CHECKSUM_FILE"
    return
  fi
  full_candidate="${OUTPUT_ROOT}/databench-offline-${BASE_VERSION}-linux-amd64.tar.gz.sha256"
  if [ -f "$full_candidate" ]; then
    BASE_CHECKSUM_FILE="$full_candidate"
    return
  fi
  matches="$(
    find "$OUTPUT_ROOT" -maxdepth 1 -type f \
      -name "databench-offline-update-*-to-${BASE_VERSION}-linux-amd64.tar.gz.sha256" \
      -print | LC_ALL=C sort
  )"
  count="$(printf '%s\n' "$matches" | awk 'NF { count += 1 } END { print count + 0 }')"
  [ "$count" -eq 1 ] ||
    die "cannot resolve one base checksum; pass --base-checksum explicitly"
  BASE_CHECKSUM_FILE="$matches"
}

resolve_base_checksum_file
BASE_BUNDLE_SHA256="$(
  awk '
    NR == 1 && $1 ~ /^[0-9a-f]{64}$/ { digest = $1 }
    NR > 1 && NF { invalid = 1 }
    END {
      if (digest != "" && !invalid) print digest
      else exit 1
    }
  ' "$BASE_CHECKSUM_FILE"
)" || die "base checksum file is invalid: $BASE_CHECKSUM_FILE"

NEED_API=false
NEED_WEB=false
NEED_WORKER=false
NEED_EVALSCOPE=false
NEED_SWIFT=false
FULL_BUNDLE_PATH=''

mark_component() {
  case "$1" in
    api) NEED_API=true ;;
    web) NEED_WEB=true ;;
    worker) NEED_WORKER=true ;;
    evalscope) NEED_EVALSCOPE=true ;;
    swift) NEED_SWIFT=true ;;
    *) die "unsupported update component: $1" ;;
  esac
}

mark_explicit_components() {
  local component rest="$1"
  validate_update_components "$rest"
  while [ -n "$rest" ]; do
    component="${rest%%,*}"
    mark_component "$component"
    if [ "$rest" = "$component" ]; then
      rest=''
    else
      rest="${rest#*,}"
    fi
  done
}

classify_changed_path() {
  local path="$1"
  case "$path" in
    apps/web/*|openapi/*)
      mark_component web
      ;;
    apps/api/*|apps/cli/*|packages/*|prisma/*)
      mark_component api
      ;;
    proto/*)
      mark_component api
      mark_component worker
      ;;
    workers/python/*)
      mark_component worker
      ;;
    workers/evalscope/*|deploy/evalscope/*)
      mark_component evalscope
      ;;
    workers/swift-studio/*|deploy/swift-studio/*|third_party/ms-swift/*|scripts/apply-swift-patch.py)
      mark_component swift
      ;;
    deploy/offline/Dockerfile.api)
      mark_component api
      ;;
    deploy/offline/Dockerfile.web|deploy/offline/Caddyfile|deploy/offline/web-build-package.json)
      mark_component web
      ;;
    package.json|pnpm-lock.yaml|pnpm-workspace.yaml|turbo.json|tsconfig.base.json)
      mark_component api
      mark_component web
      ;;
    docs/*|.github/*|AGENTS.md|THIRD_PARTY_NOTICES.md|*.md)
      ;;
    deploy/offline/*|.dockerignore)
      FULL_BUNDLE_PATH="$path"
      ;;
    tooling/*|scripts/*|*)
      FULL_BUNDLE_PATH="$path"
      ;;
  esac
}

if [ -n "$EXPLICIT_COMPONENTS" ]; then
  mark_explicit_components "$EXPLICIT_COMPONENTS"
else
  if [ -z "$BASE_REF" ]; then
    BASE_REF="$(
      docker image inspect "databench-api:${BASE_VERSION}" \
        --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' 2>/dev/null || true
    )"
    [ -n "$BASE_REF" ] ||
      die "base API image is unavailable; pass --base-ref or --components"
  fi
  BASE_GIT_SHA="$(git rev-parse "${BASE_REF}^{commit}" 2>/dev/null)" ||
    die "cannot resolve base Git revision: $BASE_REF"
  git merge-base --is-ancestor "$BASE_GIT_SHA" "$GIT_SHA" ||
    die "base Git revision is not an ancestor of the target revision"
  while IFS= read -r changed_path; do
    [ -n "$changed_path" ] || continue
    classify_changed_path "$changed_path"
  done < <(git diff --name-only "$BASE_GIT_SHA" "$GIT_SHA")
  [ -z "$FULL_BUNDLE_PATH" ] ||
    die "change requires a full offline bundle: $FULL_BUNDLE_PATH"
fi

COMPONENTS=''
for component in api web worker evalscope swift; do
  case "$component" in
    api) selected="$NEED_API" ;;
    web) selected="$NEED_WEB" ;;
    worker) selected="$NEED_WORKER" ;;
    evalscope) selected="$NEED_EVALSCOPE" ;;
    swift) selected="$NEED_SWIFT" ;;
  esac
  if [ "$selected" = true ]; then
    if [ -n "$COMPONENTS" ]; then COMPONENTS="${COMPONENTS},"; fi
    COMPONENTS="${COMPONENTS}${component}"
  fi
done
validate_update_components "$COMPONENTS"

IMAGE_VERSION="${TARGET_VERSION//+/-}"
BUNDLE_NAME="databench-offline-update-${BASE_VERSION}-to-${TARGET_VERSION}-linux-amd64"
BUNDLE_DIR="${OUTPUT_ROOT}/${BUNDLE_NAME}"
ARCHIVE="${OUTPUT_ROOT}/${BUNDLE_NAME}.tar.gz"
OUTER_CHECKSUM="${ARCHIVE}.sha256"
[ ! -e "$BUNDLE_DIR" ] || die "update directory already exists: $BUNDLE_DIR"
[ ! -e "$ARCHIVE" ] || die "update archive already exists: $ARCHIVE"
install -d -m 0755 "$OUTPUT_ROOT"

TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/databench-offline-update-build.XXXXXX")"
SWIFT_SMOKE_CONTAINER=''
cleanup_build() {
  if [ -n "$SWIFT_SMOKE_CONTAINER" ]; then
    docker rm --force "$SWIFT_SMOKE_CONTAINER" >/dev/null 2>&1 || true
  fi
  rm -rf "$TEMP_DIR"
}
trap cleanup_build EXIT

declare -a CHANGED_IMAGES=()

if [ "$NEED_API" = true ]; then
  API_IMAGE="databench-api:${IMAGE_VERSION}"
  log "building changed component api as $API_IMAGE"
  docker buildx build \
    --platform "$PLATFORM" \
    --load \
    --label "org.opencontainers.image.revision=${GIT_SHA}" \
    --label "org.opencontainers.image.version=${TARGET_VERSION}" \
    --build-arg "DATABENCH_RELEASE_VERSION=${TARGET_VERSION}" \
    --file deploy/offline/Dockerfile.api \
    --tag "$API_IMAGE" \
    .
  CHANGED_IMAGES+=("$API_IMAGE")
fi

if [ "$NEED_WEB" = true ]; then
  WEB_IMAGE="databench-web:${IMAGE_VERSION}"
  log "building changed component web as $WEB_IMAGE"
  docker buildx build \
    --platform "$PLATFORM" \
    --load \
    --label "org.opencontainers.image.revision=${GIT_SHA}" \
    --label "org.opencontainers.image.version=${TARGET_VERSION}" \
    --build-arg "VITE_DATABENCH_API_BASE_URL=/api" \
    --file deploy/offline/Dockerfile.web \
    --tag "$WEB_IMAGE" \
    .
  CHANGED_IMAGES+=("$WEB_IMAGE")
fi

if [ "$NEED_WORKER" = true ]; then
  WORKER_IMAGE="databench-worker:${IMAGE_VERSION}"
  log "building changed component worker as $WORKER_IMAGE"
  docker buildx build \
    --platform "$PLATFORM" \
    --load \
    --label "org.opencontainers.image.revision=${GIT_SHA}" \
    --label "org.opencontainers.image.version=${TARGET_VERSION}" \
    --file workers/python/Dockerfile \
    --tag "$WORKER_IMAGE" \
    workers/python
  CHANGED_IMAGES+=("$WORKER_IMAGE")
fi

if [ "$NEED_EVALSCOPE" = true ]; then
  EVALSCOPE_IMAGE="databench-evalscope:${IMAGE_VERSION}"
  log "building changed component evalscope as $EVALSCOPE_IMAGE"
  docker buildx build \
    --platform "$PLATFORM" \
    --load \
    --label "org.opencontainers.image.revision=${GIT_SHA}" \
    --label "org.opencontainers.image.version=${TARGET_VERSION}" \
    --file deploy/evalscope/Dockerfile \
    --tag "$EVALSCOPE_IMAGE" \
    .
  CHANGED_IMAGES+=("$EVALSCOPE_IMAGE")
fi

if [ "$NEED_SWIFT" = true ]; then
  SWIFT_IMAGE="databench-swift-studio:${IMAGE_VERSION}"
  log "building changed component swift as $SWIFT_IMAGE"
  docker buildx build \
    --platform "$PLATFORM" \
    --load \
    --label "org.opencontainers.image.revision=${GIT_SHA}" \
    --label "org.opencontainers.image.version=${TARGET_VERSION}" \
    --file deploy/swift-studio/Dockerfile \
    --tag "$SWIFT_IMAGE" \
    .
  CHANGED_IMAGES+=("$SWIFT_IMAGE")
fi

inspect_image() {
  local image="$1"
  local actual
  actual="$(docker image inspect --platform "$PLATFORM" "$image" --format '{{.Os}}/{{.Architecture}}')"
  [ "$actual" = "$PLATFORM" ] || die "$image has platform $actual, expected $PLATFORM"
}

for image in "${CHANGED_IMAGES[@]}"; do
  inspect_image "$image"
done

log "running executable smoke for changed components: $COMPONENTS"
if [ "$NEED_API" = true ]; then
  docker run --rm --platform "$PLATFORM" "$API_IMAGE" databench help --compact >/dev/null
fi
if [ "$NEED_WEB" = true ]; then
  docker run --rm --platform "$PLATFORM" "$WEB_IMAGE" caddy validate --config /etc/caddy/Caddyfile
fi
if [ "$NEED_WORKER" = true ]; then
  docker run --rm --platform "$PLATFORM" "$WORKER_IMAGE" --help >/dev/null
  docker run --rm --platform "$PLATFORM" \
    --entrypoint /app/.venv/bin/python "$WORKER_IMAGE" -c '
import importlib.metadata as metadata
import torch

installed = {distribution.metadata["Name"].lower() for distribution in metadata.distributions()}
assert torch.version.cuda is None and not torch.cuda.is_available()
assert not any(name == "triton" or name.startswith("nvidia-") for name in installed)
' >/dev/null
fi
if [ "$NEED_EVALSCOPE" = true ]; then
  docker run --rm --platform "$PLATFORM" \
    --entrypoint /app/.venv/bin/python "$EVALSCOPE_IMAGE" -c '
import importlib.metadata as metadata
from pathlib import Path

import databench_evalscope
import evalscope

installed = {distribution.metadata["Name"].lower() for distribution in metadata.distributions()}
assert not (Path(evalscope.__file__).parent / "web").exists()
assert not any(name == "triton" or name.startswith("nvidia-") for name in installed)
assert Path("/opt/vendor/plotly-2.35.2.min.js").is_file()
' >/dev/null
fi
if [ "$NEED_SWIFT" = true ]; then
  docker run --rm --platform "$PLATFORM" \
    --entrypoint python "$SWIFT_IMAGE" -c '
import gradio
import peft
import swift
import torch
import transformers

assert gradio.__version__ == "5.50.0"
assert swift.__version__ == "4.4.2"
assert transformers.__version__ == "4.57.6"
assert torch.version.cuda is not None
' >/dev/null
  log "running changed Swift Provider and native Gradio readiness smoke without a GPU"
  SWIFT_SMOKE_CONTAINER="databench-swift-offline-update-smoke-$$"
  docker run --detach --platform "$PLATFORM" \
    --name "$SWIFT_SMOKE_CONTAINER" \
    --env DATABENCH_API_BASE_URL=http://api:8000 \
    "$SWIFT_IMAGE" >/dev/null
  SWIFT_SMOKE_READY=false
  for _ in $(seq 1 300); do
    if docker exec "$SWIFT_SMOKE_CONTAINER" python -c '
import json
import urllib.request

body = json.load(urllib.request.urlopen("http://127.0.0.1:7861/runtime", timeout=3))
assert body["ready"] is True
assert body["service"] == "swift-studio-provider"
assert len(body["surfaces"]) == 7
' >/dev/null 2>&1; then
      SWIFT_SMOKE_READY=true
      break
    fi
    if [ "$(docker inspect "$SWIFT_SMOKE_CONTAINER" --format '{{.State.Running}}')" != 'true' ]; then
      docker logs "$SWIFT_SMOKE_CONTAINER" >&2 || true
      die "Swift Studio exited during the update readiness smoke"
    fi
    sleep 2
  done
  [ "$SWIFT_SMOKE_READY" = true ] || {
    docker logs "$SWIFT_SMOKE_CONTAINER" >&2 || true
    die "Swift Studio did not become ready during the update readiness smoke"
  }
  docker rm --force "$SWIFT_SMOKE_CONTAINER" >/dev/null
  SWIFT_SMOKE_CONTAINER=''
fi

install -d -m 0755 "$BUNDLE_DIR"
cp deploy/offline/upgrade-update.sh "${BUNDLE_DIR}/upgrade.sh"
cp deploy/offline/README-UPDATE.zh-CN.md "${BUNDLE_DIR}/README.zh-CN.md"
cp -a deploy/offline/lib "$BUNDLE_DIR/"
chmod 0755 "${BUNDLE_DIR}/upgrade.sh"

write_changed_lock_line() {
  local image="$1"
  local source="$2"
  local digest
  digest="$(docker image inspect --platform "$PLATFORM" "$image" --format '{{.Id}}')"
  printf '%s|%s|%s|%s\n' "$image" "$digest" "$PLATFORM" "$source"
}

{
  printf '# databench offline update images lock v1\n'
  if [ "$NEED_API" = true ]; then write_changed_lock_line "$API_IMAGE" "git:${GIT_SHA}"; fi
  if [ "$NEED_WEB" = true ]; then write_changed_lock_line "$WEB_IMAGE" "git:${GIT_SHA}"; fi
  if [ "$NEED_WORKER" = true ]; then write_changed_lock_line "$WORKER_IMAGE" "git:${GIT_SHA}"; fi
  if [ "$NEED_EVALSCOPE" = true ]; then
    write_changed_lock_line \
      "$EVALSCOPE_IMAGE" "evalscope:b2a62f05fd81e89ec2cf4f83b9a79ce0a5535d60;git:${GIT_SHA}"
  fi
  if [ "$NEED_SWIFT" = true ]; then
    write_changed_lock_line \
      "$SWIFT_IMAGE" "ms-swift:f48847d23dbcd72ceb15fdbc5a1482cc7eb0359d;git:${GIT_SHA}"
  fi
} > "${BUNDLE_DIR}/changed-images.lock"

CHANGED_LOCK_SHA256="$(sha256_file "${BUNDLE_DIR}/changed-images.lock")"
printf '%s\n' \
  "{\"schema_version\":1,\"bundle_kind\":\"incremental-update\",\"base_version\":\"${BASE_VERSION}\",\"target_version\":\"${TARGET_VERSION}\",\"git_sha\":\"${GIT_SHA}\",\"platform\":\"linux/amd64\",\"base_bundle_sha256\":\"${BASE_BUNDLE_SHA256}\",\"components\":\"${COMPONENTS}\",\"database_migration\":\"${DATABASE_MIGRATION}\",\"rollback_mode\":\"${ROLLBACK_MODE}\",\"object_migration\":\"none\",\"changed_images_lock_sha256\":\"${CHANGED_LOCK_SHA256}\"}" \
  > "${BUNDLE_DIR}/update-manifest.json"

BUILD_TIME="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
cat > "${BUNDLE_DIR}/RELEASE.txt" <<EOF
bundle=${BUNDLE_NAME}.tar.gz
bundle_kind=incremental-update
base_version=${BASE_VERSION}
application_version=${TARGET_VERSION}
components=${COMPONENTS}
git_sha=${GIT_SHA}
platform=${PLATFORM}
build_time=${BUILD_TIME}
docker_version=$(docker version --format '{{.Client.Version}}')
buildx_version=$(docker buildx version | awk '{print $2}')
EOF

log "saving changed images: $COMPONENTS"
docker save --platform "$PLATFORM" --output "${BUNDLE_DIR}/images.tar" "${CHANGED_IMAGES[@]}"

(
  cd "$BUNDLE_DIR"
  find . -type f ! -name SHA256SUMS -print | LC_ALL=C sort | while IFS= read -r file; do
    printf '%s  %s\n' "$(sha256_file "$file")" "$file"
  done > SHA256SUMS
)

validate_update_bundle_contract "$BUNDLE_DIR"
verify_inner_bundle "$BUNDLE_DIR"

tar -C "$OUTPUT_ROOT" -czf "$ARCHIVE" "$BUNDLE_NAME"
printf '%s  %s\n' "$(sha256_file "$ARCHIVE")" "$(basename "$ARCHIVE")" > "$OUTER_CHECKSUM"

log "offline incremental update created"
printf '%s\n%s\n' "$ARCHIVE" "$OUTER_CHECKSUM"
