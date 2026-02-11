import fs from "node:fs/promises";
import path from "node:path";
import { zWorkspaceDesiredState, type WorkspaceDesiredState } from "./workspace-config";

/**
 * Loads a desired-state workspace config from a JSON file.
 */
export async function loadWorkspaceDesiredState(configPath: string): Promise<WorkspaceDesiredState> {
  const resolved = path.isAbsolute(configPath) ? configPath : path.resolve(process.cwd(), configPath);
  const raw = await fs.readFile(resolved, "utf-8");

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid JSON in "${resolved}": ${msg}`);
  }

  return zWorkspaceDesiredState.parse(parsed);
}

