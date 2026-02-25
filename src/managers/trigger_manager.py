"""Helpers for working with GTM triggers."""

from __future__ import annotations

from typing import Any

from utils.google_api import execute_with_retry, list_all_pages


class TriggerManager:
    """Trigger operations (list/create/update/delete)."""

    def __init__(self, service: Any):
        self.service = service

    @staticmethod
    def workspace_path(account_id: str, container_id: str, workspace_id: str) -> str:
        return f"accounts/{account_id}/containers/{container_id}/workspaces/{workspace_id}"

    @staticmethod
    def trigger_path(account_id: str, container_id: str, workspace_id: str, trigger_id: str) -> str:
        return f"{TriggerManager.workspace_path(account_id, container_id, workspace_id)}/triggers/{trigger_id}"

    def list_triggers(
        self,
        account_id: str,
        container_id: str,
        workspace_id: str,
    ) -> list[dict[str, Any]]:
        """Return all triggers for a workspace (paginated)."""
        parent = self.workspace_path(account_id, container_id, workspace_id)

        def fetch_page(page_token: str | None) -> dict[str, Any]:
            req = (
                self.service.accounts()
                .containers()
                .workspaces()
                .triggers()
                .list(
                    parent=parent,
                    pageToken=page_token,
                )
            )
            return execute_with_retry(req.execute)

        return list_all_pages(fetch_page, items_field="trigger")

    def list_triggers_from_workspace_path(self, workspace_path: str) -> list[dict[str, Any]]:
        """Return all triggers for a workspace path (paginated)."""

        def fetch_page(page_token: str | None) -> dict[str, Any]:
            req = (
                self.service.accounts()
                .containers()
                .workspaces()
                .triggers()
                .list(
                    parent=workspace_path,
                    pageToken=page_token,
                )
            )
            return execute_with_retry(req.execute)

        return list_all_pages(fetch_page, items_field="trigger")

    def create_trigger(self, workspace_path: str, trigger: dict[str, Any]) -> dict[str, Any]:
        """Create a trigger in a workspace."""
        req = (
            self.service.accounts()
            .containers()
            .workspaces()
            .triggers()
            .create(parent=workspace_path, body=trigger)
        )
        return execute_with_retry(req.execute)

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
        req = self.service.accounts().containers().workspaces().triggers().update(**kwargs)
        return execute_with_retry(req.execute)

    def delete_trigger(self, trigger_path: str) -> None:
        """Delete a trigger by API path."""
        req = self.service.accounts().containers().workspaces().triggers().delete(path=trigger_path)
        execute_with_retry(req.execute)

    def find_trigger_by_name(self, workspace_path: str, name: str) -> dict[str, Any] | None:
        """Find a trigger by name (case-insensitive)."""
        wanted = name.strip().lower()
        for trigger in self.list_triggers_from_workspace_path(workspace_path):
            if (trigger.get("name") or "").strip().lower() == wanted:
                return trigger
        return None
