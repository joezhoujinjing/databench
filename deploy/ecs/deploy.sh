#!/usr/bin/env bash
set -euo pipefail

IMAGE_ARCHIVE="${1:-}"
RELEASE_TAG="${2:-}"
APP_DIR="${APP_DIR:-/opt/databench}"
LEGACY_STACK="${LEGACY_STACK:-/opt/liber-stack/docker-compose.yaml}"

if [[ -z "${IMAGE_ARCHIVE}" || -z "${RELEASE_TAG}" ]]; then
  echo "usage: $0 <image-archive.tar.gz> <release-tag>" >&2
  exit 64
fi

if [[ ! -f "${IMAGE_ARCHIVE}" ]]; then
  echo "image archive not found: ${IMAGE_ARCHIVE}" >&2
  exit 66
fi

cd "${APP_DIR}"

if [[ ! -f "${APP_DIR}/api.env" ]]; then
  echo "missing ${APP_DIR}/api.env; create it from deploy/ecs/api.env.example first" >&2
  exit 78
fi

require_env_value() {
  local key="$1"
  local line
  line="$(grep -E "^${key}=" "${APP_DIR}/api.env" | tail -n 1 || true)"
  if [[ -z "${line}" ]]; then
    echo "missing required ${key} in ${APP_DIR}/api.env" >&2
    exit 78
  fi

  local value="${line#*=}"
  if [[ -z "${value}" || "${value}" == *REPLACE_ME* || "${value}" == *"<"* || "${value}" == *">"* ]]; then
    echo "invalid placeholder value for ${key} in ${APP_DIR}/api.env" >&2
    exit 78
  fi
}

for key in DATABASE_URL OSS_REGION OSS_BUCKET OSS_ACCESS_KEY_ID OSS_ACCESS_KEY_SECRET DATABENCH_CORS_ORIGINS DATABENCH_ROOT PORT; do
  require_env_value "${key}"
done

echo "Loading image ${IMAGE_ARCHIVE}..."
gzip -dc "${IMAGE_ARCHIVE}" | docker load

cat > "${APP_DIR}/compose.env" <<EOF
DATABENCH_API_IMAGE=databench-api:${RELEASE_TAG}
EOF

COMPOSE=(docker compose --env-file "${APP_DIR}/compose.env" -f "${APP_DIR}/docker-compose.yml")

echo "Running database migrations..."
"${COMPOSE[@]}" run --rm api node_modules/.bin/prisma migrate deploy

if [[ -f "${LEGACY_STACK}" ]]; then
  echo "Stopping legacy stack at ${LEGACY_STACK} to release ports 80/443..."
  docker compose -f "${LEGACY_STACK}" down --remove-orphans
fi

echo "Starting databench services..."
"${COMPOSE[@]}" up -d --remove-orphans

echo "Waiting for local health check..."
for _ in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:8000/health >/dev/null; then
    echo "databench API is healthy"
    "${COMPOSE[@]}" ps
    exit 0
  fi
  sleep 2
done

echo "databench API did not become healthy in time" >&2
"${COMPOSE[@]}" ps >&2 || true
"${COMPOSE[@]}" logs --tail=200 api >&2 || true
exit 1
