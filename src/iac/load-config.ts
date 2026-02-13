import fs from "node:fs/promises";
import path from "node:path";
import { parseDocument } from "yaml";
import {
  zWorkspaceDesiredState,
  zWorkspaceDesiredStatePartial,
  type WorkspaceDesiredState,
  type WorkspaceDesiredStatePartial
} from "./workspace-config";

const WORKSPACE_ROOT = path.resolve(process.cwd());
const WORKSPACE_ROOT_WITH_SEP = WORKSPACE_ROOT.endsWith(path.sep) ? WORKSPACE_ROOT : `${WORKSPACE_ROOT}${path.sep}`;

function resolvePathWithinWorkspace(inputPath: string): string {
  const candidate = inputPath.trim();
  if (!candidate || candidate.includes("\0") || candidate.includes("\n") || candidate.includes("\r")) {
    throw new Error(`Invalid config path: "${inputPath}"`);
  }

  const resolved = path.normalize(path.resolve(WORKSPACE_ROOT, candidate));
  if (resolved !== WORKSPACE_ROOT && !resolved.startsWith(WORKSPACE_ROOT_WITH_SEP)) {
    throw new Error(`Config path must be within workspace root: "${inputPath}"`);
  }
  return resolved;
}

/**
 * Loads a desired-state workspace config from one or more files.
 *
 * Supported formats: JSON (.json) and YAML (.yml/.yaml).
 *
 * Overlay support:
 * - You can pass a comma-separated list of config paths.
 * - Later files override earlier ones by entity name (tags/triggers/variables/templates).
 */
export async function loadWorkspaceDesiredState(configPath: string): Promise<WorkspaceDesiredState> {
  const configPaths = configPath
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);

  if (configPaths.length === 0) {
    throw new Error("Missing config path.");
  }

  const parts: WorkspaceDesiredStatePartial[] = [];
  for (const p of configPaths) {
    parts.push(await loadWorkspaceDesiredStatePartial(p));
  }

  const merged = mergeDesiredStateParts(parts);
  return zWorkspaceDesiredState.parse(merged);
}

async function loadWorkspaceDesiredStatePartial(configPath: string): Promise<WorkspaceDesiredStatePartial> {
  const resolved = resolvePathWithinWorkspace(configPath);
  const raw = await fs.readFile(resolved, "utf-8");

  const ext = path.extname(resolved).toLowerCase();
  let parsed: unknown;

  if (ext === ".yaml" || ext === ".yml") {
    try {
      const doc = parseDocument(raw, { uniqueKeys: true });
      if (doc.errors.length > 0) {
        const details = doc.errors.map((e) => e.message).join("; ");
        throw new Error(details);
      }
      parsed = doc.toJS();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Invalid YAML in "${resolved}": ${msg}`);
    }
  } else {
    try {
      parsed = JSON.parse(raw);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Invalid JSON in "${resolved}": ${msg}`);
    }
  }

  return zWorkspaceDesiredStatePartial.parse(parsed);
}

