import { google, type tagmanager_v2 } from "googleapis";
import type { GoogleAuth } from "google-auth-library";
import {
  zGtmCustomTemplate,
  zGtmTag,
  zGtmTrigger,
  zGtmVariable,
  type GtmCustomTemplate,
  type GtmTag,
  type GtmTrigger,
  type GtmVariable
} from "../types/gtm-schema";
import type { Logger } from "./logger";
import { isRetryableGoogleApiError, withRetry, type OperationKind, type RetryOptions } from "./retry";

const READ_RETRIES = 4;
const WRITE_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 250;
const RETRY_MAX_DELAY_MS = 8_000;

export interface AccountContainerLocator {
  /**
   * GTM API Account ID (numeric string).
   * Prefer this in automation to avoid ambiguity.
   */
  accountId?: string;

  /**
   * Human-friendly account name as shown in GTM UI (less stable than ID).
   */
  accountName?: string;

  /**
   * Container ID.
   *
   * IMPORTANT: In GTM API v2 this is typically the numeric containerId
   * (not the "GTM-XXXXXX" publicId).
   *
   * This helper accepts either:
   * - numeric containerId (e.g. "51955729"), or
   * - publicId (e.g. "GTM-ABC123") and resolves it.
   */
  containerId?: string;

  /**
   * Container public ID, e.g. "GTM-XXXXXXX".
   */
  containerPublicId?: string;

  /**
   * Human-friendly container name as shown in GTM UI (less stable than ID).
   */
  containerName?: string;
}

export interface ResolvedAccountContainer {
  accountId: string;
  containerId: string;
  accountName?: string;
  containerName?: string;
  containerPublicId?: string;
}

export class GtmClient {
  private readonly api: tagmanager_v2.Tagmanager;
  private readonly logger: Logger | undefined;

  constructor(auth: GoogleAuth, options: { logger?: Logger } = {}) {
    this.api = google.tagmanager({ version: "v2", auth });
    this.logger = options.logger;
  }

  toAccountPath(accountId: string): string {
    return `accounts/${accountId}`;
  }

  toContainerPath(accountId: string, containerId: string): string {
    return `accounts/${accountId}/containers/${containerId}`;
  }

  toWorkspacePath(accountId: string, containerId: string, workspaceId: string): string {
    return `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`;
  }

  private normalizePath(p: string): string {
    return p.replace(/\/+$/, "");
  }

  private childPath(parent: string, resource: string, id: string): string {
    return `${this.normalizePath(parent)}/${resource}/${id}`;
  }

  private formatError(err: unknown): string {
    if (!err || typeof err !== "object") {
      return String(err);
    }

    const anyErr = err as {
      message?: unknown;
      code?: unknown;
      response?: {
        status?: unknown;
        statusText?: unknown;
        data?: unknown;
      };
      errors?: unknown;
    };

    const message = typeof anyErr.message === "string" ? anyErr.message : "Unknown error";
    const status = anyErr.response?.status ?? anyErr.code;
    const statusText = anyErr.response?.statusText;

    // gaxios error shape often includes `response.data.error`.
    const data = anyErr.response?.data as
      | {
          error?: {
            message?: unknown;
            errors?: Array<{ message?: unknown; reason?: unknown; domain?: unknown }>;
          };
        }
      | undefined;

    const apiMessage = typeof data?.error?.message === "string" ? data.error.message : undefined;
    const apiErrors = Array.isArray(data?.error?.errors) ? data?.error?.errors : undefined;

    const apiErrorsSummary =
      apiErrors?.length
        ? `; details=[${apiErrors
            .map((e) => {
              const parts = [
                typeof e.reason === "string" ? `reason=${e.reason}` : undefined,
                typeof e.domain === "string" ? `domain=${e.domain}` : undefined,
                typeof e.message === "string" ? `message=${e.message}` : undefined
              ].filter(Boolean);
              return `{${parts.join(",")}}`;
            })
            .join(", ")}]`
        : "";

    const statusSummary =
      status !== undefined
        ? `status=${String(status)}${typeof statusText === "string" ? ` ${statusText}` : ""}`
        : "status=unknown";

    return `${statusSummary}; message=${apiMessage ?? message}${apiErrorsSummary}`;
  }

