#!/usr/bin/env python3
"""
Export GA4 tags and parameters from a GTM container's latest version into CSV.
"""

import argparse
import csv
import json
import pathlib
import sys
from typing import Any, Dict, List, Tuple

from googleapiclient.discovery import build
from googleapiclient.errors import HttpError

SRC_ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(SRC_ROOT) not in sys.path:
    sys.path.insert(0, str(SRC_ROOT))

from utils.auth import get_credentials  # noqa: E402
from utils.helpers import ensure_output_directory  # noqa: E402
from utils.targets import (  # noqa: E402
    DEFAULT_TARGETS_CONFIG,
    LEGACY_DEFAULT_SALESLINE_CONFIG,
    resolve_account_and_container,
)

# GTM read-only scope
SCOPES = ["https://www.googleapis.com/auth/tagmanager.readonly"]

GA4_EVENT_TYPE = "gaawe"  # GA4 Event
GA4_CONFIG_TYPE = "gaawc"  # GA4 Configuration


def safe_get(data: Dict[str, Any], key: str, default=None):
    """Convenience wrapper for dict.get that safely handles None inputs."""
    return data.get(key, default) if isinstance(data, dict) else default


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
    response = service.accounts().containers().versions().latest(path=version_path).execute()

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

    ensure_output_directory(output_csv)
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
