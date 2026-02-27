#!/usr/bin/env python3
"""Export a GTM snapshot (tags, triggers, variables) to stable JSON.

This is useful for:
- reviewing state over time,
- creating a "desired snapshot" artifact for diff/sync workflows,
- testing automation logic offline.
"""

from __future__ import annotations

import argparse
import json
import pathlib
import sys
from typing import Any

from googleapiclient.discovery import build
from googleapiclient.errors import HttpError

SRC_ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(SRC_ROOT) not in sys.path:
    sys.path.insert(0, str(SRC_ROOT))

from managers.container_manager import ContainerManager  # noqa: E402
from managers.tag_manager import TagManager  # noqa: E402
from managers.trigger_manager import TriggerManager  # noqa: E402
from managers.variable_manager import VariableManager  # noqa: E402
from managers.workflow_manager import normalize_for_diff  # noqa: E402
from utils.auth import get_credentials  # noqa: E402
from utils.helpers import ensure_output_directory  # noqa: E402
from utils.targets import (  # noqa: E402
    DEFAULT_TARGETS_CONFIG,
    LEGACY_DEFAULT_SALESLINE_CONFIG,
    resolve_account_and_container,
)

SCOPES = ["https://www.googleapis.com/auth/tagmanager.readonly"]


def _sort_by_name(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return sorted(items, key=lambda x: str(x.get("name") or "").strip().lower())


def export_snapshot_from_latest_version(
    service: Any, account_id: str, container_id: str
) -> dict[str, Any]:
    """Export tags/triggers/variables from the latest container version."""
    version_path = f"accounts/{account_id}/containers/{container_id}/versions/latest"
    resp = service.accounts().containers().versions().latest(path=version_path).execute()

    tags = [
        normalize_for_diff(t)
        for t in _sort_by_name(resp.get("tag", []) or [])
        if isinstance(t, dict)
    ]
    triggers = [
        normalize_for_diff(t)
        for t in _sort_by_name(resp.get("trigger", []) or [])
        if isinstance(t, dict)
    ]
    variables = [
        normalize_for_diff(v)
        for v in _sort_by_name(resp.get("variable", []) or [])
        if isinstance(v, dict)
    ]

    return {
        "source": {"type": "containerVersionLatest", "path": version_path},
        "containerVersion": {
            "name": resp.get("name"),
            "containerVersionId": resp.get("containerVersionId"),
            "path": resp.get("path"),
        },
        "tags": tags,
        "triggers": triggers,
        "variables": variables,
    }


def export_snapshot_from_workspace(
    service: Any,
    account_id: str,
    container_id: str,
    workspace_name: str,
) -> dict[str, Any]:
    """Export tags/triggers/variables from a workspace (by name)."""
    containers = ContainerManager(service)
    result = containers.get_or_create_workspace(
        account_id,
        container_id,
        workspace_name,
        dry_run=True,
    )
    workspace = result[1] if isinstance(result, tuple) and len(result) == 2 else result
    workspace_id = workspace.get("workspaceId")
    workspace_path = workspace.get("path") or (
        f"accounts/{account_id}/containers/{container_id}/workspaces/{workspace_id}"
        if workspace_id
        else None
    )
    if not isinstance(workspace_path, str) or not workspace_path.strip():
        raise ValueError("Workspace response missing path/workspaceId.")

    tags_manager = TagManager(service)
    triggers_manager = TriggerManager(service)
    variables_manager = VariableManager(service)

    tags = [
        normalize_for_diff(t)
        for t in _sort_by_name(tags_manager.list_tags_from_workspace_path(workspace_path))
        if isinstance(t, dict)
    ]
    triggers = [
        normalize_for_diff(t)
        for t in _sort_by_name(triggers_manager.list_triggers_from_workspace_path(workspace_path))
        if isinstance(t, dict)
    ]
    variables = [
        normalize_for_diff(v)
        for v in _sort_by_name(variables_manager.list_variables_from_workspace_path(workspace_path))
        if isinstance(v, dict)
    ]

    return {
        "source": {"type": "workspace", "name": workspace_name, "path": workspace_path},
        "workspace": {
            "name": workspace.get("name"),
            "workspaceId": workspace.get("workspaceId"),
            "path": workspace.get("path"),
        },
        "tags": tags,
        "triggers": triggers,
        "variables": variables,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Export a stable GTM snapshot (tags, triggers, variables) to JSON.",
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
        "--workspace-name",
        help="If set, export this workspace by name. Otherwise exports the latest container version snapshot.",
    )
    parser.add_argument(
        "--output",
        help="Output JSON filename. If omitted, prints to stdout.",
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


def main() -> None:
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

        if args.workspace_name:
            snapshot = export_snapshot_from_workspace(
                service, account_id, container_id, args.workspace_name
            )
        else:
            snapshot = export_snapshot_from_latest_version(service, account_id, container_id)

        payload = json.dumps(snapshot, indent=2, ensure_ascii=False)
        if args.output:
            ensure_output_directory(args.output)
            with open(args.output, "w", encoding="utf-8") as handle:
                handle.write(payload)
            print(f"Wrote snapshot to {args.output}")
        else:
            print(payload)
    except HttpError as error:
        print(f"GTM API error: {error}")
        raise
    except Exception as error:
        print(f"Error: {error}")
        raise


if __name__ == "__main__":
    main()