  private async request<T>(context: string, fn: () => Promise<{ data: T }>): Promise<T> {
    return await this.requestWithRetry(context, fn, "read");
  }

  private async requestWithRetry<T>(
    context: string,
    fn: () => Promise<{ data: T }>,
    operationKind: OperationKind
  ): Promise<T> {
    try {
      const retries = operationKind === "read" ? READ_RETRIES : WRITE_RETRIES;
      const retryOptions: RetryOptions = {
        retries,
        baseDelayMs: RETRY_BASE_DELAY_MS,
        maxDelayMs: RETRY_MAX_DELAY_MS,
        jitter: true,
        shouldRetry: isRetryableGoogleApiError
      };

      if (this.logger) {
        retryOptions.onRetry = ({ attempt, delayMs, err }) => {
          this.logger.warn(`${context} retrying`, {
            attempt,
            delayMs,
            error: this.formatError(err)
          });
        };
      }

      return await withRetry(async () => {
        const res = await fn();
        return res.data;
      }, retryOptions);
    } catch (err: unknown) {
      throw new Error(`${context} failed: ${this.formatError(err)}`);
    }
  }

  async listAccounts(): Promise<tagmanager_v2.Schema$Account[]> {
    const data = await this.request("GTM accounts.list", () => this.api.accounts.list());
    return data.account ?? [];
  }

  async getAccountIdByName(accountName: string): Promise<string> {
    const accounts = await this.listAccounts();
    const match = accounts.find((a) => (a.name ?? "").toLowerCase() === accountName.toLowerCase());
    if (!match?.accountId) {
      const available = accounts.map((a) => a.name).filter(Boolean).join(", ");
      throw new Error(`Account "${accountName}" not found. Available accounts: [${available}]`);
    }
    return match.accountId;
  }

  async listContainers(accountId: string): Promise<tagmanager_v2.Schema$Container[]> {
    const parent = this.toAccountPath(accountId);
    const data = await this.request("GTM accounts.containers.list", () => this.api.accounts.containers.list({ parent }));
    return data.container ?? [];
  }

  async resolveAccountAndContainer(locator: AccountContainerLocator): Promise<ResolvedAccountContainer> {
    const accountId = locator.accountId ?? (locator.accountName ? await this.getAccountIdByName(locator.accountName) : undefined);
    if (!accountId) {
      throw new Error("Missing account locator. Provide `accountId` or `accountName`.");
    }

    const containers = await this.listContainers(accountId);

    const containerIdCandidate = locator.containerId ?? locator.containerPublicId;
    let container: tagmanager_v2.Schema$Container | undefined;

    // Accept GTM-XXXX (publicId) in `containerId` for convenience.
    if (containerIdCandidate && containerIdCandidate.toUpperCase().startsWith("GTM-")) {
      container = containers.find((c) => (c.publicId ?? "").toUpperCase() === containerIdCandidate.toUpperCase());
    } else if (containerIdCandidate) {
      container = containers.find((c) => c.containerId === containerIdCandidate);
      // Fallback: numeric-looking containerId could still have been a publicId supplied without GTM- prefix (rare).
      if (!container) {
        container = containers.find((c) => c.publicId === containerIdCandidate);
      }
    } else if (locator.containerName) {
      container = containers.find((c) => (c.name ?? "").toLowerCase() === locator.containerName!.toLowerCase());
    }

    if (!container?.containerId) {
      const hints = [
        locator.containerId ? `containerId=${locator.containerId}` : undefined,
        locator.containerPublicId ? `containerPublicId=${locator.containerPublicId}` : undefined,
        locator.containerName ? `containerName=${locator.containerName}` : undefined
      ]
        .filter(Boolean)
        .join(", ");

      const available = containers
        .map((c) => `${c.name ?? "?"} (containerId=${c.containerId ?? "?"}, publicId=${c.publicId ?? "?"})`)
        .join("; ");

      throw new Error(`Container not found (${hints}). Available containers: ${available}`);
    }

    const account = (await this.listAccounts()).find((a) => a.accountId === accountId);

    const resolved: ResolvedAccountContainer = {
      accountId,
      containerId: container.containerId
    };

    const accountName = account?.name ?? locator.accountName;
    if (accountName) {
      resolved.accountName = accountName;
    }

    const containerName = container.name ?? locator.containerName;
    if (containerName) {
      resolved.containerName = containerName;
    }

    const containerPublicId = container.publicId ?? locator.containerPublicId;
    if (containerPublicId) {
      resolved.containerPublicId = containerPublicId;
    }

    return resolved;
  }

