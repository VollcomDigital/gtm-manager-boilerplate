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

