import type { WorkspaceDesiredState } from "./workspace-config";
import { stripDynamicFieldsDeep } from "./normalize";

interface NamedEntity {
  name?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function getName(entity: unknown): string | undefined {
  if (!isRecord(entity)) return undefined;
  const n = (entity as NamedEntity).name;
  return typeof n === "string" && n.trim().length ? n : undefined;
}

/**
 * Checks whether `current` satisfies all fields specified by `desired`.
 *
 * Extra fields present in `current` are ignored.
 */
export function matchesDesiredSubset(current: unknown, desired: unknown): boolean {
  if (desired === null || typeof desired !== "object") {
    return Object.is(current, desired);
  }

  if (Array.isArray(desired)) {
    if (!Array.isArray(current)) return false;
    if (current.length !== desired.length) return false;
    for (let i = 0; i < desired.length; i += 1) {
      if (!matchesDesiredSubset(current[i], desired[i])) return false;
    }
    return true;
  }

  if (!isRecord(current) || !isRecord(desired)) return false;

  for (const [k, dv] of Object.entries(desired)) {
    if (dv === undefined) continue;
    if (!(k in current)) return false;
    if (!matchesDesiredSubset(current[k], dv)) return false;
  }
  return true;
}

export interface EntityDiff {
  create: string[];
  update: string[];
  delete: string[];
}

export interface WorkspaceDiff {
  tags: EntityDiff;
  triggers: EntityDiff;
  variables: EntityDiff;
  templates: EntityDiff;
}

export interface WorkspaceSnapshot {
  tags: unknown[];
  triggers: unknown[];
  variables: unknown[];
  templates: unknown[];
}

function diffByName(desired: Array<{ name: string }>, current: unknown[]): EntityDiff {
  const currentByName = new Map<string, unknown>();
  for (const entity of current) {
    const name = getName(entity);
    if (!name) continue;
    currentByName.set(name.toLowerCase(), stripDynamicFieldsDeep(entity));
  }

  const desiredNamesLower = new Set<string>();
  const create: string[] = [];
  const update: string[] = [];

  for (const d of desired) {
    const nameLower = d.name.toLowerCase();
    desiredNamesLower.add(nameLower);
    const c = currentByName.get(nameLower);
    if (!c) {
      create.push(d.name);
      continue;
    }

    const desiredNormalized = stripDynamicFieldsDeep(d);
    if (!matchesDesiredSubset(c, desiredNormalized)) {
      update.push(d.name);
    }
  }

  const del: string[] = [];
  for (const nameLower of currentByName.keys()) {
    if (!desiredNamesLower.has(nameLower)) {
      // Keep the original casing unknown; just output lower-case name.
      del.push(nameLower);
    }
  }

  create.sort();
  update.sort();
  del.sort();

  return { create, update, delete: del };
}

/**
 * Computes a simple name-based diff between desired state and current workspace state.
 *
 * This is intentionally conservative:
 * - entity identity is by `name`
 * - updates are detected via subset matching (desired fields must match current)
 */
export function diffWorkspace(desired: WorkspaceDesiredState, current: WorkspaceSnapshot): WorkspaceDiff {
  return {
    tags: diffByName(desired.tags, current.tags),
    triggers: diffByName(desired.triggers, current.triggers),
    variables: diffByName(desired.variables, current.variables),
    templates: diffByName(desired.templates, current.templates)
  };
}

