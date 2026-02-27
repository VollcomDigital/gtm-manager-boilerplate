from __future__ import annotations

import csv

from src.exporters.export_ga4_from_gtm import (
    export_ga4_tags_to_csv,
    extract_parameters,
    flatten_parameter_value,
)


def test_flatten_parameter_value_template() -> None:
    assert (
        flatten_parameter_value({"type": "TEMPLATE", "key": "eventName", "value": "purchase"})
        == "purchase"
    )


def test_flatten_parameter_value_list() -> None:
    assert flatten_parameter_value({"type": "LIST", "list": [{"value": "a"}, {"value": "b"}]}) == [
        "a",
        "b",
    ]


def test_flatten_parameter_value_map() -> None:
    assert flatten_parameter_value(
        {
            "type": "MAP",
            "map": [{"key": "name", "value": "item_id"}, {"key": "value", "value": "{{DLV}}"}],
        }
    ) == {"name": "item_id", "value": "{{DLV}}"}


def test_extract_parameters_expands_event_parameters() -> None:
    tag = {
        "name": "GA4 Event",
        "type": "gaawe",
        "parameter": [
            {"key": "eventName", "type": "TEMPLATE", "value": "purchase"},
            {
                "key": "eventParameters",
                "type": "LIST",
                "list": [
                    {
                        "type": "MAP",
                        "map": [
                            {"key": "name", "value": "item_id"},
                            {"key": "value", "value": "{{DLV Item ID}}"},
                        ],
                    }
                ],
            },
        ],
    }
    pairs = dict(extract_parameters(tag))
    assert pairs["eventName"] == "purchase"
    assert pairs["eventParameters"] == [{"name": "item_id", "value": "{{DLV Item ID}}"}]
    assert pairs["eventParameters.item_id"] == "{{DLV Item ID}}"


class _FakeRequest:
    def __init__(self, payload):
        self._payload = payload

    def execute(self):
        return self._payload


class _FakeVersions:
    def __init__(self, payload):
        self._payload = payload

    def latest(self, path: str):
        assert path.endswith("/versions/latest")
        return _FakeRequest(self._payload)


class _FakeContainers:
    def __init__(self, payload):
        self._payload = payload

    def versions(self):
        return _FakeVersions(self._payload)


class _FakeAccounts:
    def __init__(self, payload):
        self._payload = payload

    def containers(self):
        return _FakeContainers(self._payload)


class _FakeService:
    def __init__(self, payload):
        self._payload = payload

    def accounts(self):
        return _FakeAccounts(self._payload)


def test_export_ga4_tags_to_csv_writes_rows(tmp_path) -> None:
    payload = {
        "name": "accounts/1/containers/2/versions/3",
        "tag": [
            {"tagId": "1", "name": "Ignore", "type": "html"},
            {
                "tagId": "2",
                "name": "GA4 Config",
                "type": "gaawc",
                "parameter": [{"key": "measurementId", "type": "TEMPLATE", "value": "G-XXXX"}],
            },
            {
                "tagId": "3",
                "name": "GA4 Event",
                "type": "gaawe",
                "parameter": [{"key": "eventName", "type": "TEMPLATE", "value": "purchase"}],
            },
        ],
    }
    service = _FakeService(payload)
    out = tmp_path / "exports" / "ga4.csv"
    exported = export_ga4_tags_to_csv(service, "1", "2", str(out))
    assert exported == 2

    rows = list(csv.reader(out.read_text(encoding="utf-8").splitlines()))
    assert rows[0][0] == "account_id"
    # One row for GA4 Config parameter + one row for GA4 Event parameter.
    assert len(rows) == 1 + 2
