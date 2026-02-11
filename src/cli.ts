import "dotenv/config";
import { z } from "zod";
import { createGoogleAuth } from "./config/auth";
import { GtmClient, type AccountContainerLocator } from "./lib/gtm-client";

type FlagValue = string | boolean;

interface ParsedCli {
  command?: string;
  flags: Record<string, FlagValue>;
  positionals: string[];
}

function parseCli(argv: string[]): ParsedCli {
  const [command, ...rest] = argv;
  const flags: Record<string, FlagValue> = {};
  const positionals: string[] = [];

  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i]!;
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const withoutPrefix = token.slice(2);
    const eqIdx = withoutPrefix.indexOf("=");
    if (eqIdx >= 0) {
      const key = withoutPrefix.slice(0, eqIdx);
      const value = withoutPrefix.slice(eqIdx + 1);
      flags[key] = value;
      continue;
    }

    const key = withoutPrefix;
    const next = rest[i + 1];
    if (next && !next.startsWith("--")) {
      flags[key] = next;
      i += 1;
      continue;
    }
    flags[key] = true;
  }

  const parsed: ParsedCli = { flags, positionals };
  if (command) {
    parsed.command = command;
  }
  return parsed;
}

function isJsonFlagSet(flags: Record<string, FlagValue>): boolean {
  return flags.json === true || flags.format === "json";
}

function printHelp(): void {
  // Keep this minimal and grep-friendly; deeper docs should live in README later.
  console.log(`
GTM IaC CLI (GTM API v2)

Usage:
  npm run cli -- <command> [--flags]

Commands:
  list-accounts [--json]
  list-containers --account-id <id> | --account-name <name> [--json]
  ensure-workspace --account-id <id> --container-id <id|GTM-XXXX> --workspace-name <name> [--json]

Examples:
  npm run cli -- list-accounts --json
  npm run cli -- list-containers --account-id 1234567890 --json
  npm run cli -- ensure-workspace --account-id 1234567890 --container-id 51955729 --workspace-name Automation-Test --json
`);
}

function getStringFlag(flags: Record<string, FlagValue>, key: string): string | undefined {
  const v = flags[key];
  return typeof v === "string" && v.length ? v : undefined;
}

async function listAccounts(gtm: GtmClient, asJson: boolean): Promise<void> {
  const accounts = await gtm.listAccounts();
  if (asJson) {
    console.log(JSON.stringify(accounts, null, 2));
    return;
  }
  for (const a of accounts) {
    console.log(`${a.name ?? "?"}\taccountId=${a.accountId ?? "?"}`);
  }
}

async function listContainers(gtm: GtmClient, locator: { accountId?: string; accountName?: string }, asJson: boolean): Promise<void> {
  const accountId =
    locator.accountId ?? (locator.accountName ? await gtm.getAccountIdByName(locator.accountName) : undefined);
  if (!accountId) {
    throw new Error("Missing account selector: provide --account-id or --account-name.");
  }

  const containers = await gtm.listContainers(accountId);
  if (asJson) {
    console.log(JSON.stringify(containers, null, 2));
    return;
  }
  for (const c of containers) {
    console.log(`${c.name ?? "?"}\tcontainerId=${c.containerId ?? "?"}\tpublicId=${c.publicId ?? "?"}`);
  }
}

async function ensureWorkspace(
  gtm: GtmClient,
  locator: AccountContainerLocator,
  workspaceName: string,
  asJson: boolean
): Promise<void> {
  const { accountId, containerId } = await gtm.resolveAccountAndContainer(locator);
  const workspace = await gtm.getOrCreateWorkspace({ accountId, containerId, workspaceName });

  if (asJson) {
    console.log(JSON.stringify(workspace, null, 2));
    return;
  }

  console.log(`workspaceId=${workspace.workspaceId ?? "?"}\tname=${workspace.name ?? "?"}`);
}

async function main(): Promise<void> {
  const parsed = parseCli(process.argv.slice(2));
  if (!parsed.command || parsed.flags.help === true) {
    printHelp();
    return;
  }

  const auth = createGoogleAuth();
  const gtm = new GtmClient(auth);

  const asJson = isJsonFlagSet(parsed.flags);

  switch (parsed.command) {
    case "list-accounts": {
      await listAccounts(gtm, asJson);
      return;
    }
    case "list-containers": {
      const locator: { accountId?: string; accountName?: string } = {};
      const accountId = getStringFlag(parsed.flags, "account-id");
      if (accountId) locator.accountId = accountId;
      const accountName = getStringFlag(parsed.flags, "account-name");
      if (accountName) locator.accountName = accountName;

      await listContainers(
        gtm,
        locator,
        asJson
      );
      return;
    }
    case "ensure-workspace": {
      const schema = z
        .object({
          accountId: z.string().min(1),
          containerId: z.string().min(1),
          workspaceName: z.string().min(1)
        })
        .strict();

      const args = schema.parse({
        accountId: getStringFlag(parsed.flags, "account-id"),
        containerId: getStringFlag(parsed.flags, "container-id"),
        workspaceName: getStringFlag(parsed.flags, "workspace-name")
      });

      await ensureWorkspace(
        gtm,
        {
          accountId: args.accountId,
          containerId: args.containerId
        },
        args.workspaceName,
        asJson
      );
      return;
    }
    default: {
      printHelp();
      throw new Error(`Unknown command: ${parsed.command}`);
    }
  }
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`Fatal: ${msg}`);
  process.exitCode = 1;
});

