#!/usr/bin/env python3
"""
Export GA4 tags and parameters from a GTM container's latest version into CSV.
"""
import argparse
import csv
import json
import os
import pathlib
import sys
from typing import Any, Dict, List, Tuple

from googleapiclient.discovery import build
from googleapiclient.errors import HttpError
import yaml

SRC_ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(SRC_ROOT) not in sys.path:
    sys.path.insert(0, str(SRC_ROOT))

from utils.auth import get_credentials  # noqa: E402

# GTM read-only scope
SCOPES = ["https://www.googleapis.com/auth/tagmanager.readonly"]

GA4_EVENT_TYPE = "gaawe"  # GA4 Event
GA4_CONFIG_TYPE = "gaawc"  # GA4 Configuration
DEFAULT_TARGETS_CONFIG = "config/targets.yaml"
LEGACY_DEFAULT_SALESLINE_CONFIG = "config/saleslines.yaml"
TARGETS_ENV_VAR = "GTM_TARGETS_JSON"
LEGACY_SALESLINES_ENV_VAR = "GTM_SALESLINES_JSON"


def safe_get(data: Dict[str, Any], key: str, default=None):
    """Convenience wrapper for dict.get that safely handles None inputs."""
    return data.get(key, default) if isinstance(data, dict) else default


def load_salesline_mapping(config_path: str | None) -> Dict[str, Dict[str, Any]]:
    """
    Load the target-key -> container mapping from YAML or environment variables.

    Returns a dict keyed by target key. Supports optional grouping keys
    (e.g., "central:") which will be flattened automatically.
    """
    mapping = _load_salesline_mapping_from_file(config_path)
    if mapping is None:
        mapping = _load_salesline_mapping_from_env()

    if mapping is None:
        source_hint = config_path or DEFAULT_TARGETS_CONFIG
        raise FileNotFoundError(
            "No target mapping found. Provide --config-path, create "
            f"{source_hint}, or export JSON via {TARGETS_ENV_VAR} "
            f"(legacy: {LEGACY_SALESLINES_ENV_VAR}).",
        )

    if not isinstance(mapping, dict):
        raise ValueError("Target entries must be provided as a mapping.")

    return _normalize_salesline_mapping(mapping)


def _resolve_salesline_config_path(config_path: str | None) -> pathlib.Path | None:
    if config_path:
        return pathlib.Path(config_path)

    default_targets_path = pathlib.Path(DEFAULT_TARGETS_CONFIG)
    if default_targets_path.exists():
        return default_targets_path

    legacy_default_path = pathlib.Path(LEGACY_DEFAULT_SALESLINE_CONFIG)
    if legacy_default_path.exists():
        return legacy_default_path

    return None


def _load_salesline_mapping_from_file(config_path: str | None) -> Dict[str, Any] | None:
    path_to_load = _resolve_salesline_config_path(config_path)
    if not path_to_load or not path_to_load.exists():
        return None

    with open(path_to_load, "r", encoding="utf-8") as config_file:
        raw_data = yaml.safe_load(config_file) or {}

    if not isinstance(raw_data, dict):
        raise ValueError("Target config must be a mapping.")

    return raw_data.get("targets", raw_data.get("saleslines", raw_data))


def _load_salesline_mapping_from_env() -> Dict[str, Any] | None:
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

    return parsed


def _normalize_salesline_mapping(mapping: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
    cleaned: Dict[str, Dict[str, Any]] = {}

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


def resolve_account_and_container(
    account_id: str | None,
    container_id: str | None,
    target_key: str | None,
    config_path: str | None,
) -> Tuple[str, str]:
    """
    Resolve account/container identifiers directly or via target-key mapping.
    """
    resolved_account = account_id
    resolved_container = container_id

    if target_key:
        mapping = load_salesline_mapping(config_path)
        entry = mapping.get(target_key)
        if not entry:
            available = ", ".join(sorted(mapping.keys()))
            raise ValueError(
                f"Target key '{target_key}' not found. Available entries: {available or 'none'}",
            )

        resolved_account = resolved_account or entry.get("account_id")
        resolved_container = resolved_container or entry.get("container_id")

    if not resolved_account or not resolved_container:
        raise ValueError(
            "Provide --account-id and --container-id or specify --target-key/--salesline with a valid mapping.",
        )

    return str(resolved_account), str(resolved_container)


def is_ga4_tag(tag: Dict[str, Any]) -> bool:
    """Return True if tag type is GA4 (Event or Configuration)."""
    return safe_get(tag, "type") in {GA4_EVENT_TYPE, GA4_CONFIG_TYPE}


def flatten_parameter_value(param_obj: Dict[str, Any]) -> Any:
    """
    GTM API Parameter object can be:
      - {"type":"TEMPLATE","key":"eventName","value":"purchase"}
      - {"type":"LIST","key":"eventParameters","list":[{Parameter}, ...]}
      - {"type":"MAP","map":[{"key":"name","value":"item_id"}, {"key":"value","value":"{{DLV Item ID}}"}]}
    This converts any shape into a plain Python structure suitable for CSV/JSON.
    """
    if not isinstance(param_obj, dict):
        return param_obj

    if "value" in param_obj and param_obj["value"] is not None:
        return param_obj["value"]

    if "list" in param_obj and isinstance(param_obj["list"], list):
        return [flatten_parameter_value(item) for item in param_obj["list"]]

    if "map" in param_obj and isinstance(param_obj["map"], list):
        mapped: Dict[str, Any] = {}
        for entry in param_obj["map"]:
            key = entry.get("key")
            if key:
                mapped[key] = entry.get("value")
        return mapped

    return {k: v for k, v in param_obj.items() if k not in ("list", "map")}


def extract_parameters(tag: Dict[str, Any]) -> List[Tuple[str, Any]]:
    """Return list of (param_key, param_value) pairs for a tag."""
    pairs: List[Tuple[str, Any]] = []
    params = safe_get(tag, "parameter", []) or []

    for param in params:
        key = param.get("key", "")
        pairs.append((key, flatten_parameter_value(param)))
        pairs.extend(_extract_event_parameter_pairs(param, key))

    return pairs


def _extract_event_parameter_pairs(
    param: Dict[str, Any],
    key: str,
) -> List[Tuple[str, Any]]:
    if key != "eventParameters":
        return []

    raw_items = param.get("list", [])
    if not isinstance(raw_items, list):
        return []

    output: List[Tuple[str, Any]] = []
    for item in raw_items:
        mapped = _extract_named_value_from_map(item)
        if mapped:
            output.append((f"eventParameters.{mapped.get('name', '')}", mapped.get("value", "")))

    return output


def _extract_named_value_from_map(item: Any) -> Dict[str, Any]:
    if not isinstance(item, dict):
        return {}

    raw_map = item.get("map", [])
    if not isinstance(raw_map, list):
        return {}

    mapped: Dict[str, Any] = {}
    for entry in raw_map:
        if not isinstance(entry, dict):
            continue

        sub_key = entry.get("key")
        if sub_key:
            mapped[sub_key] = entry.get("value")

    return mapped


def normalize_value_for_csv(value: Any) -> str:
    """Convert complex values to compact JSON string representation."""
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False)
    if value is None:
        return ""
    return str(value)


