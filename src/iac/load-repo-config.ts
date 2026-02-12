import fs from "node:fs/promises";
import path from "node:path";
import { parseDocument } from "yaml";
import {
  zRepoConfig,
  zRepoConfigPartial,
  zRepoContainer,
  type RepoConfig,
  type RepoConfigPartial,
  type RepoContainer,
  type RepoContainerPartial
} from "./repo-config";

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

function lower(s: string): string {
  return s.trim().toLowerCase();
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
    map.set(lower(e.name), e);
  }
  for (const o of overlay) {
    const key = lower(o.name);
    const existing = map.get(key);
    map.set(key, (deepMergeObjects(existing ?? {}, o) as unknown) as T);
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function mergeStringSet(base: string[], overlay: string[]): string[] {
  const out = new Map<string, string>();
  for (const v of base) {
    const k = lower(v);
    if (!k) continue;
    out.set(k, v);
  }
  for (const v of overlay) {
    const k = lower(v);
    if (!k) continue;
    out.set(k, v);
  }
  return [...out.values()].sort((a, b) => a.localeCompare(b));
}

function mergeWorkspace(base: unknown, overlay: unknown): unknown {
  if (!isRecord(base) || !isRecord(overlay)) return overlay;

  const out: Record<string, unknown> = { ...base };

  // workspaceName: overlay wins if present
  if (typeof overlay.workspaceName === "string" && overlay.workspaceName.trim()) {
    out.workspaceName = overlay.workspaceName;
  }

  // builtInVariableTypes: union/merge if provided
  if (Array.isArray(overlay.builtInVariableTypes)) {
    const baseList = Array.isArray(base.builtInVariableTypes) ? (base.builtInVariableTypes as unknown[]) : [];
    const overlayList = overlay.builtInVariableTypes as unknown[];
    out.builtInVariableTypes = mergeStringSet(
      baseList.filter((v): v is string => typeof v === "string"),
      overlayList.filter((v): v is string => typeof v === "string")
    );
  }

  // policy.protectedNames: union/merge if provided
  if (isRecord(overlay.policy)) {
    const basePolicy = isRecord(base.policy) ? base.policy : {};
    const overlayPolicy = overlay.policy;

    const baseProtected = isRecord(basePolicy.protectedNames) ? basePolicy.protectedNames : {};
    const overlayProtected = isRecord(overlayPolicy.protectedNames) ? overlayPolicy.protectedNames : {};

    const keys = [
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
    ] as const;

    const mergedProtected: Record<string, unknown> = {};
    for (const k of keys) {
      const b = Array.isArray(baseProtected[k]) ? (baseProtected[k] as unknown[]) : [];
      const o = Array.isArray(overlayProtected[k]) ? (overlayProtected[k] as unknown[]) : [];
      mergedProtected[k] = mergeStringSet(
        b.filter((v): v is string => typeof v === "string"),
        o.filter((v): v is string => typeof v === "string")
      );
    }

    out.policy = { protectedNames: mergedProtected };
    if (Array.isArray(overlayPolicy.deleteAllowTypes)) {
      const b = Array.isArray(basePolicy.deleteAllowTypes) ? (basePolicy.deleteAllowTypes as unknown[]) : [];
      const o = overlayPolicy.deleteAllowTypes as unknown[];
      (out.policy as Record<string, unknown>).deleteAllowTypes = mergeStringSet(
        b.filter((v): v is string => typeof v === "string"),
        o.filter((v): v is string => typeof v === "string")
      );
    }
    if (Array.isArray(overlayPolicy.deleteDenyTypes)) {
      const b = Array.isArray(basePolicy.deleteDenyTypes) ? (basePolicy.deleteDenyTypes as unknown[]) : [];
      const o = overlayPolicy.deleteDenyTypes as unknown[];
      (out.policy as Record<string, unknown>).deleteDenyTypes = mergeStringSet(
        b.filter((v): v is string => typeof v === "string"),
        o.filter((v): v is string => typeof v === "string")
      );
    }
  }

  // Lists: merge by name if provided
  for (const listKey of ["environments", "folders", "clients", "transformations", "tags", "triggers", "variables", "templates", "zones"] as const) {
    const oList = overlay[listKey];
    if (!Array.isArray(oList)) continue;

    const bList = Array.isArray(base[listKey]) ? (base[listKey] as unknown[]) : [];
    out[listKey] = mergeByName(bList as Array<{ name: string }>, oList as Array<{ name: string }>);
  }

  return out;
}

function mergeContainer(base: RepoContainerPartial, overlay: RepoContainerPartial): RepoContainerPartial {
  const merged: RepoContainerPartial = { key: base.key };

  // description
  merged.description = overlay.description ?? base.description;

  // labels: merge map
  merged.labels = {
    ...(base.labels ?? {}),
    ...(overlay.labels ?? {})
  };

  // target: shallow merge (overlay wins)
  merged.target = {
    ...(base.target ?? {}),
    ...(overlay.target ?? {})
  };

  // workspace: merge by entity name
  if (base.workspace && overlay.workspace) {
    merged.workspace = mergeWorkspace(base.workspace, overlay.workspace) as RepoContainerPartial["workspace"];
  } else {
    merged.workspace = overlay.workspace ?? base.workspace;
  }

  return merged;
}

async function loadConfigFileAny(resolvedPath: string): Promise<unknown> {
  const raw = await fs.readFile(resolvedPath, "utf-8");
  const ext = path.extname(resolvedPath).toLowerCase();
  if (ext === ".yaml" || ext === ".yml") {
    const doc = parseDocument(raw, { uniqueKeys: true });
    if (doc.errors.length > 0) {
      const details = doc.errors.map((e) => e.message).join("; ");
      throw new Error(details);
    }
    return doc.toJS();
  }
  return JSON.parse(raw);
}

async function loadRepoConfigPart(configPath: string): Promise<RepoConfigPartial> {
  const resolved = resolvePathWithinWorkspace(configPath);
  let parsed: unknown;
  try {
    parsed = await loadConfigFileAny(resolved);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse config "${resolved}": ${msg}`);
  }
  return zRepoConfigPartial.parse(parsed);
}

function finalizeRepoConfig(partial: { defaults?: { workspaceName?: string }; containers: RepoContainerPartial[] }): RepoConfig {
  const workspaceNameDefault = partial.defaults?.workspaceName ?? "iac";

  const containers: RepoContainer[] = partial.containers.map((c) => {
    const workspaceName =
      (c.workspace as unknown as { workspaceName?: string } | undefined)?.workspaceName ?? workspaceNameDefault;

    // Build final container record:
    const container: unknown = {
      key: c.key,
      labels: c.labels ?? {},
      description: c.description,
      target: c.target,
      workspace: {
        workspaceName,
        policy: (c.workspace as unknown as { policy?: unknown } | undefined)?.policy,
        builtInVariableTypes:
          (c.workspace as unknown as { builtInVariableTypes?: unknown[] } | undefined)?.builtInVariableTypes ?? [],
        environments: (c.workspace as unknown as { environments?: unknown[] } | undefined)?.environments ?? [],
        folders: (c.workspace as unknown as { folders?: unknown[] } | undefined)?.folders ?? [],
        clients: (c.workspace as unknown as { clients?: unknown[] } | undefined)?.clients ?? [],
        transformations: (c.workspace as unknown as { transformations?: unknown[] } | undefined)?.transformations ?? [],
        tags: (c.workspace as unknown as { tags?: unknown[] } | undefined)?.tags ?? [],
        triggers: (c.workspace as unknown as { triggers?: unknown[] } | undefined)?.triggers ?? [],
        variables: (c.workspace as unknown as { variables?: unknown[] } | undefined)?.variables ?? [],
        templates: (c.workspace as unknown as { templates?: unknown[] } | undefined)?.templates ?? [],
        zones: (c.workspace as unknown as { zones?: unknown[] } | undefined)?.zones ?? []
      }
    };

    // Validate each container/workspace with strict schemas.
    return zRepoContainer.parse(container);
  });

  return zRepoConfig.parse({
    schemaVersion: 1,
    defaults: { workspaceName: workspaceNameDefault },
    containers
  });
}

/**
 * Loads a repo-level IaC config.
 *
 * Supports JSON/YAML and base+overlay merging:
 * - `--config base.yml,prod.yml`
 * - merge is by `containers[].key`
 * - later overlays win for scalar fields and are merged for workspace entities by name
 */
export async function loadRepoConfig(configPathsCsv: string): Promise<RepoConfig> {
  const configPaths = configPathsCsv
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);

  if (configPaths.length === 0) {
    throw new Error("Missing config path.");
  }

  const parts = await Promise.all(configPaths.map(loadRepoConfigPart));

  const mergedContainers = new Map<string, RepoContainerPartial>();
  let workspaceNameDefault: string | undefined;

  for (const part of parts) {
    if (part.defaults?.workspaceName) {
      workspaceNameDefault = part.defaults.workspaceName;
    }

    for (const c of part.containers) {
      const key = lower(c.key);
      const existing = mergedContainers.get(key);
      mergedContainers.set(key, existing ? mergeContainer(existing, c) : c);
    }
  }

  const input: { containers: RepoContainerPartial[]; defaults?: { workspaceName?: string } } = {
    containers: [...mergedContainers.values()]
  };
  if (workspaceNameDefault) {
    input.defaults = { workspaceName: workspaceNameDefault };
  }

  return finalizeRepoConfig(input);
}

