from __future__ import annotations

from unittest.mock import MagicMock, patch

from src.managers.tag_manager import TagManager
from src.managers.trigger_manager import TriggerManager


def _mock_tag_resource(service: MagicMock) -> MagicMock:
    return service.accounts.return_value.containers.return_value.workspaces.return_value.tags.return_value


def _mock_trigger_resource(service: MagicMock) -> MagicMock:
    return service.accounts.return_value.containers.return_value.workspaces.return_value.triggers.return_value


def test_tag_manager_upsert_creates_new_tag() -> None:
    service = MagicMock()
    tag_resource = _mock_tag_resource(service)
    tag_resource.create.return_value.execute.return_value = {"name": "Tag A", "tagId": "10"}

    manager = TagManager(service)
    with patch.object(manager, "_find_tag_by_name", return_value=None):
        action, payload = manager.upsert_tag("1", "2", "3", {"name": "Tag A", "type": "gaawe"})

    assert action == "created"
    assert payload["tagId"] == "10"
    tag_resource.create.assert_called_once()


def test_tag_manager_upsert_noop_when_payload_matches() -> None:
    service = MagicMock()
    tag_resource = _mock_tag_resource(service)
    manager = TagManager(service)
    existing = {
        "name": "Tag A",
        "type": "gaawe",
        "path": "accounts/1/containers/2/workspaces/3/tags/10",
        "tagId": "10",
    }

    with patch.object(manager, "_find_tag_by_name", return_value=existing):
        action, payload = manager.upsert_tag("1", "2", "3", {"name": "Tag A", "type": "gaawe"})

    assert action == "noop"
    assert payload["name"] == "Tag A"
    tag_resource.update.assert_not_called()


def test_trigger_manager_upsert_updates_when_drift_detected() -> None:
    service = MagicMock()
    trigger_resource = _mock_trigger_resource(service)
    trigger_resource.update.return_value.execute.return_value = {
        "name": "All Pages",
        "triggerId": "20",
    }

    manager = TriggerManager(service)
    existing = {
        "name": "All Pages",
        "type": "CLICK",
        "path": "accounts/1/containers/2/workspaces/3/triggers/20",
        "triggerId": "20",
    }

    with patch.object(manager, "_find_trigger_by_name", return_value=existing):
        action, payload = manager.upsert_trigger(
            "1",
            "2",
            "3",
            {"name": "All Pages", "type": "PAGEVIEW"},
        )

    assert action == "updated"
    assert payload["triggerId"] == "20"
    trigger_resource.update.assert_called_once()
