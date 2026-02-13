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

TARGET_KEY="${GTM_TARGET_KEY:-${GTM_SALESLINE:-}}"
if [[ -n "${TARGET_KEY}" ]]; then
  CMD+=(--target-key "${TARGET_KEY}")
  if [[ -n "${GTM_CONFIG_PATH:-}" ]]; then
    CMD+=(--config-path "${GTM_CONFIG_PATH}")
  fi
else
  CMD+=(--account-id "${GTM_ACCOUNT_ID:?Set GTM_ACCOUNT_ID or GTM_TARGET_KEY}")
  CMD+=(--container-id "${GTM_CONTAINER_ID:?Set GTM_CONTAINER_ID or GTM_TARGET_KEY}")
fi

exec "${CMD[@]}"
