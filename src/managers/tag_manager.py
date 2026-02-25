"""Utility helpers for working with GTM tags."""

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
    """Manage GTM workspace tags with idempotent upsert helpers."""

    def __init__(self, service):
        """Initialize the manager.

        Args:
            service: Google API client from ``googleapiclient.discovery.build``.
        """
        self.service = service

    def list_tags(
        self, account_id: str, container_id: str, workspace_id: str
    ) -> list[dict[str, Any]]:
        """Return all tags for a GTM workspace.

        Args:
            account_id: GTM account identifier.
            container_id: GTM container identifier.
            workspace_id: GTM workspace identifier.

        Returns:
            A list of tag objects.
        """
        workspace_path = (
            f"accounts/{account_id}/containers/{container_id}/workspaces/{workspace_id}"
        )
        return self._list_tags_by_workspace_path(workspace_path)

    def upsert_tag(
        self,
        account_id: str,
        container_id: str,
        workspace_id: str,
        tag: dict[str, Any],
        *,
        dry_run: bool = False,
    ) -> tuple[str, dict[str, Any]]:
        """Create or update a tag by ``name``.

        Args:
            account_id: GTM account identifier.
            container_id: GTM container identifier.
            workspace_id: GTM workspace identifier.
            tag: Desired GTM tag object.
            dry_run: If True, only reports intended action.

        Returns:
            Tuple of ``(action, tag_payload)`` where action is one of
            ``created``, ``updated``, or ``noop``.

        Raises:
            ValueError: If ``tag`` does not include ``name``.
        """
        name = str(tag.get("name", "")).strip()
        if not name:
            raise ValueError("Tag payload must include a non-empty 'name'.")

        workspace_path = (
            f"accounts/{account_id}/containers/{container_id}/workspaces/{workspace_id}"
        )
        desired_payload = _prepare_payload(tag, read_only_fields=READ_ONLY_TAG_FIELDS)
        existing = self._find_tag_by_name(workspace_path, name)

        if not existing:
            if dry_run:
                return "created", desired_payload
            created = (
                self.service.accounts()
                .containers()
                .workspaces()
                .tags()
                .create(parent=workspace_path, body=desired_payload)
                .execute()
            )
            return "created", created

        if _is_effectively_equal(existing, desired_payload):
            return "noop", existing

        if dry_run:
            return "updated", desired_payload

        tag_path = existing.get("path")
        if not tag_path:
            raise ValueError(f"Existing tag '{name}' is missing GTM path.")

        update_body = deepcopy(desired_payload)
        existing_tag_id = existing.get("tagId")
        if existing_tag_id:
            update_body["tagId"] = existing_tag_id

        updated = (
            self.service.accounts()
            .containers()
            .workspaces()
            .tags()
            .update(path=tag_path, body=update_body)
            .execute()
        )
        return "updated", updated

    def delete_tag_by_name(
        self,
        account_id: str,
        container_id: str,
        workspace_id: str,
        tag_name: str,
        *,
        dry_run: bool = False,
    ) -> bool:
        """Delete a tag by name.

        Args:
            account_id: GTM account identifier.
            container_id: GTM container identifier.
            workspace_id: GTM workspace identifier.
            tag_name: Name of tag to delete.
            dry_run: If True, only reports whether tag exists.

        Returns:
            True when a matching tag exists (and is deleted unless ``dry_run``).
        """
        workspace_path = (
            f"accounts/{account_id}/containers/{container_id}/workspaces/{workspace_id}"
        )
        existing = self._find_tag_by_name(workspace_path, tag_name)
        if not existing:
            return False

        if dry_run:
            return True

        tag_path = existing.get("path")
        if not tag_path:
            raise ValueError(f"Existing tag '{tag_name}' is missing GTM path.")

        (self.service.accounts().containers().workspaces().tags().delete(path=tag_path).execute())
        return True

    def _find_tag_by_name(self, workspace_path: str, tag_name: str) -> dict[str, Any] | None:
        for tag in self._list_tags_by_workspace_path(workspace_path):
            if str(tag.get("name", "")).strip() == tag_name:
                return tag
        return None

    def _list_tags_by_workspace_path(self, workspace_path: str) -> list[dict[str, Any]]:
        tags: list[dict[str, Any]] = []
        next_page_token: str | None = None

        while True:
            request = (
                self.service.accounts()
                .containers()
                .workspaces()
                .tags()
                .list(parent=workspace_path, pageToken=next_page_token)
            )
            response = request.execute()
            tags.extend(response.get("tag", []))

            next_page_token = response.get("nextPageToken")
            if not next_page_token:
                break

        return tags


def _is_effectively_equal(current: dict[str, Any], desired: dict[str, Any]) -> bool:
    return canonicalize_for_diff(
        current, read_only_fields=READ_ONLY_TAG_FIELDS
    ) == canonicalize_for_diff(
        desired,
        read_only_fields=READ_ONLY_TAG_FIELDS,
    )


def _prepare_payload(tag: dict[str, Any], *, read_only_fields: set[str]) -> dict[str, Any]:
    payload = deepcopy(tag)
    for field in read_only_fields:
        payload.pop(field, None)
    return payload
