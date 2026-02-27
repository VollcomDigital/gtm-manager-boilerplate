"""Shared helpers for GTM tooling."""

from __future__ import annotations

from pathlib import Path
from typing import Any


def ensure_output_directory(path: str) -> None:
    """Ensure the output directory exists for a given file or directory path.

    Args:
        path: A filesystem path. If it looks like a file path (has a suffix),
            the parent directory is created. Otherwise the path itself is treated
            as a directory to create.

    Returns:
        None.
    """
    candidate = Path(path).expanduser()
    directory = candidate.parent if candidate.suffix else candidate
    if str(directory) == "":
        return
    directory.mkdir(parents=True, exist_ok=True)


COMMON_READ_ONLY_FIELDS: set[str] = {
    "accountId",
    "containerId",
    "workspaceId",
    "path",
    "fingerprint",
    "tagManagerUrl",
    "tagId",
    "triggerId",
    "variableId",
}


def canonicalize_for_diff(value: Any, *, read_only_fields: set[str] | None = None) -> Any:
    """Return a stable, comparison-friendly representation of a GTM entity.

    Args:
        value: Any JSON-like structure (dict/list/primitives).
        read_only_fields: Optional set of dict keys to drop recursively. This is useful
            for stripping server-generated fields like ``path``/``fingerprint``/IDs.

    Returns:
        A stable structure with:
        - specified read-only keys removed
        - dict keys sorted
        - lists normalized recursively (and sorted when safely possible)
    """
    ro = read_only_fields or set()

    if isinstance(value, list):
        items = [canonicalize_for_diff(v, read_only_fields=ro) for v in value]
        if all(isinstance(x, dict) for x in items):
            # Deterministic ordering for list-of-dicts.
            return sorted(items, key=lambda x: repr(x))
        return items

    if isinstance(value, dict):
        out: dict[str, Any] = {}
        for k in sorted(value.keys()):
            if k in ro:
                continue
            out[k] = canonicalize_for_diff(value[k], read_only_fields=ro)
        return out

    return value


def diff_entities_by_name(
    desired: list[dict[str, Any]],
    current: list[dict[str, Any]],
    *,
    read_only_fields: set[str] | None = None,
) -> dict[str, list[str]]:
    """Compute a simple diff between desired/current entities keyed by ``name``.

    Entity identity is case-insensitive by ``name``.

    Args:
        desired: Desired entities.
        current: Current entities.
        read_only_fields: Keys to ignore in comparisons (e.g., path/fingerprint/IDs).

    Returns:
        Dict with keys: ``create``, ``update``, ``delete`` (each a list of names).
    """
    ro = read_only_fields or COMMON_READ_ONLY_FIELDS

    desired_by_name: dict[str, dict[str, Any]] = {}
    for d in desired:
        name = d.get("name")
        if isinstance(name, str) and name.strip():
            desired_by_name[name.strip().lower()] = d

    current_by_name: dict[str, dict[str, Any]] = {}
    for c in current:
        name = c.get("name")
        if isinstance(name, str) and name.strip():
            current_by_name[name.strip().lower()] = c

    create: list[str] = []
    update: list[str] = []
    delete: list[str] = []

    for name_lower, d in desired_by_name.items():
        current_entity = current_by_name.get(name_lower)
        if not current_entity:
            create.append(str(d.get("name") or name_lower))
            continue
        if canonicalize_for_diff(d, read_only_fields=ro) != canonicalize_for_diff(
            current_entity, read_only_fields=ro
        ):
            update.append(str(d.get("name") or name_lower))

    for name_lower, c in current_by_name.items():
        if name_lower not in desired_by_name:
            delete.append(str(c.get("name") or name_lower))

    create.sort(key=lambda x: x.lower())
    update.sort(key=lambda x: x.lower())
    delete.sort(key=lambda x: x.lower())

    return {"create": create, "update": update, "delete": delete}
