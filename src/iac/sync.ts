import type { tagmanager_v2 } from "googleapis";
import type { GtmClient } from "../lib/gtm-client";
import type { GtmCustomTemplate, GtmTag, GtmTrigger, GtmVariable, GtmZone } from "../types/gtm-schema";
import type { WorkspaceDesiredState } from "./workspace-config";
import { matchesDesiredSubset } from "./diff";
import { sha256HexFromString } from "./hash";
import { normalizeForDiff, stripDynamicFieldsDeep } from "./normalize";
import { fetchWorkspaceSnapshot } from "./snapshot";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function lower(s: string): string {
  return s.trim().toLowerCase();
}

function ensureUniqueNames(entities: Array<{ name: string }>, entityType: string): void {
  const seen = new Set<string>();
  for (const e of entities) {
    const k = lower(e.name);
    if (seen.has(k)) {
      throw new Error(`Duplicate ${entityType} name in desired config: "${e.name}"`);
    }
    seen.add(k);
  }
}

function mergeDesiredIntoCurrent(current: unknown, desired: unknown): unknown {
  // Arrays are treated as full replacements.
  if (Array.isArray(desired)) return desired;
  if (!isRecord(current) || !isRecord(desired)) return desired;

  const out: Record<string, unknown> = { ...current };
  for (const [k, dv] of Object.entries(desired)) {
    if (dv === undefined) continue;
    const cv = out[k];
    if (Array.isArray(dv)) {
      out[k] = dv;
      continue;
    }
    if (isRecord(dv) && isRecord(cv)) {
      out[k] = mergeDesiredIntoCurrent(cv, dv);
      continue;
    }
    out[k] = dv;
  }
  return out;
}

function tagWithResolvedTriggers(
  desiredTag: unknown,
  triggerNameToId: Map<string, string>
): unknown {
  if (!isRecord(desiredTag)) return desiredTag;
  const out: Record<string, unknown> = { ...desiredTag };

  const firingIds = out.firingTriggerId;
  const firingNames = out.firingTriggerNames;
  if (firingIds !== undefined && firingNames !== undefined) {
    throw new Error(`Tag "${String(out.name ?? "?")}" cannot specify both firingTriggerId and firingTriggerNames.`);
  }

  const blockingIds = out.blockingTriggerId;
  const blockingNames = out.blockingTriggerNames;
  if (blockingIds !== undefined && blockingNames !== undefined) {
    throw new Error(`Tag "${String(out.name ?? "?")}" cannot specify both blockingTriggerId and blockingTriggerNames.`);
  }

  if (Array.isArray(firingNames)) {
    const resolved: string[] = [];
    for (const n of firingNames) {
      if (typeof n !== "string" || !n.trim()) continue;
      const id = triggerNameToId.get(lower(n));
      if (!id) {
        throw new Error(`Tag "${String(out.name ?? "?")}" references missing trigger by name: "${n}"`);
      }
      resolved.push(id);
    }
    out.firingTriggerId = resolved;
    delete out.firingTriggerNames;
  }

  if (Array.isArray(blockingNames)) {
    const resolved: string[] = [];
    for (const n of blockingNames) {
      if (typeof n !== "string" || !n.trim()) continue;
      const id = triggerNameToId.get(lower(n));
      if (!id) {
        throw new Error(`Tag "${String(out.name ?? "?")}" references missing blocking trigger by name: "${n}"`);
      }
      resolved.push(id);
    }
    out.blockingTriggerId = resolved;
    delete out.blockingTriggerNames;
  }

  return out;
}

