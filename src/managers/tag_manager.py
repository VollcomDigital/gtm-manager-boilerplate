"""Helpers for working with GTM tags."""

from __future__ import annotations

from copy import deepcopy
from typing import Any

from ..utils.google_api import execute_with_retry, list_all_pages
from ..utils.helpers import canonicalize_for_diff

READ_ONLY_TAG_FIELDS: set[str] = {
    "accountId",
    "containerId",
    "workspaceId",
    "tagId",
    "path",
    "fingerprint",
    "tagManagerUrl",
}


class TagManager:
    """Tag operations (list/upsert/delete by name)."""

    def __init__(self, service: Any):
        self.service = service

    @staticmethod
    def workspace_path(account_id: str, container_id: str, workspace_id: str) -> str:
        return f"accounts/{account_id}/containers/{container_id}/workspaces/{workspace_id}"

    @staticmethod
    def tag_path(account_id: str, container_id: str, workspace_id: str, tag_id: str) -> str:
        return f"{TagManager.workspace_path(account_id, container_id, workspace_id)}/tags/{tag_id}"

    def _resource(self) -> Any:
        return self.service.accounts().containers().workspaces().tags()

    def list_tags(self, account_id: str, container_id: str, workspace_id: str) -> list[dict[str, Any]]:
        """Return all tags for a workspace (paginated)."""
        parent = self.workspace_path(account_id, container_id, workspace_id)

        def fetch_page(page_token: str | None) -> dict[str, Any]:
            req = self._resource().list(parent=parent, pageToken=page_token)
            return execute_with_retry(req.execute)

        return list_all_pages(fetch_page, items_field="tag")

    def list_tags_from_workspace_path(self, workspace_path: str) -> list[dict[str, Any]]:
        """Return all tags for a workspace path (paginated)."""

        def fetch_page(page_token: str | None) -> dict[str, Any]:
            req = self._resource().list(parent=workspace_path, pageToken=page_token)
            return execute_with_retry(req.execute)

        return list_all_pages(fetch_page, items_field="tag")

    def create_tag(self, workspace_path: str, tag: dict[str, Any]) -> dict[str, Any]:
        """Create a tag in a workspace."""
        return execute_with_retry(self._resource().create(parent=workspace_path, body=tag).execute)

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
        return execute_with_retry(self._resource().update(**kwargs).execute)

    def delete_tag(self, tag_path: str) -> None:
        """Delete a tag by API path."""
        execute_with_retry(self._resource().delete(path=tag_path).execute)

    def _find_tag_by_name(
        self,
        account_id: str,
        container_id: str,
        workspace_id: str,
        name: str,
    ) -> dict[str, Any] | None:
        wanted = name.strip().lower()
        for tag in self.list_tags(account_id, container_id, workspace_id):
            if str(tag.get("name") or "").strip().lower() == wanted:
                return tag
        return None

    def upsert_tag(
        self,
        account_id: str,
        container_id: str,
        workspace_id: str,
        desired: dict[str, Any],
        *,
        dry_run: bool = False,
    ) -> tuple[str, dict[str, Any]]:
        """Create or update a tag by name.

        Returns:
            Tuple of (action, payload) where action is one of: created, updated, noop.
        """
        name = str(desired.get("name") or "").strip()
        if not name:
            raise ValueError("Tag is missing a non-empty 'name'.")

        existing = self._find_tag_by_name(account_id, container_id, workspace_id, name)
        if not existing:
            if dry_run:
                return "created", {"name": name, "dry_run": True}
            parent = self.workspace_path(account_id, container_id, workspace_id)
            cleaned_desired = deepcopy(desired)
            for k in READ_ONLY_TAG_FIELDS:
                cleaned_desired.pop(k, None)
            created = execute_with_retry(
                self._resource().create(parent=parent, body=cleaned_desired).execute
            )
            return "created", created

        desired_canon = canonicalize_for_diff(desired, read_only_fields=READ_ONLY_TAG_FIELDS)
        existing_canon = canonicalize_for_diff(existing, read_only_fields=READ_ONLY_TAG_FIELDS)
        if desired_canon == existing_canon:
            return "noop", existing

        if dry_run:
            return "updated", {"name": name, "dry_run": True}

        path = existing.get("path") or (
            self.tag_path(account_id, container_id, workspace_id, str(existing.get("tagId") or ""))
        )
        body = deepcopy(existing)
        for k in READ_ONLY_TAG_FIELDS:
            body.pop(k, None)
        cleaned_desired = deepcopy(desired)
        for k in READ_ONLY_TAG_FIELDS:
            cleaned_desired.pop(k, None)
        body.update(cleaned_desired)

        fingerprint = existing.get("fingerprint")
        kwargs: dict[str, Any] = {"path": path, "body": body}
        if isinstance(fingerprint, str) and fingerprint.strip():
            kwargs["fingerprint"] = fingerprint

        updated = execute_with_retry(self._resource().update(**kwargs).execute)
        return "updated", updated

    def delete_tag_by_name(
        self,
        account_id: str,
        container_id: str,
        workspace_id: str,
        name: str,
        *,
        dry_run: bool = False,
    ) -> bool:
        existing = self._find_tag_by_name(account_id, container_id, workspace_id, name)
        if not existing:
            return False
        if dry_run:
            return True
        path = existing.get("path")
        if not isinstance(path, str) or not path.strip():
            return False
        execute_with_retry(self._resource().delete(path=path).execute)
        return True
