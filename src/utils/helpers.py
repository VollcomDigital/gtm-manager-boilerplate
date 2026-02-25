"""Shared helpers for GTM tooling."""

from __future__ import annotations

import json
from copy import deepcopy
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

DEFAULT_READ_ONLY_FIELDS = {
    "accountId",
    "containerId",
    "workspaceId",
    "tagId",
    "triggerId",
    "variableId",
    "path",
    "fingerprint",
    "tagManagerUrl",
}


def ensure_output_directory(path: str) -> None:
    """Create the parent directory for an output file if needed.

    Args:
        path: Destination file path.

    Returns:
        None

    Raises:
        ValueError: If ``path`` is empty.
        OSError: If the directory cannot be created.
    """
    if not path:
        raise ValueError("Output path must not be empty.")

    directory = Path(path).expanduser().resolve().parent
    directory.mkdir(parents=True, exist_ok=True)


def canonicalize_for_diff(
    value: Any,
    *,
    read_only_fields: Iterable[str] | None = None,
) -> Any:
    """Canonicalize GTM entities for deterministic comparisons.

    Args:
        value: Raw entity value to normalize.
        read_only_fields: Field names removed from dictionaries before compare.

    Returns:
        A recursively normalized structure with sorted keys and stable list order.
    """
    fields_to_drop = set(read_only_fields or DEFAULT_READ_ONLY_FIELDS)
    return _canonicalize(value, fields_to_drop)


def diff_entities_by_name(
    desired: Sequence[Mapping[str, Any]],
    current: Sequence[Mapping[str, Any]],
    *,
    read_only_fields: Iterable[str] | None = None,
) -> dict[str, list[str]]:
    """Compute create/update/delete sets for entity lists keyed by ``name``.

    Args:
        desired: Target list of entities from IaC config.
        current: Current list of GTM entities fetched from API.
        read_only_fields: Optional override for fields to ignore in comparisons.

    Returns:
        A dict containing sorted ``create``, ``update``, and ``delete`` name lists.
    """
    desired_map = _index_by_name(desired)
    current_map = _index_by_name(current)
    fields_to_drop = set(read_only_fields or DEFAULT_READ_ONLY_FIELDS)

    desired_names = set(desired_map)
    current_names = set(current_map)

    create = sorted(desired_names - current_names)
    delete = sorted(current_names - desired_names)

    update: list[str] = []
    for name in sorted(desired_names & current_names):
        desired_norm = _canonicalize(desired_map[name], fields_to_drop)
        current_norm = _canonicalize(current_map[name], fields_to_drop)
        if desired_norm != current_norm:
            update.append(name)

    return {"create": create, "update": update, "delete": delete}


def prepare_payload(
    entity: dict[str, Any],
    *,
    read_only_fields: Iterable[str],
) -> dict[str, Any]:
    """Return a payload with read-only fields removed.

    Args:
        entity: Raw GTM entity payload.
        read_only_fields: Field names to drop before upsert.

    Returns:
        A deep-copied payload without read-only fields.
    """
    payload = deepcopy(entity)
    for field in read_only_fields:
        payload.pop(field, None)
    return payload


def is_effectively_equal(
    current: dict[str, Any],
    desired: dict[str, Any],
    *,
    read_only_fields: Iterable[str],
) -> bool:
    """Compare entity payloads while ignoring read-only fields.

    Args:
        current: Current GTM entity payload from the API.
        desired: Desired GTM entity payload from configuration.
        read_only_fields: Field names ignored during comparison.

    Returns:
        True when the canonicalized payloads match.
    """
    return canonicalize_for_diff(
        current,
        read_only_fields=read_only_fields,
    ) == canonicalize_for_diff(
        desired,
        read_only_fields=read_only_fields,
    )


def _index_by_name(entities: Sequence[Mapping[str, Any]]) -> dict[str, Mapping[str, Any]]:
    indexed: dict[str, Mapping[str, Any]] = {}
    for entity in entities:
        name = str(entity.get("name", "")).strip()
        if name:
            indexed[name] = entity
    return indexed


def _canonicalize(value: Any, read_only_fields: set[str]) -> Any:
    if isinstance(value, Mapping):
        cleaned = {
            key: _canonicalize(inner, read_only_fields)
            for key, inner in value.items()
            if key not in read_only_fields
        }
        return {key: cleaned[key] for key in sorted(cleaned)}

    if isinstance(value, list):
        canonical_items = [_canonicalize(item, read_only_fields) for item in value]
        return sorted(canonical_items, key=_stable_sort_key)

    return value


def _stable_sort_key(value: Any) -> str:
    try:
        return json.dumps(value, sort_keys=True, ensure_ascii=False)
    except TypeError:
        return str(value)
