"""Helpers for working with GTM tags."""

from __future__ import annotations

from typing import Any

from utils.google_api import execute_with_retry, list_all_pages

from __future__ import annotations

from copy import deepcopy
from typing import Any

from ..utils.helpers import canonicalize_for_diff

READ_ONLY_TAG_FIELDS = {
    "accountId",
    "containerId",
    "workspaceId",
    "tagId",
    "path",
    "fingerprint",
    "tagManagerUrl",
}


class TagManager:
    """Tag operations (list/create/update/delete)."""

    def __init__(self, service: Any):
        self.service = service

    @staticmethod
    def workspace_path(account_id: str, container_id: str, workspace_id: str) -> str:
        return f"accounts/{account_id}/containers/{container_id}/workspaces/{workspace_id}"

    @staticmethod
    def tag_path(account_id: str, container_id: str, workspace_id: str, tag_id: str) -> str:
        return f"{TagManager.workspace_path(account_id, container_id, workspace_id)}/tags/{tag_id}"

    def list_tags(
        self, account_id: str, container_id: str, workspace_id: str
    ) -> list[dict[str, Any]]:
        """Return all tags for a workspace (paginated)."""
        parent = self.workspace_path(account_id, container_id, workspace_id)

        def fetch_page(page_token: str | None) -> dict[str, Any]:
            req = (
                self.service.accounts()
                .containers()
                .workspaces()
                .tags()
                .list(
                    parent=parent,
                    pageToken=page_token,
                )
            )
            return execute_with_retry(req.execute)

        return list_all_pages(fetch_page, items_field="tag")

    def create_tag(self, workspace_path: str, tag: dict[str, Any]) -> dict[str, Any]:
        """Create a tag in a workspace."""
        req = (
            self.service.accounts()
            .containers()
            .workspaces()
            .tags()
            .create(parent=workspace_path, body=tag)
        )
        return execute_with_retry(req.execute)

    def update_tag(
        self,
        tag_path: str,
        tag: dict[str, Any],
        *,
        fingerprint: str | None = None,
    ) -> dict[str, Any]:
        """Update a tag by API path."""
        kwargs: dict[str, Any] = {"path": tag_path, "body": tag}
        if fingerprint:
            kwargs["fingerprint"] = fingerprint
        req = self.service.accounts().containers().workspaces().tags().update(**kwargs)
        return execute_with_retry(req.execute)

    def delete_tag(self, tag_path: str) -> None:
        """Delete a tag by API path."""
        req = self.service.accounts().containers().workspaces().tags().delete(path=tag_path)
        execute_with_retry(req.execute)

    def find_tag_by_name(self, workspace_path: str, name: str) -> dict[str, Any] | None:
        """Find a tag by name (case-insensitive)."""
        wanted = name.strip().lower()
        for tag in self.list_tags_from_workspace_path(workspace_path):
            if (tag.get("name") or "").strip().lower() == wanted:
                return tag
        return None

    def list_tags_from_workspace_path(self, workspace_path: str) -> list[dict[str, Any]]:
        """Return all tags for a workspace path (paginated)."""

        def fetch_page(page_token: str | None) -> dict[str, Any]:
            req = (
                self.service.accounts()
                .containers()
                .workspaces()
                .tags()
                .list(
                    parent=workspace_path,
                    pageToken=page_token,
                )
            )
            return execute_with_retry(req.execute)

        return list_all_pages(fetch_page, items_field="tag")
