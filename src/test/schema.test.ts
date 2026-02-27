import assert from "node:assert/strict";
import test from "node:test";
import { zGtmTag } from "../types/gtm-schema";

test("zGtmTag: accepts minimal tag payload", () => {
  const parsed = zGtmTag.parse({
    name: "Example Tag",
    type: "html"
  });
  assert.equal(parsed.name, "Example Tag");
  assert.equal(parsed.type, "html");
});

test("zGtmTag: rejects empty name", () => {
  assert.throws(() => {
    zGtmTag.parse({ name: "", type: "html" });
  });
});
