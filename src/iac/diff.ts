import type { WorkspaceDesiredState } from "./workspace-config";
import { normalizeForDiff } from "./normalize";

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
    if (desired.length === 0) return true;

    // If desired array contains primitives, treat it as a subset.
    const primitives = desired.every((v) => v === null || ["string", "number", "boolean"].includes(typeof v));
    if (primitives) {
      return desired.every((dv) => current.some((cv) => Object.is(cv, dv)));
    }

    // If desired array contains named/keyed objects, match by identity key.
    const desiredHasName = desired.every((v) => isRecord(v) && typeof v.name === "string");
    const desiredHasKey = desired.every((v) => isRecord(v) && typeof v.key === "string");
    if (desiredHasName || desiredHasKey) {
      const identityKey = desiredHasName ? "name" : "key";
      const currentIndex = new Map<string, unknown>();
      for (const cv of current) {
        if (!isRecord(cv)) continue;
        const id = cv[identityKey];
        if (typeof id === "string" && id.trim().length) {
          currentIndex.set(id.toLowerCase(), cv);
        }
      }

      for (const dv of desired) {
        const id = (dv as Record<string, unknown>)[identityKey];
        if (typeof id !== "string") return false;
        const cv = currentIndex.get(id.toLowerCase());
        if (!cv) return false;
        if (!matchesDesiredSubset(cv, dv)) return false;
      }
      return true;
    }

    // Fallback: treat as ordered array (same length and position).
    if (current.length !== desired.length) return false;
    return desired.every((dv, i) => matchesDesiredSubset(current[i], dv));
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
  builtInVariables: EntityDiff;
  folders: EntityDiff;
  clients: EntityDiff;
  transformations: EntityDiff;
  tags: EntityDiff;
  triggers: EntityDiff;
  variables: EntityDiff;
  templates: EntityDiff;
  zones: EntityDiff;
}

export interface WorkspaceSnapshot {
  builtInVariables: unknown[];
  folders: unknown[];
  clients: unknown[];
  transformations: unknown[];
  tags: unknown[];
  triggers: unknown[];
  variables: unknown[];
  templates: unknown[];
  zones: unknown[];
}

function diffByName(desired: Array<{ name: string }>, current: unknown[]): EntityDiff {
  const currentByName = new Map<string, unknown>();
  for (const entity of current) {
    const name = getName(entity);
    if (!name) continue;
    currentByName.set(name.toLowerCase(), normalizeForDiff(entity));
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

    const desiredNormalized = normalizeForDiff(d);
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

function diffStringSet(desired: string[], current: unknown[]): EntityDiff {
  const desiredByLower = new Map<string, string>();
  for (const v of desired) {
    const key = v.trim().toLowerCase();
    if (key) desiredByLower.set(key, v);
  }

  const currentByLower = new Map<string, string>();
  for (const v of current) {
    let raw: string | undefined;
    if (typeof v === "string") {
      raw = v;
    } else if (isRecord(v) && typeof v.type === "string") {
      // Support passing API objects like Schema$BuiltInVariable.
      raw = v.type;
    }
    if (!raw) continue;
    const key = raw.trim().toLowerCase();
    if (key) currentByLower.set(key, raw);
  }

  const create: string[] = [];
  const update: string[] = [];
  const del: string[] = [];

  for (const [k, v] of desiredByLower.entries()) {
    if (!currentByLower.has(k)) create.push(v);
  }
  for (const [k, v] of currentByLower.entries()) {
    if (!desiredByLower.has(k)) del.push(v);
  }

  create.sort();
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
    builtInVariables: diffStringSet(desired.builtInVariableTypes, current.builtInVariables),
    folders: diffByName(desired.folders, current.folders),
    clients: diffByName(desired.clients, current.clients),
    transformations: diffByName(desired.transformations, current.transformations),
    tags: diffByName(desired.tags, current.tags),
    triggers: diffByName(desired.triggers, current.triggers),
    variables: diffByName(desired.variables, current.variables),
    templates: diffByName(desired.templates, current.templates),
    zones: diffByName(desired.zones, current.zones)
  };
}

