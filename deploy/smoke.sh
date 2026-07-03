#!/usr/bin/env bash
set -euo pipefail

API_ORIGIN="${1:-https://api.databench.jinjing.me}"
API_ORIGIN="${API_ORIGIN%/}"

curl -fsS "${API_ORIGIN}/health" >/dev/null
curl -fsS "${API_ORIGIN}/version" >/dev/null
curl -fsS "${API_ORIGIN}/capabilities" >/dev/null

echo "smoke ok: ${API_ORIGIN}"