function zoneWithResolvedCustomEvalTriggers(
  desiredZone: unknown,
  triggerNameToId: Map<string, string>
): unknown {
  if (!isRecord(desiredZone)) return desiredZone;
  const out: Record<string, unknown> = { ...desiredZone };

  const boundary = out.boundary;
  if (!isRecord(boundary)) {
    return out;
  }

  const customIds = boundary.customEvaluationTriggerId;
  const customNames = boundary.customEvaluationTriggerNames;
  if (customIds !== undefined && customNames !== undefined) {
    throw new Error(`Zone "${String(out.name ?? "?")}" cannot specify both boundary.customEvaluationTriggerId and boundary.customEvaluationTriggerNames.`);
  }

  if (Array.isArray(customNames)) {
    const resolved: string[] = [];
    for (const n of customNames) {
      if (typeof n !== "string" || !n.trim()) continue;
      const id = triggerNameToId.get(lower(n));
      if (!id) {
        throw new Error(`Zone "${String(out.name ?? "?")}" references missing custom evaluation trigger by name: "${n}"`);
      }
      resolved.push(id);
    }
    out.boundary = {
      ...boundary,
      customEvaluationTriggerId: resolved
    };
    delete (out.boundary as Record<string, unknown>).customEvaluationTriggerNames;
  }

  return out;
}

function normalizeEntityName<T extends { name?: string | null }>(entity: T): string | undefined {
  const name = entity.name ?? undefined;
  if (!name) return undefined;
  const trimmed = name.trim();
  return trimmed.length ? trimmed : undefined;
}

export interface EntitySyncSummary {
  created: string[];
  updated: string[];
  deleted: string[];
  skipped: string[];
}

export interface SyncWorkspaceResult {
  workspacePath: string;
  templates: EntitySyncSummary;
  variables: EntitySyncSummary;
  triggers: EntitySyncSummary;
  zones: EntitySyncSummary;
  tags: EntitySyncSummary;
  warnings: string[];
}

export interface SyncWorkspaceOptions {
  dryRun: boolean;
  deleteMissing: boolean;
  updateExisting: boolean;
  validateVariableRefs: boolean;
}

function emptySummary(): EntitySyncSummary {
  return { created: [], updated: [], deleted: [], skipped: [] };
}

function shouldUpdate(currentEntity: unknown, desiredEntity: unknown): boolean {
  const currentNormalized = normalizeForDiff(currentEntity);
  const desiredNormalized = normalizeForDiff(desiredEntity);
  return !matchesDesiredSubset(currentNormalized, desiredNormalized);
}

