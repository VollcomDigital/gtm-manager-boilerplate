import { z } from "zod";
import { zWorkspaceDesiredState, zWorkspaceDesiredStatePartial } from "./workspace-config";

export const zLabels = z.record(z.string().min(1), z.string().min(1)).default({});

export const zContainerTarget = z
  .object({
    accountId: z.string().trim().min(1).optional(),
    accountName: z.string().trim().min(1).optional(),
    containerId: z.string().trim().min(1).optional(),
    containerPublicId: z.string().trim().min(1).optional(),
    containerName: z.string().trim().min(1).optional()
  })
  .strict()
  .refine((v) => Boolean(v.accountId || v.accountName), {
    message: "Container target must include accountId or accountName."
  })
  .refine((v) => Boolean(v.containerId || v.containerPublicId || v.containerName), {
    message: "Container target must include containerId, containerPublicId, or containerName."
  });

export type ContainerTarget = z.infer<typeof zContainerTarget>;

/**
 * A single GTM container entry in the repo-level IaC config.
 */
export const zRepoContainer = z
  .object({
    key: z.string().trim().min(1),
    labels: zLabels.optional(),
    description: z.string().trim().min(1).optional(),
    target: zContainerTarget,
    workspace: zWorkspaceDesiredState
  })
  .strict();

export type RepoContainer = z.infer<typeof zRepoContainer>;

export const zRepoConfig = z
  .object({
    schemaVersion: z.literal(1),
    defaults: z
      .object({
        workspaceName: z.string().trim().min(1).default("iac")
      })
      .strict()
      .default({ workspaceName: "iac" }),
    containers: z.array(zRepoContainer).min(1)
  })
  .strict();

export type RepoConfig = z.infer<typeof zRepoConfig>;

// ----------------------------
// Overlay config parts (for base + environment overrides)
// ----------------------------

export const zContainerTargetPartial = z
  .object({
    accountId: z.string().trim().min(1).optional(),
    accountName: z.string().trim().min(1).optional(),
    containerId: z.string().trim().min(1).optional(),
    containerPublicId: z.string().trim().min(1).optional(),
    containerName: z.string().trim().min(1).optional()
  })
  .strict();

export type ContainerTargetPartial = z.infer<typeof zContainerTargetPartial>;

export const zRepoContainerPartial = z
  .object({
    key: z.string().trim().min(1),
    labels: zLabels.optional(),
    description: z.string().trim().min(1).optional(),
    target: zContainerTargetPartial.optional(),
    workspace: zWorkspaceDesiredStatePartial.optional()
  })
  .strict();

export type RepoContainerPartial = z.infer<typeof zRepoContainerPartial>;

export const zRepoConfigPartial = z
  .object({
    schemaVersion: z.literal(1),
    defaults: z
      .object({
        workspaceName: z.string().trim().min(1).optional()
      })
      .strict()
      .optional(),
    containers: z.array(zRepoContainerPartial).min(1)
  })
  .strict();

export type RepoConfigPartial = z.infer<typeof zRepoConfigPartial>;

