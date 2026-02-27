import assert from "node:assert/strict";
import test from "node:test";
import { GoogleAuth } from "google-auth-library";
import { GtmClient } from "../lib/gtm-client";

class FakeGtmClient extends GtmClient {
  constructor(
    private readonly fakeAccounts: Array<{ accountId: string; name: string }>,
    private readonly fakeContainers: Record<string, Array<{ containerId: string; publicId: string; name: string }>>
  ) {
    super(new GoogleAuth({ scopes: [] }));
  }

  override async listAccounts() {
    return this.fakeAccounts;
  }

  override async listContainers(accountId: string) {
    return this.fakeContainers[accountId] ?? [];
  }
}

test("resolveAccountAndContainer: resolves by accountId + containerId", async () => {
  const gtm = new FakeGtmClient(
    [{ accountId: "1", name: "Account A" }],
    {
      "1": [{ containerId: "100", publicId: "GTM-AAAAAAA", name: "Container A" }]
    }
  );

  const resolved = await gtm.resolveAccountAndContainer({ accountId: "1", containerId: "100" });
  assert.equal(resolved.accountId, "1");
  assert.equal(resolved.containerId, "100");
  assert.equal(resolved.containerPublicId, "GTM-AAAAAAA");
});

test("resolveAccountAndContainer: resolves by accountName + publicId", async () => {
  const gtm = new FakeGtmClient(
    [{ accountId: "1", name: "Account A" }],
    {
      "1": [{ containerId: "100", publicId: "GTM-AAAAAAA", name: "Container A" }]
    }
  );

  const resolved = await gtm.resolveAccountAndContainer({ accountName: "Account A", containerId: "GTM-AAAAAAA" });
  assert.equal(resolved.accountId, "1");
  assert.equal(resolved.containerId, "100");
});

test("resolveAccountAndContainer: throws when container not found", async () => {
  const gtm = new FakeGtmClient([{ accountId: "1", name: "Account A" }], { "1": [] });

  await assert.rejects(
    async () => {
      await gtm.resolveAccountAndContainer({ accountId: "1", containerId: "999" });
    },
    (err: unknown) => (err instanceof Error ? err.message.includes("Container not found") : false)
  );
});
