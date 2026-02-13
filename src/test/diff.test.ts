import assert from "node:assert/strict";
import test from "node:test";
import { matchesDesiredSubset } from "../iac/diff";
import { normalizeForDiff } from "../iac/normalize";

test("matchesDesiredSubset: parameter array order does not matter after normalize", () => {
  const current = normalizeForDiff({
    name: "Tag A",
    type: "gaawc",
    parameter: [
      { key: "sendPageView", type: "BOOLEAN", value: "true" },
      { key: "measurementId", type: "TEMPLATE", value: "G-XXXX" }
    ]
  });

  const desired = normalizeForDiff({
    name: "Tag A",
    type: "gaawc",
    parameter: [
      { key: "measurementId", type: "TEMPLATE", value: "G-XXXX" },
      { key: "sendPageView", type: "BOOLEAN", value: "true" }
    ]
  });

  assert.equal(matchesDesiredSubset(current, desired), true);
});

test("matchesDesiredSubset: desired parameter subset matches current superset", () => {
  const current = normalizeForDiff({
    name: "Tag A",
    type: "gaawc",
    parameter: [
      { key: "measurementId", type: "TEMPLATE", value: "G-XXXX" },
      { key: "sendPageView", type: "BOOLEAN", value: "true" }
    ]
  });

  const desired = normalizeForDiff({
    name: "Tag A",
    parameter: [{ key: "measurementId", value: "G-XXXX" }]
  });

  assert.equal(matchesDesiredSubset(current, desired), true);
});