  /**
   * Workspaces are required for mutations in GTM API v2.
   *
   * SAFETY: GTM API v2 does not allow editing a container directly; you must
   * create/modify entities in a Workspace, then create a container version and
   * publish it.
   */
  async getOrCreateWorkspace(params: {
    accountId: string;
    containerId: string;
    workspaceName: string;
  }): Promise<tagmanager_v2.Schema$Workspace> {
    const parent = this.toContainerPath(params.accountId, params.containerId);

    const existing = await this.request("GTM workspaces.list", () =>
      this.api.accounts.containers.workspaces.list({ parent })
    );
    const workspaces = existing.workspace ?? [];
    const match = workspaces.find((w) => (w.name ?? "").toLowerCase() === params.workspaceName.toLowerCase());
    if (match) {
      return match;
    }

    return await this.requestWithRetry("GTM workspaces.create", () =>
      this.api.accounts.containers.workspaces.create({
        parent,
        requestBody: {
          name: params.workspaceName
        }
      })
    , "write");
  }

  async listWorkspaces(containerPath: string): Promise<tagmanager_v2.Schema$Workspace[]> {
    const data = await this.request("GTM workspaces.list", () =>
      this.api.accounts.containers.workspaces.list({ parent: containerPath })
    );
    return data.workspace ?? [];
  }

  async createWorkspace(containerPath: string, workspaceName: string): Promise<tagmanager_v2.Schema$Workspace> {
    return await this.requestWithRetry(
      "GTM workspaces.create",
      () =>
        this.api.accounts.containers.workspaces.create({
          parent: containerPath,
          requestBody: { name: workspaceName }
        }),
      "write"
    );
  }

  async getWorkspace(workspacePath: string): Promise<tagmanager_v2.Schema$Workspace> {
    return await this.request("GTM workspaces.get", () =>
      this.api.accounts.containers.workspaces.get({ path: workspacePath })
    );
  }

  async deleteWorkspace(workspacePath: string): Promise<void> {
    await this.requestWithRetry(
      "GTM workspaces.delete",
      () => this.api.accounts.containers.workspaces.delete({ path: workspacePath }),
      "write"
    );
  }

  /**
   * Creates a new container version from the given workspace.
   *
   * Note: version creation may sync the workspace against the latest container
   * version first; inspect the response's `syncStatus`.
   */
  async createContainerVersionFromWorkspace(
    workspacePath: string,
    options: { name?: string; notes?: string } = {}
  ): Promise<tagmanager_v2.Schema$CreateContainerVersionResponse> {
    const requestBody: tagmanager_v2.Schema$CreateContainerVersionRequestVersionOptions = {};
    if (options.name) requestBody.name = options.name;
    if (options.notes) requestBody.notes = options.notes;

    return await this.requestWithRetry(
      "GTM workspaces.create_version",
      () =>
        this.api.accounts.containers.workspaces.create_version({
          path: workspacePath,
          requestBody
        }),
      "write"
    );
  }

