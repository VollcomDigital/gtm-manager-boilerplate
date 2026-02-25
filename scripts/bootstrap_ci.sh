#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "${REPO_ROOT}"

export PATH="${HOME}/.local/bin:${PATH}"
export POETRY_VIRTUALENVS_IN_PROJECT=true
export POETRY_NO_INTERACTION=1

if [[ -n "${GITHUB_PATH:-}" ]]; then
  echo "${HOME}/.local/bin" >> "${GITHUB_PATH}"
fi

CACHE_DIR="${REPO_ROOT}/.cache/bootstrap"
mkdir -p "${CACHE_DIR}"

ensure_cmd() {
  local cmd="$1"
  if ! command -v "${cmd}" >/dev/null 2>&1; then
    echo "[bootstrap] Required command is missing: ${cmd}" >&2
    exit 1
  fi
}

sha_file() {
  local file_path="$1"
  sha256sum "${file_path}" | awk '{print $1}'
}

install_poetry_if_needed() {
  if command -v poetry >/dev/null 2>&1; then
    return
  fi

  echo "[bootstrap] Poetry is missing; installing with pip --user..."
  python3 -m pip install --user --upgrade pip
  python3 -m pip install --user poetry
}

bootstrap_node() {
  ensure_cmd npm
  if [[ ! -f "${REPO_ROOT}/package-lock.json" ]]; then
    echo "[bootstrap] package-lock.json is missing; cannot run npm ci." >&2
    exit 1
  fi

  local lock_hash
  lock_hash="$(sha_file package-lock.json)"
  local stamp_file="${CACHE_DIR}/node-${lock_hash}.stamp"

  if [[ -d "${REPO_ROOT}/node_modules" && -f "${stamp_file}" ]]; then
    echo "[bootstrap] Node deps up-to-date; skipping npm ci."
    return
  fi

  echo "[bootstrap] Installing Node dependencies (npm ci)..."
  npm ci --prefer-offline --no-audit
  rm -f "${CACHE_DIR}"/node-*.stamp
  touch "${stamp_file}"
}

bootstrap_python() {
  ensure_cmd python3
  if [[ ! -f "${REPO_ROOT}/pyproject.toml" || ! -f "${REPO_ROOT}/poetry.lock" ]]; then
    echo "[bootstrap] pyproject.toml and poetry.lock are required for Poetry bootstrap." >&2
    exit 1
  fi

  install_poetry_if_needed
  ensure_cmd poetry

  local lock_hash
  lock_hash="$( (sha256sum pyproject.toml poetry.lock) | sha256sum | awk '{print $1}')"
  local stamp_file="${CACHE_DIR}/python-${lock_hash}.stamp"
  local poetry_env_path=""
  poetry_env_path="$(poetry env info --path 2>/dev/null || true)"

  if [[ -n "${poetry_env_path}" && -d "${poetry_env_path}" && -f "${stamp_file}" ]]; then
    echo "[bootstrap] Python deps up-to-date; skipping poetry install."
    return
  fi

  echo "[bootstrap] Installing Python dependencies (poetry install --with dev)..."
  poetry install --with dev --no-ansi --no-root
  rm -f "${CACHE_DIR}"/python-*.stamp
  touch "${stamp_file}"
}

echo "[bootstrap] Starting environment bootstrap for gtm-manager-boilerplate..."
bootstrap_node
bootstrap_python
echo "[bootstrap] Bootstrap complete."
