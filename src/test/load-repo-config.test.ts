import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadRepoConfig } from "../iac/load-repo-config";

test("loadRepoConfig: merges containers by key and workspace entities by name", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "gtm-iac-repo-config-"));
  const basePath = path.join(tmpDir, "base.yml");
  const overlayPath = path.join(tmpDir, "prod.yml");

  await fs.writeFile(
    basePath,
    [
      "schemaVersion: 1",
      "defaults:",
      "  workspaceName: iac",
      "containers:",
      "  - key: site_a",
      "    labels:",
      "      env: dev",
      "    target:",
      "      accountId: \"1\"",
      "      containerId: \"10\"",
      "    workspace:",
      "      workspaceName: iac",
      "      triggers:",
      "        - name: All Pages",
      "          type: PAGEVIEW",
      "      tags:",
      "        - name: Tag A",
      "          type: html"
    ].join("\n"),
    "utf-8"
  );

  await fs.writeFile(
    overlayPath,
    [
      "schemaVersion: 1",
      "containers:",
      "  - key: site_a",
      "    labels:",
      "      env: prod",
      "      region: eu",
      "    workspace:",
      "      tags:",
      "        - name: Tag A",
      "          type: html",
      "          parameter:",
      "            - key: html",
      "              type: TEMPLATE",
      "              value: \"<span/>\"",
      "        - name: Tag B",
      "          type: html"
    ].join("\n"),
    "utf-8"
  );

  const repo = await loadRepoConfig(`${basePath},${overlayPath}`);
  assert.equal(repo.schemaVersion, 1);
  assert.equal(repo.containers.length, 1);

  const c = repo.containers[0]!;
  assert.equal(c.key, "site_a");
  assert.equal(c.labels?.env, "prod");
  assert.equal(c.labels?.region, "eu");

  assert.equal(c.workspace.tags.length, 2);
  const tagA = c.workspace.tags.find((t) => t.name === "Tag A");
  assert.ok(tagA);
});

