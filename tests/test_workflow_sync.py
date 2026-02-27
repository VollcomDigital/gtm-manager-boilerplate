from __future__ import annotations

from src.managers.workflow_manager import WorkspaceWorkflowManager


class _FakeContainerManager:
    @staticmethod
    def workspace_path(account_id: str, container_id: str, workspace_id: str) -> str:
        return f"accounts/{account_id}/containers/{container_id}/workspaces/{workspace_id}"

    def __init__(self):
        self.created_versions: list[tuple[str, str, str]] = []
        self.published: list[str] = []

    def get_or_create_workspace(
        self,
        account_id: str,
        container_id: str,
        workspace_name: str,
        *,
        create_if_missing: bool = True,
    ):
        return {
            "name": workspace_name,
            "workspaceId": "1",
            "path": self.workspace_path(account_id, container_id, "1"),
        }

    def create_container_version_from_workspace(
        self, workspace_path: str, *, name: str | None = None, notes: str | None = None
    ):
        version_path = workspace_path.replace("/workspaces/", "/versions/") + "/42"
        self.created_versions.append((workspace_path, name or "", notes or ""))
        return {
            "containerVersion": {"path": version_path, "name": name, "containerVersionId": "42"}
        }

    def publish_container_version(self, container_version_path: str):
        self.published.append(container_version_path)
        return {"containerVersion": {"path": container_version_path}}


class _BaseFakeWorkspaceResourceManager:
    def __init__(self, collection: str, id_key: str):
        self._collection = collection
        self._id_key = id_key
        self._next_id = 1
        self._by_name: dict[str, dict] = {}

    def _path(self, workspace_path: str, entity_id: str) -> str:
        return f"{workspace_path}/{self._collection}/{entity_id}"

    def _mk_id(self) -> str:
        v = str(self._next_id)
        self._next_id += 1
        return v

    def list_from_workspace_path(self, _workspace_path: str):
        return list(self._by_name.values())

    def create(self, workspace_path: str, body: dict):
        entity_id = self._mk_id()
        name = body["name"]
        created = {
            **body,
            self._id_key: entity_id,
            "path": self._path(workspace_path, entity_id),
            "fingerprint": "fp",
        }
        self._by_name[name.strip().lower()] = created
        return created

    def update(self, entity_path: str, body: dict, *, fingerprint: str | None = None):
        _ = fingerprint
        name = body["name"]
        key = name.strip().lower()
        existing = self._by_name[key]
        updated = {**existing, **body, "path": entity_path, "fingerprint": "fp2"}
        self._by_name[key] = updated
        return updated

    def delete(self, entity_path: str):
        to_delete = None
        for k, v in self._by_name.items():
            if v.get("path") == entity_path:
                to_delete = k
                break
        if to_delete is not None:
            del self._by_name[to_delete]


class _FakeVariableManager(_BaseFakeWorkspaceResourceManager):
    def __init__(self):
        super().__init__("variables", "variableId")

    def list_variables_from_workspace_path(self, workspace_path: str):
        return self.list_from_workspace_path(workspace_path)

    def create_variable(self, workspace_path: str, variable: dict):
        return self.create(workspace_path, variable)

    def update_variable(
        self, variable_path: str, variable: dict, *, fingerprint: str | None = None
    ):
        return self.update(variable_path, variable, fingerprint=fingerprint)

    def delete_variable(self, variable_path: str):
        self.delete(variable_path)


class _FakeTriggerManager(_BaseFakeWorkspaceResourceManager):
    def __init__(self):
        super().__init__("triggers", "triggerId")

    def list_triggers_from_workspace_path(self, workspace_path: str):
        return self.list_from_workspace_path(workspace_path)

    def create_trigger(self, workspace_path: str, trigger: dict):
        return self.create(workspace_path, trigger)

    def update_trigger(self, trigger_path: str, trigger: dict, *, fingerprint: str | None = None):
        return self.update(trigger_path, trigger, fingerprint=fingerprint)

    def delete_trigger(self, trigger_path: str):
        self.delete(trigger_path)


