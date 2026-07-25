#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
WORKER_ROOT="${REPO_ROOT}/workers/python"
UV_BIN=${DATABENCH_UV:-$(command -v uv)}
PYTHON_BIN=${DATABENCH_PYTHON:-$("${UV_BIN}" python find 3.11.15)}

"${WORKER_ROOT}/scripts/native-preflight.sh" "${UV_BIN}" "${PYTHON_BIN}"

cd "${REPO_ROOT}"
pnpm exec buf lint proto
pnpm exec buf generate proto --template proto/buf.gen.yaml

"${UV_BIN}" run --directory "${WORKER_ROOT}" python -m grpc_tools.protoc \
  -I "${REPO_ROOT}/proto" \
  --python_out="${WORKER_ROOT}/src" \
  --grpc_python_out="${WORKER_ROOT}/src" \
  "${REPO_ROOT}/proto/databench/worker/v1/worker.proto"
