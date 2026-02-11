import fs from "node:fs";
import path from "node:path";
import { GoogleAuth } from "google-auth-library";
import { z } from "zod";

/**
 * Scopes for GTM API v2.
 *
 * NOTE: For Infrastructure-as-Code write operations you typically need
 * `tagmanager.edit.containers` and, if you publish versions, `tagmanager.publish`.
 * You may reduce scopes for purely reporting workflows.
 */
export const GTM_SCOPES: readonly string[] = [
  "https://www.googleapis.com/auth/tagmanager.edit.containers",
  "https://www.googleapis.com/auth/tagmanager.publish"
];

const EnvSchema = z.object({
  // Re-use the repo's existing env naming where possible.
  GTM_CREDENTIALS_PATH: z.string().trim().min(1).optional(),
  // Optional override for scopes (comma/space-separated).
  GTM_SCOPES: z.string().trim().min(1).optional(),
  // Standard Google env var supported by google-auth-library.
  GOOGLE_APPLICATION_CREDENTIALS: z.string().trim().min(1).optional()
});

export interface CreateGoogleAuthOptions {
  /**
   * OAuth scopes to request.
   * Defaults to {@link GTM_SCOPES}.
   */
  scopes?: readonly string[];

  /**
   * Optional path to a service-account JSON key file.
   * When omitted, Application Default Credentials (ADC) are used.
   */
  keyFilePath?: string;
}

/**
 * Creates a GoogleAuth client for GTM API v2.
 *
 * Supports authenticating via a service-account JSON key path provided by:
 * - `GTM_CREDENTIALS_PATH` (repo convention), or
 * - `GOOGLE_APPLICATION_CREDENTIALS` (Google convention)
 *
 * If neither is set, this falls back to Application Default Credentials (ADC).
 */
export function createGoogleAuth(options: CreateGoogleAuthOptions = {}): GoogleAuth {
  const env = EnvSchema.parse({
    GTM_CREDENTIALS_PATH: process.env.GTM_CREDENTIALS_PATH,
    GTM_SCOPES: process.env.GTM_SCOPES,
    GOOGLE_APPLICATION_CREDENTIALS: process.env.GOOGLE_APPLICATION_CREDENTIALS
  });

  const scopesFromEnv = env.GTM_SCOPES
    ? env.GTM_SCOPES
        .split(/[,\s]+/g)
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;

  const scopes = options.scopes ?? scopesFromEnv ?? GTM_SCOPES;
  const keyFilePathFromEnv = env.GTM_CREDENTIALS_PATH ?? env.GOOGLE_APPLICATION_CREDENTIALS;
  const keyFilePath = options.keyFilePath ?? keyFilePathFromEnv;

  if (!keyFilePath) {
    return new GoogleAuth({ scopes: [...scopes] });
  }

  const resolved = path.isAbsolute(keyFilePath) ? keyFilePath : path.resolve(process.cwd(), keyFilePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(
      `Service account key file not found at "${resolved}". ` +
        `Set GTM_CREDENTIALS_PATH (or GOOGLE_APPLICATION_CREDENTIALS) to an absolute path.`
    );
  }

  return new GoogleAuth({
    keyFile: resolved,
    scopes: [...scopes]
  });
}

