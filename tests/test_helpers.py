from __future__ import annotations

from pathlib import Path

from src.utils.helpers import diff_entities_by_name, ensure_output_directory


def test_ensure_output_directory_creates_parent_path(tmp_path: Path) -> None:
    output_file = tmp_path / "nested" / "folder" / "snapshot.json"
    ensure_output_directory(str(output_file))
    assert output_file.parent.exists()


def test_diff_entities_by_name_ignores_read_only_fields() -> None:
    desired = [{"name": "Tag A", "type": "gaawe"}]
    current = [
        {
            "name": "Tag A",
            "type": "gaawe",
            "path": "accounts/1/containers/2/workspaces/3/tags/4",
            "tagId": "4",
            "fingerprint": "abc",
        }
    ]

    diff = diff_entities_by_name(desired, current)
    assert diff == {"create": [], "update": [], "delete": []}
