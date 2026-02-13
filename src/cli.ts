import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { createGoogleAuth } from "./config/auth";
import { GtmClient, type AccountContainerLocator } from "./lib/gtm-client";
import { createLogger, type LogLevel } from "./lib/logger";
import { diffWorkspace } from "./iac/diff";
import { sha256HexFromString } from "./iac/hash";
import { loadWorkspaceDesiredState } from "./iac/load-config";
import { loadRepoConfig } from "./iac/load-repo-config";
import { normalizeForDiff } from "./iac/normalize";
import { fetchWorkspaceSnapshot } from "./iac/snapshot";
import { syncWorkspace } from "./iac/sync";
import { snapshotFromContainerVersion } from "./iac/version-snapshot";
import type { GtmEnvironment } from "./types/gtm-schema";

type FlagValue = string | boolean;

interface ParsedCli {
  command?: string;
  flags: Record<string, FlagValue>;
  positionals: string[];
}

const WORKSPACE_ROOT = path.resolve(process.cwd());
const WORKSPACE_ROOT_WITH_SEP = WORKSPACE_ROOT.endsWith(path.sep) ? WORKSPACE_ROOT : `${WORKSPACE_ROOT}${path.sep}`;

function parseCli(argv: string[]): ParsedCli {
  const [command, ...rest] = argv;
  const flags: Record<string, FlagValue> = {};
  const positionals: string[] = [];

  let i = 0;
  while (i < rest.length) {
    const token = rest[i]!;
    let consumed = 1;

    if (!token.startsWith("--")) {
      positionals.push(token);
      i += consumed;
      continue;
    }

    const withoutPrefix = token.slice(2);
    const eqIdx = withoutPrefix.indexOf("=");
    if (eqIdx >= 0) {
      const key = withoutPrefix.slice(0, eqIdx);
      const value = withoutPrefix.slice(eqIdx + 1);
      flags[key] = value;
      i += consumed;
      continue;
    }

    const key = withoutPrefix;
    const next = rest[i + 1];
    if (next && !next.startsWith("--")) {
      flags[key] = next;
      consumed = 2;
    } else {
      flags[key] = true;
    }

    i += consumed;
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

Global flags:
  --json           Print JSON output where supported
  --dry-run        Do not perform mutations; print intended actions
  --block-on-live-drift  Refuse sync if live version != desired (unless --force)
  --force          Override safety checks like --block-on-live-drift

Commands:
  list-accounts [--json]
  list-user-permissions --account-id <id> [--json]
  get-user-permission --user-permission-path <accounts/.../user_permissions/...> [--json]
  list-containers --account-id <id> | --account-name <name> [--json]
  ensure-workspace --account-id <id> --container-id <id|GTM-XXXX> --workspace-name <name> [--json]
  list-workspaces --account-id <id> --container-id <id|GTM-XXXX> [--json]
  create-version --account-id <id> --container-id <id|GTM-XXXX> --workspace-name <name> [--version-name <name>] [--notes <text>] [--json]
  publish-version --version-path <accounts/.../containers/.../versions/...> --confirm [--json]
  live-version --account-id <id> --container-id <id|GTM-XXXX> [--json]
  get-version --version-path <accounts/.../containers/.../versions/...> [--json]
  list-environments --account-id <id> --container-id <id|GTM-XXXX> [--json]
  get-environment --environment-path <accounts/.../containers/.../environments/...> [--json]
  create-environment --account-id <id> --container-id <id|GTM-XXXX> --name <name> [--type USER] [--url <url>] [--enable-debug true|false] [--description <text>] [--json]
  update-environment --environment-path <accounts/.../containers/.../environments/...> [--name <name>] [--url <url>] [--enable-debug true|false] [--description <text>] [--container-version-id <id>] [--workspace-id <id>] [--json]
  promote-environment --environment-path <accounts/.../containers/.../environments/...> --version-path <accounts/.../containers/.../versions/...> [--reauthorize] --confirm [--json]
  delete-environment --environment-path <accounts/.../containers/.../environments/...> --confirm
  delete-workspace --workspace-path <accounts/.../containers/.../workspaces/...> --confirm
  reset-workspace --account-id <id> --container-id <id|GTM-XXXX> --workspace-name <name> --confirm [--json]
  export-workspace --account-id <id> --container-id <id|GTM-XXXX> --workspace-name <name> [--out <file>] [--json]
  diff-workspace --account-id <id> --container-id <id|GTM-XXXX> --workspace-name <name> --config <file> [--json]
  diff-live --account-id <id> --container-id <id|GTM-XXXX> --config <file> [--json]
  sync-workspace --account-id <id> --container-id <id|GTM-XXXX> --workspace-name <name> --config <file> [--delete-missing --confirm] [--json]
  hash-config --config <file>
  diff-repo --config <file[,overlay...]> [--container-keys a,b] [--labels k=v,k2=v2] [--json]
  sync-repo --config <file[,overlay...]> [--container-keys a,b] [--labels k=v] [--delete-missing --confirm] [--publish --confirm] [--json]

Examples:
  npm run cli -- list-accounts --json
  npm run cli -- list-user-permissions --account-id 1234567890 --json
  npm run cli -- get-user-permission --user-permission-path accounts/123/user_permissions/456 --json
  npm run cli -- list-containers --account-id 1234567890 --json
  npm run cli -- ensure-workspace --account-id 1234567890 --container-id 51955729 --workspace-name Automation-Test --json
  npm run cli -- list-workspaces --account-id 1234567890 --container-id 51955729 --json
  npm run cli -- create-version --account-id 1234567890 --container-id 51955729 --workspace-name Automation-Test --version-name "IaC Release" --notes "Automated publish" --json
  npm run cli -- publish-version --version-path accounts/123/containers/456/versions/7 --confirm --json
  npm run cli -- live-version --account-id 123 --container-id 456 --json
  npm run cli -- get-version --version-path accounts/123/containers/456/versions/7 --json
  npm run cli -- list-environments --account-id 123 --container-id 456 --json
  npm run cli -- create-environment --account-id 123 --container-id 456 --name "Staging" --type USER --url "https://example.com" --enable-debug true --json
  npm run cli -- get-environment --environment-path accounts/123/containers/456/environments/7 --json
  npm run cli -- update-environment --environment-path accounts/123/containers/456/environments/7 --enable-debug false --json
  npm run cli -- promote-environment --environment-path accounts/123/containers/456/environments/7 --version-path accounts/123/containers/456/versions/11 --reauthorize --confirm --json
  npm run cli -- delete-environment --environment-path accounts/123/containers/456/environments/7 --confirm
  npm run cli -- delete-workspace --workspace-path accounts/123/containers/456/workspaces/999 --confirm
  npm run cli -- reset-workspace --account-id 1234567890 --container-id 51955729 --workspace-name Automation-Test --confirm --json
  npm run cli -- export-workspace --account-id 1234567890 --container-id 51955729 --workspace-name Automation-Test --out ./workspace.snapshot.json
  npm run cli -- diff-workspace --account-id 1234567890 --container-id 51955729 --workspace-name Automation-Test --config ./desired.workspace.json --json
  npm run cli -- diff-live --account-id 1234567890 --container-id 51955729 --config ./desired.workspace.json --json
  npm run cli -- sync-workspace --account-id 1234567890 --container-id 51955729 --workspace-name Automation-Test --config ./desired.workspace.json --dry-run --json
  npm run cli -- hash-config --config ./desired.workspace.json --json
  npm run cli -- diff-repo --config ./gtm.repo.yml --labels env=prod --fail-on-drift --json
  npm run cli -- sync-repo --config ./gtm.repo.yml --container-keys site_a,site_b --dry-run --json

Diff flags:
  --fail-on-drift   Exit non-zero when drift detected
  --ignore-deletes  Ignore deletions when evaluating drift

Sync flags:
  --validate-variable-refs  Best-effort check for {{Variable}} references
`);
}

function getStringFlag(flags: Record<string, FlagValue>, key: string): string | undefined {
  const v = flags[key];
  return typeof v === "string" && v.length ? v : undefined;
}

function getBooleanFlag(flags: Record<string, FlagValue>, key: string): boolean | undefined {
  const v = flags[key];
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (s === "true" || s === "1" || s === "yes") return true;
    if (s === "false" || s === "0" || s === "no") return false;
  }
  return undefined;
}

function parseCsv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseLabelsFilter(value: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const token of parseCsv(value)) {
    const idx = token.indexOf("=");
    if (idx < 0) {
      throw new Error(`Invalid label filter "${token}" (expected key=value).`);
    }
    const k = token.slice(0, idx).trim();
    const v = token.slice(idx + 1).trim();
    if (!k || !v) {
      throw new Error(`Invalid label filter "${token}" (expected key=value).`);
    }
    out[k] = v;
  }
  return out;
}

function resolvePathWithinWorkspace(inputPath: string, fieldName: string): string {
  const candidate = inputPath.trim();
  if (!candidate || candidate.includes("\0") || candidate.includes("\n") || candidate.includes("\r")) {
    throw new Error(`Invalid ${fieldName} path: "${inputPath}"`);
  }

  const resolved = path.normalize(path.resolve(WORKSPACE_ROOT, candidate));
  if (resolved !== WORKSPACE_ROOT && !resolved.startsWith(WORKSPACE_ROOT_WITH_SEP)) {
    throw new Error(`${fieldName} must be within workspace root: "${inputPath}"`);
  }
  return resolved;
}

function matchesLabels(labels: Record<string, string> | undefined, filter: Record<string, string>): boolean {
  if (Object.keys(filter).length === 0) return true;
  const l = labels ?? {};
  for (const [k, v] of Object.entries(filter)) {
    if (l[k] !== v) return false;
  }
  return true;
}

function toLocator(target: {
  accountId?: string | undefined;
  accountName?: string | undefined;
  containerId?: string | undefined;
  containerPublicId?: string | undefined;
  containerName?: string | undefined;
}): AccountContainerLocator {
  return {
    ...(target.accountId ? { accountId: target.accountId } : {}),
    ...(target.accountName ? { accountName: target.accountName } : {}),
    ...(target.containerId ? { containerId: target.containerId } : {}),
    ...(target.containerPublicId ? { containerPublicId: target.containerPublicId } : {}),
    ...(target.containerName ? { containerName: target.containerName } : {})
  };
}

interface RepoSyncResultItem {
  key: string;
  labels: Record<string, string>;
  workspacePath?: string;
  sync?: unknown;
  version?: { versionPath?: string; publishedPath?: string };
  error?: string;
}

type RepoContainerConfig = Awaited<ReturnType<typeof loadRepoConfig>>["containers"][number];

function hasEntityDiffChanges(diff: { create: string[]; update: string[]; delete: string[] }): boolean {
  return diff.create.length > 0 || diff.update.length > 0 || diff.delete.length > 0;
}

function hasWorkspaceDrift(diff: ReturnType<typeof diffWorkspace>): boolean {
  return [
    diff.environments,
    diff.builtInVariables,
    diff.folders,
    diff.clients,
    diff.transformations,
    diff.tags,
    diff.triggers,
    diff.variables,
    diff.templates,
    diff.zones
  ].some(hasEntityDiffChanges);
}

function stableStringForHash(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "[unserializable-template-data]";
  }
}

function selectRepoContainers(
  containers: RepoContainerConfig[],
  containerKeys: string[],
  labels: Record<string, string>
): RepoContainerConfig[] {
  const keysFilter = new Set(containerKeys.map((key) => key.toLowerCase()));
  return containers.filter((container) => {
    if (keysFilter.size === 0) {
      return matchesLabels(container.labels ?? {}, labels);
    }
    return keysFilter.has(container.key.toLowerCase()) && matchesLabels(container.labels ?? {}, labels);
  });
}

function buildVersionCreateOptions(opts: { versionName?: string; notes?: string }): { name?: string; notes?: string } {
  const out: { name?: string; notes?: string } = {};
  if (opts.versionName) out.name = opts.versionName;
  if (opts.notes) out.notes = opts.notes;
  return out;
}

async function getLiveDriftBlockResult(
  gtm: GtmClient,
  containerPath: string,
  workspace: RepoContainerConfig["workspace"],
  opts: { blockOnLiveDrift: boolean; force: boolean; dryRun: boolean }
): Promise<{ blocked: boolean; versionPath?: string }> {
  if (!opts.blockOnLiveDrift || opts.force || opts.dryRun) {
    return { blocked: false };
  }
  const live = await gtm.getLiveContainerVersion(containerPath);
  const liveSnapshot = snapshotFromContainerVersion(live);
  liveSnapshot.environments = await gtm.listEnvironments(containerPath);
  const liveDiff = diffWorkspace(workspace, liveSnapshot);
  if (!hasWorkspaceDrift(liveDiff)) {
    return { blocked: false };
  }
  const versionPath = live.path ?? undefined;
  return versionPath ? { blocked: true, versionPath } : { blocked: true };
}

async function syncSingleRepoContainer(
  gtm: GtmClient,
  container: RepoContainerConfig,
  opts: {
    deleteMissing: boolean;
    dryRun: boolean;
    validateVariableRefs: boolean;
    blockOnLiveDrift: boolean;
    force: boolean;
    publish: boolean;
    versionName?: string;
    notes?: string;
  }
): Promise<RepoSyncResultItem> {
  const labels = container.labels ?? {};
  const { accountId, containerId } = await gtm.resolveAccountAndContainer(toLocator(container.target));
  const containerPath = gtm.toContainerPath(accountId, containerId);

  const liveDriftResult = await getLiveDriftBlockResult(gtm, containerPath, container.workspace, opts);
  if (liveDriftResult.blocked) {
    return {
      key: container.key,
      labels,
      error: "Live published version differs from desired state; refusing to sync without --force. Run diff-live for details.",
      ...(liveDriftResult.versionPath ? { version: { versionPath: liveDriftResult.versionPath } } : {})
    };
  }

  const ws = await gtm.getOrCreateWorkspace({
    accountId,
    containerId,
    workspaceName: container.workspace.workspaceName
  });
  if (!ws.workspaceId) {
    throw new Error("Workspace response missing workspaceId.");
  }

  const workspacePath = gtm.toWorkspacePath(accountId, containerId, ws.workspaceId);
  const sync = await syncWorkspace(gtm, workspacePath, container.workspace, {
    dryRun: opts.dryRun,
    deleteMissing: opts.deleteMissing,
    updateExisting: true,
    validateVariableRefs: opts.validateVariableRefs
  });

  const result: RepoSyncResultItem = {
    key: container.key,
    labels,
    workspacePath,
    sync
  };

  if (opts.publish && !opts.dryRun) {
    const versionOptions = buildVersionCreateOptions(opts);
    const created = await gtm.createContainerVersionFromWorkspace(workspacePath, versionOptions);
    const versionPath = created.containerVersion?.path ?? undefined;
    if (!versionPath) {
      throw new Error("Version creation did not return containerVersion.path.");
    }
    const published = await gtm.publishContainerVersion(versionPath);
    result.version = {
      versionPath,
      publishedPath: published.containerVersion?.path ?? versionPath
    };
  }

  return result;
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

async function listUserPermissions(gtm: GtmClient, accountId: string, asJson: boolean): Promise<void> {
  const perms = await gtm.listUserPermissions(accountId);
  if (asJson) {
    console.log(JSON.stringify(perms, null, 2));
    return;
  }
  for (const p of perms) {
    const email = p.emailAddress ?? "?";
    console.log(`${email}\tpath=${p.path ?? "?"}`);
  }
}

async function getUserPermission(gtm: GtmClient, userPermissionPath: string, asJson: boolean): Promise<void> {
  const perm = await gtm.getUserPermission(userPermissionPath);
  if (asJson) {
    console.log(JSON.stringify(perm, null, 2));
    return;
  }
  console.log(`email=${perm.emailAddress ?? "?"}\tpath=${perm.path ?? "?"}`);
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
  asJson: boolean,
  dryRun: boolean
): Promise<void> {
  const { accountId, containerId } = await gtm.resolveAccountAndContainer(locator);
  const containerPath = gtm.toContainerPath(accountId, containerId);

  const workspaces = await gtm.listWorkspaces(containerPath);
  const existing = workspaces.find((w) => (w.name ?? "").toLowerCase() === workspaceName.toLowerCase());

  if (existing) {
    if (asJson) {
      console.log(JSON.stringify(existing, null, 2));
      return;
    }
    console.log(`workspaceId=${existing.workspaceId ?? "?"}\tname=${existing.name ?? "?"}`);
    return;
  }

  if (dryRun) {
    const msg = { dryRun: true, action: "createWorkspace", containerPath, workspaceName };
    if (asJson) {
      console.log(JSON.stringify(msg, null, 2));
    } else {
      console.log(`dry-run: would create workspace name="${workspaceName}" in ${containerPath}`);
    }
    return;
  }

  const workspace = await gtm.createWorkspace(containerPath, workspaceName);

  if (asJson) {
    console.log(JSON.stringify(workspace, null, 2));
    return;
  }

  console.log(`workspaceId=${workspace.workspaceId ?? "?"}\tname=${workspace.name ?? "?"}`);
}

async function listWorkspaces(gtm: GtmClient, locator: AccountContainerLocator, asJson: boolean): Promise<void> {
  const { accountId, containerId } = await gtm.resolveAccountAndContainer(locator);
  const containerPath = gtm.toContainerPath(accountId, containerId);
  const workspaces = await gtm.listWorkspaces(containerPath);

  if (asJson) {
    console.log(JSON.stringify(workspaces, null, 2));
    return;
  }

  for (const w of workspaces) {
    console.log(`${w.name ?? "?"}\tworkspaceId=${w.workspaceId ?? "?"}`);
  }
}

async function createVersionFromWorkspace(
  gtm: GtmClient,
  locator: AccountContainerLocator,
  workspaceName: string,
  options: { versionName?: string; notes?: string },
  asJson: boolean,
  dryRun: boolean
): Promise<void> {
  const { accountId, containerId } = await gtm.resolveAccountAndContainer(locator);
  const containerPath = gtm.toContainerPath(accountId, containerId);

  const workspaces = await gtm.listWorkspaces(containerPath);
  let workspace = workspaces.find((w) => (w.name ?? "").toLowerCase() === workspaceName.toLowerCase());

  if (!workspace && dryRun) {
    const msg = { dryRun: true, action: "createVersion", note: "workspace does not exist", containerPath, workspaceName };
    if (asJson) {
      console.log(JSON.stringify(msg, null, 2));
    } else {
      console.log(`dry-run: would create version, but workspace "${workspaceName}" does not exist in ${containerPath}`);
    }
    return;
  }

  if (!workspace) {
    workspace = await gtm.createWorkspace(containerPath, workspaceName);
  }

  if (!workspace.workspaceId) throw new Error("Workspace response missing workspaceId.");

  const workspacePath = gtm.toWorkspacePath(accountId, containerId, workspace.workspaceId);
  const versionOptions: { name?: string; notes?: string } = {};
  if (options.versionName) versionOptions.name = options.versionName;
  if (options.notes) versionOptions.notes = options.notes;

  if (dryRun) {
    const msg = { dryRun: true, action: "createContainerVersionFromWorkspace", workspacePath, ...versionOptions };
    if (asJson) {
      console.log(JSON.stringify(msg, null, 2));
    } else {
      console.log(`dry-run: would create container version from ${workspacePath}`);
    }
    return;
  }

  const res = await gtm.createContainerVersionFromWorkspace(workspacePath, versionOptions);

  if (asJson) {
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  const versionPath = res.containerVersion?.path ?? "?";
  const versionName = res.containerVersion?.name ?? "?";
  const versionId = res.containerVersion?.containerVersionId ?? "?";
  console.log(`created versionId=${versionId}\tname=${versionName}\tpath=${versionPath}`);
}

async function publishVersion(
  gtm: GtmClient,
  containerVersionPath: string,
  asJson: boolean,
  dryRun: boolean
): Promise<void> {
  if (dryRun) {
    const msg = { dryRun: true, action: "publishContainerVersion", containerVersionPath };
    if (asJson) {
      console.log(JSON.stringify(msg, null, 2));
    } else {
      console.log(`dry-run: would publish version path=${containerVersionPath}`);
    }
    return;
  }

  const res = await gtm.publishContainerVersion(containerVersionPath);
  if (asJson) {
    console.log(JSON.stringify(res, null, 2));
    return;
  }
  const versionPath = res.containerVersion?.path ?? "?";
  const versionName = res.containerVersion?.name ?? "?";
  const versionId = res.containerVersion?.containerVersionId ?? "?";
  console.log(`published versionId=${versionId}\tname=${versionName}\tpath=${versionPath}`);
}

async function liveVersion(gtm: GtmClient, locator: AccountContainerLocator, asJson: boolean): Promise<void> {
  const { accountId, containerId } = await gtm.resolveAccountAndContainer(locator);
  const containerPath = gtm.toContainerPath(accountId, containerId);
  const version = await gtm.getLiveContainerVersion(containerPath);

  if (asJson) {
    console.log(JSON.stringify(version, null, 2));
    return;
  }
  console.log(
    `live versionId=${version.containerVersionId ?? "?"}\tname=${version.name ?? "?"}\tpath=${version.path ?? "?"}`
  );
}

async function getVersion(gtm: GtmClient, versionPath: string, asJson: boolean): Promise<void> {
  const version = await gtm.getContainerVersion(versionPath);
  if (asJson) {
    console.log(JSON.stringify(version, null, 2));
    return;
  }
  console.log(`versionId=${version.containerVersionId ?? "?"}\tname=${version.name ?? "?"}\tpath=${version.path ?? "?"}`);
}

async function listEnvironments(gtm: GtmClient, locator: AccountContainerLocator, asJson: boolean): Promise<void> {
  const { accountId, containerId } = await gtm.resolveAccountAndContainer(locator);
  const containerPath = gtm.toContainerPath(accountId, containerId);
  const envs = await gtm.listEnvironments(containerPath);

  if (asJson) {
    console.log(JSON.stringify(envs, null, 2));
    return;
  }

  for (const e of envs) {
    console.log(`${e.name ?? "?"}\tenvironmentId=${e.environmentId ?? "?"}\ttype=${e.type ?? "?"}\turl=${e.url ?? "?"}`);
  }
}

async function getEnvironment(gtm: GtmClient, environmentPath: string, asJson: boolean): Promise<void> {
  const env = await gtm.getEnvironment(environmentPath);
  if (asJson) {
    console.log(JSON.stringify(env, null, 2));
    return;
  }
  console.log(`environmentId=${env.environmentId ?? "?"}\tname=${env.name ?? "?"}\ttype=${env.type ?? "?"}`);
}

async function createEnvironment(
  gtm: GtmClient,
  locator: AccountContainerLocator,
  env: GtmEnvironment,
  asJson: boolean,
  dryRun: boolean
): Promise<void> {
  const { accountId, containerId } = await gtm.resolveAccountAndContainer(locator);
  const containerPath = gtm.toContainerPath(accountId, containerId);

  if (dryRun) {
    console.log(JSON.stringify({ dryRun: true, action: "createEnvironment", containerPath, environment: env }, null, 2));
    return;
  }

  const created = await gtm.createEnvironment(containerPath, env);
  if (asJson) {
    console.log(JSON.stringify(created, null, 2));
    return;
  }
  console.log(`created environmentId=${created.environmentId ?? "?"}\tname=${created.name ?? "?"}\tpath=${created.path ?? "?"}`);
}

async function updateEnvironment(
  gtm: GtmClient,
  environmentPath: string,
  patch: GtmEnvironment,
  asJson: boolean,
  dryRun: boolean
): Promise<void> {
  if (dryRun) {
    console.log(JSON.stringify({ dryRun: true, action: "updateEnvironment", environmentPath, patch }, null, 2));
    return;
  }

  // Merge with current to avoid accidental field loss if the endpoint behaves like PUT.
  const current = await gtm.getEnvironment(environmentPath);
  const base: GtmEnvironment = {};
  if (current.name != null) base.name = current.name;
  if (current.type != null) base.type = current.type;
  if (current.description != null) base.description = current.description;
  if (current.url != null) base.url = current.url;
  if (current.enableDebug != null) base.enableDebug = current.enableDebug;
  if (current.containerVersionId != null) base.containerVersionId = current.containerVersionId;
  if (current.workspaceId != null) base.workspaceId = current.workspaceId;

  const merged: GtmEnvironment = { ...base, ...patch };
  const fingerprint = current.fingerprint ?? undefined;
  const updated = await gtm.updateEnvironment(environmentPath, merged, fingerprint ? { fingerprint } : {});

  if (asJson) {
    console.log(JSON.stringify(updated, null, 2));
    return;
  }
  console.log(`updated environmentId=${updated.environmentId ?? "?"}\tname=${updated.name ?? "?"}\tpath=${updated.path ?? "?"}`);
}

async function promoteEnvironment(
  gtm: GtmClient,
  environmentPath: string,
  versionPath: string,
  options: { reauthorize: boolean },
  asJson: boolean,
  dryRun: boolean
): Promise<void> {
  if (dryRun) {
    console.log(
      JSON.stringify(
        {
          dryRun: true,
          action: "promoteEnvironment",
          environmentPath,
          versionPath,
          reauthorize: options.reauthorize
        },
        null,
        2
      )
    );
    return;
  }

  const version = await gtm.getContainerVersion(versionPath);
  const containerVersionId = version.containerVersionId ?? undefined;
  if (!containerVersionId) {
    throw new Error(`Version payload missing containerVersionId: path=${versionPath}`);
  }

  const current = await gtm.getEnvironment(environmentPath);
  const patch: GtmEnvironment = { containerVersionId };
  if (current.name != null) patch.name = current.name;
  if (current.type != null) patch.type = current.type;
  if (current.description != null) patch.description = current.description;
  if (current.url != null) patch.url = current.url;
  if (current.enableDebug === true || current.enableDebug === false) {
    patch.enableDebug = current.enableDebug;
  }
  if (current.workspaceId != null) patch.workspaceId = current.workspaceId;

  const fingerprint = current.fingerprint ?? undefined;
  const updated = await gtm.updateEnvironment(environmentPath, patch, fingerprint ? { fingerprint } : {});
  const finalEnv =
    options.reauthorize && (updated.path ?? environmentPath)
      ? await gtm.reauthorizeEnvironment(updated.path ?? environmentPath)
      : updated;

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          promotedToVersion: {
            path: versionPath,
            containerVersionId
          },
          environment: finalEnv
        },
        null,
        2
      )
    );
    return;
  }

  console.log(
    `promoted environmentId=${finalEnv.environmentId ?? "?"}\tname=${finalEnv.name ?? "?"}\tcontainerVersionId=${containerVersionId}`
  );
}

async function deleteEnvironment(gtm: GtmClient, environmentPath: string, dryRun: boolean): Promise<void> {
  if (dryRun) {
    console.log(JSON.stringify({ dryRun: true, action: "deleteEnvironment", environmentPath }));
    return;
  }
  await gtm.deleteEnvironment(environmentPath);
  console.log(`deleted environment path=${environmentPath}`);
}

async function deleteWorkspace(gtm: GtmClient, workspacePath: string, dryRun: boolean): Promise<void> {
  if (dryRun) {
    console.log(JSON.stringify({ dryRun: true, action: "deleteWorkspace", workspacePath }));
    return;
  }
  await gtm.deleteWorkspace(workspacePath);
  console.log(`deleted workspace path=${workspacePath}`);
}

function resolveWorkspacePath(
  gtm: GtmClient,
  accountId: string,
  containerId: string,
  workspace: { path?: string | null; workspaceId?: string | null }
): string | undefined {
  if (workspace.path) {
    return workspace.path;
  }
  if (workspace.workspaceId) {
    return gtm.toWorkspacePath(accountId, containerId, workspace.workspaceId);
  }
  return undefined;
}

function printResetWorkspaceDryRun(
  asJson: boolean,
  payload: Record<string, unknown>,
  fallbackMessage: string
): void {
  if (asJson) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  console.log(fallbackMessage);
}

async function resetWorkspace(
  gtm: GtmClient,
  locator: AccountContainerLocator,
  workspaceName: string,
  asJson: boolean,
  dryRun: boolean
): Promise<void> {
  if (workspaceName.toLowerCase() === "default workspace") {
    throw new Error("Refusing to reset the Default Workspace.");
  }

  const { accountId, containerId } = await gtm.resolveAccountAndContainer(locator);
  const containerPath = gtm.toContainerPath(accountId, containerId);

  const workspaces = await gtm.listWorkspaces(containerPath);
  const existing = workspaces.find((w) => (w.name ?? "").toLowerCase() === workspaceName.toLowerCase());
  const existingPath = existing ? resolveWorkspacePath(gtm, accountId, containerId, existing) : undefined;
  if (existingPath && dryRun) {
    printResetWorkspaceDryRun(
      asJson,
      { dryRun: true, action: "resetWorkspace", note: "would delete existing workspace", workspacePath: existingPath },
      `dry-run: would delete workspace path=${existingPath}`
    );
    return;
  }
  if (existingPath) {
    await gtm.deleteWorkspace(existingPath);
  }

  if (dryRun) {
    printResetWorkspaceDryRun(
      asJson,
      { dryRun: true, action: "resetWorkspace", note: "would create workspace", containerPath, workspaceName },
      `dry-run: would create workspace name="${workspaceName}" in ${containerPath}`
    );
    return;
  }

  const created = await gtm.createWorkspace(containerPath, workspaceName);
  if (asJson) {
    console.log(JSON.stringify(created, null, 2));
    return;
  }
  console.log(`workspaceId=${created.workspaceId ?? "?"}\tname=${created.name ?? "?"}`);
}

async function resolveWorkspacePathByName(
  gtm: GtmClient,
  locator: AccountContainerLocator,
  workspaceName: string
): Promise<{ accountId: string; containerId: string; containerPath: string; workspacePath: string }> {
  const { accountId, containerId } = await gtm.resolveAccountAndContainer(locator);
  const containerPath = gtm.toContainerPath(accountId, containerId);
  const workspaces = await gtm.listWorkspaces(containerPath);
  const workspace = workspaces.find((w) => (w.name ?? "").toLowerCase() === workspaceName.toLowerCase());
  if (!workspace?.workspaceId) {
    throw new Error(`Workspace not found in container (${containerPath}): name="${workspaceName}"`);
  }
  const workspacePath = workspace.path ?? gtm.toWorkspacePath(accountId, containerId, workspace.workspaceId);
  return { accountId, containerId, containerPath, workspacePath };
}

async function exportWorkspaceSnapshot(
  gtm: GtmClient,
  locator: AccountContainerLocator,
  workspaceName: string,
  outPath: string | undefined,
  asJson: boolean
): Promise<void> {
  const { workspacePath } = await resolveWorkspacePathByName(gtm, locator, workspaceName);
  const snapshot = await fetchWorkspaceSnapshot(gtm, workspacePath);

  const desiredLike = {
    workspaceName,
    environments: snapshot.environments.map((e) => normalizeForDiff(e)),
    builtInVariableTypes: snapshot.builtInVariables
      .map((v) => v.type)
      .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
      .sort((a, b) => a.localeCompare(b)),
    folders: snapshot.folders.map((f) => normalizeForDiff(f)),
    clients: snapshot.clients.map((c) => normalizeForDiff(c)),
    transformations: snapshot.transformations.map((t) => normalizeForDiff(t)),
    tags: snapshot.tags.map((t) => normalizeForDiff(t)),
    triggers: snapshot.triggers.map((t) => normalizeForDiff(t)),
    variables: snapshot.variables.map((v) => normalizeForDiff(v)),
    templates: snapshot.templates.map((t) => normalizeForDiff(t)),
    zones: snapshot.zones.map((z) => normalizeForDiff(z))
  };

  const json = JSON.stringify(desiredLike, null, 2);

  if (outPath) {
    const resolved = resolvePathWithinWorkspace(outPath, "out");
    await fs.writeFile(resolved, json, "utf-8");
    if (!asJson) {
      console.log(`wrote ${resolved}`);
    }
    return;
  }

  console.log(json);
}

async function diffWorkspaceFromConfig(
  gtm: GtmClient,
  locator: AccountContainerLocator,
  workspaceName: string,
  configPath: string,
  options: { failOnDrift: boolean; ignoreDeletes: boolean },
  asJson: boolean
): Promise<void> {
  const desired = await loadWorkspaceDesiredState(configPath);
  const { workspacePath } = await resolveWorkspacePathByName(gtm, locator, workspaceName);
  const snapshot = await fetchWorkspaceSnapshot(gtm, workspacePath);
  const diff = diffWorkspace(desired, snapshot);

  if (options.ignoreDeletes) {
    diff.environments.delete = [];
    diff.builtInVariables.delete = [];
    diff.folders.delete = [];
    diff.clients.delete = [];
    diff.transformations.delete = [];
    diff.tags.delete = [];
    diff.triggers.delete = [];
    diff.variables.delete = [];
    diff.templates.delete = [];
    diff.zones.delete = [];
  }

  const hasDrift = hasWorkspaceDrift(diff);

  if (options.failOnDrift && hasDrift) {
    process.exitCode = 2;
  }

  const json = JSON.stringify(diff, null, 2);

  if (asJson) {
    console.log(json);
    return;
  }

  console.log(json);
}

async function diffLiveFromConfig(
  gtm: GtmClient,
  locator: AccountContainerLocator,
  configPath: string,
  options: { failOnDrift: boolean; ignoreDeletes: boolean },
  asJson: boolean
): Promise<void> {
  const desired = await loadWorkspaceDesiredState(configPath);
  const { accountId, containerId } = await gtm.resolveAccountAndContainer(locator);
  const containerPath = gtm.toContainerPath(accountId, containerId);
  const live = await gtm.getLiveContainerVersion(containerPath);
  const snapshot = snapshotFromContainerVersion(live);
  snapshot.environments = await gtm.listEnvironments(containerPath);
  const diff = diffWorkspace(desired, snapshot);

  if (options.ignoreDeletes) {
    diff.environments.delete = [];
    diff.builtInVariables.delete = [];
    diff.folders.delete = [];
    diff.clients.delete = [];
    diff.transformations.delete = [];
    diff.tags.delete = [];
    diff.triggers.delete = [];
    diff.variables.delete = [];
    diff.templates.delete = [];
    diff.zones.delete = [];
  }

  const hasDrift = hasWorkspaceDrift(diff);

  if (options.failOnDrift && hasDrift) {
    process.exitCode = 2;
  }

  const json = JSON.stringify(
    {
      liveVersion: {
        containerVersionId: live.containerVersionId ?? null,
        name: live.name ?? null,
        path: live.path ?? null
      },
      diff
    },
    null,
    2
  );

  // For now this command is JSON-first since it is typically used in CI.
  console.log(json);
  if (!asJson) return;
}

async function diffRepoFromConfig(
  gtm: GtmClient,
  configPaths: string,
  options: { containerKeys: string[]; labels: Record<string, string>; failOnDrift: boolean; ignoreDeletes: boolean },
  asJson: boolean
): Promise<void> {
  const repo = await loadRepoConfig(configPaths);

  const keysFilter = new Set(options.containerKeys.map((k) => k.toLowerCase()));

  const selected = repo.containers.filter((c) => {
    if (keysFilter.size && !keysFilter.has(c.key.toLowerCase())) return false;
    return matchesLabels(c.labels ?? {}, options.labels);
  });

  const results: Array<{
    key: string;
    labels: Record<string, string>;
    workspaceName: string;
    workspacePath?: string;
    diff?: unknown;
    error?: string;
  }> = [];

  let hadError = false;
  let hadDrift = false;

  for (const c of selected) {
    try {
      const { workspacePath } = await resolveWorkspacePathByName(
        gtm,
        toLocator(c.target),
        c.workspace.workspaceName
      );

      const snapshot = await fetchWorkspaceSnapshot(gtm, workspacePath);
      const diff = diffWorkspace(c.workspace, snapshot);
      if (options.ignoreDeletes) {
        diff.environments.delete = [];
        diff.builtInVariables.delete = [];
        diff.folders.delete = [];
        diff.clients.delete = [];
        diff.transformations.delete = [];
        diff.tags.delete = [];
        diff.triggers.delete = [];
        diff.variables.delete = [];
        diff.templates.delete = [];
        diff.zones.delete = [];
      }

      const drift = [
        diff.environments,
        diff.builtInVariables,
        diff.folders,
        diff.clients,
        diff.transformations,
        diff.tags,
        diff.triggers,
        diff.variables,
        diff.templates,
        diff.zones
      ].some((d) => d.create.length > 0 || d.update.length > 0 || d.delete.length > 0);
      if (drift) hadDrift = true;

      results.push({
        key: c.key,
        labels: c.labels ?? {},
        workspaceName: c.workspace.workspaceName,
        workspacePath,
        diff
      });
    } catch (err: unknown) {
      hadError = true;
      results.push({
        key: c.key,
        labels: c.labels ?? {},
        workspaceName: c.workspace.workspaceName,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  if (options.failOnDrift && hadDrift) {
    process.exitCode = 2;
  }
  if (hadError) {
    process.exitCode = 1;
  }

  const payload = {
    schemaVersion: repo.schemaVersion,
    defaults: repo.defaults,
    selectedCount: selected.length,
    results
  };

  const json = JSON.stringify(payload, null, 2);
  console.log(json);
  if (!asJson) return;
}

async function syncWorkspaceFromConfig(
  gtm: GtmClient,
  locator: AccountContainerLocator,
  workspaceName: string,
  configPath: string,
  opts: {
    deleteMissing: boolean;
    dryRun: boolean;
    updateExisting: boolean;
    validateVariableRefs: boolean;
    blockOnLiveDrift: boolean;
    force: boolean;
  },
  asJson: boolean
): Promise<void> {
  const desired = await loadWorkspaceDesiredState(configPath);
  const { containerPath, workspacePath } = await resolveWorkspacePathByName(gtm, locator, workspaceName);

  if (opts.blockOnLiveDrift && !opts.force && !opts.dryRun) {
    const live = await gtm.getLiveContainerVersion(containerPath);
    const liveSnapshot = snapshotFromContainerVersion(live);
    liveSnapshot.environments = await gtm.listEnvironments(containerPath);
    const liveDiff = diffWorkspace(desired, liveSnapshot);
    const hasDrift = hasWorkspaceDrift(liveDiff);
    if (hasDrift) {
      throw new Error(
        `Live published version differs from desired state; refusing to sync without --force. ` +
          `Run: npm run cli -- diff-live --account-id <...> --container-id <...> --config ${configPath}`
      );
    }
  }

  const result = await syncWorkspace(gtm, workspacePath, desired, {
    dryRun: opts.dryRun,
    deleteMissing: opts.deleteMissing,
    updateExisting: opts.updateExisting,
    validateVariableRefs: opts.validateVariableRefs
  });

  const json = JSON.stringify(result, null, 2);
  if (asJson) {
    console.log(json);
    return;
  }
  console.log(json);
}

async function syncRepoFromConfig(
  gtm: GtmClient,
  configPaths: string,
  opts: {
    containerKeys: string[];
    labels: Record<string, string>;
    deleteMissing: boolean;
    dryRun: boolean;
    validateVariableRefs: boolean;
    blockOnLiveDrift: boolean;
    force: boolean;
    publish: boolean;
    versionName?: string;
    notes?: string;
  },
  asJson: boolean
): Promise<void> {
  const repo = await loadRepoConfig(configPaths);
  const selected = selectRepoContainers(repo.containers, opts.containerKeys, opts.labels);
  const results: RepoSyncResultItem[] = [];

  let hadError = false;

  for (const container of selected) {
    try {
      const result = await syncSingleRepoContainer(gtm, container, opts);
      if (result.error) {
        hadError = true;
      }
      results.push(result);
    } catch (err: unknown) {
      hadError = true;
      results.push({
        key: container.key,
        labels: container.labels ?? {},
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  if (hadError) {
    process.exitCode = 1;
  }

  const payload = {
    schemaVersion: repo.schemaVersion,
    defaults: repo.defaults,
    selectedCount: selected.length,
    results
  };

  const json = JSON.stringify(payload, null, 2);
  console.log(json);
  if (!asJson) return;
}

async function hashConfig(configPath: string, asJson: boolean): Promise<void> {
  const desired = await loadWorkspaceDesiredState(configPath);
  const templates = desired.templates.map((t) => ({
    name: t.name,
    sha256: sha256HexFromString(stableStringForHash((t as { templateData?: unknown }).templateData))
  }));

  const out = { workspaceName: desired.workspaceName, templates };
  const json = JSON.stringify(out, null, 2);
  console.log(json);

  if (!asJson) {
    // Human-readable is currently identical JSON.
    return;
  }
}

async function main(): Promise<void> {
  await mainInternal();
}

async function mainInternal(): Promise<void> {
  const parsed = parseCli(process.argv.slice(2));
  if (!parsed.command || parsed.flags.help === true) {
    printHelp();
    return;
  }

  const auth = createGoogleAuth();
  const logger = createLogger({
    level: (process.env.LOG_LEVEL as LogLevel | undefined) ?? "info",
    format: process.env.LOG_FORMAT === "json" ? "json" : "pretty"
  });
  const gtm = new GtmClient(auth, { logger });

  const asJson = isJsonFlagSet(parsed.flags);
  const dryRun = getBooleanFlag(parsed.flags, "dry-run") ?? getBooleanFlag(parsed.flags, "dryRun") ?? false;
  const deleteMissing =
    getBooleanFlag(parsed.flags, "delete-missing") ?? getBooleanFlag(parsed.flags, "deleteMissing") ?? false;
  const failOnDrift =
    getBooleanFlag(parsed.flags, "fail-on-drift") ?? getBooleanFlag(parsed.flags, "failOnDrift") ?? false;
  const ignoreDeletes =
    getBooleanFlag(parsed.flags, "ignore-deletes") ?? getBooleanFlag(parsed.flags, "ignoreDeletes") ?? false;
  const validateVariableRefs =
    getBooleanFlag(parsed.flags, "validate-variable-refs") ??
    getBooleanFlag(parsed.flags, "validateVariableRefs") ??
    false;
  const publish = getBooleanFlag(parsed.flags, "publish") ?? false;
  const blockOnLiveDrift =
    getBooleanFlag(parsed.flags, "block-on-live-drift") ?? getBooleanFlag(parsed.flags, "blockOnLiveDrift") ?? false;
  const force = getBooleanFlag(parsed.flags, "force") ?? false;
  const confirmFlag = getBooleanFlag(parsed.flags, "confirm") ?? getBooleanFlag(parsed.flags, "yes") ?? false;

  switch (parsed.command) {
    case "list-accounts": {
      await listAccounts(gtm, asJson);
      return;
    }
    case "list-user-permissions": {
      const schema = z
        .object({
          accountId: z.string().min(1)
        })
        .strict();

      const args = schema.parse({
        accountId: getStringFlag(parsed.flags, "account-id")
      });

      await listUserPermissions(gtm, args.accountId, asJson);
      return;
    }
    case "get-user-permission": {
      const schema = z
        .object({
          userPermissionPath: z.string().min(1)
        })
        .strict();

      const args = schema.parse({
        userPermissionPath: getStringFlag(parsed.flags, "user-permission-path")
      });

      await getUserPermission(gtm, args.userPermissionPath, asJson);
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
        asJson,
        dryRun
      );
      return;
    }
    case "list-workspaces": {
      const schema = z
        .object({
          accountId: z.string().min(1),
          containerId: z.string().min(1)
        })
        .strict();

      const args = schema.parse({
        accountId: getStringFlag(parsed.flags, "account-id"),
        containerId: getStringFlag(parsed.flags, "container-id")
      });

      await listWorkspaces(
        gtm,
        {
          accountId: args.accountId,
          containerId: args.containerId
        },
        asJson
      );
      return;
    }
    case "create-version": {
      const schema = z
        .object({
          accountId: z.string().min(1),
          containerId: z.string().min(1),
          workspaceName: z.string().min(1),
          versionName: z.string().min(1).optional(),
          notes: z.string().min(1).optional()
        })
        .strict();

      const args = schema.parse({
        accountId: getStringFlag(parsed.flags, "account-id"),
        containerId: getStringFlag(parsed.flags, "container-id"),
        workspaceName: getStringFlag(parsed.flags, "workspace-name"),
        versionName: getStringFlag(parsed.flags, "version-name"),
        notes: getStringFlag(parsed.flags, "notes")
      });

      const versionInput: { versionName?: string; notes?: string } = {};
      if (args.versionName) versionInput.versionName = args.versionName;
      if (args.notes) versionInput.notes = args.notes;

      await createVersionFromWorkspace(
        gtm,
        {
          accountId: args.accountId,
          containerId: args.containerId
        },
        args.workspaceName,
        versionInput,
        asJson,
        dryRun
      );
      return;
    }
    case "publish-version": {
      const schema = z
        .object({
          versionPath: z.string().min(1),
          confirm: z.literal(true)
        })
        .strict();

      const args = schema.parse({
        versionPath: getStringFlag(parsed.flags, "version-path"),
        confirm: dryRun ? true : confirmFlag
      });

      await publishVersion(gtm, args.versionPath, asJson, dryRun);
      return;
    }
    case "live-version": {
      const schema = z
        .object({
          accountId: z.string().min(1),
          containerId: z.string().min(1)
        })
        .strict();

      const args = schema.parse({
        accountId: getStringFlag(parsed.flags, "account-id"),
        containerId: getStringFlag(parsed.flags, "container-id")
      });

      await liveVersion(
        gtm,
        {
          accountId: args.accountId,
          containerId: args.containerId
        },
        asJson
      );
      return;
    }
    case "get-version": {
      const schema = z
        .object({
          versionPath: z.string().min(1)
        })
        .strict();

      const args = schema.parse({
        versionPath: getStringFlag(parsed.flags, "version-path")
      });

      await getVersion(gtm, args.versionPath, asJson);
      return;
    }
    case "list-environments": {
      const schema = z
        .object({
          accountId: z.string().min(1),
          containerId: z.string().min(1)
        })
        .strict();

      const args = schema.parse({
        accountId: getStringFlag(parsed.flags, "account-id"),
        containerId: getStringFlag(parsed.flags, "container-id")
      });

      await listEnvironments(
        gtm,
        { accountId: args.accountId, containerId: args.containerId },
        asJson
      );
      return;
    }
    case "get-environment": {
      const schema = z
        .object({
          environmentPath: z.string().min(1)
        })
        .strict();

      const args = schema.parse({
        environmentPath: getStringFlag(parsed.flags, "environment-path")
      });

      await getEnvironment(gtm, args.environmentPath, asJson);
      return;
    }
    case "create-environment": {
      const schema = z
        .object({
          accountId: z.string().min(1),
          containerId: z.string().min(1),
          name: z.string().min(1),
          type: z.string().min(1).optional(),
          url: z.string().min(1).optional(),
          description: z.string().min(1).optional()
        })
        .strict();

      const args = schema.parse({
        accountId: getStringFlag(parsed.flags, "account-id"),
        containerId: getStringFlag(parsed.flags, "container-id"),
        name: getStringFlag(parsed.flags, "name"),
        type: getStringFlag(parsed.flags, "type"),
        url: getStringFlag(parsed.flags, "url"),
        description: getStringFlag(parsed.flags, "description")
      });

      const enableDebug = getBooleanFlag(parsed.flags, "enable-debug");

      const env: GtmEnvironment = {
        name: args.name,
        type: args.type ?? "USER",
        ...(args.url ? { url: args.url } : {}),
        ...(args.description ? { description: args.description } : {})
      };
      if (enableDebug === true || enableDebug === false) {
        env.enableDebug = enableDebug;
      }

      await createEnvironment(
        gtm,
        { accountId: args.accountId, containerId: args.containerId },
        env,
        asJson,
        dryRun
      );
      return;
    }
    case "update-environment": {
      const schema = z
        .object({
          environmentPath: z.string().min(1),
          name: z.string().min(1).optional(),
          type: z.string().min(1).optional(),
          url: z.string().min(1).optional(),
          description: z.string().min(1).optional(),
          containerVersionId: z.string().min(1).optional(),
          workspaceId: z.string().min(1).optional()
        })
        .strict();

      const args = schema.parse({
        environmentPath: getStringFlag(parsed.flags, "environment-path"),
        name: getStringFlag(parsed.flags, "name"),
        type: getStringFlag(parsed.flags, "type"),
        url: getStringFlag(parsed.flags, "url"),
        description: getStringFlag(parsed.flags, "description"),
        containerVersionId: getStringFlag(parsed.flags, "container-version-id"),
        workspaceId: getStringFlag(parsed.flags, "workspace-id")
      });

      const enableDebug = getBooleanFlag(parsed.flags, "enable-debug");
      const patch: GtmEnvironment = {
        ...(args.name ? { name: args.name } : {}),
        ...(args.type ? { type: args.type } : {}),
        ...(args.url ? { url: args.url } : {}),
        ...(args.description ? { description: args.description } : {}),
        ...(args.containerVersionId ? { containerVersionId: args.containerVersionId } : {}),
        ...(args.workspaceId ? { workspaceId: args.workspaceId } : {})
      };
      if (enableDebug === true || enableDebug === false) {
        patch.enableDebug = enableDebug;
      }

      await updateEnvironment(gtm, args.environmentPath, patch, asJson, dryRun);
      return;
    }
    case "promote-environment": {
      const schema = z
        .object({
          environmentPath: z.string().min(1),
          versionPath: z.string().min(1),
          confirm: z.literal(true)
        })
        .strict();

      const args = schema.parse({
        environmentPath: getStringFlag(parsed.flags, "environment-path"),
        versionPath: getStringFlag(parsed.flags, "version-path"),
        confirm: dryRun ? true : confirmFlag
      });

      await promoteEnvironment(
        gtm,
        args.environmentPath,
        args.versionPath,
        { reauthorize: getBooleanFlag(parsed.flags, "reauthorize") ?? false },
        asJson,
        dryRun
      );
      return;
    }
    case "delete-environment": {
      const schema = z
        .object({
          environmentPath: z.string().min(1),
          confirm: z.literal(true)
        })
        .strict();

      const args = schema.parse({
        environmentPath: getStringFlag(parsed.flags, "environment-path"),
        confirm: confirmFlag
      });

      await deleteEnvironment(gtm, args.environmentPath, dryRun);
      return;
    }
    case "delete-workspace": {
      const schema = z
        .object({
          workspacePath: z.string().min(1),
          confirm: z.literal(true)
        })
        .strict();

      const args = schema.parse({
        workspacePath: getStringFlag(parsed.flags, "workspace-path"),
        confirm: confirmFlag
      });

      await deleteWorkspace(gtm, args.workspacePath, dryRun);
      return;
    }
    case "reset-workspace": {
      const schema = z
        .object({
          accountId: z.string().min(1),
          containerId: z.string().min(1),
          workspaceName: z.string().min(1),
          confirm: z.literal(true)
        })
        .strict();

      const args = schema.parse({
        accountId: getStringFlag(parsed.flags, "account-id"),
        containerId: getStringFlag(parsed.flags, "container-id"),
        workspaceName: getStringFlag(parsed.flags, "workspace-name"),
        confirm: confirmFlag
      });

      await resetWorkspace(
        gtm,
        {
          accountId: args.accountId,
          containerId: args.containerId
        },
        args.workspaceName,
        asJson,
        dryRun
      );
      return;
    }
    case "export-workspace": {
      const schema = z
        .object({
          accountId: z.string().min(1),
          containerId: z.string().min(1),
          workspaceName: z.string().min(1),
          out: z.string().min(1).optional()
        })
        .strict();

      const args = schema.parse({
        accountId: getStringFlag(parsed.flags, "account-id"),
        containerId: getStringFlag(parsed.flags, "container-id"),
        workspaceName: getStringFlag(parsed.flags, "workspace-name"),
        out: getStringFlag(parsed.flags, "out")
      });

      await exportWorkspaceSnapshot(
        gtm,
        {
          accountId: args.accountId,
          containerId: args.containerId
        },
        args.workspaceName,
        args.out,
        asJson
      );
      return;
    }
    case "diff-workspace": {
      const schema = z
        .object({
          accountId: z.string().min(1),
          containerId: z.string().min(1),
          workspaceName: z.string().min(1),
          config: z.string().min(1)
        })
        .strict();

      const args = schema.parse({
        accountId: getStringFlag(parsed.flags, "account-id"),
        containerId: getStringFlag(parsed.flags, "container-id"),
        workspaceName: getStringFlag(parsed.flags, "workspace-name"),
        config: getStringFlag(parsed.flags, "config")
      });

      await diffWorkspaceFromConfig(
        gtm,
        {
          accountId: args.accountId,
          containerId: args.containerId
        },
        args.workspaceName,
        args.config,
        { failOnDrift, ignoreDeletes },
        asJson
      );
      return;
    }
    case "diff-live": {
      const schema = z
        .object({
          accountId: z.string().min(1),
          containerId: z.string().min(1),
          config: z.string().min(1)
        })
        .strict();

      const args = schema.parse({
        accountId: getStringFlag(parsed.flags, "account-id"),
        containerId: getStringFlag(parsed.flags, "container-id"),
        config: getStringFlag(parsed.flags, "config")
      });

      await diffLiveFromConfig(
        gtm,
        {
          accountId: args.accountId,
          containerId: args.containerId
        },
        args.config,
        { failOnDrift, ignoreDeletes },
        asJson
      );
      return;
    }
    case "sync-workspace": {
      const schema = z
        .object({
          accountId: z.string().min(1),
          containerId: z.string().min(1),
          workspaceName: z.string().min(1),
          config: z.string().min(1),
          confirm: z.literal(true)
        })
        .strict();

      const args = schema.parse({
        accountId: getStringFlag(parsed.flags, "account-id"),
        containerId: getStringFlag(parsed.flags, "container-id"),
        workspaceName: getStringFlag(parsed.flags, "workspace-name"),
        config: getStringFlag(parsed.flags, "config"),
        // Require confirmation iff deleteMissing is set.
        confirm: deleteMissing ? confirmFlag : true
      });

      await syncWorkspaceFromConfig(
        gtm,
        {
          accountId: args.accountId,
          containerId: args.containerId
        },
        args.workspaceName,
        args.config,
        {
          deleteMissing,
          dryRun,
          updateExisting: true,
          validateVariableRefs,
          blockOnLiveDrift,
          force
        },
        asJson
      );
      return;
    }
    case "diff-repo": {
      const schema = z
        .object({
          config: z.string().min(1),
          containerKeys: z.string().optional(),
          labels: z.string().optional()
        })
        .strict();

      const args = schema.parse({
        config: getStringFlag(parsed.flags, "config"),
        containerKeys: getStringFlag(parsed.flags, "container-keys"),
        labels: getStringFlag(parsed.flags, "labels")
      });

      await diffRepoFromConfig(
        gtm,
        args.config,
        {
          containerKeys: parseCsv(args.containerKeys),
          labels: parseLabelsFilter(args.labels),
          failOnDrift,
          ignoreDeletes
        },
        asJson
      );
      return;
    }
    case "sync-repo": {
      const schema = z
        .object({
          config: z.string().min(1),
          containerKeys: z.string().optional(),
          labels: z.string().optional(),
          versionName: z.string().min(1).optional(),
          notes: z.string().min(1).optional()
        })
        .strict();

      const args = schema.parse({
        config: getStringFlag(parsed.flags, "config"),
        containerKeys: getStringFlag(parsed.flags, "container-keys"),
        labels: getStringFlag(parsed.flags, "labels"),
        versionName: getStringFlag(parsed.flags, "version-name"),
        notes: getStringFlag(parsed.flags, "notes")
      });

      if ((deleteMissing || publish) && !dryRun && !confirmFlag) {
        throw new Error("Refusing to mutate with deletions/publish without --confirm (or --yes).");
      }

      const repoOpts: {
        containerKeys: string[];
        labels: Record<string, string>;
        deleteMissing: boolean;
        dryRun: boolean;
        validateVariableRefs: boolean;
        blockOnLiveDrift: boolean;
        force: boolean;
        publish: boolean;
        versionName?: string;
        notes?: string;
      } = {
        containerKeys: parseCsv(args.containerKeys),
        labels: parseLabelsFilter(args.labels),
        deleteMissing,
        dryRun,
        validateVariableRefs,
        blockOnLiveDrift,
        force,
        publish
      };
      if (args.versionName) repoOpts.versionName = args.versionName;
      if (args.notes) repoOpts.notes = args.notes;

      await syncRepoFromConfig(
        gtm,
        args.config,
        repoOpts,
        asJson
      );
      return;
    }
    case "hash-config": {
      const schema = z
        .object({
          config: z.string().min(1)
        })
        .strict();

      const args = schema.parse({
        config: getStringFlag(parsed.flags, "config")
      });

      await hashConfig(args.config, asJson);
      return;
    }
    default: {
      printHelp();
      throw new Error(`Unknown command: ${parsed.command}`);
    }
  }
}

async function runCli(): Promise<void> {
  try {
    await main();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Fatal: ${msg}`);
    process.exitCode = 1;
  }
}

void runCli();

