import "dotenv/config";
import { z } from "zod";
import { createGoogleAuth } from "./config/auth";
import { GtmClient, type AccountContainerLocator } from "./lib/gtm-client";
import type { GtmTag, GtmTrigger } from "./types/gtm-schema";

const EnvSchema = z
  .object({
    // Auth
    GTM_CREDENTIALS_PATH: z.string().trim().min(1).optional(),

    // Target container (IDs recommended; names are supported but less stable)
    GTM_ACCOUNT_ID: z.string().trim().min(1).optional(),
    GTM_ACCOUNT_NAME: z.string().trim().min(1).optional(),
    GTM_CONTAINER_ID: z.string().trim().min(1).optional(),
    GTM_CONTAINER_NAME: z.string().trim().min(1).optional(),

    // Workspace to mutate
    GTM_WORKSPACE_NAME: z.string().trim().min(1).default("Automation-Test"),

    // Example payload
    GA4_MEASUREMENT_ID: z.string().trim().min(1)
  })
  .refine((e) => Boolean(e.GTM_ACCOUNT_ID || e.GTM_ACCOUNT_NAME), {
    message: "Provide GTM_ACCOUNT_ID (preferred) or GTM_ACCOUNT_NAME."
  })
  .refine((e) => Boolean(e.GTM_CONTAINER_ID || e.GTM_CONTAINER_NAME), {
    message: "Provide GTM_CONTAINER_ID (preferred) or GTM_CONTAINER_NAME."
  });

async function runExampleMain(): Promise<void> {
  const env = EnvSchema.parse(process.env);

  const auth = createGoogleAuth();
  const gtm = new GtmClient(auth);

  const locator: AccountContainerLocator = {
    ...(env.GTM_ACCOUNT_ID ? { accountId: env.GTM_ACCOUNT_ID } : {}),
    ...(env.GTM_ACCOUNT_NAME ? { accountName: env.GTM_ACCOUNT_NAME } : {}),
    ...(env.GTM_CONTAINER_ID ? { containerId: env.GTM_CONTAINER_ID } : {}),
    ...(env.GTM_CONTAINER_NAME ? { containerName: env.GTM_CONTAINER_NAME } : {})
  };

  const { accountId, containerId, containerPublicId, containerName } = await gtm.resolveAccountAndContainer(locator);

  const containerPath = gtm.toContainerPath(accountId, containerId);
  console.log(`Resolved container: accountId=${accountId}, containerId=${containerId}, publicId=${containerPublicId ?? "?"}, name=${containerName ?? "?"}`);
  console.log(`Container path: ${containerPath}`);

  const workspace = await gtm.getOrCreateWorkspace({
    accountId,
    containerId,
    workspaceName: env.GTM_WORKSPACE_NAME
  });

  if (!workspace.workspaceId) {
    throw new Error("Workspace response missing workspaceId.");
  }

  const workspacePath = gtm.toWorkspacePath(accountId, containerId, workspace.workspaceId);
  console.log(`Workspace: name=${workspace.name ?? "?"}, workspaceId=${workspace.workspaceId}`);
  console.log(`Workspace path: ${workspacePath}`);

  // Create (or reuse) an "All Pages" Page View trigger.
  const triggers = await gtm.listTriggers(workspacePath);
  const triggerName = "All Pages";
  let allPagesTrigger = triggers.find((t) => (t.name ?? "").toLowerCase() === triggerName.toLowerCase());

  if (allPagesTrigger) {
    console.log(`Reusing trigger: name=${allPagesTrigger.name ?? "?"}, triggerId=${allPagesTrigger.triggerId ?? "?"}`);
  } else {
    const triggerPayload: GtmTrigger = {
      name: triggerName,
      type: "PAGEVIEW"
      // No filters => fires on all pageviews.
    };

    allPagesTrigger = await gtm.createTrigger(workspacePath, triggerPayload);
    console.log(`Created trigger: name=${allPagesTrigger.name ?? "?"}, triggerId=${allPagesTrigger.triggerId ?? "?"}`);
  }

  if (!allPagesTrigger.triggerId) {
    throw new Error("Trigger response missing triggerId.");
  }

  // Add a basic GA4 Configuration tag.
  //
  // NOTE: GTM built-in tag "type" values are not strongly typed by the API.
  // The GA4 configuration tag is commonly "gaawc" (GA4 Configuration).
  const tags = await gtm.listTags(workspacePath);
  const tagName = "GA4 - Configuration (Automation-Test)";

  const existing = tags.find((t) => (t.name ?? "").toLowerCase() === tagName.toLowerCase());
  if (existing) {
    console.log(`Tag already exists: name=${existing.name ?? "?"}, tagId=${existing.tagId ?? "?"}`);
    return;
  }

  const ga4ConfigTag: GtmTag = {
    name: tagName,
    type: "gaawc",
    firingTriggerId: [allPagesTrigger.triggerId],
    parameter: [
      {
        key: "measurementId",
        type: "TEMPLATE",
        value: env.GA4_MEASUREMENT_ID
      },
      {
        key: "sendPageView",
        type: "BOOLEAN",
        value: "true"
      }
    ]
  };

  const created = await gtm.createTag(workspacePath, ga4ConfigTag);
  console.log(`Created tag: name=${created.name ?? "?"}, tagId=${created.tagId ?? "?"}`);

  console.log(
    "Next steps: create a container version from this workspace and publish it (publishing is not shown in this scaffold)."
  );
}

function main(): void {
  void runExampleMain();
}

process.on("unhandledRejection", (err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`Fatal: ${msg}`);
  process.exitCode = 1;
});

main();
