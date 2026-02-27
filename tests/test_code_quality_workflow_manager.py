from __future__ import annotations

import ast
from pathlib import Path


def _get_function_def(module: ast.Module, name: str) -> ast.FunctionDef:
    for node in module.body:
        if isinstance(node, ast.ClassDef):
            for item in node.body:
                if isinstance(item, ast.FunctionDef) and item.name == name:
                    return item
    raise AssertionError(f"Function not found: {name}")


def _count_assignments_to_name(fn: ast.FunctionDef, target_name: str) -> int:
    count = 0
    for node in ast.walk(fn):
        if isinstance(node, ast.Assign):
            for t in node.targets:
                if isinstance(t, ast.Name) and t.id == target_name:
                    count += 1
                if isinstance(t, ast.Tuple):
                    for elt in t.elts:
                        if isinstance(elt, ast.Name) and elt.id == target_name:
                            count += 1
    return count


def test_sync_workspace_does_not_redefine_tag_by_name() -> None:
    """Arrange-Act-Assert: prevent redundant tag_by_name assignments regression."""
    src_path = Path(__file__).resolve().parents[1] / "src" / "managers" / "workflow_manager.py"
    tree = ast.parse(src_path.read_text(encoding="utf-8"))

    fn = _get_function_def(tree, "sync_workspace")
    # The only allowed assignment is the one that receives `_sync_tags(...)` results.
    assert _count_assignments_to_name(fn, "tag_by_name") == 1

