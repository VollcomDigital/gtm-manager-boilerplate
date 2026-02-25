"""Utility helpers for working with GTM containers."""

from __future__ import annotations

from copy import deepcopy
from typing import Any

from ..utils.helpers import canonicalize_for_diff, diff_entities_by_name, prepare_payload
from .tag_manager import TagManager
from .trigger_manager import TriggerManager

READ_ONLY_VARIABLE_FIELDS = {
    "accountId",
    "containerId",
    "workspaceId",
    "variableId",
    "path",
    "fingerprint",
    "tagManagerUrl",
}


class ContainerManager:
    """Container-level GTM automation helpers (diff, sync, publish)."""

    def __init__(self, service):
        """Initialize the manager.

        Args:
            service: Google API client from ``googleapiclient.discovery.build``.
        """
        self.service = service
        self.tag_manager = TagManager(service)
        self.trigger_manager = TriggerManager(service)

    def list_containers(self, account_id: str) -> list[dict[str, Any]]:
        """Return all containers for a GTM account.

        Args:
            account_id: GTM account identifier.

        Returns:
            A list of container objects.
        """
        containers: list[dict[str, Any]] = []
        next_page_token: str | None = None
        parent = f"accounts/{account_id}"

        while True:
            request = (
                self.service.accounts().containers().list(parent=parent, pageToken=next_page_token)
            )
            response = request.execute()
            containers.extend(response.get("container", []))
            next_page_token = response.get("nextPageToken")
            if not next_page_token:
                break

        return containers

    def list_workspaces(self, account_id: str, container_id: str) -> list[dict[str, Any]]:
        """Return all workspaces for a GTM container.

        Args:
            account_id: GTM account identifier.
            container_id: GTM container identifier.

        Returns:
            A list of workspace objects.
        """
        workspaces: list[dict[str, Any]] = []
        next_page_token: str | None = None
        parent = self._container_path(account_id, container_id)

        while True:
            request = (
                self.service.accounts()
                .containers()
                .workspaces()
                .list(parent=parent, pageToken=next_page_token)
            )
            response = request.execute()
            workspaces.extend(response.get("workspace", []))
            next_page_token = response.get("nextPageToken")
            if not next_page_token:
                break

        return workspaces

    def get_or_create_workspace(
        self,
        account_id: str,
        container_id: str,
        workspace_name: str,
        *,
        dry_run: bool = False,
    ) -> tuple[str, dict[str, Any]]:
        """Resolve an existing workspace by name or create one.

        Args:
            account_id: GTM account identifier.
            container_id: GTM container identifier.
            workspace_name: Workspace display name.
            dry_run: If True, report intended creation without mutating.

        Returns:
            Tuple of ``(action, workspace)`` where action is ``existing`` or ``created``.

        Raises:
            ValueError: If ``workspace_name`` is empty.
        """
        if not workspace_name.strip():
            raise ValueError("Workspace name must not be empty.")

        parent = self._container_path(account_id, container_id)
        for workspace in self.list_workspaces(account_id, container_id):
            if str(workspace.get("name", "")).strip() == workspace_name:
                return "existing", workspace

        workspace_payload = {"name": workspace_name}
        if dry_run:
            return "created", workspace_payload

        created = (
            self.service.accounts()
            .containers()
            .workspaces()
            .create(parent=parent, body=workspace_payload)
            .execute()
        )
        return "created", created

    def get_workspace_snapshot(
        self,
        account_id: str,
        container_id: str,
        workspace_id: str,
    ) -> dict[str, list[dict[str, Any]]]:
        """Fetch tags, triggers, and variables for a workspace.

        Args:
            account_id: GTM account identifier.
            container_id: GTM container identifier.
            workspace_id: GTM workspace identifier.

        Returns:
            Snapshot dictionary with ``tags``, ``triggers``, and ``variables`` keys.
        """
        return {
            "tags": self.tag_manager.list_tags(account_id, container_id, workspace_id),
            "triggers": self.trigger_manager.list_triggers(account_id, container_id, workspace_id),
            "variables": self.list_variables(account_id, container_id, workspace_id),
        }

    def diff_workspace(
        self,
        account_id: str,
        container_id: str,
        workspace_id: str,
        desired_state: dict[str, list[dict[str, Any]]],
    ) -> dict[str, dict[str, list[str]]]:
        """Compute create/update/delete drift for tags/triggers/variables.

        Args:
            account_id: GTM account identifier.
            container_id: GTM container identifier.
            workspace_id: GTM workspace identifier.
            desired_state: Desired-state payload with optional ``tags``, ``triggers``,
                and ``variables`` arrays.

        Returns:
            Diff dictionary for each entity type.
        """
        current = self.get_workspace_snapshot(account_id, container_id, workspace_id)
        desired_tags = desired_state.get("tags", [])
        desired_triggers = desired_state.get("triggers", [])
        desired_variables = desired_state.get("variables", [])

        return {
            "tags": diff_entities_by_name(desired_tags, current["tags"]),
            "triggers": diff_entities_by_name(desired_triggers, current["triggers"]),
            "variables": diff_entities_by_name(
                desired_variables,
                current["variables"],
                read_only_fields=READ_ONLY_VARIABLE_FIELDS,
            ),
        }

    def sync_workspace(
        self,
        account_id: str,
        container_id: str,
        workspace_id: str,
        desired_state: dict[str, list[dict[str, Any]]],
        *,
        delete_missing: bool = False,
        dry_run: bool = False,
    ) -> dict[str, Any]:
        """Apply desired workspace state in safe order: variables -> triggers -> tags.

        Args:
            account_id: GTM account identifier.
            container_id: GTM container identifier.
            workspace_id: GTM workspace identifier.
            desired_state: Desired-state payload with optional ``variables``,
                ``triggers``, and ``tags`` arrays.
            delete_missing: If True, deletes entities absent from desired state.
            dry_run: If True, no API mutations are executed.

        Returns:
            Operation summary for each entity type.
        """
        summary = self._new_sync_summary(account_id, container_id, workspace_id)
        desired_entities = self._extract_desired_entities(desired_state)

        self._sync_desired_entities(
            account_id=account_id,
            container_id=container_id,
            workspace_id=workspace_id,
            desired_entities=desired_entities["variables"],
            upsert_fn=self.upsert_variable,
            summary_bucket=summary["variables"],
            dry_run=dry_run,
        )
        self._sync_desired_entities(
            account_id=account_id,
            container_id=container_id,
            workspace_id=workspace_id,
            desired_entities=desired_entities["triggers"],
            upsert_fn=self.trigger_manager.upsert_trigger,
            summary_bucket=summary["triggers"],
            dry_run=dry_run,
        )
        self._sync_desired_entities(
            account_id=account_id,
            container_id=container_id,
            workspace_id=workspace_id,
            desired_entities=desired_entities["tags"],
            upsert_fn=self.tag_manager.upsert_tag,
            summary_bucket=summary["tags"],
            dry_run=dry_run,
        )

        if delete_missing:
            self._delete_missing_entities(
                account_id=account_id,
                container_id=container_id,
                workspace_id=workspace_id,
                desired_entities=desired_entities,
                summary=summary,
                dry_run=dry_run,
            )

        return summary

    def list_variables(
        self,
        account_id: str,
        container_id: str,
        workspace_id: str,
    ) -> list[dict[str, Any]]:
        """Return all variables for a GTM workspace.

        Args:
            account_id: GTM account identifier.
            container_id: GTM container identifier.
            workspace_id: GTM workspace identifier.

        Returns:
            A list of variable objects.
        """
        workspace_path = self._workspace_path(account_id, container_id, workspace_id)
        return self._list_variables_by_workspace_path(workspace_path)

    def upsert_variable(
        self,
        account_id: str,
        container_id: str,
        workspace_id: str,
        variable: dict[str, Any],
        *,
        dry_run: bool = False,
    ) -> tuple[str, dict[str, Any]]:
        """Create or update a variable by ``name``.

        Args:
            account_id: GTM account identifier.
            container_id: GTM container identifier.
            workspace_id: GTM workspace identifier.
            variable: Desired GTM variable object.
            dry_run: If True, only reports intended action.

        Returns:
            Tuple of ``(action, variable_payload)`` where action is one of
            ``created``, ``updated``, or ``noop``.
        """
        variable_name = str(variable.get("name", "")).strip()
        if not variable_name:
            raise ValueError("Variable payload must include a non-empty 'name'.")

        workspace_path = self._workspace_path(account_id, container_id, workspace_id)
        desired_payload = prepare_payload(variable, read_only_fields=READ_ONLY_VARIABLE_FIELDS)
        existing = self._find_variable_by_name(workspace_path, variable_name)

        if not existing:
            if dry_run:
                return "created", desired_payload
            created = (
                self.service.accounts()
                .containers()
                .workspaces()
                .variables()
                .create(parent=workspace_path, body=desired_payload)
                .execute()
            )
            return "created", created

        if canonicalize_for_diff(
            existing,
            read_only_fields=READ_ONLY_VARIABLE_FIELDS,
        ) == canonicalize_for_diff(
            desired_payload,
            read_only_fields=READ_ONLY_VARIABLE_FIELDS,
        ):
            return "noop", existing

        if dry_run:
            return "updated", desired_payload

        variable_path = existing.get("path")
        if not variable_path:
            raise ValueError(f"Existing variable '{variable_name}' is missing GTM path.")

        update_body = deepcopy(desired_payload)
        variable_id = existing.get("variableId")
        if variable_id:
            update_body["variableId"] = variable_id

        updated = (
            self.service.accounts()
            .containers()
            .workspaces()
            .variables()
            .update(path=variable_path, body=update_body)
            .execute()
        )
        return "updated", updated

    def delete_variable_by_name(
        self,
        account_id: str,
        container_id: str,
        workspace_id: str,
        variable_name: str,
        *,
        dry_run: bool = False,
    ) -> bool:
        """Delete a variable by name.

        Args:
            account_id: GTM account identifier.
            container_id: GTM container identifier.
            workspace_id: GTM workspace identifier.
            variable_name: Name of variable to delete.
            dry_run: If True, only reports whether variable exists.

        Returns:
            True when a matching variable exists (and is deleted unless ``dry_run``).
        """
        workspace_path = self._workspace_path(account_id, container_id, workspace_id)
        existing = self._find_variable_by_name(workspace_path, variable_name)
        if not existing:
            return False

        if dry_run:
            return True

        variable_path = existing.get("path")
        if not variable_path:
            raise ValueError(f"Existing variable '{variable_name}' is missing GTM path.")

        (
            self.service.accounts()
            .containers()
            .workspaces()
            .variables()
            .delete(path=variable_path)
            .execute()
        )
        return True

    def create_container_version(
        self,
        account_id: str,
        container_id: str,
        workspace_id: str,
        *,
        version_name: str,
        notes: str = "",
    ) -> dict[str, Any]:
        """Create a GTM container version from a workspace.

        Args:
            account_id: GTM account identifier.
            container_id: GTM container identifier.
            workspace_id: GTM workspace identifier.
            version_name: Name for the new container version.
            notes: Optional release notes.

        Returns:
            API response payload from ``workspaces.create_version``.
        """
        workspace_path = self._workspace_path(account_id, container_id, workspace_id)
        body = {"name": version_name}
        if notes:
            body["notes"] = notes

        return (
            self.service.accounts()
            .containers()
            .workspaces()
            .create_version(path=workspace_path, body=body)
            .execute()
        )

    def publish_container_version(self, version_path: str) -> dict[str, Any]:
        """Publish a GTM container version by path.

        Args:
            version_path: GTM version path
                (``accounts/<id>/containers/<id>/versions/<id>``).

        Returns:
            API response payload from ``versions.publish``.
        """
        return self.service.accounts().containers().versions().publish(path=version_path).execute()

    def publish_workspace(
        self,
        account_id: str,
        container_id: str,
        workspace_id: str,
        *,
        version_name: str,
        notes: str = "",
        dry_run: bool = False,
    ) -> dict[str, Any]:
        """Create and publish a new container version from a workspace.

        Args:
            account_id: GTM account identifier.
            container_id: GTM container identifier.
            workspace_id: GTM workspace identifier.
            version_name: Name for the created version.
            notes: Optional release notes.
            dry_run: If True, returns intended publish payload only.

        Returns:
            Dict containing create-version and publish responses.

        Raises:
            ValueError: If the create-version response has no version path.
        """
        workspace_path = self._workspace_path(account_id, container_id, workspace_id)
        if dry_run:
            return {
                "dry_run": True,
                "workspacePath": workspace_path,
                "versionName": version_name,
                "notes": notes,
            }

        create_result = self.create_container_version(
            account_id,
            container_id,
            workspace_id,
            version_name=version_name,
            notes=notes,
        )
        container_version = create_result.get("containerVersion", create_result)
        version_path = container_version.get("path")
        if not version_path:
            raise ValueError("Container version path missing from create_version response.")

        publish_result = self.publish_container_version(version_path)
        return {
            "workspacePath": workspace_path,
            "containerVersionPath": version_path,
            "createVersion": create_result,
            "publish": publish_result,
        }

    def _container_path(self, account_id: str, container_id: str) -> str:
        return f"accounts/{account_id}/containers/{container_id}"

    def _workspace_path(self, account_id: str, container_id: str, workspace_id: str) -> str:
        return f"{self._container_path(account_id, container_id)}/workspaces/{workspace_id}"

    def _find_variable_by_name(
        self,
        workspace_path: str,
        variable_name: str,
    ) -> dict[str, Any] | None:
        for variable in self._list_variables_by_workspace_path(workspace_path):
            if str(variable.get("name", "")).strip() == variable_name:
                return variable
        return None

    def _list_variables_by_workspace_path(
        self,
        workspace_path: str,
    ) -> list[dict[str, Any]]:
        variables: list[dict[str, Any]] = []
        next_page_token: str | None = None

        while True:
            request = (
                self.service.accounts()
                .containers()
                .workspaces()
                .variables()
                .list(parent=workspace_path, pageToken=next_page_token)
            )
            response = request.execute()
            variables.extend(response.get("variable", []))

            next_page_token = response.get("nextPageToken")
            if not next_page_token:
                break

        return variables

    def _new_sync_summary(
        self,
        account_id: str,
        container_id: str,
        workspace_id: str,
    ) -> dict[str, Any]:
        return {
            "workspacePath": self._workspace_path(account_id, container_id, workspace_id),
            "variables": _new_entity_summary(),
            "triggers": _new_entity_summary(),
            "tags": _new_entity_summary(),
        }

    def _extract_desired_entities(
        self,
        desired_state: dict[str, list[dict[str, Any]]],
    ) -> dict[str, list[dict[str, Any]]]:
        return {
            "variables": desired_state.get("variables", []),
            "triggers": desired_state.get("triggers", []),
            "tags": desired_state.get("tags", []),
        }

    def _sync_desired_entities(
        self,
        *,
        account_id: str,
        container_id: str,
        workspace_id: str,
        desired_entities: list[dict[str, Any]],
        upsert_fn: Any,
        summary_bucket: dict[str, list[str]],
        dry_run: bool,
    ) -> None:
        for entity in desired_entities:
            action, payload = upsert_fn(
                account_id,
                container_id,
                workspace_id,
                entity,
                dry_run=dry_run,
            )
            _record_summary_action(summary_bucket, action, payload)

    def _delete_missing_entities(
        self,
        *,
        account_id: str,
        container_id: str,
        workspace_id: str,
        desired_entities: dict[str, list[dict[str, Any]]],
        summary: dict[str, Any],
        dry_run: bool,
    ) -> None:
        current = self.get_workspace_snapshot(account_id, container_id, workspace_id)
        self._delete_missing_for_type(
            account_id=account_id,
            container_id=container_id,
            workspace_id=workspace_id,
            current_entities=current["tags"],
            desired_names={str(entity.get("name", "")).strip() for entity in desired_entities["tags"]},
            delete_fn=self.tag_manager.delete_tag_by_name,
            summary_bucket=summary["tags"],
            dry_run=dry_run,
        )
        self._delete_missing_for_type(
            account_id=account_id,
            container_id=container_id,
            workspace_id=workspace_id,
            current_entities=current["triggers"],
            desired_names={
                str(entity.get("name", "")).strip() for entity in desired_entities["triggers"]
            },
            delete_fn=self.trigger_manager.delete_trigger_by_name,
            summary_bucket=summary["triggers"],
            dry_run=dry_run,
        )
        self._delete_missing_for_type(
            account_id=account_id,
            container_id=container_id,
            workspace_id=workspace_id,
            current_entities=current["variables"],
            desired_names={
                str(entity.get("name", "")).strip() for entity in desired_entities["variables"]
            },
            delete_fn=self.delete_variable_by_name,
            summary_bucket=summary["variables"],
            dry_run=dry_run,
        )
        for entity_key in ("tags", "triggers", "variables"):
            summary[entity_key]["deleted"].sort()

    def _delete_missing_for_type(
        self,
        *,
        account_id: str,
        container_id: str,
        workspace_id: str,
        current_entities: list[dict[str, Any]],
        desired_names: set[str],
        delete_fn: Any,
        summary_bucket: dict[str, list[str]],
        dry_run: bool,
    ) -> None:
        for entity in current_entities:
            name = str(entity.get("name", "")).strip()
            if (
                name
                and name not in desired_names
                and delete_fn(
                    account_id,
                    container_id,
                    workspace_id,
                    name,
                    dry_run=dry_run,
                )
            ):
                summary_bucket["deleted"].append(name)


def _new_entity_summary() -> dict[str, list[str]]:
    return {"created": [], "updated": [], "deleted": [], "noop": []}


def _record_summary_action(
    entity_summary: dict[str, list[str]], action: str, payload: dict[str, Any]
) -> None:
    name = str(payload.get("name", "")).strip()
    if not name:
        return

    if action == "created":
        entity_summary["created"].append(name)
    elif action == "updated":
        entity_summary["updated"].append(name)
    elif action == "noop":
        entity_summary["noop"].append(name)

    for key in ("created", "updated", "noop"):
        entity_summary[key].sort()