  /**
   * Publishes a container version.
   *
   * @param containerVersionPath API path: `accounts/{accountId}/containers/{containerId}/versions/{versionId}`
   */
  async publishContainerVersion(
    containerVersionPath: string
  ): Promise<tagmanager_v2.Schema$PublishContainerVersionResponse> {
    return await this.requestWithRetry(
      "GTM versions.publish",
      () => this.api.accounts.containers.versions.publish({ path: containerVersionPath }),
      "write"
    );
  }

  private async listAllPages<T>(
    context: string,
    fetchPage: (pageToken?: string) => Promise<{ items: T[]; nextPageToken?: string | null | undefined }>
  ): Promise<T[]> {
    const out: T[] = [];
    let pageToken: string | undefined;

    do {
      const page = await fetchPage(pageToken);
      out.push(...page.items);
      pageToken = page.nextPageToken ?? undefined;
    } while (pageToken);

    return out;
  }

  // ----------------------------
  // Tags
  // ----------------------------
  async listTags(workspacePath: string): Promise<tagmanager_v2.Schema$Tag[]> {
    return await this.listAllPages("GTM tags.list", async (pageToken) => {
      const data = await this.request("GTM tags.list", () =>
        this.api.accounts.containers.workspaces.tags.list(
          pageToken === undefined ? { parent: workspacePath } : { parent: workspacePath, pageToken }
        )
      );
      return { items: data.tag ?? [], nextPageToken: data.nextPageToken };
    });
  }

  async createTag(workspacePath: string, tag: GtmTag): Promise<tagmanager_v2.Schema$Tag> {
    const payload = zGtmTag.parse(tag);
    return await this.requestWithRetry("GTM tags.create", () =>
      this.api.accounts.containers.workspaces.tags.create({
        parent: workspacePath,
        requestBody: payload as unknown as tagmanager_v2.Schema$Tag
      })
    , "write");
  }

  async getTag(tagPath: string): Promise<tagmanager_v2.Schema$Tag> {
    return await this.request("GTM tags.get", () => this.api.accounts.containers.workspaces.tags.get({ path: tagPath }));
  }

  async getTagById(workspacePath: string, tagId: string): Promise<tagmanager_v2.Schema$Tag> {
    return await this.getTag(this.childPath(workspacePath, "tags", tagId));
  }

  async updateTag(
    tagPath: string,
    tag: GtmTag,
    options: { fingerprint?: string } = {}
  ): Promise<tagmanager_v2.Schema$Tag> {
    const payload = zGtmTag.parse(tag);
    const params: { path: string; requestBody: tagmanager_v2.Schema$Tag; fingerprint?: string } = {
      path: tagPath,
      requestBody: payload as unknown as tagmanager_v2.Schema$Tag
    };
    if (options.fingerprint) {
      params.fingerprint = options.fingerprint;
    }

    return await this.requestWithRetry("GTM tags.update", () => this.api.accounts.containers.workspaces.tags.update(params), "write");
  }

  async updateTagById(
    workspacePath: string,
    tagId: string,
    tag: GtmTag,
    options: { fingerprint?: string } = {}
  ): Promise<tagmanager_v2.Schema$Tag> {
    return await this.updateTag(this.childPath(workspacePath, "tags", tagId), tag, options);
  }

  async deleteTag(tagPath: string): Promise<void> {
    await this.requestWithRetry("GTM tags.delete", () => this.api.accounts.containers.workspaces.tags.delete({ path: tagPath }), "write");
  }

  async deleteTagById(workspacePath: string, tagId: string): Promise<void> {
    await this.deleteTag(this.childPath(workspacePath, "tags", tagId));
  }

