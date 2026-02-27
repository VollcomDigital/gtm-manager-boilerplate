"""High-level GTM automation workflows: snapshot, diff, sync, publish.

This Python workflow layer intentionally focuses on the common GTM resources
needed for lightweight automation (tags, triggers, variables). For richer IaC,
use the TypeScript implementation in this repository.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterable

from managers.container_manager import ContainerManager
from managers.tag_manager import TagManager
from managers.trigger_manager import TriggerManager
from managers.variable_manager import VariableManager

_WORKSPACE_PATH_MISSING_ERROR = "Workspace response missing path/workspaceId."
_DESIRED_LISTS_MISSING_ERROR = "Desired snapshot must contain list fields: variables/triggers/tags."

_DYNAMIC_FIELDS = {
    "accountId",
    "containerId",
    "workspaceId",
    "path",
    "fingerprint",
    "tagId",
    "triggerId",
    "variableId",
}


def _lower(s: str) -> str:
    return s.strip().lower()


def _is_record(value: Any) -> bool:
    return isinstance(value, dict)


def strip_dynamic_fields_deep(value: Any) -> Any:
    """Strip server-generated + IaC-only fields from a GTM payload recursively."""
    if isinstance(value, list):
        return [strip_dynamic_fields_deep(v) for v in value]
    if not _is_record(value):
        return value
    out: dict[str, Any] = {}
    for k, v in value.items():
        if k in _DYNAMIC_FIELDS:
            continue
        if k.startswith("__"):
            continue
        out[k] = strip_dynamic_fields_deep(v)
    return out


def _stable_jsonish(value: Any) -> Any:
    """Convert nested structures into a canonical, comparison-friendly form."""
    if isinstance(value, list):
        items = [_stable_jsonish(v) for v in value]
        # Sort lists of dicts deterministically to reduce noisy diffs.
        if all(isinstance(x, dict) for x in items):
            return sorted(items, key=lambda x: repr(x))
        return items
    if isinstance(value, dict):
        return {k: _stable_jsonish(value[k]) for k in sorted(value.keys())}
    return value


def normalize_for_diff(entity: dict[str, Any]) -> dict[str, Any]:
    """Normalize an entity into a stable shape for diffing."""
    stripped = strip_dynamic_fields_deep(entity)
    stable = _stable_jsonish(stripped)
    return stable if isinstance(stable, dict) else {}


def _index_by_name(entities: Iterable[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for e in entities:
        name = e.get("name")
        if isinstance(name, str) and name.strip():
            out[_lower(name)] = e
    return out


def _sort_by_name(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return sorted(items, key=lambda x: _lower(str(x.get("name") or "")))


def _workspace_path_from_workspace_payload(
    containers: ContainerManager,
    *,
    account_id: str,
    container_id: str,
    workspace: dict[str, Any],
) -> str:
    workspace_id = workspace.get("workspaceId")
    workspace_path = workspace.get("path") or (
        containers.workspace_path(account_id, container_id, str(workspace_id))
        if workspace_id
        else None
    )
    if not isinstance(workspace_path, str) or not workspace_path.strip():
        raise ValueError(_WORKSPACE_PATH_MISSING_ERROR)
    return workspace_path


@dataclass(frozen=True)
class EntityDiff:
    """Create/update/delete lists for a resource type."""

    create: list[str]
    update: list[str]
    delete: list[str]


@dataclass(frozen=True)
class WorkspaceDiff:
    """Diff result across tag/trigger/variable resources."""

    tags: EntityDiff
    triggers: EntityDiff
    variables: EntityDiff


def diff_named_entities(
    *,
    desired: list[dict[str, Any]],
    current: list[dict[str, Any]],
) -> EntityDiff:
    """Diff two lists of named GTM entities by `name`."""
    desired_by_name = _index_by_name(desired)
    current_by_name = _index_by_name(current)

    create: list[str] = []
    update: list[str] = []

    for name_lower, desired_entity in desired_by_name.items():
        current_entity = current_by_name.get(name_lower)
        if not current_entity:
            create.append(desired_entity.get("name", name_lower))
            continue
        if normalize_for_diff(desired_entity) != normalize_for_diff(current_entity):
            update.append(desired_entity.get("name", name_lower))

    delete: list[str] = []
    for name_lower, current_entity in current_by_name.items():
        if name_lower not in desired_by_name:
            delete.append(current_entity.get("name", name_lower))

    create.sort(key=lambda x: str(x).lower())
    update.sort(key=lambda x: str(x).lower())
    delete.sort(key=lambda x: str(x).lower())
    return EntityDiff(create=create, update=update, delete=delete)


def diff_workspace(
    desired_snapshot: dict[str, Any], current_snapshot: dict[str, Any]
) -> WorkspaceDiff:
    """Compute a name-based diff between two workspace snapshot shapes."""
    desired_tags = desired_snapshot.get("tags") or []
    desired_triggers = desired_snapshot.get("triggers") or []
    desired_variables = desired_snapshot.get("variables") or []

    current_tags = current_snapshot.get("tags") or []
    current_triggers = current_snapshot.get("triggers") or []
    current_variables = current_snapshot.get("variables") or []

    if not isinstance(desired_tags, list) or not isinstance(current_tags, list):
        raise ValueError("Snapshot 'tags' must be a list.")
    if not isinstance(desired_triggers, list) or not isinstance(current_triggers, list):
        raise ValueError("Snapshot 'triggers' must be a list.")
    if not isinstance(desired_variables, list) or not isinstance(current_variables, list):
        raise ValueError("Snapshot 'variables' must be a list.")

    return WorkspaceDiff(
        tags=diff_named_entities(desired=desired_tags, current=current_tags),
        triggers=diff_named_entities(desired=desired_triggers, current=current_triggers),
        variables=diff_named_entities(desired=desired_variables, current=current_variables),
    )


def _merge_desired_into_current(current: Any, desired: Any) -> Any:
    if isinstance(desired, list):
        return desired
    if not isinstance(current, dict) or not isinstance(desired, dict):
        return desired
    merged: dict[str, Any] = dict(current)
    for k, v in desired.items():
        if v is None:
            merged[k] = None
            continue
        merged[k] = _merge_desired_into_current(merged.get(k), v)
    return merged


def _resolve_trigger_ids(
    *,
    tag_name: str,
    trigger_names: list[str],
    trigger_name_to_id: dict[str, str],
    label: str,
) -> list[str]:
    resolved: list[str] = []
    for raw in trigger_names:
        if not isinstance(raw, str) or not raw.strip():
            continue
        trigger_id = trigger_name_to_id.get(_lower(raw))
        if not trigger_id:
            raise ValueError(f"Tag '{tag_name}' references missing {label} by name: '{raw}'")
        resolved.append(trigger_id)
    return resolved


def _tag_with_resolved_triggers(
    tag: dict[str, Any], trigger_name_to_id: dict[str, str]
) -> dict[str, Any]:
    out = dict(tag)
    tag_name = str(out.get("name") or "?")

    if "firingTriggerNames" in out and "firingTriggerId" in out:
        raise ValueError(
            f"Tag '{tag_name}' cannot specify both firingTriggerNames and firingTriggerId."
        )
    firing_names = out.get("firingTriggerNames")
    if isinstance(firing_names, list):
        out["firingTriggerId"] = _resolve_trigger_ids(
            tag_name=tag_name,
            trigger_names=[str(x) for x in firing_names],
            trigger_name_to_id=trigger_name_to_id,
            label="trigger",
        )
        out.pop("firingTriggerNames", None)

    if "blockingTriggerNames" in out and "blockingTriggerId" in out:
        raise ValueError(
            f"Tag '{tag_name}' cannot specify both blockingTriggerNames and blockingTriggerId."
        )
    blocking_names = out.get("blockingTriggerNames")
    if isinstance(blocking_names, list):
        out["blockingTriggerId"] = _resolve_trigger_ids(
            tag_name=tag_name,
            trigger_names=[str(x) for x in blocking_names],
            trigger_name_to_id=trigger_name_to_id,
            label="blocking trigger",
        )
        out.pop("blockingTriggerNames", None)

    return out


def _entity_path_from_workspace(
    workspace_path: str, collection: str, entity: dict[str, Any], id_key: str
) -> str | None:
    if isinstance(entity.get("path"), str) and entity["path"].strip():
        return str(entity["path"])
    raw_id = entity.get(id_key)
    if isinstance(raw_id, str) and raw_id.strip():
        return f"{workspace_path}/{collection}/{raw_id}"
    return None


def _summarize_list(value: list[str]) -> list[str]:
    return sorted([str(v) for v in value if str(v).strip()], key=lambda x: x.lower())


class WorkspaceWorkflowManager:
    """Orchestrates snapshot/diff/sync/publish against a GTM workspace."""

    def __init__(self, service: Any):
        self.service = service
        self.containers = ContainerManager(service)
        self.tags = TagManager(service)
        self.triggers = TriggerManager(service)
        self.variables = VariableManager(service)

    def _get_workspace_path(
        self,
        *,
        account_id: str,
        container_id: str,
        workspace_name: str,
        create_if_missing: bool,
    ) -> str:
        workspace = self.containers.get_or_create_workspace(
            account_id,
            container_id,
            workspace_name,
            create_if_missing=create_if_missing,
        )
        return _workspace_path_from_workspace_payload(
            self.containers,
            account_id=account_id,
            container_id=container_id,
            workspace=workspace,
        )

    @staticmethod
    def _parse_desired_snapshot(
        desired_snapshot: dict[str, Any],
    ) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
        desired_variables = desired_snapshot.get("variables") or []
        desired_triggers = desired_snapshot.get("triggers") or []
        desired_tags = desired_snapshot.get("tags") or []

        if (
            not isinstance(desired_variables, list)
            or not isinstance(desired_triggers, list)
            or not isinstance(desired_tags, list)
        ):
            raise ValueError(_DESIRED_LISTS_MISSING_ERROR)

        return (
            [v for v in desired_variables if isinstance(v, dict)],
            [t for t in desired_triggers if isinstance(t, dict)],
            [t for t in desired_tags if isinstance(t, dict)],
        )

    @staticmethod
    def _init_summary(
        *, workspace_path: str, dry_run: bool, delete_missing: bool
    ) -> dict[str, Any]:
        return {
            "workspacePath": workspace_path,
            "dryRun": dry_run,
            "deleteMissing": delete_missing,
            "variables": {"created": [], "updated": [], "deleted": [], "skipped": []},
            "triggers": {"created": [], "updated": [], "deleted": [], "skipped": []},
            "tags": {"created": [], "updated": [], "deleted": [], "skipped": []},
        }

    def _sync_variables(
        self,
        *,
        workspace_path: str,
        desired_variables: list[dict[str, Any]],
        summary: dict[str, Any],
        dry_run: bool,
        update_existing: bool,
    ) -> tuple[dict[str, dict[str, Any]], dict[str, dict[str, Any]]]:
        current_variables = self.variables.list_variables_from_workspace_path(workspace_path)
        var_by_name = _index_by_name(current_variables)
        desired_var_by_name = _index_by_name(desired_variables)

        for name_lower, desired_var in desired_var_by_name.items():
            display_name = str(desired_var.get("name") or name_lower)
            existing = var_by_name.get(name_lower)
            if not existing:
                summary["variables"]["created"].append(display_name)
                if not dry_run:
                    body = strip_dynamic_fields_deep(desired_var)
                    self.variables.create_variable(workspace_path, body)
                continue

            if not update_existing:
                summary["variables"]["skipped"].append(display_name)
                continue

            if normalize_for_diff(desired_var) == normalize_for_diff(existing):
                summary["variables"]["skipped"].append(display_name)
                continue

            summary["variables"]["updated"].append(display_name)
            if not dry_run:
                merged = _merge_desired_into_current(existing, desired_var)
                body = strip_dynamic_fields_deep(merged)
                path = _entity_path_from_workspace(
                    workspace_path, "variables", existing, "variableId"
                )
                if not path:
                    raise ValueError(
                        f"Cannot update variable '{display_name}' (missing path/variableId)."
                    )
                self.variables.update_variable(path, body, fingerprint=existing.get("fingerprint"))

        return var_by_name, desired_var_by_name

    def _sync_triggers(
        self,
        *,
        workspace_path: str,
        desired_triggers: list[dict[str, Any]],
        summary: dict[str, Any],
        dry_run: bool,
        update_existing: bool,
    ) -> tuple[dict[str, dict[str, Any]], dict[str, dict[str, Any]], dict[str, str]]:
        current_triggers = self.triggers.list_triggers_from_workspace_path(workspace_path)
        trig_by_name = _index_by_name(current_triggers)
        desired_trig_by_name = _index_by_name(desired_triggers)

        trigger_name_to_id: dict[str, str] = {}
        for trigger in current_triggers:
            name = trigger.get("name")
            trigger_id = trigger.get("triggerId")
            if (
                isinstance(name, str)
                and isinstance(trigger_id, str)
                and name.strip()
                and trigger_id.strip()
            ):
                trigger_name_to_id[_lower(name)] = trigger_id

        for name_lower, desired_trig in desired_trig_by_name.items():
            display_name = str(desired_trig.get("name") or name_lower)
            existing = trig_by_name.get(name_lower)
            if not existing:
                summary["triggers"]["created"].append(display_name)
                if not dry_run:
                    body = strip_dynamic_fields_deep(desired_trig)
                    created = self.triggers.create_trigger(workspace_path, body)
                    created_id = created.get("triggerId")
                    if isinstance(created_id, str) and created_id.strip():
                        trigger_name_to_id[name_lower] = created_id
                continue

            if not update_existing:
                summary["triggers"]["skipped"].append(display_name)
                continue

            if normalize_for_diff(desired_trig) == normalize_for_diff(existing):
                summary["triggers"]["skipped"].append(display_name)
                continue

            summary["triggers"]["updated"].append(display_name)
            if not dry_run:
                merged = _merge_desired_into_current(existing, desired_trig)
                body = strip_dynamic_fields_deep(merged)
                path = _entity_path_from_workspace(
                    workspace_path, "triggers", existing, "triggerId"
                )
                if not path:
                    raise ValueError(
                        f"Cannot update trigger '{display_name}' (missing path/triggerId)."
                    )
                updated = self.triggers.update_trigger(
                    path, body, fingerprint=existing.get("fingerprint")
                )
                updated_id = updated.get("triggerId") or existing.get("triggerId")
                if isinstance(updated_id, str) and updated_id.strip():
                    trigger_name_to_id[name_lower] = updated_id

        return trig_by_name, desired_trig_by_name, trigger_name_to_id

    def _sync_tags(
        self,
        *,
        workspace_path: str,
        desired_tags: list[dict[str, Any]],
        trigger_name_to_id: dict[str, str],
        summary: dict[str, Any],
        dry_run: bool,
        update_existing: bool,
    ) -> tuple[dict[str, dict[str, Any]], dict[str, dict[str, Any]]]:
        current_tags = self.tags.list_tags_from_workspace_path(workspace_path)
        tag_by_name = _index_by_name(current_tags)
        desired_tag_by_name = _index_by_name(desired_tags)

        for name_lower, raw_desired_tag in desired_tag_by_name.items():
            desired_tag = _tag_with_resolved_triggers(raw_desired_tag, trigger_name_to_id)
            display_name = str(desired_tag.get("name") or name_lower)
            existing = tag_by_name.get(name_lower)

            if not existing:
                if not isinstance(desired_tag.get("firingTriggerId"), list):
                    raise ValueError(
                        f"Cannot create tag '{display_name}': missing firingTriggerId (or firingTriggerNames)."
                    )
                summary["tags"]["created"].append(display_name)
                if not dry_run:
                    body = strip_dynamic_fields_deep(desired_tag)
                    self.tags.create_tag(workspace_path, body)
                continue

            if not update_existing:
                summary["tags"]["skipped"].append(display_name)
                continue

            if normalize_for_diff(desired_tag) == normalize_for_diff(existing):
                summary["tags"]["skipped"].append(display_name)
                continue

            summary["tags"]["updated"].append(display_name)
            if not dry_run:
                merged = _merge_desired_into_current(existing, desired_tag)
                body = strip_dynamic_fields_deep(merged)
                path = _entity_path_from_workspace(workspace_path, "tags", existing, "tagId")
                if not path:
                    raise ValueError(f"Cannot update tag '{display_name}' (missing path/tagId).")
                self.tags.update_tag(path, body, fingerprint=existing.get("fingerprint"))

        return tag_by_name, desired_tag_by_name

    def _apply_deletes(
        self,
        *,
        workspace_path: str,
        summary: dict[str, Any],
        dry_run: bool,
        delete_missing: bool,
        var_by_name: dict[str, dict[str, Any]],
        desired_var_by_name: dict[str, dict[str, Any]],
        trig_by_name: dict[str, dict[str, Any]],
        desired_trig_by_name: dict[str, dict[str, Any]],
        tag_by_name: dict[str, dict[str, Any]],
        desired_tag_by_name: dict[str, dict[str, Any]],
    ) -> None:
        if not delete_missing:
            return

        desired_var_names = set(desired_var_by_name.keys())
        desired_trig_names = set(desired_trig_by_name.keys())
        desired_tag_names = set(desired_tag_by_name.keys())

        # Delete in reverse dependency order: tags -> triggers -> variables.
        for name_lower, existing in tag_by_name.items():
            if name_lower in desired_tag_names:
                continue
            display_name = str(existing.get("name") or name_lower)
            summary["tags"]["deleted"].append(display_name)
            if dry_run:
                continue
            path = _entity_path_from_workspace(workspace_path, "tags", existing, "tagId")
            if path:
                self.tags.delete_tag(path)

        for name_lower, existing in trig_by_name.items():
            if name_lower in desired_trig_names:
                continue
            display_name = str(existing.get("name") or name_lower)
            summary["triggers"]["deleted"].append(display_name)
            if dry_run:
                continue
            path = _entity_path_from_workspace(workspace_path, "triggers", existing, "triggerId")
            if path:
                self.triggers.delete_trigger(path)

        for name_lower, existing in var_by_name.items():
            if name_lower in desired_var_names:
                continue
            display_name = str(existing.get("name") or name_lower)
            summary["variables"]["deleted"].append(display_name)
            if dry_run:
                continue
            path = _entity_path_from_workspace(workspace_path, "variables", existing, "variableId")
            if path:
                self.variables.delete_variable(path)

    @staticmethod
    def _finalize_summary(summary: dict[str, Any]) -> dict[str, Any]:
        for resource in ("variables", "triggers", "tags"):
            for k in ("created", "updated", "deleted", "skipped"):
                summary[resource][k] = _summarize_list(summary[resource][k])
        return summary

    def export_workspace_snapshot(
        self,
        *,
        account_id: str,
        container_id: str,
        workspace_name: str,
        create_if_missing: bool = False,
    ) -> dict[str, Any]:
        """Fetch tags/triggers/variables from a workspace into a stable snapshot shape."""
        workspace_path = self._get_workspace_path(
            account_id=account_id,
            container_id=container_id,
            workspace_name=workspace_name,
            create_if_missing=create_if_missing,
        )

        tags = self.tags.list_tags_from_workspace_path(workspace_path)
        triggers = self.triggers.list_triggers_from_workspace_path(workspace_path)
        variables = self.variables.list_variables_from_workspace_path(workspace_path)

        return {
            "workspaceName": workspace_name,
            "workspacePath": workspace_path,
            "tags": [normalize_for_diff(t) for t in _sort_by_name(tags)],
            "triggers": [normalize_for_diff(t) for t in _sort_by_name(triggers)],
            "variables": [normalize_for_diff(v) for v in _sort_by_name(variables)],
        }

    def diff_workspace_against_snapshot(
        self,
        *,
        desired_snapshot: dict[str, Any],
        account_id: str,
        container_id: str,
        workspace_name: str,
    ) -> WorkspaceDiff:
        """Diff a desired snapshot against the current workspace state."""
        current = self.export_workspace_snapshot(
            account_id=account_id,
            container_id=container_id,
            workspace_name=workspace_name,
            create_if_missing=False,
        )
        return diff_workspace(desired_snapshot, current)

    def sync_workspace(
        self,
        *,
        desired_snapshot: dict[str, Any],
        account_id: str,
        container_id: str,
        workspace_name: str,
        dry_run: bool = True,
        delete_missing: bool = False,
        update_existing: bool = True,
    ) -> dict[str, Any]:
        """Apply desired tags/triggers/variables to a workspace (idempotent by name)."""
        workspace_path = self._get_workspace_path(
            account_id=account_id,
            container_id=container_id,
            workspace_name=workspace_name,
            create_if_missing=True,
        )
        desired_variables, desired_triggers, desired_tags = self._parse_desired_snapshot(
            desired_snapshot
        )

        summary = self._init_summary(
            workspace_path=workspace_path,
            dry_run=dry_run,
            delete_missing=delete_missing,
        )

        var_by_name, desired_var_by_name = self._sync_variables(
            workspace_path=workspace_path,
            desired_variables=desired_variables,
            summary=summary,
            dry_run=dry_run,
            update_existing=update_existing,
        )
        trig_by_name, desired_trig_by_name, trigger_name_to_id = self._sync_triggers(
            workspace_path=workspace_path,
            desired_triggers=desired_triggers,
            summary=summary,
            dry_run=dry_run,
            update_existing=update_existing,
        )
        tag_by_name, desired_tag_by_name = self._sync_tags(
            workspace_path=workspace_path,
            desired_tags=desired_tags,
            trigger_name_to_id=trigger_name_to_id,
            summary=summary,
            dry_run=dry_run,
            update_existing=update_existing,
        )
        self._apply_deletes(
            workspace_path=workspace_path,
            summary=summary,
            dry_run=dry_run,
            delete_missing=delete_missing,
            var_by_name=var_by_name,
            desired_var_by_name=desired_var_by_name,
            trig_by_name=trig_by_name,
            desired_trig_by_name=desired_trig_by_name,
            tag_by_name=tag_by_name,
            desired_tag_by_name=desired_tag_by_name,
        )
        return self._finalize_summary(summary)

    def publish_from_workspace(
        self,
        *,
        account_id: str,
        container_id: str,
        workspace_name: str,
        version_name: str,
        version_notes: str,
        dry_run: bool = True,
    ) -> dict[str, Any]:
        """Create + publish a container version from a named workspace."""
        workspace_path = self._get_workspace_path(
            account_id=account_id,
            container_id=container_id,
            workspace_name=workspace_name,
            create_if_missing=True,
        )

        if dry_run:
            return {
                "dryRun": True,
                "action": "publish",
                "workspacePath": workspace_path,
                "versionName": version_name,
            }

        created = self.containers.create_container_version_from_workspace(
            workspace_path,
            name=version_name,
            notes=version_notes,
        )
        version_path = (
            (created.get("containerVersion") or {})
            if isinstance(created.get("containerVersion"), dict)
            else {}
        ).get("path")
        if not isinstance(version_path, str) or not version_path.strip():
            raise ValueError("Version creation did not return containerVersion.path.")

        published = self.containers.publish_container_version(version_path)
        return {
            "created": created,
            "published": published,
        }
