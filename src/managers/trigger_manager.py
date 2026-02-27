"""Helpers for working with GTM triggers."""

from __future__ import annotations

from copy import deepcopy
from typing import Any

from ..utils.google_api import execute_with_retry, list_all_pages
from ..utils.helpers import canonicalize_for_diff

READ_ONLY_TRIGGER_FIELDS: set[str] = {
    "accountId",
    "containerId",
    "workspaceId",
    "triggerId",
    "path",
    "fingerprint",
    "tagManagerUrl",
}


class TriggerManager:
    """Trigger operations (list/upsert/delete by name)."""

    def __init__(self, service: Any):
        self.service = service

    @staticmethod
    def workspace_path(account_id: str, container_id: str, workspace_id: str) -> str:
        return f"accounts/{account_id}/containers/{container_id}/workspaces/{workspace_id}"

    @staticmethod
    def trigger_path(account_id: str, container_id: str, workspace_id: str, trigger_id: str) -> str:
        return f"{TriggerManager.workspace_path(account_id, container_id, workspace_id)}/triggers/{trigger_id}"

    def _resource(self) -> Any:
        return self.service.accounts().containers().workspaces().triggers()

    def list_triggers(
        self,
        account_id: str,
        container_id: str,
        workspace_id: str,
    ) -> list[dict[str, Any]]:
        """Return all triggers for a workspace (paginated)."""
        parent = self.workspace_path(account_id, container_id, workspace_id)

        def fetch_page(page_token: str | None) -> dict[str, Any]:
            req = self._resource().list(parent=parent, pageToken=page_token)
            return execute_with_retry(req.execute)

        return list_all_pages(fetch_page, items_field="trigger")

    def list_triggers_from_workspace_path(self, workspace_path: str) -> list[dict[str, Any]]:
        """Return all triggers for a workspace path (paginated)."""

        def fetch_page(page_token: str | None) -> dict[str, Any]:
            req = self._resource().list(parent=workspace_path, pageToken=page_token)
            return execute_with_retry(req.execute)

        return list_all_pages(fetch_page, items_field="trigger")

    def create_trigger(self, workspace_path: str, trigger: dict[str, Any]) -> dict[str, Any]:
        """Create a trigger in a workspace."""
        return execute_with_retry(self._resource().create(parent=workspace_path, body=trigger).execute)

    def update_trigger(
        self,
        trigger_path: str,
        trigger: dict[str, Any],
        *,
        fingerprint: str | None = None,
    ) -> dict[str, Any]:
        """Update a trigger by API path."""
        kwargs: dict[str, Any] = {"path": trigger_path, "body": trigger}
        if fingerprint:
            kwargs["fingerprint"] = fingerprint
        return execute_with_retry(self._resource().update(**kwargs).execute)

    def delete_trigger(self, trigger_path: str) -> None:
        """Delete a trigger by API path."""
        execute_with_retry(self._resource().delete(path=trigger_path).execute)

    def _find_trigger_by_name(
        self,
        account_id: str,
        container_id: str,
        workspace_id: str,
        name: str,
    ) -> dict[str, Any] | None:
        wanted = name.strip().lower()
        for trig in self.list_triggers(account_id, container_id, workspace_id):
            if str(trig.get("name") or "").strip().lower() == wanted:
                return trig
        return None

    def upsert_trigger(
        self,
        account_id: str,
        container_id: str,
        workspace_id: str,
        desired: dict[str, Any],
        *,
        dry_run: bool = False,
    ) -> tuple[str, dict[str, Any]]:
        """Create or update a trigger by name."""
        name = str(desired.get("name") or "").strip()
        if not name:
            raise ValueError("Trigger is missing a non-empty 'name'.")

        existing = self._find_trigger_by_name(account_id, container_id, workspace_id, name)
        if not existing:
            if dry_run:
                return "created", {"name": name, "dry_run": True}
            parent = self.workspace_path(account_id, container_id, workspace_id)
            cleaned_desired = deepcopy(desired)
            for k in READ_ONLY_TRIGGER_FIELDS:
                cleaned_desired.pop(k, None)
            created = execute_with_retry(
                self._resource().create(parent=parent, body=cleaned_desired).execute
            )
            return "created", created

        desired_canon = canonicalize_for_diff(desired, read_only_fields=READ_ONLY_TRIGGER_FIELDS)
        existing_canon = canonicalize_for_diff(existing, read_only_fields=READ_ONLY_TRIGGER_FIELDS)
        if desired_canon == existing_canon:
            return "noop", existing

        if dry_run:
            return "updated", {"name": name, "dry_run": True}

        path = existing.get("path") or (
            self.trigger_path(account_id, container_id, workspace_id, str(existing.get("triggerId") or ""))
        )
        body = deepcopy(existing)
        for k in READ_ONLY_TRIGGER_FIELDS:
            body.pop(k, None)
        cleaned_desired = deepcopy(desired)
        for k in READ_ONLY_TRIGGER_FIELDS:
            cleaned_desired.pop(k, None)
        body.update(cleaned_desired)

        fingerprint = existing.get("fingerprint")
        kwargs: dict[str, Any] = {"path": path, "body": body}
        if isinstance(fingerprint, str) and fingerprint.strip():
            kwargs["fingerprint"] = fingerprint

        updated = execute_with_retry(self._resource().update(**kwargs).execute)
        return "updated", updated

    def delete_trigger_by_name(
        self,
        account_id: str,
        container_id: str,
        workspace_id: str,
        name: str,
        *,
        dry_run: bool = False,
    ) -> bool:
        existing = self._find_trigger_by_name(account_id, container_id, workspace_id, name)
        if not existing:
            return False
        if dry_run:
            return True
        path = existing.get("path")
        if not isinstance(path, str) or not path.strip():
            return False
        execute_with_retry(self._resource().delete(path=path).execute)
        return True