  async findTagByName(workspacePath: string, tagName: string): Promise<tagmanager_v2.Schema$Tag | undefined> {
    const tags = await this.listTags(workspacePath);
    return tags.find((t) => (t.name ?? "").toLowerCase() === tagName.toLowerCase());
  }

  async getTagByName(workspacePath: string, tagName: string): Promise<tagmanager_v2.Schema$Tag> {
    const match = await this.findTagByName(workspacePath, tagName);
    if (!match) {
      throw new Error(`Tag not found in workspace (${workspacePath}): name="${tagName}"`);
    }
    return match;
  }

  async getOrCreateTag(workspacePath: string, tag: GtmTag): Promise<tagmanager_v2.Schema$Tag> {
    const existing = await this.findTagByName(workspacePath, tag.name);
    if (existing) return existing;
    return await this.createTag(workspacePath, tag);
  }

  async upsertTagByName(
    workspacePath: string,
    tag: GtmTag,
    options: { updateIfExists?: boolean } = {}
  ): Promise<tagmanager_v2.Schema$Tag> {
    const existing = await this.findTagByName(workspacePath, tag.name);
    if (!existing) {
      return await this.createTag(workspacePath, tag);
    }
    if (!options.updateIfExists) {
      return existing;
    }
    if (!existing.tagId) {
      throw new Error(`Cannot update tag without tagId (name="${tag.name}").`);
    }
    const tagPath = this.childPath(workspacePath, "tags", existing.tagId);
    const updateOptions = existing.fingerprint ? { fingerprint: existing.fingerprint } : {};
    return await this.updateTag(tagPath, tag, updateOptions);
  }

  // ----------------------------
  // Triggers
  // ----------------------------
  async listTriggers(workspacePath: string): Promise<tagmanager_v2.Schema$Trigger[]> {
    return await this.listAllPages("GTM triggers.list", async (pageToken) => {
      const data = await this.request("GTM triggers.list", () =>
        this.api.accounts.containers.workspaces.triggers.list(
          pageToken === undefined ? { parent: workspacePath } : { parent: workspacePath, pageToken }
        )
      );
      return { items: data.trigger ?? [], nextPageToken: data.nextPageToken };
    });
  }

  async createTrigger(workspacePath: string, trigger: GtmTrigger): Promise<tagmanager_v2.Schema$Trigger> {
    const payload = zGtmTrigger.parse(trigger);
    return await this.requestWithRetry("GTM triggers.create", () =>
      this.api.accounts.containers.workspaces.triggers.create({
        parent: workspacePath,
        requestBody: payload as unknown as tagmanager_v2.Schema$Trigger
      })
    , "write");
  }

  async getTrigger(triggerPath: string): Promise<tagmanager_v2.Schema$Trigger> {
    return await this.request("GTM triggers.get", () =>
      this.api.accounts.containers.workspaces.triggers.get({ path: triggerPath })
    );
  }

  async getTriggerById(workspacePath: string, triggerId: string): Promise<tagmanager_v2.Schema$Trigger> {
    return await this.getTrigger(this.childPath(workspacePath, "triggers", triggerId));
  }

  async updateTrigger(
    triggerPath: string,
    trigger: GtmTrigger,
    options: { fingerprint?: string } = {}
  ): Promise<tagmanager_v2.Schema$Trigger> {
    const payload = zGtmTrigger.parse(trigger);
    const params: { path: string; requestBody: tagmanager_v2.Schema$Trigger; fingerprint?: string } = {
      path: triggerPath,
      requestBody: payload as unknown as tagmanager_v2.Schema$Trigger
    };
    if (options.fingerprint) {
      params.fingerprint = options.fingerprint;
    }

    return await this.requestWithRetry(
      "GTM triggers.update",
      () => this.api.accounts.containers.workspaces.triggers.update(params),
      "write"
    );
  }

