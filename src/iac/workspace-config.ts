import { z } from "zod";
import { zGtmCustomTemplate, zGtmTag, zGtmTrigger, zGtmVariable } from "../types/gtm-schema";

/**
 * Minimal desired-state schema for a single GTM Workspace.
 *
 * Phase 3 will evolve this into a multi-container / multi-environment schema
 * (JSON/YAML) with overlays.
 */
export const zWorkspaceDesiredState = z
  .object({
    workspaceName: z.string().trim().min(1),
    tags: z.array(zGtmTag).default([]),
    triggers: z.array(zGtmTrigger).default([]),
    variables: z.array(zGtmVariable).default([]),
    templates: z.array(zGtmCustomTemplate).default([])
  })
  .strict();

export type WorkspaceDesiredState = z.infer<typeof zWorkspaceDesiredState>;

