"""Target-key mapping helpers for GTM scripts.

This module provides a consistent way to resolve (account_id, container_id)
either directly or via a target-key mapping sourced from YAML or environment
variables.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

import yaml

DEFAULT_TARGETS_CONFIG = "config/targets.yaml"
LEGACY_DEFAULT_SALESLINE_CONFIG = "config/saleslines.yaml"
TARGETS_ENV_VAR = "GTM_TARGETS_JSON"
LEGACY_SALESLINES_ENV_VAR = "GTM_SALESLINES_JSON"


def load_target_mapping(config_path: str | None) -> dict[str, dict[str, Any]]:
    """Load the target-key -> GTM account/container mapping.

    The mapping can be supplied from:
    - a YAML file (preferred), or
    - a JSON payload in `GTM_TARGETS_JSON` (legacy: `GTM_SALESLINES_JSON`).

    The file can either be a raw mapping or contain top-level keys `targets` or
    `saleslines`. Grouped entries are supported, e.g.:

    ```yaml
    targets:
      central:
        ga4: { account_id: "...", container_id: "..." }
        marketing: { account_id: "...", container_id: "..." }
    ```

    which is flattened to keys like `central_ga4` / `central_marketing`.

    Args:
        config_path: Optional explicit YAML path.

    Returns:
        Normalized mapping keyed by target key, each containing `account_id` and `container_id`.

    Raises:
        FileNotFoundError: If neither file nor env mapping is available.
        ValueError: If the mapping is malformed.
    """
    mapping = _load_mapping_from_file(config_path)
    if mapping is None:
        mapping = _load_mapping_from_env()

    if mapping is None:
        source_hint = config_path or DEFAULT_TARGETS_CONFIG
        raise FileNotFoundError(
            "No target mapping found. Provide --config-path, create "
            f"{source_hint}, or export JSON via {TARGETS_ENV_VAR} "
            f"(legacy: {LEGACY_SALESLINES_ENV_VAR}).",
        )

    if not isinstance(mapping, dict):
        raise ValueError("Target entries must be provided as a mapping.")

    return _normalize_mapping(mapping)


def resolve_account_and_container(
    account_id: str | None,
    container_id: str | None,
    target_key: str | None,
    config_path: str | None,
) -> tuple[str, str]:
    """Resolve account/container identifiers directly or via target-key mapping.

    Args:
        account_id: Direct GTM account ID (numeric string).
        container_id: Direct GTM container ID (numeric string).
        target_key: Lookup key in mapping to fill missing identifiers.
        config_path: Optional mapping YAML path.

    Returns:
        Tuple of (account_id, container_id).

    Raises:
        ValueError: If required identifiers cannot be resolved.
    """
    resolved_account = account_id
    resolved_container = container_id

    if target_key:
        mapping = load_target_mapping(config_path)
        entry = mapping.get(target_key)
        if not entry:
            available = ", ".join(sorted(mapping.keys()))
            raise ValueError(
                f"Target key '{target_key}' not found. Available entries: {available or 'none'}",
            )
        resolved_account = resolved_account or str(entry.get("account_id") or "")
        resolved_container = resolved_container or str(entry.get("container_id") or "")

    if not resolved_account or not resolved_container:
        raise ValueError(
            "Provide --account-id and --container-id or specify --target-key/--salesline with a valid mapping.",
        )

    return str(resolved_account), str(resolved_container)


def _resolve_mapping_path(config_path: str | None) -> Path | None:
    if config_path:
        return Path(config_path)

    default_targets_path = Path(DEFAULT_TARGETS_CONFIG)
    if default_targets_path.exists():
        return default_targets_path

    legacy_default_path = Path(LEGACY_DEFAULT_SALESLINE_CONFIG)
    if legacy_default_path.exists():
        return legacy_default_path

    return None


def _load_mapping_from_file(config_path: str | None) -> dict[str, Any] | None:
    path_to_load = _resolve_mapping_path(config_path)
    if not path_to_load or not path_to_load.exists():
        return None

    with open(path_to_load, "r", encoding="utf-8") as config_file:
        raw_data = yaml.safe_load(config_file) or {}

    if not isinstance(raw_data, dict):
        raise ValueError("Target config must be a mapping.")

    # Support both: top-level mapping, or wrapped in `targets:` / `saleslines:`.
    raw_mapping = raw_data.get("targets", raw_data.get("saleslines", raw_data))
    if raw_mapping is None:
        return None
    if not isinstance(raw_mapping, dict):
        raise ValueError("Target config must be a mapping.")
    return raw_mapping


def _load_mapping_from_env() -> dict[str, Any] | None:
    source_env_var = TARGETS_ENV_VAR
    env_payload = os.getenv(source_env_var)
    if not env_payload:
        source_env_var = LEGACY_SALESLINES_ENV_VAR
        env_payload = os.getenv(source_env_var)
    if not env_payload:
        return None

    try:
        parsed = json.loads(env_payload)
    except json.JSONDecodeError as exc:
        raise ValueError(
            f"Failed to parse {source_env_var} environment variable as JSON.",
        ) from exc

    if not isinstance(parsed, dict):
        raise ValueError(f"{source_env_var} must contain a JSON object mapping.")
    return parsed


def _normalize_mapping(mapping: dict[str, Any]) -> dict[str, dict[str, Any]]:
    cleaned: dict[str, dict[str, Any]] = {}

    for key, value in mapping.items():
        if not isinstance(value, dict):
            raise ValueError(f"Target key '{key}' configuration must be a mapping.")

        if {"account_id", "container_id"} <= set(value.keys()):
            cleaned[key] = {
                "account_id": value.get("account_id"),
                "container_id": value.get("container_id"),
            }
            continue

        # Allow grouping keys (e.g., central: { ga4: {...}, marketing: {...} })
        subgroup_added = False
        for sub_key, sub_value in value.items():
            if not isinstance(sub_value, dict):
                continue
            if {"account_id", "container_id"} <= set(sub_value.keys()):
                cleaned_key = f"{key}_{sub_key}"
                cleaned[cleaned_key] = {
                    "account_id": sub_value.get("account_id"),
                    "container_id": sub_value.get("container_id"),
                }
                subgroup_added = True
        if subgroup_added:
            continue

        raise ValueError(
            f"Target key '{key}' configuration is missing 'account_id'/'container_id' "
            "and does not contain sub-entries with those fields.",
        )

    return cleaned