function lowerName(name: string): string {
  return name.trim().toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function deepMergeObjects(current: unknown, overlay: unknown): unknown {
  if (Array.isArray(overlay)) return overlay;
  if (!isRecord(current) || !isRecord(overlay)) return overlay;

  const out: Record<string, unknown> = { ...current };
  for (const [k, v] of Object.entries(overlay)) {
    if (v === undefined) continue;
    const existing = out[k];
    if (Array.isArray(v)) {
      out[k] = v;
    } else if (isRecord(v) && isRecord(existing)) {
      out[k] = deepMergeObjects(existing, v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function mergeByName<T extends { name: string }>(base: T[], overlay: T[]): T[] {
  const map = new Map<string, T>();
  for (const e of base) {
    map.set(lowerName(e.name), e);
  }
  for (const o of overlay) {
    const key = lowerName(o.name);
    const existing = map.get(key);
    map.set(key, deepMergeObjects(existing ?? {}, o) as T);
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function mergeStringSet(base: string[], overlay: string[]): string[] {
  const out = new Map<string, string>();
  for (const v of base) {
    const k = v.trim().toLowerCase();
    if (!k) continue;
    out.set(k, v);
  }
  for (const v of overlay) {
    const k = v.trim().toLowerCase();
    if (!k) continue;
    out.set(k, v);
  }
  return [...out.values()].sort((a, b) => a.localeCompare(b));
}

function makeEmptyPolicy(): WorkspaceDesiredState["policy"] {
  return {
    protectedNames: {
      builtInVariableTypes: [],
      environments: [],
      folders: [],
      clients: [],
      transformations: [],
      tags: [],
      triggers: [],
      variables: [],
      templates: [],
      zones: []
    },
    deleteAllowTypes: [],
    deleteDenyTypes: []
  };
}

const PROTECTED_NAME_KEYS: Array<keyof WorkspaceDesiredState["policy"]["protectedNames"]> = [
  "builtInVariableTypes",
  "environments",
  "folders",
  "clients",
  "transformations",
  "tags",
  "triggers",
  "variables",
  "templates",
  "zones"
];

function mergePolicy(
  base: WorkspaceDesiredState["policy"],
  overlay: WorkspaceDesiredState["policy"]
): WorkspaceDesiredState["policy"] {
  const merged = makeEmptyPolicy();
  for (const key of PROTECTED_NAME_KEYS) {
    merged.protectedNames[key] = mergeStringSet(base.protectedNames[key], overlay.protectedNames[key]);
  }
  merged.deleteAllowTypes = mergeStringSet(base.deleteAllowTypes, overlay.deleteAllowTypes);
  merged.deleteDenyTypes = mergeStringSet(base.deleteDenyTypes, overlay.deleteDenyTypes);
  return merged;
}

function mergeEntityLists(out: WorkspaceDesiredState, partial: WorkspaceDesiredStatePartial): void {
  if (partial.builtInVariableTypes) {
    out.builtInVariableTypes = mergeStringSet(out.builtInVariableTypes, partial.builtInVariableTypes);
  }
  if (partial.environments) out.environments = mergeByName(out.environments, partial.environments);
  if (partial.folders) out.folders = mergeByName(out.folders, partial.folders);
  if (partial.clients) out.clients = mergeByName(out.clients, partial.clients);
  if (partial.transformations) out.transformations = mergeByName(out.transformations, partial.transformations);
  if (partial.tags) out.tags = mergeByName(out.tags, partial.tags);
  if (partial.triggers) out.triggers = mergeByName(out.triggers, partial.triggers);
  if (partial.variables) out.variables = mergeByName(out.variables, partial.variables);
  if (partial.templates) out.templates = mergeByName(out.templates, partial.templates);
  if (partial.zones) out.zones = mergeByName(out.zones, partial.zones);
}

function mergeDesiredStateParts(parts: WorkspaceDesiredStatePartial[]): WorkspaceDesiredState {
  const [first, ...rest] = parts;
  if (!first) {
    throw new Error("No config parts to merge.");
  }

  let out: WorkspaceDesiredState = {
    workspaceName: first.workspaceName,
    policy: first.policy ?? makeEmptyPolicy(),
    builtInVariableTypes: first.builtInVariableTypes ?? [],
    environments: first.environments ?? [],
    folders: first.folders ?? [],
    clients: first.clients ?? [],
    transformations: first.transformations ?? [],
    tags: first.tags ?? [],
    triggers: first.triggers ?? [],
    variables: first.variables ?? [],
    templates: first.templates ?? [],
    zones: first.zones ?? []
  };

  for (const p of rest) {
    if (p.workspaceName !== out.workspaceName) {
      throw new Error(`workspaceName mismatch across overlays: "${out.workspaceName}" vs "${p.workspaceName}"`);
    }
    if (p.policy) {
      out.policy = mergePolicy(out.policy, p.policy);
    }
    mergeEntityLists(out, p);
  }

  return out;
}