  async updateTriggerById(
    workspacePath: string,
    triggerId: string,
    trigger: GtmTrigger,
    options: { fingerprint?: string } = {}
  ): Promise<tagmanager_v2.Schema$Trigger> {
    return await this.updateTrigger(this.childPath(workspacePath, "triggers", triggerId), trigger, options);
  }

  async deleteTrigger(triggerPath: string): Promise<void> {
    await this.requestWithRetry(
      "GTM triggers.delete",
      () => this.api.accounts.containers.workspaces.triggers.delete({ path: triggerPath }),
      "write"
    );
  }

  async deleteTriggerById(workspacePath: string, triggerId: string): Promise<void> {
    await this.deleteTrigger(this.childPath(workspacePath, "triggers", triggerId));
  }

  async findTriggerByName(workspacePath: string, triggerName: string): Promise<tagmanager_v2.Schema$Trigger | undefined> {
    const triggers = await this.listTriggers(workspacePath);
    return triggers.find((t) => (t.name ?? "").toLowerCase() === triggerName.toLowerCase());
  }

  async getTriggerByName(workspacePath: string, triggerName: string): Promise<tagmanager_v2.Schema$Trigger> {
    const match = await this.findTriggerByName(workspacePath, triggerName);
    if (!match) {
      throw new Error(`Trigger not found in workspace (${workspacePath}): name="${triggerName}"`);
    }
    return match;
  }

  async getOrCreateTrigger(workspacePath: string, trigger: GtmTrigger): Promise<tagmanager_v2.Schema$Trigger> {
    const existing = await this.findTriggerByName(workspacePath, trigger.name);
    if (existing) return existing;
    return await this.createTrigger(workspacePath, trigger);
  }

  async upsertTriggerByName(
    workspacePath: string,
    trigger: GtmTrigger,
    options: { updateIfExists?: boolean } = {}
  ): Promise<tagmanager_v2.Schema$Trigger> {
    const existing = await this.findTriggerByName(workspacePath, trigger.name);
    if (!existing) {
      return await this.createTrigger(workspacePath, trigger);
    }
    if (!options.updateIfExists) {
      return existing;
    }
    if (!existing.triggerId) {
      throw new Error(`Cannot update trigger without triggerId (name="${trigger.name}").`);
    }
    const triggerPath = this.childPath(workspacePath, "triggers", existing.triggerId);
    const updateOptions = existing.fingerprint ? { fingerprint: existing.fingerprint } : {};
    return await this.updateTrigger(triggerPath, trigger, updateOptions);
  }

  // ----------------------------
  // Variables
  // ----------------------------
  async listVariables(workspacePath: string): Promise<tagmanager_v2.Schema$Variable[]> {
    return await this.listAllPages("GTM variables.list", async (pageToken) => {
      const data = await this.request("GTM variables.list", () =>
        this.api.accounts.containers.workspaces.variables.list(
          pageToken === undefined ? { parent: workspacePath } : { parent: workspacePath, pageToken }
        )
      );
      return { items: data.variable ?? [], nextPageToken: data.nextPageToken };
    });
  }

  async createVariable(workspacePath: string, variable: GtmVariable): Promise<tagmanager_v2.Schema$Variable> {
    const payload = zGtmVariable.parse(variable);
    return await this.requestWithRetry("GTM variables.create", () =>
      this.api.accounts.containers.workspaces.variables.create({
        parent: workspacePath,
        requestBody: payload as unknown as tagmanager_v2.Schema$Variable
      })
    , "write");
  }

  async getVariable(variablePath: string): Promise<tagmanager_v2.Schema$Variable> {
    return await this.request("GTM variables.get", () =>
      this.api.accounts.containers.workspaces.variables.get({ path: variablePath })
    );
  }

  async getVariableById(workspacePath: string, variableId: string): Promise<tagmanager_v2.Schema$Variable> {
    return await this.getVariable(this.childPath(workspacePath, "variables", variableId));
  }

