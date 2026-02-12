import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadWorkspaceDesiredState } from "../iac/load-config";

test("loadWorkspaceDesiredState: supports JSON + YAML overlays (merge by name)", async () => {
  const tmpDir = await fs.mkdtemp(path.join(process.cwd(), ".tmp-gtm-iac-config-"));
  try {
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
    const value = (tagA as unknown as { parameter?: Array<{ value?: unknown }> }).parameter?.[0]?.value;
    assert.equal(value, "<span/>");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("loadWorkspaceDesiredState: rejects config paths outside workspace root", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "gtm-iac-outside-config-"));
  const outsidePath = path.join(tmpDir, "outside.json");
  try {
    await fs.writeFile(outsidePath, JSON.stringify({ workspaceName: "Automation-Test" }), "utf-8");
    await assert.rejects(
      loadWorkspaceDesiredState(outsidePath),
      /Config path must be within workspace root/
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

