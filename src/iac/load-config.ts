import fs from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import {
  zWorkspaceDesiredState,
  zWorkspaceDesiredStatePartial,
  type WorkspaceDesiredState,
  type WorkspaceDesiredStatePartial
} from "./workspace-config";

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
  const resolved = path.isAbsolute(configPath) ? configPath : path.resolve(process.cwd(), configPath);
  const raw = await fs.readFile(resolved, "utf-8");

  const ext = path.extname(resolved).toLowerCase();
  let parsed: unknown;

  if (ext === ".yaml" || ext === ".yml") {
    try {
      parsed = parseYaml(raw);
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
    map.set(key, (deepMergeObjects(existing ?? {}, o) as unknown) as T);
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

function mergeDesiredStateParts(parts: WorkspaceDesiredStatePartial[]): WorkspaceDesiredState {
  const [first, ...rest] = parts;
  if (!first) {
    throw new Error("No config parts to merge.");
  }

  let out: WorkspaceDesiredState = {
    workspaceName: first.workspaceName,
    builtInVariableTypes: first.builtInVariableTypes ?? [],
    folders: first.folders ?? [],
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
    if (p.builtInVariableTypes) out.builtInVariableTypes = mergeStringSet(out.builtInVariableTypes, p.builtInVariableTypes);
    if (p.folders) out.folders = mergeByName(out.folders, p.folders);
    if (p.tags) out.tags = mergeByName(out.tags, p.tags);
    if (p.triggers) out.triggers = mergeByName(out.triggers, p.triggers);
    if (p.variables) out.variables = mergeByName(out.variables, p.variables);
    if (p.templates) out.templates = mergeByName(out.templates, p.templates);
    if (p.zones) out.zones = mergeByName(out.zones, p.zones);
  }

  return out;
}

