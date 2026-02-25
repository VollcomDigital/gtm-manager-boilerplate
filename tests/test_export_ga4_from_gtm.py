from __future__ import annotations

import csv
import json
from pathlib import Path

from src.exporters.export_ga4_from_gtm import (
    export_ga4_tags_to_csv,
    export_triggers_to_csv,
    export_variables_to_csv,
    export_workspace_snapshot_to_json,
    resolve_account_and_container,
)


class _FakeRequest:
    def __init__(self, payload: dict):
        self._payload = payload

    def execute(self) -> dict:
        return self._payload


class _FakeVersionsResource:
    def __init__(self, payload: dict):
        self._payload = payload
        self.latest_paths: list[str] = []

    def latest(self, *, path: str) -> _FakeRequest:
        self.latest_paths.append(path)
        return _FakeRequest(self._payload)


class _FakeContainersResource:
    def __init__(self, versions_resource: _FakeVersionsResource):
        self._versions = versions_resource

    def versions(self) -> _FakeVersionsResource:
        return self._versions


class _FakeAccountsResource:
    def __init__(self, containers_resource: _FakeContainersResource):
        self._containers = containers_resource

    def containers(self) -> _FakeContainersResource:
        return self._containers


class _FakeService:
    def __init__(self, payload: dict):
        self.versions_resource = _FakeVersionsResource(payload)
        self.accounts_resource = _FakeAccountsResource(
            _FakeContainersResource(self.versions_resource),
        )

    def accounts(self) -> _FakeAccountsResource:
        return self.accounts_resource


LATEST_VERSION_PAYLOAD = {
    "name": "Version 42",
    "path": "accounts/1/containers/2/versions/42",
    "tag": [
        {
            "tagId": "10",
            "name": "GA4 Purchase",
            "type": "gaawe",
            "parameter": [
                {"key": "eventName", "type": "TEMPLATE", "value": "purchase"},
                {"key": "currency", "type": "TEMPLATE", "value": "USD"},
            ],
        },
        {"tagId": "11", "name": "Custom HTML", "type": "html"},
    ],
    "trigger": [
        {
            "triggerId": "20",
            "name": "All Pages",
            "type": "PAGEVIEW",
            "parameter": [{"key": "path", "type": "TEMPLATE", "value": "/"}],
        }
    ],
    "variable": [
        {
            "variableId": "30",
            "name": "DLV - Item Id",
            "type": "v",
            "parameter": [{"key": "name", "type": "TEMPLATE", "value": "item_id"}],
        }
    ],
}


def test_resolve_account_and_container_with_target_mapping(tmp_path: Path) -> None:
    config_path = tmp_path / "targets.yml"
    config_path.write_text(
        "targets:\n  site_a:\n    account_id: '123'\n    container_id: '456'\n",
        encoding="utf-8",
    )

    account_id, container_id = resolve_account_and_container(
        None,
        None,
        "site_a",
        str(config_path),
    )
    assert account_id == "123"
    assert container_id == "456"


def test_export_ga4_tags_to_csv_writes_only_ga4_rows(tmp_path: Path) -> None:
    service = _FakeService(LATEST_VERSION_PAYLOAD)
    output_path = tmp_path / "ga4.csv"

    count = export_ga4_tags_to_csv(service, "1", "2", str(output_path))
    assert count == 1

    with output_path.open("r", encoding="utf-8", newline="") as handle:
        rows = list(csv.reader(handle))

    assert rows[0][0:4] == [
        "account_id",
        "container_id",
        "container_version_name",
        "tag_id",
    ]
    assert rows[1][3] == "10"
    assert rows[1][4] == "GA4 Purchase"
    assert rows[1][6] == "purchase"


def test_export_triggers_variables_and_snapshot(tmp_path: Path) -> None:
    service = _FakeService(LATEST_VERSION_PAYLOAD)
    triggers_csv = tmp_path / "triggers.csv"
    variables_csv = tmp_path / "variables.csv"
    snapshot_json = tmp_path / "snapshot.json"

    trigger_count = export_triggers_to_csv(service, "1", "2", str(triggers_csv))
    variable_count = export_variables_to_csv(service, "1", "2", str(variables_csv))
    snapshot = export_workspace_snapshot_to_json(service, "1", "2", str(snapshot_json))

    assert trigger_count == 1
    assert variable_count == 1
    assert snapshot["container_version_name"] == "Version 42"
    assert len(snapshot["triggers"]) == 1
    assert len(snapshot["variables"]) == 1

    persisted_snapshot = json.loads(snapshot_json.read_text(encoding="utf-8"))
    assert persisted_snapshot["container_version_path"].endswith("/versions/42")
