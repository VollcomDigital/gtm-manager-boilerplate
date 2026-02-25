from __future__ import annotations

from unittest.mock import MagicMock

from src.managers.container_manager import ContainerManager


def test_container_manager_diff_workspace() -> None:
    manager = ContainerManager(MagicMock())
    manager.get_workspace_snapshot = MagicMock(
        return_value={
            "variables": [{"name": "Currency", "type": "v"}],
            "triggers": [{"name": "All Pages", "type": "PAGEVIEW"}],
            "tags": [{"name": "GA4 Config", "type": "gaawc"}],
        },
    )
    desired_state = {
        "variables": [{"name": "Currency", "type": "v"}],
        "triggers": [{"name": "All Pages", "type": "CLICK"}],
        "tags": [{"name": "GA4 Config", "type": "gaawc"}, {"name": "GA4 Event", "type": "gaawe"}],
    }

    diff = manager.diff_workspace("1", "2", "3", desired_state)
    assert diff["variables"] == {"create": [], "update": [], "delete": []}
    assert diff["triggers"]["update"] == ["All Pages"]
    assert diff["tags"]["create"] == ["GA4 Event"]


def test_container_manager_sync_workspace_summary_and_delete_missing() -> None:
    manager = ContainerManager(MagicMock())
    manager.upsert_variable = MagicMock(return_value=("created", {"name": "Currency"}))
    manager.delete_variable_by_name = MagicMock(return_value=True)

    manager.trigger_manager = MagicMock()
    manager.trigger_manager.upsert_trigger.return_value = ("updated", {"name": "All Pages"})
    manager.trigger_manager.delete_trigger_by_name.return_value = True

    manager.tag_manager = MagicMock()
    manager.tag_manager.upsert_tag.return_value = ("noop", {"name": "GA4 Config"})
    manager.tag_manager.delete_tag_by_name.return_value = True

    manager.get_workspace_snapshot = MagicMock(
        return_value={
            "variables": [{"name": "Legacy Var"}],
            "triggers": [{"name": "Legacy Trigger"}],
            "tags": [{"name": "Legacy Tag"}],
        },
    )

    summary = manager.sync_workspace(
        "1",
        "2",
        "3",
        desired_state={
            "variables": [{"name": "Currency"}],
            "triggers": [{"name": "All Pages"}],
            "tags": [{"name": "GA4 Config"}],
        },
        delete_missing=True,
        dry_run=True,
    )

    assert summary["variables"]["created"] == ["Currency"]
    assert summary["triggers"]["updated"] == ["All Pages"]
    assert summary["tags"]["noop"] == ["GA4 Config"]
    assert summary["variables"]["deleted"] == ["Legacy Var"]
    assert summary["triggers"]["deleted"] == ["Legacy Trigger"]
    assert summary["tags"]["deleted"] == ["Legacy Tag"]


def test_container_manager_publish_workspace_dry_run_and_apply() -> None:
    manager = ContainerManager(MagicMock())

    dry_run_result = manager.publish_workspace(
        "1",
        "2",
        "3",
        version_name="Release 1",
        notes="Automated publish",
        dry_run=True,
    )
    assert dry_run_result["dry_run"] is True
    assert dry_run_result["versionName"] == "Release 1"

    manager.create_container_version = MagicMock(
        return_value={"containerVersion": {"path": "accounts/1/containers/2/versions/9"}},
    )
    manager.publish_container_version = MagicMock(
        return_value={"containerVersion": {"path": "accounts/1/containers/2/versions/9"}},
    )
    applied = manager.publish_workspace(
        "1",
        "2",
        "3",
        version_name="Release 1",
        notes="Automated publish",
        dry_run=False,
    )

    assert applied["containerVersionPath"] == "accounts/1/containers/2/versions/9"
    manager.create_container_version.assert_called_once()
    manager.publish_container_version.assert_called_once_with("accounts/1/containers/2/versions/9")
