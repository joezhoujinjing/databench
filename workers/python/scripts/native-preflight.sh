#!/usr/bin/env bash
set -euo pipefail

UV_BIN=${1:-${DATABENCH_UV:-$(command -v uv)}}
PYTHON_BIN=${2:-${DATABENCH_PYTHON:-$("${UV_BIN}" python find 3.11.15)}}

test -x "${UV_BIN}" || { echo "native uv is not executable: ${UV_BIN}" >&2; exit 1; }
test -x "${PYTHON_BIN}" || { echo "native Python is not executable: ${PYTHON_BIN}" >&2; exit 1; }

UV_ARCH=$("${UV_BIN}" --version 2>&1)
PYTHON_FACTS=$("${PYTHON_BIN}" -c 'import platform,sys; print(f"{platform.system()} {sys.version.split()[0]} {platform.machine()}")')

case "${UV_ARCH}" in
  "uv 0.11.1 "*) ;;
  *) echo "uv must be version 0.11.1, got: ${UV_ARCH}" >&2; exit 1 ;;
esac

case "${PYTHON_FACTS}" in
  "Darwin 3.11.15 arm64")
    case "${UV_BIN}" in
      /usr/local/*) echo "refusing Rosetta uv under /usr/local: ${UV_BIN}" >&2; exit 1 ;;
    esac
    case "${PYTHON_BIN}" in
      /usr/local/*) echo "refusing Rosetta Python under /usr/local: ${PYTHON_BIN}" >&2; exit 1 ;;
    esac
    case "${UV_ARCH}" in
      *aarch64-apple-darwin*) ;;
      *) echo "uv must be native Apple Silicon: ${UV_ARCH}" >&2; exit 1 ;;
    esac
    ;;
  "Linux 3.11.15 "*) ;;
  *) echo "Python must be 3.11.15 (and ARM64 on macOS), got: ${PYTHON_FACTS}" >&2; exit 1 ;;
esac

echo "native worker toolchain: ${UV_ARCH}; Python ${PYTHON_FACTS}"
