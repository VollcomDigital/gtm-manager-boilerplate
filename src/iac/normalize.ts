const DYNAMIC_KEYS = new Set<string>([
  // Common GTM server-managed fields
  "accountId",
  "containerId",
  "workspaceId",
  "path",
  "tagManagerUrl",
  "fingerprint",

  // Entity IDs (IaC typically matches by name)
  "tagId",
  "triggerId",
  "variableId",
  "templateId"
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function getStringField(value: unknown, field: "name" | "key"): string | undefined {
  if (!isRecord(value)) return undefined;
  const v = value[field];
  return typeof v === "string" && v.trim().length ? v : undefined;
}

/**
 * Removes server-managed / environment-specific keys from a GTM API object.
 *
 * This is useful for producing stable JSON snapshots and for diffing desired
 * state (IaC) against live API responses.
 */
export function stripDynamicFieldsDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripDynamicFieldsDeep);
  }
  if (!isRecord(value)) {
    return value;
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (DYNAMIC_KEYS.has(k)) continue;
    out[k] = stripDynamicFieldsDeep(v);
  }
  return out;
}

/**
 * Canonicalizes a value into a deterministic representation for stable diffs.
 *
 * - object keys are sorted
 * - arrays of strings are sorted
 * - arrays of objects are sorted by `name` or `key` when present
 */
export function canonicalizeDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    if (value.every((v) => typeof v === "string")) {
      return [...value].sort((a, b) => (a as string).localeCompare(b as string));
    }

    const canonicalItems = value.map(canonicalizeDeep);

    // Sort arrays of objects by name/key where possible.
    if (canonicalItems.every((v) => isRecord(v))) {
      const items = canonicalItems as Array<Record<string, unknown>>;
      const hasName = items.every((v) => typeof v.name === "string");
      const hasKey = items.every((v) => typeof v.key === "string");
      if (hasName) {
        return [...items].sort((a, b) =>
          (String(a.name) as string).toLowerCase().localeCompare((String(b.name) as string).toLowerCase())
        );
      }
      if (hasKey) {
        return [...items].sort((a, b) =>
          (String(a.key) as string).toLowerCase().localeCompare((String(b.key) as string).toLowerCase())
        );
      }
    }

    return canonicalItems;
  }

  if (!isRecord(value)) {
    return value;
  }

  const out: Record<string, unknown> = {};
  const keys = Object.keys(value).sort((a, b) => a.localeCompare(b));
  for (const k of keys) {
    out[k] = canonicalizeDeep(value[k]);
  }
  return out;
}

/**
 * Normalizes an entity (desired/current) for diffing/comparison:
 * - strips dynamic/server-managed fields
 * - canonicalizes keys + common arrays to avoid order-only drift
 */
export function normalizeForDiff(value: unknown): unknown {
  return canonicalizeDeep(stripDynamicFieldsDeep(value));
}

