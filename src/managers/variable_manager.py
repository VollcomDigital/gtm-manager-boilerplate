"""Helpers for working with GTM variables."""

from __future__ import annotations

from typing import Any

from utils.google_api import execute_with_retry, list_all_pages


class VariableManager:
    """Variable operations (list/create/update/delete)."""

    def __init__(self, service: Any):
        self.service = service

    def list_variables_from_workspace_path(self, workspace_path: str) -> list[dict[str, Any]]:
        """Return all variables for a workspace path (paginated)."""

        def fetch_page(page_token: str | None) -> dict[str, Any]:
            req = (
                self.service.accounts()
                .containers()
                .workspaces()
                .variables()
                .list(
                    parent=workspace_path,
                    pageToken=page_token,
                )
            )
            return execute_with_retry(req.execute)

        return list_all_pages(fetch_page, items_field="variable")

    def create_variable(self, workspace_path: str, variable: dict[str, Any]) -> dict[str, Any]:
        """Create a variable in a workspace."""
        req = (
            self.service.accounts()
            .containers()
            .workspaces()
            .variables()
            .create(
                parent=workspace_path,
                body=variable,
            )
        )
        return execute_with_retry(req.execute)

    def update_variable(
        self,
        variable_path: str,
        variable: dict[str, Any],
        *,
        fingerprint: str | None = None,
    ) -> dict[str, Any]:
        """Update a variable by API path."""
        kwargs: dict[str, Any] = {"path": variable_path, "body": variable}
        if fingerprint:
            kwargs["fingerprint"] = fingerprint
        req = self.service.accounts().containers().workspaces().variables().update(**kwargs)
        return execute_with_retry(req.execute)

    def delete_variable(self, variable_path: str) -> None:
        """Delete a variable by API path."""
        req = (
            self.service.accounts().containers().workspaces().variables().delete(path=variable_path)
        )
        execute_with_retry(req.execute)

    def find_variable_by_name(self, workspace_path: str, name: str) -> dict[str, Any] | None:
        """Find a variable by name (case-insensitive)."""
        wanted = name.strip().lower()
        for variable in self.list_variables_from_workspace_path(workspace_path):
            if (variable.get("name") or "").strip().lower() == wanted:
                return variable
        return None
