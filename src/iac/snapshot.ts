import type { tagmanager_v2 } from "googleapis";
import type { GtmClient } from "../lib/gtm-client";

export interface WorkspaceSnapshot {
  environments: tagmanager_v2.Schema$Environment[];
  folders: tagmanager_v2.Schema$Folder[];
  builtInVariables: tagmanager_v2.Schema$BuiltInVariable[];
  clients: tagmanager_v2.Schema$Client[];
  transformations: tagmanager_v2.Schema$Transformation[];
  tags: tagmanager_v2.Schema$Tag[];
  triggers: tagmanager_v2.Schema$Trigger[];
  variables: tagmanager_v2.Schema$Variable[];
  templates: tagmanager_v2.Schema$CustomTemplate[];
  zones: tagmanager_v2.Schema$Zone[];
}

/**
 * Fetches the current state of a GTM workspace (subset) needed for IaC diffing.
 */
export async function fetchWorkspaceSnapshot(gtm: GtmClient, workspacePath: string): Promise<WorkspaceSnapshot> {
  const containerPath = containerPathFromWorkspacePath(workspacePath);

  const [environments, folders, builtInVariables, clients, transformations, tags, triggers, variables, templates, zones] = await Promise.all([
    gtm.listEnvironments(containerPath),
    gtm.listFolders(workspacePath),
    gtm.listEnabledBuiltInVariables(workspacePath),
    listClientsSafe(gtm, workspacePath),
    listTransformationsSafe(gtm, workspacePath),
    gtm.listTags(workspacePath),
    gtm.listTriggers(workspacePath),
    gtm.listVariables(workspacePath),
    gtm.listTemplates(workspacePath),
    listZonesSafe(gtm, workspacePath)
  ]);

  return { environments, folders, builtInVariables, clients, transformations, tags, triggers, variables, templates, zones };
}

function containerPathFromWorkspacePath(workspacePath: string): string {
  const m = workspacePath.match(/^(accounts\/[^/]+\/containers\/[^/]+)\/workspaces\/[^/]+$/);
  if (!m) {
    throw new Error(`Invalid workspace path: "${workspacePath}"`);
  }
  return m[1]!;
}

function toStatusCode(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined;
}

function parseStatusCodeFromMessage(msg: string): number | undefined {
  const m = msg.match(/status=(\d{3})/);
  if (!m) return undefined;
  const n = Number(m[1]);
  return toStatusCode(n);
}

function parseStatusFromError(err: unknown): number | undefined {
  if (err && typeof err === "object") {
    const direct = err as {
      status?: unknown;
      response?: { status?: unknown };
      cause?: unknown;
    };
    const directStatus = toStatusCode(direct.response?.status) ?? toStatusCode(direct.status);
    if (directStatus !== undefined) {
      return directStatus;
    }

    const cause = direct.cause;
    if (cause && typeof cause === "object") {
      const caused = cause as { status?: unknown; response?: { status?: unknown } };
      const causeStatus = toStatusCode(caused.response?.status) ?? toStatusCode(caused.status);
      if (causeStatus !== undefined) {
        return causeStatus;
      }
    }
  }

  if (err instanceof Error) {
    return parseStatusCodeFromMessage(err.message);
  }

  return parseStatusCodeFromMessage(String(err));
}

async function listZonesSafe(gtm: GtmClient, workspacePath: string): Promise<tagmanager_v2.Schema$Zone[]> {
  try {
    return await gtm.listZones(workspacePath);
  } catch (err: unknown) {
    // Zones are commonly associated with GTM 360. For GTM free or non-eligible
    // containers, the API can respond with 403/404. Treat as "no zones".
    const status = parseStatusFromError(err);
    if (status === 403 || status === 404) {
      return [];
    }
    throw err;
  }
}

async function listClientsSafe(gtm: GtmClient, workspacePath: string): Promise<tagmanager_v2.Schema$Client[]> {
  try {
    return await gtm.listClients(workspacePath);
  } catch (err: unknown) {
    // Clients are a server-side GTM feature. For web containers, the API can respond with 403/404.
    const status = parseStatusFromError(err);
    if (status === 403 || status === 404) {
      return [];
    }
    throw err;
  }
}

async function listTransformationsSafe(gtm: GtmClient, workspacePath: string): Promise<tagmanager_v2.Schema$Transformation[]> {
  try {
    return await gtm.listTransformations(workspacePath);
  } catch (err: unknown) {
    // Transformations are a server-side GTM feature. For web containers, the API can respond with 403/404.
    const status = parseStatusFromError(err);
    if (status === 403 || status === 404) {
      return [];
    }
    throw err;
  }
}

