import type { tagmanager_v2 } from "googleapis";
import type { GtmClient } from "../lib/gtm-client";
import type {
  GtmCustomTemplate,
  GtmEnvironment,
  GtmFolder,
  GtmServerClient,
  GtmServerTransformation,
  GtmTag,
  GtmTrigger,
  GtmVariable,
  GtmZone
} from "../types/gtm-schema";
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

function containerPathFromWorkspacePath(workspacePath: string): string {
  const m = workspacePath.match(/^(accounts\/[^/]+\/containers\/[^/]+)\/workspaces\/[^/]+$/);
  if (!m) {
    throw new Error(`Invalid workspace path: "${workspacePath}"`);
  }
  return m[1]!;
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
  environments: EntitySyncSummary;
  templates: EntitySyncSummary;
  variables: EntitySyncSummary;
  builtInVariables: EntitySyncSummary;
  clients: EntitySyncSummary;
  transformations: EntitySyncSummary;
  triggers: EntitySyncSummary;
  zones: EntitySyncSummary;
  folders: EntitySyncSummary;
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
  ensureUniqueNames(desired.environments, "environment");
  ensureUniqueNames(desired.templates, "template");
  ensureUniqueNames(desired.variables, "variable");
  ensureUniqueNames(desired.clients, "client");
  ensureUniqueNames(desired.transformations, "transformation");
  ensureUniqueNames(desired.triggers, "trigger");
  ensureUniqueNames(desired.zones, "zone");
  ensureUniqueNames(desired.folders, "folder");
  ensureUniqueNames(desired.tags, "tag");

  const snapshot = await fetchWorkspaceSnapshot(gtm, workspacePath);

  const res: SyncWorkspaceResult = {
    workspacePath,
    environments: emptySummary(),
    templates: emptySummary(),
    variables: emptySummary(),
    builtInVariables: emptySummary(),
    clients: emptySummary(),
    transformations: emptySummary(),
    triggers: emptySummary(),
    zones: emptySummary(),
    folders: emptySummary(),
    tags: emptySummary(),
    warnings: []
  };

  const protectedByType = {
    builtInVariableTypes: new Set(desired.policy.protectedNames.builtInVariableTypes.map(lower)),
    environments: new Set(desired.policy.protectedNames.environments.map(lower)),
    folders: new Set(desired.policy.protectedNames.folders.map(lower)),
    clients: new Set(desired.policy.protectedNames.clients.map(lower)),
    transformations: new Set(desired.policy.protectedNames.transformations.map(lower)),
    tags: new Set(desired.policy.protectedNames.tags.map(lower)),
    triggers: new Set(desired.policy.protectedNames.triggers.map(lower)),
    variables: new Set(desired.policy.protectedNames.variables.map(lower)),
    templates: new Set(desired.policy.protectedNames.templates.map(lower)),
    zones: new Set(desired.policy.protectedNames.zones.map(lower))
  };

  const deleteAllowTypes = new Set(desired.policy.deleteAllowTypes.map(lower));
  const deleteDenyTypes = new Set(desired.policy.deleteDenyTypes.map(lower));
  const isDeleteAllowedForType = (resourceType: string): boolean => {
    const t = lower(resourceType);
    if (deleteDenyTypes.has(t)) return false;
    if (deleteAllowTypes.size > 0 && !deleteAllowTypes.has(t)) return false;
    return true;
  };

  const containerPath = containerPathFromWorkspacePath(workspacePath);

  // ----------------------------
  // Environments (container-level)
  // ----------------------------
  const currentEnvironmentsByName = new Map<string, tagmanager_v2.Schema$Environment>();
  for (const e of snapshot.environments) {
    const name = normalizeEntityName(e);
    if (name) currentEnvironmentsByName.set(lower(name), e);
  }

  for (const de of desired.environments) {
    const key = lower(de.name);
    const existing = currentEnvironmentsByName.get(key);
    if (!existing) {
      res.environments.created.push(de.name);
      if (!options.dryRun) {
        await gtm.createEnvironment(containerPath, de as unknown as GtmEnvironment);
      }
      continue;
    }

    if (!options.updateExisting) {
      res.environments.skipped.push(de.name);
      continue;
    }

    if (!shouldUpdate(existing, de)) {
      res.environments.skipped.push(de.name);
      continue;
    }

    res.environments.updated.push(de.name);
    if (!options.dryRun) {
      const envPath = existing.path ?? undefined;
      if (!envPath) {
        throw new Error(`Cannot update environment "${de.name}" (missing path).`);
      }
      const merged = mergeDesiredIntoCurrent(existing, de);
      const body = stripDynamicFieldsDeep(merged) as unknown as GtmEnvironment;
      const fingerprint = existing.fingerprint ?? undefined;
      await gtm.updateEnvironment(envPath, body as unknown as GtmEnvironment, fingerprint ? { fingerprint } : {});
    }
  }

  if (options.deleteMissing) {
    const desiredSet = new Set(desired.environments.map((e) => lower(e.name)));
    for (const [nameLowerKey, existing] of currentEnvironmentsByName.entries()) {
      if (desiredSet.has(nameLowerKey)) continue;

      const displayName = existing.name ?? nameLowerKey;

      if (!isDeleteAllowedForType("environments")) {
        res.environments.skipped.push(displayName);
        res.warnings.push(`Deletion blocked by policy for type "environments": "${displayName}"`);
        continue;
      }

      if (protectedByType.environments.has(nameLowerKey)) {
        res.environments.skipped.push(displayName);
        res.warnings.push(`Protected environment not deleted: "${displayName}"`);
        continue;
      }

      // GTM only allows deleting USER-type environments.
      const envType = (existing.type ?? "").toUpperCase();
      if (envType && envType !== "USER") {
        res.environments.skipped.push(displayName);
        res.warnings.push(`Non-USER environment not deleted: "${displayName}" (type=${existing.type ?? "?"})`);
        continue;
      }

      const envPath = existing.path ?? undefined;
      if (!envPath) {
        res.environments.skipped.push(displayName);
        res.warnings.push(`Environment missing path; cannot delete: "${displayName}"`);
        continue;
      }

      res.environments.deleted.push(displayName);
      if (!options.dryRun) {
        await gtm.deleteEnvironment(envPath);
      }
    }
  }

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
      if (!isDeleteAllowedForType("templates")) {
        res.templates.skipped.push(displayName);
        res.warnings.push(`Deletion blocked by policy for type "templates": "${displayName}"`);
        continue;
      }
      if (protectedByType.templates.has(nameLowerKey)) {
        res.templates.skipped.push(displayName);
        res.warnings.push(`Protected template not deleted: "${displayName}"`);
        continue;
      }
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
  const variableNameToId = new Map<string, string>();
  for (const v of snapshot.variables) {
    const name = normalizeEntityName(v);
    if (name) {
      const k = lower(name);
      currentVariablesByName.set(k, v);
      availableVariableNames.add(k);
      if (v.variableId) {
        variableNameToId.set(k, v.variableId);
      }
    }
  }

  for (const dv of desired.variables) {
    const key = lower(dv.name);
    const existing = currentVariablesByName.get(key);
    if (!existing) {
      res.variables.created.push(dv.name);
      availableVariableNames.add(key);
      if (!options.dryRun) {
        const created = await gtm.createVariable(workspacePath, dv as unknown as GtmVariable);
        if (created.variableId) {
          variableNameToId.set(key, created.variableId);
        }
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
      const updated = await gtm.updateVariableById(
        workspacePath,
        existing.variableId,
        body as unknown as GtmVariable,
        fingerprint ? { fingerprint } : {}
      );
      if (updated.variableId) {
        variableNameToId.set(key, updated.variableId);
      }
    }
  }

  if (options.deleteMissing) {
    const desiredSet = new Set(desired.variables.map((v) => lower(v.name)));
    for (const [nameLowerKey, existing] of currentVariablesByName.entries()) {
      if (desiredSet.has(nameLowerKey)) continue;
      const displayName = existing.name ?? nameLowerKey;
      if (!isDeleteAllowedForType("variables")) {
        res.variables.skipped.push(displayName);
        res.warnings.push(`Deletion blocked by policy for type "variables": "${displayName}"`);
        continue;
      }
      if (protectedByType.variables.has(nameLowerKey)) {
        res.variables.skipped.push(displayName);
        res.warnings.push(`Protected variable not deleted: "${displayName}"`);
        continue;
      }
      res.variables.deleted.push(displayName);
      if (!options.dryRun && existing.variableId) {
        await gtm.deleteVariableById(workspacePath, existing.variableId);
      }
    }
  }

  // ----------------------------
  // Built-in Variables (enable/disable)
  // ----------------------------
  const currentBuiltInTypesByLower = new Map<string, string>();
  for (const v of snapshot.builtInVariables) {
    const t = v.type ?? undefined;
    if (typeof t === "string" && t.trim()) {
      currentBuiltInTypesByLower.set(lower(t), t);
    }
    const n = v.name ?? undefined;
    if (typeof n === "string" && n.trim()) {
      availableVariableNames.add(lower(n));
    }
  }

  const desiredBuiltInTypesByLower = new Map<string, string>();
  for (const t of desired.builtInVariableTypes) {
    const raw = t.trim();
    if (!raw) continue;
    desiredBuiltInTypesByLower.set(lower(raw), raw);
  }

  const toEnable: string[] = [];
  for (const [k, raw] of desiredBuiltInTypesByLower.entries()) {
    if (!currentBuiltInTypesByLower.has(k)) {
      toEnable.push(raw);
    }
  }

  const toDisable: string[] = [];
  if (options.deleteMissing) {
    for (const [k, raw] of currentBuiltInTypesByLower.entries()) {
      if (!desiredBuiltInTypesByLower.has(k)) {
        if (!isDeleteAllowedForType("builtInVariableTypes")) {
          res.builtInVariables.skipped.push(raw);
          res.warnings.push(`Deletion blocked by policy for type "builtInVariableTypes": "${raw}"`);
          continue;
        }
        if (protectedByType.builtInVariableTypes.has(k)) {
          res.builtInVariables.skipped.push(raw);
          res.warnings.push(`Protected built-in variable type not disabled: "${raw}"`);
          continue;
        }
        toDisable.push(raw);
      }
    }
  }

  toEnable.sort();
  toDisable.sort();

  if (toEnable.length) {
    res.builtInVariables.created.push(...toEnable);
    if (!options.dryRun) {
      await gtm.enableBuiltInVariables(workspacePath, toEnable);
    }
  }
  if (toDisable.length) {
    res.builtInVariables.deleted.push(...toDisable);
    if (!options.dryRun) {
      await gtm.disableBuiltInVariables(workspacePath, toDisable);
    }
  }

  // ----------------------------
  // Server-side GTM: Clients
  // ----------------------------
  const currentClientsByName = new Map<string, tagmanager_v2.Schema$Client>();
  for (const c of snapshot.clients) {
    const name = normalizeEntityName(c);
    if (name) currentClientsByName.set(lower(name), c);
  }

  for (const dc of desired.clients) {
    const key = lower(dc.name);
    const existing = currentClientsByName.get(key);
    if (!existing) {
      res.clients.created.push(dc.name);
      if (!options.dryRun) {
        await gtm.createClient(workspacePath, dc as unknown as GtmServerClient);
      }
      continue;
    }

    if (!options.updateExisting) {
      res.clients.skipped.push(dc.name);
      continue;
    }

    if (!shouldUpdate(existing, dc)) {
      res.clients.skipped.push(dc.name);
      continue;
    }

    res.clients.updated.push(dc.name);
    if (!options.dryRun) {
      if (!existing.clientId) throw new Error(`Cannot update client "${dc.name}" (missing clientId).`);
      const merged = mergeDesiredIntoCurrent(existing, dc);
      const body = stripDynamicFieldsDeep(merged) as unknown as GtmServerClient;
      const fingerprint = existing.fingerprint ?? undefined;
      await gtm.updateClientById(
        workspacePath,
        existing.clientId,
        body as unknown as GtmServerClient,
        fingerprint ? { fingerprint } : {}
      );
    }
  }

  if (options.deleteMissing) {
    const desiredSet = new Set(desired.clients.map((c) => lower(c.name)));
    for (const [nameLowerKey, existing] of currentClientsByName.entries()) {
      if (desiredSet.has(nameLowerKey)) continue;
      const displayName = existing.name ?? nameLowerKey;
      if (!isDeleteAllowedForType("clients")) {
        res.clients.skipped.push(displayName);
        res.warnings.push(`Deletion blocked by policy for type "clients": "${displayName}"`);
        continue;
      }
      if (protectedByType.clients.has(nameLowerKey)) {
        res.clients.skipped.push(displayName);
        res.warnings.push(`Protected client not deleted: "${displayName}"`);
        continue;
      }
      res.clients.deleted.push(displayName);
      if (!options.dryRun && existing.clientId) {
        await gtm.deleteClientById(workspacePath, existing.clientId);
      }
    }
  }

  // ----------------------------
  // Server-side GTM: Transformations
  // ----------------------------
  const currentTransformationsByName = new Map<string, tagmanager_v2.Schema$Transformation>();
  for (const t of snapshot.transformations) {
    const name = normalizeEntityName(t);
    if (name) currentTransformationsByName.set(lower(name), t);
  }

  for (const dt of desired.transformations) {
    const key = lower(dt.name);
    const existing = currentTransformationsByName.get(key);
    if (!existing) {
      res.transformations.created.push(dt.name);
      if (!options.dryRun) {
        await gtm.createTransformation(workspacePath, dt as unknown as GtmServerTransformation);
      }
      continue;
    }

    if (!options.updateExisting) {
      res.transformations.skipped.push(dt.name);
      continue;
    }

    if (!shouldUpdate(existing, dt)) {
      res.transformations.skipped.push(dt.name);
      continue;
    }

    res.transformations.updated.push(dt.name);
    if (!options.dryRun) {
      if (!existing.transformationId) {
        throw new Error(`Cannot update transformation "${dt.name}" (missing transformationId).`);
      }
      const merged = mergeDesiredIntoCurrent(existing, dt);
      const body = stripDynamicFieldsDeep(merged) as unknown as GtmServerTransformation;
      const fingerprint = existing.fingerprint ?? undefined;
      await gtm.updateTransformationById(
        workspacePath,
        existing.transformationId,
        body as unknown as GtmServerTransformation,
        fingerprint ? { fingerprint } : {}
      );
    }
  }

  if (options.deleteMissing) {
    const desiredSet = new Set(desired.transformations.map((t) => lower(t.name)));
    for (const [nameLowerKey, existing] of currentTransformationsByName.entries()) {
      if (desiredSet.has(nameLowerKey)) continue;
      const displayName = existing.name ?? nameLowerKey;
      if (!isDeleteAllowedForType("transformations")) {
        res.transformations.skipped.push(displayName);
        res.warnings.push(`Deletion blocked by policy for type "transformations": "${displayName}"`);
        continue;
      }
      if (protectedByType.transformations.has(nameLowerKey)) {
        res.transformations.skipped.push(displayName);
        res.warnings.push(`Protected transformation not deleted: "${displayName}"`);
        continue;
      }
      res.transformations.deleted.push(displayName);
      if (!options.dryRun && existing.transformationId) {
        await gtm.deleteTransformationById(workspacePath, existing.transformationId);
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
      if (!isDeleteAllowedForType("triggers")) {
        res.triggers.skipped.push(displayName);
        res.warnings.push(`Deletion blocked by policy for type "triggers": "${displayName}"`);
        continue;
      }
      if (protectedByType.triggers.has(nameLowerKey)) {
        res.triggers.skipped.push(displayName);
        res.warnings.push(`Protected trigger not deleted: "${displayName}"`);
        continue;
      }
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
      if (!isDeleteAllowedForType("zones")) {
        res.zones.skipped.push(displayName);
        res.warnings.push(`Deletion blocked by policy for type "zones": "${displayName}"`);
        continue;
      }
      if (protectedByType.zones.has(nameLowerKey)) {
        res.zones.skipped.push(displayName);
        res.warnings.push(`Protected zone not deleted: "${displayName}"`);
        continue;
      }
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
  const tagNameToId = new Map<string, string>();
  for (const t of snapshot.tags) {
    const name = normalizeEntityName(t);
    if (name) {
      const k = lower(name);
      currentTagsByName.set(k, t);
      if (t.tagId) {
        tagNameToId.set(k, t.tagId);
      }
    }
  }

  if (options.validateVariableRefs) {
    const refs = collectVariableReferencesFromValues([
      ...desired.tags,
      ...desired.triggers,
      ...desired.clients,
      ...desired.transformations,
      ...desired.zones
    ]);
    for (const refName of refs) {
      const k = lower(refName);
      if (!availableVariableNames.has(k)) {
        // NOTE: Best-effort check. We include enabled built-in variables, but do
        // not know the full universe of built-ins that could exist in a container.
        res.warnings.push(
          `Config references variable "{{${refName}}}" not found in workspace variables or enabled built-in variables.`
        );
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
        const created = await gtm.createTag(
          workspacePath,
          stripDynamicFieldsDeep(desiredTagResolved) as unknown as GtmTag
        );
        if (created.tagId) {
          tagNameToId.set(key, created.tagId);
        }
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
      const updated = await gtm.updateTagById(workspacePath, existing.tagId, body as unknown as GtmTag, fingerprint ? { fingerprint } : {});
      if (updated.tagId) {
        tagNameToId.set(key, updated.tagId);
      }
    }
  }

  if (options.deleteMissing) {
    const desiredSet = new Set(desired.tags.map((t) => lower(t.name)));
    for (const [nameLowerKey, existing] of currentTagsByName.entries()) {
      if (desiredSet.has(nameLowerKey)) continue;
      const displayName = existing.name ?? nameLowerKey;
      if (!isDeleteAllowedForType("tags")) {
        res.tags.skipped.push(displayName);
        res.warnings.push(`Deletion blocked by policy for type "tags": "${displayName}"`);
        continue;
      }
      if (protectedByType.tags.has(nameLowerKey)) {
        res.tags.skipped.push(displayName);
        res.warnings.push(`Protected tag not deleted: "${displayName}"`);
        continue;
      }
      res.tags.deleted.push(displayName);
      if (!options.dryRun && existing.tagId) {
        await gtm.deleteTagById(workspacePath, existing.tagId);
      }
    }
  }

  // ----------------------------
  // Folders (optional membership)
  // ----------------------------
  const currentFoldersByName = new Map<string, tagmanager_v2.Schema$Folder>();
  for (const f of snapshot.folders) {
    const name = normalizeEntityName(f);
    if (name) currentFoldersByName.set(lower(name), f);
  }

  for (const df of desired.folders) {
    const key = lower(df.name);
    const existing = currentFoldersByName.get(key);

    let folderId: string | undefined = existing?.folderId ?? undefined;

    if (!existing) {
      res.folders.created.push(df.name);
      if (!options.dryRun) {
        const created = await gtm.createFolder(workspacePath, stripDynamicFieldsDeep(df) as unknown as GtmFolder);
        folderId = created.folderId ?? undefined;
      }
    } else if (!options.updateExisting) {
      res.folders.skipped.push(df.name);
    } else if (!shouldUpdate(existing, df)) {
      res.folders.skipped.push(df.name);
    } else {
      res.folders.updated.push(df.name);
      if (!options.dryRun) {
        if (!existing.folderId) throw new Error(`Cannot update folder "${df.name}" (missing folderId).`);
        const merged = mergeDesiredIntoCurrent(existing, df);
        const body = stripDynamicFieldsDeep(merged) as unknown as GtmFolder;
        const fingerprint = existing.fingerprint ?? undefined;
        const updated = await gtm.updateFolderById(
          workspacePath,
          existing.folderId,
          body as unknown as GtmFolder,
          fingerprint ? { fingerprint } : {}
        );
        folderId = updated.folderId ?? existing.folderId;
      }
    }

    // Apply membership mapping by names, if provided.
    const members = (df as unknown as { __members?: { tagNames?: string[]; triggerNames?: string[]; variableNames?: string[] } })
      .__members;
    const hasMembers =
      Boolean(members?.tagNames?.length) || Boolean(members?.triggerNames?.length) || Boolean(members?.variableNames?.length);

    if (!hasMembers) {
      continue;
    }

    if (options.dryRun) {
      res.warnings.push(`dry-run: would move entities into folder "${df.name}"`);
      continue;
    }

    if (!folderId) {
      throw new Error(`Cannot move entities into folder "${df.name}" (missing folderId).`);
    }

    const resolveIds = (names: string[] | undefined, map: Map<string, string>, kind: string): string[] => {
      const out: string[] = [];
      for (const n of names ?? []) {
        const id = map.get(lower(n));
        if (!id) {
          throw new Error(`Folder "${df.name}" references missing ${kind} by name: "${n}"`);
        }
        out.push(id);
      }
      return out;
    };

    const tagIds = resolveIds(members?.tagNames, tagNameToId, "tag");
    const triggerIds = resolveIds(members?.triggerNames, triggerNameToId, "trigger");
    const variableIds = resolveIds(members?.variableNames, variableNameToId, "variable");

    const folderPath = `${workspacePath}/folders/${folderId}`;
    await gtm.moveEntitiesToFolder({
      folderPath,
      tagId: tagIds,
      triggerId: triggerIds,
      variableId: variableIds
    });
  }

  if (options.deleteMissing) {
    const desiredSet = new Set(desired.folders.map((f) => lower(f.name)));
    for (const [nameLowerKey, existing] of currentFoldersByName.entries()) {
      if (desiredSet.has(nameLowerKey)) continue;
      const displayName = existing.name ?? nameLowerKey;
      if (!isDeleteAllowedForType("folders")) {
        res.folders.skipped.push(displayName);
        res.warnings.push(`Deletion blocked by policy for type "folders": "${displayName}"`);
        continue;
      }
      if (protectedByType.folders.has(nameLowerKey)) {
        res.folders.skipped.push(displayName);
        res.warnings.push(`Protected folder not deleted: "${displayName}"`);
        continue;
      }
      res.folders.deleted.push(displayName);
      if (!options.dryRun && existing.folderId) {
        await gtm.deleteFolderById(workspacePath, existing.folderId);
      }
    }
  }

  // Sort for stable output.
  for (const summary of [
    res.environments,
    res.templates,
    res.variables,
    res.builtInVariables,
    res.clients,
    res.transformations,
    res.triggers,
    res.zones,
    res.tags,
    res.folders
  ]) {
    summary.created.sort();
    summary.updated.sort();
    summary.deleted.sort();
    summary.skipped.sort();
  }

  res.warnings.sort();

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

