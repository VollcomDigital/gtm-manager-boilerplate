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

function isPrimitiveComparable(value: unknown): boolean {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

function matchesPrimitiveArraySubset(current: unknown[], desired: unknown[]): boolean {
  return desired.every((dv) => current.some((cv) => Object.is(cv, dv)));
}

function resolveIdentityKey(items: unknown[]): "name" | "key" | undefined {
  const hasName = items.every((v) => isRecord(v) && typeof v.name === "string");
  if (hasName) {
    return "name";
  }
  const hasKey = items.every((v) => isRecord(v) && typeof v.key === "string");
  return hasKey ? "key" : undefined;
}

function buildIdentityIndex(items: unknown[], identityKey: "name" | "key"): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const item of items) {
    if (!isRecord(item)) {
      continue;
    }
    const id = item[identityKey];
    if (typeof id === "string" && id.trim().length) {
      out.set(id.toLowerCase(), item);
    }
  }
  return out;
}

function matchesNamedOrKeyedArraySubset(current: unknown[], desired: unknown[], identityKey: "name" | "key"): boolean {
  const currentIndex = buildIdentityIndex(current, identityKey);
  for (const desiredItem of desired) {
    const id = (desiredItem as Record<string, unknown>)[identityKey];
    if (typeof id !== "string") {
      return false;
    }
    const currentItem = currentIndex.get(id.toLowerCase());
    if (!currentItem || !matchesDesiredSubset(currentItem, desiredItem)) {
      return false;
    }
  }
  return true;
}

function matchesOrderedArray(current: unknown[], desired: unknown[]): boolean {
  if (current.length !== desired.length) {
    return false;
  }
  return desired.every((dv, i) => matchesDesiredSubset(current[i], dv));
}

function matchesDesiredArray(current: unknown, desired: unknown[]): boolean {
  if (!Array.isArray(current)) {
    return false;
  }
  if (desired.length === 0) {
    return true;
  }
  if (desired.every(isPrimitiveComparable)) {
    return matchesPrimitiveArraySubset(current, desired);
  }

  const identityKey = resolveIdentityKey(desired);
  if (identityKey) {
    return matchesNamedOrKeyedArraySubset(current, desired, identityKey);
  }
  return matchesOrderedArray(current, desired);
}

function matchesDesiredObject(current: unknown, desired: Record<string, unknown>): boolean {
  if (!isRecord(current)) {
    return false;
  }
  for (const [key, desiredValue] of Object.entries(desired)) {
    if (desiredValue === undefined) {
      continue;
    }
    if (!(key in current) || !matchesDesiredSubset(current[key], desiredValue)) {
      return false;
    }
  }
  return true;
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
    return matchesDesiredArray(current, desired);
  }

  if (!isRecord(desired)) {
    return false;
  }
  return matchesDesiredObject(current, desired);
}

export interface EntityDiff {
  create: string[];
  update: string[];
  delete: string[];
}

export interface WorkspaceDiff {
  environments: EntityDiff;
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
  environments: unknown[];
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

  create.sort((a, b) => a.localeCompare(b));
  update.sort((a, b) => a.localeCompare(b));
  del.sort((a, b) => a.localeCompare(b));

  return { create, update, delete: del };
}

function asCurrentStringSetEntry(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (!isRecord(value) || typeof value.type !== "string") {
    return undefined;
  }
  return value.type;
}

function buildDesiredStringSetIndex(values: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const value of values) {
    const key = value.trim().toLowerCase();
    if (key) {
      out.set(key, value);
    }
  }
  return out;
}

function buildCurrentStringSetIndex(values: unknown[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const value of values) {
    const raw = asCurrentStringSetEntry(value);
    if (!raw) {
      continue;
    }
    const key = raw.trim().toLowerCase();
    if (key) {
      out.set(key, raw);
    }
  }
  return out;
}

function collectMissingValues(source: Map<string, string>, target: Map<string, string>): string[] {
  const out: string[] = [];
  for (const [key, value] of source.entries()) {
    if (!target.has(key)) {
      out.push(value);
    }
  }
  return out;
}

function diffStringSet(desired: string[], current: unknown[]): EntityDiff {
  const desiredByLower = buildDesiredStringSetIndex(desired);
  const currentByLower = buildCurrentStringSetIndex(current);

  const create = collectMissingValues(desiredByLower, currentByLower);
  const update: string[] = [];
  const del = collectMissingValues(currentByLower, desiredByLower);

  create.sort((a, b) => a.localeCompare(b));
  del.sort((a, b) => a.localeCompare(b));
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
    environments: diffByName(desired.environments, current.environments),
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

