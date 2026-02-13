import crypto from "node:crypto";
import { normalizeForDiff } from "./normalize";

/**
 * Computes a SHA-256 hex digest of a string.
 */
export function sha256HexFromString(input: string): string {
  return crypto.createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * Computes a stable hash for an arbitrary value by:
 * - normalizing it for diff (strip dynamic fields + canonicalize)
 * - hashing the resulting JSON string
 */
export function sha256HexOfNormalized(value: unknown): string {
  const normalized = normalizeForDiff(value);
  return sha256HexFromString(JSON.stringify(normalized));
}