  async updateVariable(
    variablePath: string,
    variable: GtmVariable,
    options: { fingerprint?: string } = {}
  ): Promise<tagmanager_v2.Schema$Variable> {
    const payload = zGtmVariable.parse(variable);
    const params: { path: string; requestBody: tagmanager_v2.Schema$Variable; fingerprint?: string } = {
      path: variablePath,
      requestBody: payload as unknown as tagmanager_v2.Schema$Variable
    };
    if (options.fingerprint) {
      params.fingerprint = options.fingerprint;
    }

    return await this.requestWithRetry(
      "GTM variables.update",
      () => this.api.accounts.containers.workspaces.variables.update(params),
      "write"
    );
  }

  async updateVariableById(
    workspacePath: string,
    variableId: string,
    variable: GtmVariable,
    options: { fingerprint?: string } = {}
  ): Promise<tagmanager_v2.Schema$Variable> {
    return await this.updateVariable(this.childPath(workspacePath, "variables", variableId), variable, options);
  }

  async deleteVariable(variablePath: string): Promise<void> {
    await this.requestWithRetry(
      "GTM variables.delete",
      () => this.api.accounts.containers.workspaces.variables.delete({ path: variablePath }),
      "write"
    );
  }

  async deleteVariableById(workspacePath: string, variableId: string): Promise<void> {
    await this.deleteVariable(this.childPath(workspacePath, "variables", variableId));
  }

  async findVariableByName(workspacePath: string, variableName: string): Promise<tagmanager_v2.Schema$Variable | undefined> {
    const variables = await this.listVariables(workspacePath);
    return variables.find((v) => (v.name ?? "").toLowerCase() === variableName.toLowerCase());
  }

  async getVariableByName(workspacePath: string, variableName: string): Promise<tagmanager_v2.Schema$Variable> {
    const match = await this.findVariableByName(workspacePath, variableName);
    if (!match) {
      throw new Error(`Variable not found in workspace (${workspacePath}): name="${variableName}"`);
    }
    return match;
  }

  async getOrCreateVariable(workspacePath: string, variable: GtmVariable): Promise<tagmanager_v2.Schema$Variable> {
    const existing = await this.findVariableByName(workspacePath, variable.name);
    if (existing) return existing;
    return await this.createVariable(workspacePath, variable);
  }

  async upsertVariableByName(
    workspacePath: string,
    variable: GtmVariable,
    options: { updateIfExists?: boolean } = {}
  ): Promise<tagmanager_v2.Schema$Variable> {
    const existing = await this.findVariableByName(workspacePath, variable.name);
    if (!existing) {
      return await this.createVariable(workspacePath, variable);
    }
    if (!options.updateIfExists) {
      return existing;
    }
    if (!existing.variableId) {
      throw new Error(`Cannot update variable without variableId (name="${variable.name}").`);
    }
    const variablePath = this.childPath(workspacePath, "variables", existing.variableId);
    const updateOptions = existing.fingerprint ? { fingerprint: existing.fingerprint } : {};
    return await this.updateVariable(variablePath, variable, updateOptions);
  }

  // ----------------------------
  // Custom Templates
  // ----------------------------
  async listTemplates(workspacePath: string): Promise<tagmanager_v2.Schema$CustomTemplate[]> {
    return await this.listAllPages("GTM templates.list", async (pageToken) => {
      const data = await this.request("GTM templates.list", () =>
        this.api.accounts.containers.workspaces.templates.list(
          pageToken === undefined ? { parent: workspacePath } : { parent: workspacePath, pageToken }
        )
      );
      return { items: data.template ?? [], nextPageToken: data.nextPageToken };
    });
  }

  async createTemplate(
    workspacePath: string,
    template: GtmCustomTemplate
  ): Promise<tagmanager_v2.Schema$CustomTemplate> {
    const payload = zGtmCustomTemplate.parse(template);
    return await this.requestWithRetry(
      "GTM templates.create",
      () =>
        this.api.accounts.containers.workspaces.templates.create({
          parent: workspacePath,
          requestBody: payload as unknown as tagmanager_v2.Schema$CustomTemplate
        }),
      "write"
    );
  }

