"""Utility helpers for working with GTM triggers."""

from __future__ import annotations

from copy import deepcopy
from typing import Any

from ..utils.helpers import canonicalize_for_diff

READ_ONLY_TRIGGER_FIELDS = {
    "accountId",
    "containerId",
    "workspaceId",
    "triggerId",
    "path",
    "fingerprint",
    "tagManagerUrl",
}


class TriggerManager:
    """Manage GTM workspace triggers with idempotent upsert helpers."""

    def __init__(self, service):
        """Initialize the manager.

        Args:
            service: Google API client from ``googleapiclient.discovery.build``.
        """
        self.service = service

    def list_triggers(
        self,
        account_id: str,
        container_id: str,
        workspace_id: str,
    ) -> list[dict[str, Any]]:
        """Return all triggers for a GTM workspace.

        Args:
            account_id: GTM account identifier.
            container_id: GTM container identifier.
            workspace_id: GTM workspace identifier.

        Returns:
            A list of trigger objects.
        """
        workspace_path = (
            f"accounts/{account_id}/containers/{container_id}/workspaces/{workspace_id}"
        )
        return self._list_triggers_by_workspace_path(workspace_path)

    def upsert_trigger(
        self,
        account_id: str,
        container_id: str,
        workspace_id: str,
        trigger: dict[str, Any],
        *,
        dry_run: bool = False,
    ) -> tuple[str, dict[str, Any]]:
        """Create or update a trigger by ``name``.

        Args:
            account_id: GTM account identifier.
            container_id: GTM container identifier.
            workspace_id: GTM workspace identifier.
            trigger: Desired GTM trigger object.
            dry_run: If True, only reports intended action.

        Returns:
            Tuple of ``(action, trigger_payload)`` where action is one of
            ``created``, ``updated``, or ``noop``.

        Raises:
            ValueError: If ``trigger`` does not include ``name``.
        """
        name = str(trigger.get("name", "")).strip()
        if not name:
            raise ValueError("Trigger payload must include a non-empty 'name'.")

        workspace_path = (
            f"accounts/{account_id}/containers/{container_id}/workspaces/{workspace_id}"
        )
        desired_payload = _prepare_payload(trigger, read_only_fields=READ_ONLY_TRIGGER_FIELDS)
        existing = self._find_trigger_by_name(workspace_path, name)

        if not existing:
            if dry_run:
                return "created", desired_payload
            created = (
                self.service.accounts()
                .containers()
                .workspaces()
                .triggers()
                .create(parent=workspace_path, body=desired_payload)
                .execute()
            )
            return "created", created

        if _is_effectively_equal(existing, desired_payload):
            return "noop", existing

        if dry_run:
            return "updated", desired_payload

        trigger_path = existing.get("path")
        if not trigger_path:
            raise ValueError(f"Existing trigger '{name}' is missing GTM path.")

        update_body = deepcopy(desired_payload)
        existing_trigger_id = existing.get("triggerId")
        if existing_trigger_id:
            update_body["triggerId"] = existing_trigger_id

        updated = (
            self.service.accounts()
            .containers()
            .workspaces()
            .triggers()
            .update(path=trigger_path, body=update_body)
            .execute()
        )
        return "updated", updated

    def delete_trigger_by_name(
        self,
        account_id: str,
        container_id: str,
        workspace_id: str,
        trigger_name: str,
        *,
        dry_run: bool = False,
    ) -> bool:
        """Delete a trigger by name.

        Args:
            account_id: GTM account identifier.
            container_id: GTM container identifier.
            workspace_id: GTM workspace identifier.
            trigger_name: Name of trigger to delete.
            dry_run: If True, only reports whether trigger exists.

        Returns:
            True when a matching trigger exists (and is deleted unless ``dry_run``).
        """
        workspace_path = (
            f"accounts/{account_id}/containers/{container_id}/workspaces/{workspace_id}"
        )
        existing = self._find_trigger_by_name(workspace_path, trigger_name)
        if not existing:
            return False

        if dry_run:
            return True

        trigger_path = existing.get("path")
        if not trigger_path:
            raise ValueError(f"Existing trigger '{trigger_name}' is missing GTM path.")

        (
            self.service.accounts()
            .containers()
            .workspaces()
            .triggers()
            .delete(path=trigger_path)
            .execute()
        )
        return True

    def _find_trigger_by_name(
        self, workspace_path: str, trigger_name: str
    ) -> dict[str, Any] | None:
        for trigger in self._list_triggers_by_workspace_path(workspace_path):
            if str(trigger.get("name", "")).strip() == trigger_name:
                return trigger
        return None

    def _list_triggers_by_workspace_path(self, workspace_path: str) -> list[dict[str, Any]]:
        triggers: list[dict[str, Any]] = []
        next_page_token: str | None = None

        while True:
            request = (
                self.service.accounts()
                .containers()
                .workspaces()
                .triggers()
                .list(parent=workspace_path, pageToken=next_page_token)
            )
            response = request.execute()
            triggers.extend(response.get("trigger", []))

            next_page_token = response.get("nextPageToken")
            if not next_page_token:
                break

        return triggers


def _is_effectively_equal(current: dict[str, Any], desired: dict[str, Any]) -> bool:
    return canonicalize_for_diff(
        current,
        read_only_fields=READ_ONLY_TRIGGER_FIELDS,
    ) == canonicalize_for_diff(
        desired,
        read_only_fields=READ_ONLY_TRIGGER_FIELDS,
    )


def _prepare_payload(trigger: dict[str, Any], *, read_only_fields: set[str]) -> dict[str, Any]:
    payload = deepcopy(trigger)
    for field in read_only_fields:
        payload.pop(field, None)
    return payload
