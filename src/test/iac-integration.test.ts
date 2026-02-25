import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { GtmClient } from "../lib/gtm-client";
import { diffWorkspace } from "../iac/diff";
import { syncWorkspace } from "../iac/sync";
import { zWorkspaceDesiredState } from "../iac/workspace-config";

function fixturePath(fileName: string): string {
  return path.resolve(process.cwd(), "src", "test", "fixtures", fileName);
}

test("integration fixture: diffWorkspace detects multi-resource drift", async () => {
  const desiredRaw = await fs.readFile(fixturePath("workspace-desired.json"), "utf-8");
  const currentRaw = await fs.readFile(fixturePath("workspace-current.json"), "utf-8");

  const desired = zWorkspaceDesiredState.parse(JSON.parse(desiredRaw));
  const current = JSON.parse(currentRaw) as Parameters<typeof diffWorkspace>[1];

  const diff = diffWorkspace(desired, current);

  assert.deepEqual(diff.builtInVariables.create, ["CLICK_TEXT"]);
  assert.deepEqual(diff.environments.update, ["Staging"]);
  assert.deepEqual(diff.environments.delete, ["legacy"]);
  assert.deepEqual(diff.clients.create, ["HTTP Client"]);
  assert.deepEqual(diff.transformations.update, ["PII Redact"]);
  assert.deepEqual(diff.tags.update, ["Main Tag"]);
  assert.deepEqual(diff.templates.update, ["Template A"]);
});

test("integration fixture: syncWorkspace respects protected names + delete type allowlist", async () => {
  const fakeGtm = {
    listEnvironments: async () => [],
    listFolders: async () => [],
    listEnabledBuiltInVariables: async () => [],
    listClients: async () => [],
    listTransformations: async () => [],
    listTags: async () => [
      { name: "Keep Tag", tagId: "1" },
      { name: "Old Tag", tagId: "2" }
    ],
    listTriggers: async () => [],
    listVariables: async () => [],
    listTemplates: async () => [],
    listZones: async () => []
  } as unknown as GtmClient;

  const desired = zWorkspaceDesiredState.parse({
    workspaceName: "iac",
    policy: {
      protectedNames: {
        tags: ["Keep Tag"]
      },
      deleteAllowTypes: ["tags"]
    },
    tags: []
  });

  const res = await syncWorkspace(
    fakeGtm,
    "accounts/1/containers/10/workspaces/100",
    desired,
    {
      dryRun: true,
      deleteMissing: true,
      updateExisting: true,
      validateVariableRefs: false
    }
  );

  assert.deepEqual(res.tags.deleted, ["Old Tag"]);
  assert.deepEqual(res.tags.skipped, ["Keep Tag"]);
  assert.ok(res.warnings.some((w) => w.includes("Protected tag not deleted")));
});
