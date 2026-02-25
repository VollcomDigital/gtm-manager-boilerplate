"""Helpers for working with GTM containers, workspaces, and versions."""

from __future__ import annotations

from typing import Any

from utils.google_api import execute_with_retry, list_all_pages


class ContainerManager:
    """Container-level operations (containers, workspaces, versions)."""

    def __init__(self, service: Any):
        self.service = service

    @staticmethod
    def container_path(account_id: str, container_id: str) -> str:
        """Build a GTM container API path."""
        return f"accounts/{account_id}/containers/{container_id}"

    @staticmethod
    def workspace_path(account_id: str, container_id: str, workspace_id: str) -> str:
        """Build a GTM workspace API path."""
        return f"accounts/{account_id}/containers/{container_id}/workspaces/{workspace_id}"

    def list_containers(self, account_id: str) -> list[dict[str, Any]]:
        """Return all containers for a GTM account (paginated)."""
        parent = f"accounts/{account_id}"

        def fetch_page(page_token: str | None) -> dict[str, Any]:
            req = (
                self.service.accounts()
                .containers()
                .list(
                    parent=parent,
                    pageToken=page_token,
                )
            )
            return execute_with_retry(req.execute)

        return list_all_pages(fetch_page, items_field="container")

    def list_workspaces(self, account_id: str, container_id: str) -> list[dict[str, Any]]:
        """Return all workspaces for a container (paginated)."""
        parent = self.container_path(account_id, container_id)

        def fetch_page(page_token: str | None) -> dict[str, Any]:
            req = (
                self.service.accounts()
                .containers()
                .workspaces()
                .list(
                    parent=parent,
                    pageToken=page_token,
                )
            )
            return execute_with_retry(req.execute)

        return list_all_pages(fetch_page, items_field="workspace")

    def find_workspace_by_name(
        self,
        account_id: str,
        container_id: str,
        workspace_name: str,
    ) -> dict[str, Any] | None:
        """Find a workspace by name (case-insensitive)."""
        wanted = workspace_name.strip().lower()
        for workspace in self.list_workspaces(account_id, container_id):
            name = (workspace.get("name") or "").strip().lower()
            if name and name == wanted:
                return workspace
        return None

    def get_or_create_workspace(
        self,
        account_id: str,
        container_id: str,
        workspace_name: str,
        *,
        create_if_missing: bool = True,
    ) -> dict[str, Any]:
        """Get a workspace by name, creating it if needed.

        Args:
            account_id: GTM account ID.
            container_id: GTM container ID.
            workspace_name: Workspace display name.
            create_if_missing: If False, raises if missing.

        Returns:
            Workspace payload (dict).
        """
        existing = self.find_workspace_by_name(account_id, container_id, workspace_name)
        if existing:
            return existing
        if not create_if_missing:
            raise ValueError(
                f"Workspace not found: name='{workspace_name}' in {self.container_path(account_id, container_id)}",
            )

        parent = self.container_path(account_id, container_id)
        req = (
            self.service.accounts()
            .containers()
            .workspaces()
            .create(
                parent=parent,
                body={"name": workspace_name},
            )
        )
        return execute_with_retry(req.execute)

    def create_container_version_from_workspace(
        self,
        workspace_path: str,
        *,
        name: str | None = None,
        notes: str | None = None,
    ) -> dict[str, Any]:
        """Create a container version from a workspace."""
        body: dict[str, Any] = {}
        if name:
            body["name"] = name
        if notes:
            body["notes"] = notes

        req = (
            self.service.accounts()
            .containers()
            .workspaces()
            .create_version(
                path=workspace_path,
                body=body,
            )
        )
        return execute_with_retry(req.execute)

    def publish_container_version(self, container_version_path: str) -> dict[str, Any]:
        """Publish a container version by API path."""
        req = self.service.accounts().containers().versions().publish(path=container_version_path)
        return execute_with_retry(req.execute)
