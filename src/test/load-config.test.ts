import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadWorkspaceDesiredState } from "../iac/load-config";

test("loadWorkspaceDesiredState: supports JSON + YAML overlays (merge by name)", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "gtm-iac-config-"));
  const basePath = path.join(tmpDir, "base.json");
  const overlayPath = path.join(tmpDir, "overlay.yml");

  await fs.writeFile(
    basePath,
    JSON.stringify(
      {
        workspaceName: "Automation-Test",
        tags: [{ name: "Tag A", type: "html", parameter: [{ key: "html", type: "TEMPLATE", value: "<div/>" }] }]
      },
      null,
      2
    ),
    "utf-8"
  );

  await fs.writeFile(
    overlayPath,
    [
      "workspaceName: Automation-Test",
      "tags:",
      "  - name: Tag A",
      "    type: html",
      "    parameter:",
      "      - key: html",
      "        type: TEMPLATE",
      "        value: \"<span/>\"",
      "  - name: Tag B",
      "    type: html"
    ].join("\n"),
    "utf-8"
  );

  const merged = await loadWorkspaceDesiredState(`${basePath},${overlayPath}`);

  assert.equal(merged.workspaceName, "Automation-Test");
  assert.equal(merged.tags.length, 2);

  const tagA = merged.tags.find((t) => t.name === "Tag A");
  assert.ok(tagA);
  assert.deepEqual(tagA.parameter?.[0]?.value, "<span/>");
});

