#!/usr/bin/env bash
set -euo pipefail

API_ORIGIN="${1:-https://api.databench.jinjing.me}"
API_ORIGIN="${API_ORIGIN%/}"
EVALSCOPE_ACCESS_TOKEN="${DATABENCH_EVALSCOPE_ACCESS_TOKEN:-}"

curl -fsS "${API_ORIGIN}/health" >/dev/null
curl -fsS "${API_ORIGIN}/version" >/dev/null
curl -fsS "${API_ORIGIN}/capabilities" >/dev/null

if [[ -n "${EVALSCOPE_ACCESS_TOKEN}" ]]; then
  status="$(curl -sS -o /dev/null -w '%{http_code}' "${API_ORIGIN}/evalscope-api/health")"
  [[ "${status}" == '401' ]] || {
    echo "EvalScope anonymous health returned ${status}, expected 401" >&2
    exit 1
  }
  curl -fsS -H "Authorization: Bearer ${EVALSCOPE_ACCESS_TOKEN}" \
    "${API_ORIGIN}/evalscope-api/health" | grep -q 'ready'
  curl -fsS -H "Authorization: Bearer ${EVALSCOPE_ACCESS_TOKEN}" \
    "${API_ORIGIN}/evalscope-api/api/v1/config" | grep -q 'evalscope_commit'
  [[ "$(curl -sS -o /dev/null -w '%{http_code}' "${API_ORIGIN}/evalscope-api/unknown")" == '404' ]]
fi

echo "smoke ok: ${API_ORIGIN}"