class _FakeTagManager(_BaseFakeWorkspaceResourceManager):
    def __init__(self):
        super().__init__("tags", "tagId")

    def list_tags_from_workspace_path(self, workspace_path: str):
        return self.list_from_workspace_path(workspace_path)

    def create_tag(self, workspace_path: str, tag: dict):
        return self.create(workspace_path, tag)

    def update_tag(self, tag_path: str, tag: dict, *, fingerprint: str | None = None):
        return self.update(tag_path, tag, fingerprint=fingerprint)

    def delete_tag(self, tag_path: str):
        self.delete(tag_path)


def test_sync_workspace_creates_entities_and_resolves_trigger_names() -> None:
    mgr = WorkspaceWorkflowManager(service=None)
    mgr.containers = _FakeContainerManager()
    mgr.variables = _FakeVariableManager()
    mgr.triggers = _FakeTriggerManager()
    mgr.tags = _FakeTagManager()

    desired = {
        "variables": [{"name": "Env Var", "type": "v"}],
        "triggers": [{"name": "All Pages", "type": "PAGEVIEW"}],
        "tags": [{"name": "Main Tag", "type": "html", "firingTriggerNames": ["All Pages"]}],
    }

    res = mgr.sync_workspace(
        desired_snapshot=desired,
        account_id="1",
        container_id="2",
        workspace_name="iac",
        dry_run=False,
        delete_missing=False,
    )

    assert res["variables"]["created"] == ["Env Var"]
    assert res["triggers"]["created"] == ["All Pages"]
    assert res["tags"]["created"] == ["Main Tag"]

    created_tag = mgr.tags.list_tags_from_workspace_path(res["workspacePath"])[0]
    assert created_tag["firingTriggerId"] == ["1"]


def test_sync_workspace_deletes_missing_in_reverse_dependency_order() -> None:
    mgr = WorkspaceWorkflowManager(service=None)
    mgr.containers = _FakeContainerManager()
    mgr.variables = _FakeVariableManager()
    mgr.triggers = _FakeTriggerManager()
    mgr.tags = _FakeTagManager()

    ws_path = mgr.containers.workspace_path("1", "2", "1")
    mgr.variables.create_variable(ws_path, {"name": "Old Var", "type": "v"})
    mgr.triggers.create_trigger(ws_path, {"name": "Old Trigger", "type": "PAGEVIEW"})
    mgr.tags.create_tag(ws_path, {"name": "Old Tag", "type": "html", "firingTriggerId": ["1"]})

    res = mgr.sync_workspace(
        desired_snapshot={"variables": [], "triggers": [], "tags": []},
        account_id="1",
        container_id="2",
        workspace_name="iac",
        dry_run=False,
        delete_missing=True,
    )

    assert res["tags"]["deleted"] == ["Old Tag"]
    assert res["triggers"]["deleted"] == ["Old Trigger"]
    assert res["variables"]["deleted"] == ["Old Var"]


def test_publish_from_workspace_dry_run() -> None:
    mgr = WorkspaceWorkflowManager(service=None)
    mgr.containers = _FakeContainerManager()

    res = mgr.publish_from_workspace(
        account_id="1",
        container_id="2",
        workspace_name="iac",
        version_name="Release",
        version_notes="Notes",
        dry_run=True,
    )
    assert res["dryRun"] is True
    assert res["action"] == "publish"


def test_sync_workspace_dry_run_allows_new_trigger_name_references() -> None:
    """Arrange-Act-Assert: dry-run should not crash on missing trigger IDs."""
    mgr = WorkspaceWorkflowManager(service=None)
    mgr.containers = _FakeContainerManager()
    mgr.variables = _FakeVariableManager()
    mgr.triggers = _FakeTriggerManager()
    mgr.tags = _FakeTagManager()

    desired = {
        "variables": [],
        "triggers": [{"name": "New Trigger", "type": "PAGEVIEW"}],
        "tags": [{"name": "New Tag", "type": "html", "firingTriggerNames": ["New Trigger"]}],
    }

    res = mgr.sync_workspace(
        desired_snapshot=desired,
        account_id="1",
        container_id="2",
        workspace_name="iac",
        dry_run=True,
        delete_missing=False,
    )

    assert res["triggers"]["created"] == ["New Trigger"]
    assert res["tags"]["created"] == ["New Tag"]
