import assert from "node:assert/strict";
import test from "node:test";
import type { tagmanager_v2 } from "googleapis";
import {
  zGtmCustomTemplate,
  zGtmEnvironment,
  zGtmFolder,
  zGtmServerClient,
  zGtmServerTransformation,
  zGtmTag,
  zGtmTrigger,
  zGtmVariable,
  zGtmZone
} from "../types/gtm-schema";

test("schema contract: zod schemas accept googleapis-shaped resources", () => {
  const tagFromApi: tagmanager_v2.Schema$Tag = { name: "Tag A", type: "html" };
  const triggerFromApi: tagmanager_v2.Schema$Trigger = { name: "All Pages", type: "PAGEVIEW" };
  const variableFromApi: tagmanager_v2.Schema$Variable = { name: "Var A", type: "v" };
  const templateFromApi: tagmanager_v2.Schema$CustomTemplate = { name: "Tpl A", templateData: "const x = 1;" };
  const zoneFromApi: tagmanager_v2.Schema$Zone = { name: "Zone A" };
  const folderFromApi: tagmanager_v2.Schema$Folder = { name: "Folder A" };
  const environmentFromApi: tagmanager_v2.Schema$Environment = { name: "Staging", type: "USER" };
  const clientFromApi: tagmanager_v2.Schema$Client = { name: "HTTP Client", type: "http" };
  const transformationFromApi: tagmanager_v2.Schema$Transformation = { name: "PII Redact", type: "allowlist" };

  assert.equal(zGtmTag.parse(tagFromApi).name, "Tag A");
  assert.equal(zGtmTrigger.parse(triggerFromApi).name, "All Pages");
  assert.equal(zGtmVariable.parse(variableFromApi).name, "Var A");
  assert.equal(zGtmCustomTemplate.parse(templateFromApi).name, "Tpl A");
  assert.equal(zGtmZone.parse(zoneFromApi).name, "Zone A");
  assert.equal(zGtmFolder.parse(folderFromApi).name, "Folder A");
  assert.equal(zGtmEnvironment.parse(environmentFromApi).name, "Staging");
  assert.equal(zGtmServerClient.parse(clientFromApi).name, "HTTP Client");
  assert.equal(zGtmServerTransformation.parse(transformationFromApi).name, "PII Redact");
});
