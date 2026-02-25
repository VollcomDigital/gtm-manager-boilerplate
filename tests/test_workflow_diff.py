from __future__ import annotations

from managers.workflow_manager import diff_workspace


def test_diff_workspace_reports_create_update_delete() -> None:
    desired = {
        "tags": [{"name": "Main Tag", "type": "html", "notes": "new"}],
        "triggers": [{"name": "All Pages", "type": "PAGEVIEW"}],
        "variables": [{"name": "Env Var", "type": "v"}],
    }
    current = {
        "tags": [
            {"name": "Main Tag", "type": "html", "notes": "old"},
            {"name": "Old Tag", "type": "html"},
        ],
        "triggers": [{"name": "All Pages", "type": "PAGEVIEW"}],
        "variables": [],
    }

    diff = diff_workspace(desired, current)
    assert diff.tags.create == []
    assert diff.tags.update == ["Main Tag"]
    assert diff.tags.delete == ["Old Tag"]
    assert diff.variables.create == ["Env Var"]
