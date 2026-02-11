import { z } from "zod";
import {
  zGtmCustomTemplate,
  zGtmFolder,
  zGtmServerClient,
  zGtmServerTransformation,
  zGtmTag,
  zGtmTrigger,
  zGtmVariable,
  zGtmZone
} from "../types/gtm-schema";

const EMPTY_PROTECTED_NAMES = {
  builtInVariableTypes: [],
  folders: [],
  clients: [],
  transformations: [],
  tags: [],
  triggers: [],
  variables: [],
  templates: [],
  zones: []
} as const;

const zWorkspaceProtectedNames = z
  .object({
    builtInVariableTypes: z.array(z.string().trim().min(1)).default([]),
    folders: z.array(z.string().trim().min(1)).default([]),
    clients: z.array(z.string().trim().min(1)).default([]),
    transformations: z.array(z.string().trim().min(1)).default([]),
    tags: z.array(z.string().trim().min(1)).default([]),
    triggers: z.array(z.string().trim().min(1)).default([]),
    variables: z.array(z.string().trim().min(1)).default([]),
    templates: z.array(z.string().trim().min(1)).default([]),
    zones: z.array(z.string().trim().min(1)).default([])
  })
  .strict()
  .default(EMPTY_PROTECTED_NAMES);

export const zWorkspacePolicy = z
  .object({
    protectedNames: zWorkspaceProtectedNames
  })
  .strict()
  .default({ protectedNames: EMPTY_PROTECTED_NAMES });

/**
 * Minimal desired-state schema for a single GTM Workspace.
 *
 * Phase 3 will evolve this into a multi-container / multi-environment schema
 * (JSON/YAML) with overlays.
 */
export const zWorkspaceDesiredState = z
  .object({
    workspaceName: z.string().trim().min(1),
    policy: zWorkspacePolicy,
    builtInVariableTypes: z.array(z.string().trim().min(1)).default([]),
    folders: z.array(zGtmFolder).default([]),
    clients: z.array(zGtmServerClient).default([]),
    transformations: z.array(zGtmServerTransformation).default([]),
    tags: z.array(zGtmTag).default([]),
    triggers: z.array(zGtmTrigger).default([]),
    variables: z.array(zGtmVariable).default([]),
    templates: z.array(zGtmCustomTemplate).default([]),
    zones: z.array(zGtmZone).default([])
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
    policy: zWorkspacePolicy.optional(),
    builtInVariableTypes: z.array(z.string().trim().min(1)).optional(),
    folders: z.array(zGtmFolder).optional(),
    clients: z.array(zGtmServerClient).optional(),
    transformations: z.array(zGtmServerTransformation).optional(),
    tags: z.array(zGtmTag).optional(),
    triggers: z.array(zGtmTrigger).optional(),
    variables: z.array(zGtmVariable).optional(),
    templates: z.array(zGtmCustomTemplate).optional(),
    zones: z.array(zGtmZone).optional()
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
    policy: zWorkspacePolicy.optional(),
    builtInVariableTypes: z.array(z.string().trim().min(1)).optional(),
    folders: z.array(zGtmFolder).optional(),
    clients: z.array(zGtmServerClient).optional(),
    transformations: z.array(zGtmServerTransformation).optional(),
    tags: z.array(zGtmTag).optional(),
    triggers: z.array(zGtmTrigger).optional(),
    variables: z.array(zGtmVariable).optional(),
    templates: z.array(zGtmCustomTemplate).optional(),
    zones: z.array(zGtmZone).optional()
  })
  .strict();

export type WorkspaceDesiredStateOverlay = z.infer<typeof zWorkspaceDesiredStateOverlay>;

