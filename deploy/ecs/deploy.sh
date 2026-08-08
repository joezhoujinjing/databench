#!/usr/bin/env bash
set -euo pipefail

IMAGE_ARCHIVE="${1:-}"
RELEASE_TAG="${2:-}"
APP_DIR="${APP_DIR:-/opt/databench}"
LEGACY_STACK="${LEGACY_STACK:-/opt/liber-stack/docker-compose.yaml}"
CLEANUP_SCRIPT="${APP_DIR}/cleanup.sh"

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

if [[ ! -f "${CLEANUP_SCRIPT}" ]]; then
  echo "missing ${CLEANUP_SCRIPT}" >&2
  exit 78
fi

# shellcheck source=cleanup.sh
source "${CLEANUP_SCRIPT}"

ensure_cursor_secret() {
  if grep -q '^DATABENCH_V2_CURSOR_SECRET=' "${APP_DIR}/api.env"; then
    return
  fi
  if ! command -v openssl >/dev/null 2>&1; then
    echo "openssl is required to generate DATABENCH_V2_CURSOR_SECRET" >&2
    exit 78
  fi
  umask 077
  printf '\nDATABENCH_V2_CURSOR_SECRET=%s\n' "$(openssl rand -hex 32)" >> "${APP_DIR}/api.env"
  chmod 600 "${APP_DIR}/api.env"
  echo "Generated missing DATABENCH_V2_CURSOR_SECRET in ${APP_DIR}/api.env"
}

ensure_cursor_secret

ensure_hex_secret() {
  local key="$1"
  local file="$2"
  local line
  line="$(grep -E "^${key}=" "${file}" | tail -n 1 || true)"
  if [[ -n "${line}" ]]; then
    if [[ ! "${line#*=}" =~ ^[0-9a-f]{64}$ ]]; then
      echo "${key} in ${file} must contain 32 random bytes in lowercase hex" >&2
      exit 78
    fi
    return
  fi
  if ! command -v openssl >/dev/null 2>&1; then
    echo "openssl is required to generate ${key}" >&2
    exit 78
  fi
  umask 077
  printf '\n%s=%s\n' "${key}" "$(openssl rand -hex 32)" >> "${file}"
  chmod 600 "${file}"
  echo "Generated missing ${key} in ${file}"
}

ensure_evalscope_config() {
  local config_file="${APP_DIR}/evalscope.env"
  local example_file="${APP_DIR}/evalscope.env.example"
  if [[ ! -f "${config_file}" ]]; then
    if [[ ! -f "${example_file}" ]]; then
      echo "missing ${example_file}" >&2
      exit 78
    fi
    umask 077
    grep -v -E '^(EVALSCOPE_TASK_CONFIG_HMAC_KEY|EVALSCOPE_OPERATOR_TOKEN)=' \
      "${example_file}" > "${config_file}"
    chmod 600 "${config_file}"
  fi
  ensure_hex_secret EVALSCOPE_TASK_CONFIG_HMAC_KEY "${config_file}"
  ensure_hex_secret EVALSCOPE_OPERATOR_TOKEN "${config_file}"
}

ensure_evalscope_runtime_files() {
  install -d -m 0750 "${APP_DIR}/config"
  if [[ ! -f "${APP_DIR}/config/model-endpoint-policy.json" ]]; then
    install -m 0644 "${APP_DIR}/model-endpoint-policy.example.json" \
      "${APP_DIR}/config/model-endpoint-policy.json"
  fi
  if [[ ! -f "${APP_DIR}/config/evalscope-model-credentials.json" ]]; then
    install -m 0444 "${APP_DIR}/evalscope-model-credentials.example.json" \
      "${APP_DIR}/config/evalscope-model-credentials.json"
  fi
}

ensure_hex_secret DATABENCH_EVALSCOPE_ACCESS_TOKEN "${APP_DIR}/api.env"
ensure_evalscope_config
ensure_evalscope_runtime_files

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

for key in DATABASE_URL OSS_REGION OSS_BUCKET OSS_ACCESS_KEY_ID OSS_ACCESS_KEY_SECRET DATABENCH_CORS_ORIGINS DATABENCH_ROOT DATABENCH_V2_CURSOR_SECRET PORT; do
  require_env_value "${key}"
done
for key in EVALSCOPE_TASK_CONFIG_HMAC_KEY EVALSCOPE_OPERATOR_TOKEN EVALSCOPE_MAX_CONCURRENT_EVALS EVALSCOPE_MAX_CONCURRENT_PERF EVALSCOPE_TASK_RUNTIME_SECONDS EVALSCOPE_EVALUATION_SAMPLE_LIMIT_MAX; do
  if ! grep -q -E "^${key}=.+" "${APP_DIR}/evalscope.env"; then
    echo "missing required ${key} in ${APP_DIR}/evalscope.env" >&2
    exit 78
  fi
done

cleanup_databench_releases "${RELEASE_TAG}" "${IMAGE_ARCHIVE}" pre-load

echo "Loading image ${IMAGE_ARCHIVE}..."
gzip -dc "${IMAGE_ARCHIVE}" | docker load

cat > "${APP_DIR}/compose.env" <<EOF
DATABENCH_API_IMAGE=databench-api:${RELEASE_TAG}
DATABENCH_EVALSCOPE_IMAGE=databench-evalscope:${RELEASE_TAG}
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
    if [[ "$(docker inspect --format '{{.State.Health.Status}}' databench-evalscope 2>/dev/null || true)" != 'healthy' ]]; then
      sleep 2
      continue
    fi
    echo "databench API and EvalScope are healthy"
    "${COMPOSE[@]}" ps
    cleanup_databench_releases "${RELEASE_TAG}" "${IMAGE_ARCHIVE}" post-deploy
    exit 0
  fi
  sleep 2
done

echo "databench API did not become healthy in time" >&2
"${COMPOSE[@]}" ps >&2 || true
"${COMPOSE[@]}" logs --tail=200 api >&2 || true
"${COMPOSE[@]}" logs --tail=200 evalscope >&2 || true
exit 1
