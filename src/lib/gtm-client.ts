import { google, type tagmanager_v2 } from "googleapis";
import type { GoogleAuth } from "google-auth-library";
import { zGtmTag, zGtmTrigger, zGtmVariable, type GtmTag, type GtmTrigger, type GtmVariable } from "../types/gtm-schema";

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

  constructor(auth: GoogleAuth) {
    this.api = google.tagmanager({ version: "v2", auth });
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
    try {
      const res = await fn();
      return res.data;
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
    return {
      accountId,
      containerId: container.containerId,
      accountName: account?.name ?? locator.accountName,
      containerName: container.name ?? locator.containerName,
      containerPublicId: container.publicId ?? locator.containerPublicId
    };
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

    return await this.request("GTM workspaces.create", () =>
      this.api.accounts.containers.workspaces.create({
        parent,
        requestBody: {
          name: params.workspaceName
        }
      })
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
        this.api.accounts.containers.workspaces.tags.list({
          parent: workspacePath,
          pageToken
        })
      );
      return { items: data.tag ?? [], nextPageToken: data.nextPageToken };
    });
  }

  async createTag(workspacePath: string, tag: GtmTag): Promise<tagmanager_v2.Schema$Tag> {
    const payload = zGtmTag.parse(tag);
    return await this.request("GTM tags.create", () =>
      this.api.accounts.containers.workspaces.tags.create({
        parent: workspacePath,
        requestBody: payload as unknown as tagmanager_v2.Schema$Tag
      })
    );
  }

  // ----------------------------
  // Triggers
  // ----------------------------
  async listTriggers(workspacePath: string): Promise<tagmanager_v2.Schema$Trigger[]> {
    return await this.listAllPages("GTM triggers.list", async (pageToken) => {
      const data = await this.request("GTM triggers.list", () =>
        this.api.accounts.containers.workspaces.triggers.list({
          parent: workspacePath,
          pageToken
        })
      );
      return { items: data.trigger ?? [], nextPageToken: data.nextPageToken };
    });
  }

  async createTrigger(workspacePath: string, trigger: GtmTrigger): Promise<tagmanager_v2.Schema$Trigger> {
    const payload = zGtmTrigger.parse(trigger);
    return await this.request("GTM triggers.create", () =>
      this.api.accounts.containers.workspaces.triggers.create({
        parent: workspacePath,
        requestBody: payload as unknown as tagmanager_v2.Schema$Trigger
      })
    );
  }

  // ----------------------------
  // Variables
  // ----------------------------
  async listVariables(workspacePath: string): Promise<tagmanager_v2.Schema$Variable[]> {
    return await this.listAllPages("GTM variables.list", async (pageToken) => {
      const data = await this.request("GTM variables.list", () =>
        this.api.accounts.containers.workspaces.variables.list({
          parent: workspacePath,
          pageToken
        })
      );
      return { items: data.variable ?? [], nextPageToken: data.nextPageToken };
    });
  }

  async createVariable(workspacePath: string, variable: GtmVariable): Promise<tagmanager_v2.Schema$Variable> {
    const payload = zGtmVariable.parse(variable);
    return await this.request("GTM variables.create", () =>
      this.api.accounts.containers.workspaces.variables.create({
        parent: workspacePath,
        requestBody: payload as unknown as tagmanager_v2.Schema$Variable
      })
    );
  }
}

