#!/usr/bin/env bash

set -euo pipefail

CONFIG_PATH="${GTM_REPO_CONFIG_PATH:-${1:-gtm.repo.yml}}"

# Defaults are conservative: dry-run on, no deletes, no publish.
DRY_RUN="${GTM_DRY_RUN:-true}"
DELETE_MISSING="${GTM_DELETE_MISSING:-false}"
PUBLISH="${GTM_PUBLISH:-false}"

EXTRA_ARGS=()

if [[ -n "${GTM_CONTAINER_KEYS:-}" ]]; then
  EXTRA_ARGS+=(--container-keys "${GTM_CONTAINER_KEYS}")
fi

if [[ -n "${GTM_LABELS:-}" ]]; then
  EXTRA_ARGS+=(--labels "${GTM_LABELS}")
fi

if [[ "${DRY_RUN}" == "true" ]]; then
  EXTRA_ARGS+=(--dry-run)
fi

if [[ "${DELETE_MISSING}" == "true" ]]; then
  EXTRA_ARGS+=(--delete-missing --confirm)
fi

if [[ "${PUBLISH}" == "true" ]]; then
  EXTRA_ARGS+=(--publish --confirm)
  if [[ -n "${GTM_VERSION_NAME:-}" ]]; then
    EXTRA_ARGS+=(--version-name "${GTM_VERSION_NAME}")
  fi
  if [[ -n "${GTM_VERSION_NOTES:-}" ]]; then
    EXTRA_ARGS+=(--notes "${GTM_VERSION_NOTES}")
  fi
fi

exec npm run cli -- sync-repo --config "${CONFIG_PATH}" --json "${EXTRA_ARGS[@]}"
