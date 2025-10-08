#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

OUTPUT_PATH="${GTM_OUTPUT_PATH:-${1:-data/exports/ga4_tags.csv}}"

CMD=(
  poetry run python
  "${SCRIPT_DIR}/../src/exporters/export_ga4_from_gtm.py"
  --auth "${GTM_AUTH_METHOD:-user}"
  --output "${OUTPUT_PATH}"
)

if [[ "${GTM_AUTH_METHOD:-user}" != "adc" ]]; then
  CMD+=(--credentials "${GTM_CREDENTIALS_PATH:?Set GTM_CREDENTIALS_PATH for service/user auth}")
fi

if [[ -n "${GTM_SALESLINE:-}" ]]; then
  CMD+=(--salesline "${GTM_SALESLINE}")
  if [[ -n "${GTM_CONFIG_PATH:-}" ]]; then
    CMD+=(--config-path "${GTM_CONFIG_PATH}")
  fi
else
  CMD+=(--account-id "${GTM_ACCOUNT_ID:?Set GTM_ACCOUNT_ID or GTM_SALESLINE}")
  CMD+=(--container-id "${GTM_CONTAINER_ID:?Set GTM_CONTAINER_ID or GTM_SALESLINE}")
fi

exec "${CMD[@]}"
