import type { tagmanager_v2 } from "googleapis";
import type { GtmClient } from "../lib/gtm-client";

export interface WorkspaceSnapshot {
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
  const [tags, triggers, variables, templates, zones] = await Promise.all([
    gtm.listTags(workspacePath),
    gtm.listTriggers(workspacePath),
    gtm.listVariables(workspacePath),
    gtm.listTemplates(workspacePath),
    gtm.listZones(workspacePath)
  ]);

  return { tags, triggers, variables, templates, zones };
}

