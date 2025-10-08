#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

ARGS=(
  poetry run python
  "${SCRIPT_DIR}/../src/exporters/list_gtm_accounts.py"
  --auth "${GTM_AUTH_METHOD:-user}"
)

if [[ "${GTM_AUTH_METHOD:-user}" != "adc" ]]; then
  ARGS+=(--credentials "${GTM_CREDENTIALS_PATH:?Set GTM_CREDENTIALS_PATH for service/user auth}")
fi

if [[ "${GTM_WITH_CONTAINERS:-0}" == "1" ]]; then
  ARGS+=(--with-containers)
fi

if [[ -n "${GTM_LIST_OUTPUT:-}" ]]; then
  ARGS+=(--output "${GTM_LIST_OUTPUT}")
fi

exec "${ARGS[@]}"
