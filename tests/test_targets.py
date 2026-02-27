from __future__ import annotations

import json

import pytest

from src.utils.targets import load_target_mapping, resolve_account_and_container


def test_load_target_mapping_flattens_grouped_entries(tmp_path) -> None:
    config = tmp_path / "targets.yaml"
    config.write_text(
        """
targets:
  central:
    ga4:
      account_id: "111"
      container_id: "222"
    marketing:
      account_id: "333"
      container_id: "444"
  site_a:
    account_id: "555"
    container_id: "666"
""".lstrip(),
        encoding="utf-8",
    )

    mapping = load_target_mapping(str(config))
    assert mapping["central_ga4"]["account_id"] == "111"
    assert mapping["central_ga4"]["container_id"] == "222"
    assert mapping["central_marketing"]["account_id"] == "333"
    assert mapping["central_marketing"]["container_id"] == "444"
    assert mapping["site_a"]["account_id"] == "555"


def test_load_target_mapping_from_env(monkeypatch) -> None:
    monkeypatch.setenv(
        "GTM_TARGETS_JSON",
        json.dumps({"site_a": {"account_id": "1", "container_id": "2"}}),
    )
    mapping = load_target_mapping(None)
    assert mapping["site_a"]["account_id"] == "1"
    assert mapping["site_a"]["container_id"] == "2"


def test_resolve_account_and_container_prefers_direct_ids(monkeypatch) -> None:
    monkeypatch.setenv(
        "GTM_TARGETS_JSON",
        json.dumps({"site_a": {"account_id": "1", "container_id": "2"}}),
    )
    account_id, container_id = resolve_account_and_container("9", "8", "site_a", None)
    assert account_id == "9"
    assert container_id == "8"


def test_resolve_account_and_container_uses_target_key(monkeypatch) -> None:
    monkeypatch.setenv(
        "GTM_TARGETS_JSON",
        json.dumps({"site_a": {"account_id": "1", "container_id": "2"}}),
    )
    account_id, container_id = resolve_account_and_container(None, None, "site_a", None)
    assert account_id == "1"
    assert container_id == "2"


def test_resolve_account_and_container_raises_on_missing(monkeypatch) -> None:
    monkeypatch.delenv("GTM_TARGETS_JSON", raising=False)
    with pytest.raises(ValueError):
        resolve_account_and_container(None, None, None, None)
