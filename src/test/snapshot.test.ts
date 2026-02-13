import assert from "node:assert/strict";
import test from "node:test";
import type { GtmClient } from "../lib/gtm-client";
import { fetchWorkspaceSnapshot } from "../iac/snapshot";

test("fetchWorkspaceSnapshot: handles wrapped 403/404 for optional resources", async () => {
  const gtm = {
    listEnvironments: async () => [],
    listFolders: async () => [],
    listEnabledBuiltInVariables: async () => [],
    listClients: async () => {
      throw new Error("GTM clients.list failed: status=403 Forbidden", {
        cause: { response: { status: 403 } }
      });
    },
    listTransformations: async () => {
      throw new Error("GTM transformations.list failed: status=404 Not Found", {
        cause: { response: { status: 404 } }
      });
    },
    listTags: async () => [],
    listTriggers: async () => [],
    listVariables: async () => [],
    listTemplates: async () => [],
    listZones: async () => {
      throw new Error("GTM zones.list failed: status=403 Forbidden", {
        cause: { response: { status: 403 } }
      });
    }
  } as unknown as GtmClient;

  const snapshot = await fetchWorkspaceSnapshot(gtm, "accounts/1/containers/2/workspaces/3");
  assert.deepEqual(snapshot.clients, []);
  assert.deepEqual(snapshot.transformations, []);
  assert.deepEqual(snapshot.zones, []);
});

test("fetchWorkspaceSnapshot: rethrows non-403/404 optional-resource errors", async () => {
  const gtm = {
    listEnvironments: async () => [],
    listFolders: async () => [],
    listEnabledBuiltInVariables: async () => [],
    listClients: async () => [],
    listTransformations: async () => [],
    listTags: async () => [],
    listTriggers: async () => [],
    listVariables: async () => [],
    listTemplates: async () => [],
    listZones: async () => {
      throw new Error("GTM zones.list failed: status=500 Internal Server Error", {
        cause: { response: { status: 500 } }
      });
    }
  } as unknown as GtmClient;

  await assert.rejects(
    fetchWorkspaceSnapshot(gtm, "accounts/1/containers/2/workspaces/3"),
    /status=500/
  );
});
