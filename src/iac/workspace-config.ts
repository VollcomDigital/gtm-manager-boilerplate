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

/**
 * Partial desired-state schema for overlay configs.
 *
 * Lists are optional so an overlay can specify only the entities it wants to
 * add/override without wiping the base config.
 */
export const zWorkspaceDesiredStatePartial = z
  .object({
    workspaceName: z.string().trim().min(1),
    tags: z.array(zGtmTag).optional(),
    triggers: z.array(zGtmTrigger).optional(),
    variables: z.array(zGtmVariable).optional(),
    templates: z.array(zGtmCustomTemplate).optional()
  })
  .strict();

export type WorkspaceDesiredStatePartial = z.infer<typeof zWorkspaceDesiredStatePartial>;

/**
 * Overlay schema where workspaceName is optional.
 *
 * Used for repo-level overlays where workspaceName may be inherited from base
 * config or repo defaults.
 */
export const zWorkspaceDesiredStateOverlay = z
  .object({
    workspaceName: z.string().trim().min(1).optional(),
    tags: z.array(zGtmTag).optional(),
    triggers: z.array(zGtmTrigger).optional(),
    variables: z.array(zGtmVariable).optional(),
    templates: z.array(zGtmCustomTemplate).optional()
  })
  .strict();

export type WorkspaceDesiredStateOverlay = z.infer<typeof zWorkspaceDesiredStateOverlay>;