  async getTemplate(templatePath: string): Promise<tagmanager_v2.Schema$CustomTemplate> {
    return await this.request("GTM templates.get", () =>
      this.api.accounts.containers.workspaces.templates.get({ path: templatePath })
    );
  }

  async getTemplateById(workspacePath: string, templateId: string): Promise<tagmanager_v2.Schema$CustomTemplate> {
    return await this.getTemplate(this.childPath(workspacePath, "templates", templateId));
  }

  async updateTemplate(
    templatePath: string,
    template: GtmCustomTemplate,
    options: { fingerprint?: string } = {}
  ): Promise<tagmanager_v2.Schema$CustomTemplate> {
    const payload = zGtmCustomTemplate.parse(template);
    const params: { path: string; requestBody: tagmanager_v2.Schema$CustomTemplate; fingerprint?: string } = {
      path: templatePath,
      requestBody: payload as unknown as tagmanager_v2.Schema$CustomTemplate
    };
    if (options.fingerprint) {
      params.fingerprint = options.fingerprint;
    }

    return await this.requestWithRetry(
      "GTM templates.update",
      () => this.api.accounts.containers.workspaces.templates.update(params),
      "write"
    );
  }

  async updateTemplateById(
    workspacePath: string,
    templateId: string,
    template: GtmCustomTemplate,
    options: { fingerprint?: string } = {}
  ): Promise<tagmanager_v2.Schema$CustomTemplate> {
    return await this.updateTemplate(this.childPath(workspacePath, "templates", templateId), template, options);
  }

  async deleteTemplate(templatePath: string): Promise<void> {
    await this.requestWithRetry(
      "GTM templates.delete",
      () => this.api.accounts.containers.workspaces.templates.delete({ path: templatePath }),
      "write"
    );
  }

  async deleteTemplateById(workspacePath: string, templateId: string): Promise<void> {
    await this.deleteTemplate(this.childPath(workspacePath, "templates", templateId));
  }

  async findTemplateByName(
    workspacePath: string,
    templateName: string
  ): Promise<tagmanager_v2.Schema$CustomTemplate | undefined> {
    const templates = await this.listTemplates(workspacePath);
    return templates.find((t) => (t.name ?? "").toLowerCase() === templateName.toLowerCase());
  }

  async getTemplateByName(workspacePath: string, templateName: string): Promise<tagmanager_v2.Schema$CustomTemplate> {
    const match = await this.findTemplateByName(workspacePath, templateName);
    if (!match) {
      throw new Error(`Custom template not found in workspace (${workspacePath}): name="${templateName}"`);
    }
    return match;
  }

  async getOrCreateTemplate(
    workspacePath: string,
    template: GtmCustomTemplate
  ): Promise<tagmanager_v2.Schema$CustomTemplate> {
    const existing = await this.findTemplateByName(workspacePath, template.name);
    if (existing) return existing;
    return await this.createTemplate(workspacePath, template);
  }

  async upsertTemplateByName(
    workspacePath: string,
    template: GtmCustomTemplate,
    options: { updateIfExists?: boolean } = {}
  ): Promise<tagmanager_v2.Schema$CustomTemplate> {
    const existing = await this.findTemplateByName(workspacePath, template.name);
    if (!existing) {
      return await this.createTemplate(workspacePath, template);
    }
    if (!options.updateIfExists) {
      return existing;
    }
    if (!existing.path) {
      throw new Error(`Cannot update template without path (name="${template.name}").`);
    }

    const updateOptions = existing.fingerprint ? { fingerprint: existing.fingerprint } : {};
    return await this.updateTemplate(existing.path, template, updateOptions);
  }
}