def export_ga4_tags_to_csv(
    service,
    account_id: str,
    container_id: str,
    output_csv: str,
) -> int:
    """
    Pull latest container version, filter GA4 tags, flatten parameters, and write CSV.
    Returns the number of GA4 tags exported.
    """
    version_path = f"accounts/{account_id}/containers/{container_id}/versions/latest"
    response = (
        service.accounts()
        .containers()
        .versions()
        .latest(path=version_path)
        .execute()
    )

    tags = response.get("tag", []) or []
    ga4_tags = [tag for tag in tags if is_ga4_tag(tag)]

    header = [
        "account_id",
        "container_id",
        "container_version_name",
        "tag_id",
        "tag_name",
        "tag_type",
        "event_name",
        "parameter_key",
        "parameter_value",
    ]

    with open(output_csv, "w", newline="", encoding="utf-8") as file_handle:
        writer = csv.writer(file_handle)
        writer.writerow(header)

        version_name = response.get("name", "")

        for tag in ga4_tags:
            tag_id = tag.get("tagId", "")
            tag_name = tag.get("name", "")
            tag_type = tag.get("type", "")

            event_name = ""
            for param in tag.get("parameter", []) or []:
                if param.get("key") == "eventName":
                    event_name = normalize_value_for_csv(flatten_parameter_value(param))
                    break

            parameters = extract_parameters(tag)

            if parameters:
                for key, value in parameters:
                    writer.writerow(
                        [
                            account_id,
                            container_id,
                            version_name,
                            tag_id,
                            tag_name,
                            tag_type,
                            event_name,
                            key,
                            normalize_value_for_csv(value),
                        ],
                    )
            else:
                writer.writerow(
                    [
                        account_id,
                        container_id,
                        version_name,
                        tag_id,
                        tag_name,
                        tag_type,
                        event_name,
                        "",
                        "",
                    ],
                )

    return len(ga4_tags)


def parse_args() -> argparse.Namespace:
    """Parse CLI arguments."""
    parser = argparse.ArgumentParser(
        description="Export GA4 tags and parameters from a GTM container to CSV (latest version).",
    )
    parser.add_argument("--account-id", help="GTM Account ID (e.g., 2824463661)")
    parser.add_argument("--container-id", help="GTM Container ID (e.g., 51955729)")
    parser.add_argument(
        "--target-key",
        help="Target key defined in the YAML mapping for account/container lookup.",
    )
    parser.add_argument(
        "--salesline",
        dest="legacy_target_key",
        help=argparse.SUPPRESS,
    )
    parser.add_argument(
        "--config-path",
        help=(
            "Path to the target configuration YAML. "
            f"Defaults to {DEFAULT_TARGETS_CONFIG} (legacy fallback: {LEGACY_DEFAULT_SALESLINE_CONFIG}) "
            "when --target-key/--salesline is used."
        ),
    )
    parser.add_argument(
        "--output",
        default="ga4_tags.csv",
        help="Output CSV filename (default: ga4_tags.csv)",
    )
    parser.add_argument(
        "--auth",
        choices=["service", "user", "adc"],
        default="user",
        help="Auth method: service (Service Account), user (OAuth), or adc (gcloud / ADC). Default: user",
    )
    parser.add_argument(
        "--credentials",
        help=(
            "Path to Service Account JSON (for --auth service) or OAuth client_secrets.json "
            "(for --auth user). Not required for --auth adc."
        ),
    )
    return parser.parse_args()


def main():
    """CLI entry point."""
    args = parse_args()

    try:
        credentials = get_credentials(args.auth, args.credentials, SCOPES)
        account_id, container_id = resolve_account_and_container(
            args.account_id,
            args.container_id,
            args.target_key or args.legacy_target_key,
            args.config_path,
        )
        service = build("tagmanager", "v2", credentials=credentials, cache_discovery=False)
        count = export_ga4_tags_to_csv(
            service,
            account_id,
            container_id,
            args.output,
        )
        print(f"Done. Wrote GA4 tags to {args.output}. GA4 tags found: {count}")
    except HttpError as error:
        print(f"GTM API error: {error}")
        raise
    except Exception as error:
        print(f"Error: {error}")
        raise


if __name__ == "__main__":
    main()