export async function syncWorkspace(
  gtm: GtmClient,
  workspacePath: string,
  desired: WorkspaceDesiredState,
  options: SyncWorkspaceOptions
): Promise<SyncWorkspaceResult> {
  ensureUniqueNames(desired.templates, "template");
  ensureUniqueNames(desired.variables, "variable");
  ensureUniqueNames(desired.triggers, "trigger");
  ensureUniqueNames(desired.zones, "zone");
  ensureUniqueNames(desired.tags, "tag");

  const snapshot = await fetchWorkspaceSnapshot(gtm, workspacePath);

  const res: SyncWorkspaceResult = {
    workspacePath,
    templates: emptySummary(),
    variables: emptySummary(),
    triggers: emptySummary(),
    zones: emptySummary(),
    tags: emptySummary(),
    warnings: []
  };

  // ----------------------------
  // Templates
  // ----------------------------
  const currentTemplatesByName = new Map<string, tagmanager_v2.Schema$CustomTemplate>();
  for (const t of snapshot.templates) {
    const name = normalizeEntityName(t);
    if (name) currentTemplatesByName.set(lower(name), t);
  }

  for (const dt of desired.templates) {
    const key = lower(dt.name);
    const existing = currentTemplatesByName.get(key);

    // Optional: allow pinning templateData via a hash in config.
    // If provided, we verify the content before applying changes.
    if (isRecord(dt)) {
      const expected = dt.__sha256;
      if (typeof expected === "string" && expected.trim().length) {
        const actual = sha256HexFromString(String(dt.templateData ?? ""));
        if (actual !== expected.trim().toLowerCase()) {
          throw new Error(`Template "${dt.name}" __sha256 mismatch (expected=${expected}, actual=${actual}).`);
        }
      }
    }

    if (!existing) {
      res.templates.created.push(dt.name);
      if (!options.dryRun) {
        await gtm.createTemplate(workspacePath, dt as unknown as GtmCustomTemplate);
      }
      continue;
    }

    if (!options.updateExisting) {
      res.templates.skipped.push(dt.name);
      continue;
    }

    if (!shouldUpdate(existing, dt)) {
      res.templates.skipped.push(dt.name);
      continue;
    }

    res.templates.updated.push(dt.name);
    if (!options.dryRun) {
      if (!existing.path && !existing.templateId) {
        throw new Error(`Cannot update template "${dt.name}" (missing path/templateId).`);
      }
      const merged = mergeDesiredIntoCurrent(existing, dt);
      const body = stripDynamicFieldsDeep(merged) as unknown as GtmCustomTemplate;
      // Prefer path if present.
      const fingerprint = existing.fingerprint ?? undefined;
      if (existing.path) {
        await gtm.updateTemplate(existing.path, body as unknown as GtmCustomTemplate, fingerprint ? { fingerprint } : {});
      } else {
        await gtm.updateTemplateById(
          workspacePath,
          existing.templateId!,
          body as unknown as GtmCustomTemplate,
          fingerprint ? { fingerprint } : {}
        );
      }
    }
  }

  if (options.deleteMissing) {
    const desiredSet = new Set(desired.templates.map((t) => lower(t.name)));
    for (const [nameLowerKey, existing] of currentTemplatesByName.entries()) {
      if (desiredSet.has(nameLowerKey)) continue;
      const displayName = existing.name ?? nameLowerKey;
      res.templates.deleted.push(displayName);
      if (!options.dryRun) {
        if (existing.path) {
          await gtm.deleteTemplate(existing.path);
        } else if (existing.templateId) {
          await gtm.deleteTemplateById(workspacePath, existing.templateId);
        }
      }
    }
  }

  // ----------------------------
  // Variables
  // ----------------------------
  const currentVariablesByName = new Map<string, tagmanager_v2.Schema$Variable>();
  const availableVariableNames = new Set<string>();
  for (const v of snapshot.variables) {
    const name = normalizeEntityName(v);
    if (name) {
      const k = lower(name);
      currentVariablesByName.set(k, v);
      availableVariableNames.add(k);
    }
  }

  for (const dv of desired.variables) {
    const key = lower(dv.name);
    const existing = currentVariablesByName.get(key);
    if (!existing) {
      res.variables.created.push(dv.name);
      availableVariableNames.add(key);
      if (!options.dryRun) {
        await gtm.createVariable(workspacePath, dv as unknown as GtmVariable);
      }
      continue;
    }

    if (!options.updateExisting) {
      res.variables.skipped.push(dv.name);
      continue;
    }

    if (!shouldUpdate(existing, dv)) {
      res.variables.skipped.push(dv.name);
      continue;
    }

    res.variables.updated.push(dv.name);
    if (!options.dryRun) {
      if (!existing.variableId) throw new Error(`Cannot update variable "${dv.name}" (missing variableId).`);
      const merged = mergeDesiredIntoCurrent(existing, dv);
      const body = stripDynamicFieldsDeep(merged) as unknown as GtmVariable;
      const fingerprint = existing.fingerprint ?? undefined;
      await gtm.updateVariableById(
        workspacePath,
        existing.variableId,
        body as unknown as GtmVariable,
        fingerprint ? { fingerprint } : {}
      );
    }
  }

  if (options.deleteMissing) {
    const desiredSet = new Set(desired.variables.map((v) => lower(v.name)));
    for (const [nameLowerKey, existing] of currentVariablesByName.entries()) {
      if (desiredSet.has(nameLowerKey)) continue;
      const displayName = existing.name ?? nameLowerKey;
      res.variables.deleted.push(displayName);
      if (!options.dryRun && existing.variableId) {
        await gtm.deleteVariableById(workspacePath, existing.variableId);
      }
    }
  }

  // ----------------------------
  // Triggers
  // ----------------------------
  const currentTriggersByName = new Map<string, tagmanager_v2.Schema$Trigger>();
  const triggerNameToId = new Map<string, string>();
  for (const t of snapshot.triggers) {
    const name = normalizeEntityName(t);
    if (!name) continue;
    currentTriggersByName.set(lower(name), t);
    if (t.triggerId) {
      triggerNameToId.set(lower(name), t.triggerId);
    }
  }

  for (const dt of desired.triggers) {
    const key = lower(dt.name);
    const existing = currentTriggersByName.get(key);
    if (!existing) {
      res.triggers.created.push(dt.name);
      if (!options.dryRun) {
        const created = await gtm.createTrigger(workspacePath, dt as unknown as GtmTrigger);
        if (created.triggerId) {
          triggerNameToId.set(key, created.triggerId);
        }
      }
      continue;
    }

    if (!options.updateExisting) {
      res.triggers.skipped.push(dt.name);
      continue;
    }

    if (!shouldUpdate(existing, dt)) {
      res.triggers.skipped.push(dt.name);
      continue;
    }

    res.triggers.updated.push(dt.name);
    if (!options.dryRun) {
      if (!existing.triggerId) throw new Error(`Cannot update trigger "${dt.name}" (missing triggerId).`);
      const merged = mergeDesiredIntoCurrent(existing, dt);
      const body = stripDynamicFieldsDeep(merged) as unknown as GtmTrigger;
      const fingerprint = existing.fingerprint ?? undefined;
      const updated = await gtm.updateTriggerById(
        workspacePath,
        existing.triggerId,
        body as unknown as GtmTrigger,
        fingerprint ? { fingerprint } : {}
      );
      if (updated.triggerId) {
        triggerNameToId.set(key, updated.triggerId);
      }
    }
  }

  if (options.deleteMissing) {
    const desiredSet = new Set(desired.triggers.map((t) => lower(t.name)));
    for (const [nameLowerKey, existing] of currentTriggersByName.entries()) {
      if (desiredSet.has(nameLowerKey)) continue;
      const displayName = existing.name ?? nameLowerKey;
      res.triggers.deleted.push(displayName);
      if (!options.dryRun && existing.triggerId) {
        await gtm.deleteTriggerById(workspacePath, existing.triggerId);
      }
    }
  }

  // ----------------------------
  // Zones (depends on triggers for customEvaluationTriggerId)
  // ----------------------------
  const currentZonesByName = new Map<string, tagmanager_v2.Schema$Zone>();
  for (const z of snapshot.zones) {
    const name = normalizeEntityName(z);
    if (name) currentZonesByName.set(lower(name), z);
  }

  for (const rawDesiredZone of desired.zones) {
    const desiredZoneResolved = zoneWithResolvedCustomEvalTriggers(rawDesiredZone as unknown, triggerNameToId);
    const name = isRecord(desiredZoneResolved) ? desiredZoneResolved.name : undefined;
    if (typeof name !== "string" || !name.trim()) {
      throw new Error("Desired zone missing a valid name.");
    }

    const key = lower(name);
    const existing = currentZonesByName.get(key);

    if (!existing) {
      res.zones.created.push(name);
      if (!options.dryRun) {
        await gtm.createZone(workspacePath, stripDynamicFieldsDeep(desiredZoneResolved) as unknown as GtmZone);
      }
      continue;
    }

    if (!options.updateExisting) {
      res.zones.skipped.push(name);
      continue;
    }

    if (!shouldUpdate(zoneWithResolvedCustomEvalTriggers(existing as unknown, triggerNameToId), desiredZoneResolved)) {
      res.zones.skipped.push(name);
      continue;
    }

    res.zones.updated.push(name);
    if (!options.dryRun) {
      if (!existing.zoneId) throw new Error(`Cannot update zone "${name}" (missing zoneId).`);
      const merged = mergeDesiredIntoCurrent(existing, desiredZoneResolved);
      const body = stripDynamicFieldsDeep(merged) as unknown as GtmZone;
      const fingerprint = existing.fingerprint ?? undefined;
      await gtm.updateZoneById(workspacePath, existing.zoneId, body as unknown as GtmZone, fingerprint ? { fingerprint } : {});
    }
  }

  if (options.deleteMissing) {
    const desiredSet = new Set(desired.zones.map((z) => lower(z.name)));
    for (const [nameLowerKey, existing] of currentZonesByName.entries()) {
      if (desiredSet.has(nameLowerKey)) continue;
      const displayName = existing.name ?? nameLowerKey;
      res.zones.deleted.push(displayName);
      if (!options.dryRun && existing.zoneId) {
        await gtm.deleteZoneById(workspacePath, existing.zoneId);
      }
    }
  }

  // ----------------------------
  // Tags (depends on triggers)
  // ----------------------------
  const currentTagsByName = new Map<string, tagmanager_v2.Schema$Tag>();
  for (const t of snapshot.tags) {
    const name = normalizeEntityName(t);
    if (name) currentTagsByName.set(lower(name), t);
  }

  if (options.validateVariableRefs) {
    const refs = collectVariableReferencesFromValues([...desired.tags, ...desired.zones]);
    for (const refName of refs) {
      const k = lower(refName);
      if (!availableVariableNames.has(k)) {
        // NOTE: This is a best-effort check. Built-in variables are not returned
        // by `workspaces.variables.list`, so some warnings may be benign.
        res.warnings.push(`Config references variable "{{${refName}}}" not found in workspace variables list.`);
      }
    }
    res.warnings.sort();
  }

  for (const rawDesiredTag of desired.tags) {
    const desiredTagResolved = tagWithResolvedTriggers(rawDesiredTag as unknown, triggerNameToId);
    const name = isRecord(desiredTagResolved) ? desiredTagResolved.name : undefined;
    if (typeof name !== "string" || !name.trim()) {
      throw new Error("Desired tag missing a valid name.");
    }

    const key = lower(name);
    const existing = currentTagsByName.get(key);

    if (!existing) {
      // For create, enforce that a firing trigger is specified (by IDs or names).
      if (isRecord(desiredTagResolved) && !Array.isArray(desiredTagResolved.firingTriggerId)) {
        throw new Error(`Cannot create tag "${name}": missing firingTriggerId (or firingTriggerNames).`);
      }

      res.tags.created.push(name);
      if (!options.dryRun) {
        await gtm.createTag(
          workspacePath,
          stripDynamicFieldsDeep(desiredTagResolved) as unknown as GtmTag
        );
      }
      continue;
    }

    if (!options.updateExisting) {
      res.tags.skipped.push(name);
      continue;
    }

    if (!shouldUpdate(tagWithResolvedTriggers(existing as unknown, triggerNameToId), desiredTagResolved)) {
      res.tags.skipped.push(name);
      continue;
    }

    res.tags.updated.push(name);
    if (!options.dryRun) {
      if (!existing.tagId) throw new Error(`Cannot update tag "${name}" (missing tagId).`);
      const merged = mergeDesiredIntoCurrent(existing, desiredTagResolved);
      const body = stripDynamicFieldsDeep(merged) as unknown as GtmTag;
      const fingerprint = existing.fingerprint ?? undefined;
      await gtm.updateTagById(workspacePath, existing.tagId, body as unknown as GtmTag, fingerprint ? { fingerprint } : {});
    }
  }

  if (options.deleteMissing) {
    const desiredSet = new Set(desired.tags.map((t) => lower(t.name)));
    for (const [nameLowerKey, existing] of currentTagsByName.entries()) {
      if (desiredSet.has(nameLowerKey)) continue;
      const displayName = existing.name ?? nameLowerKey;
      res.tags.deleted.push(displayName);
      if (!options.dryRun && existing.tagId) {
        await gtm.deleteTagById(workspacePath, existing.tagId);
      }
    }
  }

  // Sort for stable output.
  for (const summary of [res.templates, res.variables, res.triggers, res.zones, res.tags]) {
    summary.created.sort();
    summary.updated.sort();
    summary.deleted.sort();
    summary.skipped.sort();
  }

  return res;
}

function collectVariableReferencesFromValues(values: unknown[]): Set<string> {
  const out = new Set<string>();
  for (const v of values) {
    collectVariableReferencesDeep(v, out);
  }
  return out;
}

function collectVariableReferencesDeep(value: unknown, out: Set<string>): void {
  if (typeof value === "string") {
    for (const m of value.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)) {
      const name = m[1]?.trim();
      if (name) out.add(name);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectVariableReferencesDeep(v, out);
    return;
  }
  if (isRecord(value)) {
    for (const v of Object.values(value)) collectVariableReferencesDeep(v, out);
  }
}

