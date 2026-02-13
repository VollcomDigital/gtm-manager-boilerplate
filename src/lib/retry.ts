import { randomInt } from "node:crypto";
import { sleep } from "./sleep";

export type OperationKind = "read" | "write";

export interface RetryOptions {
  /**
   * Number of retries after the first attempt.
   */
  retries: number;

  /**
   * Base delay for exponential backoff.
   */
  baseDelayMs: number;

  /**
   * Max delay cap for exponential backoff.
   */
  maxDelayMs: number;

  /**
   * Whether to apply jitter to delays.
   */
  jitter: boolean;

  /**
   * Optional callback invoked before sleeping between retries.
   */
  onRetry?: (info: { attempt: number; delayMs: number; err: unknown }) => void;

  /**
   * Controls which errors should be retried.
   */
  shouldRetry: (err: unknown) => boolean;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function randomJitterFactor(): number {
  // Use cryptographically strong randomness to avoid weak-PRNG security findings.
  const thousandths = randomInt(0, 1001); // [0, 1000]
  return 0.5 + thousandths / 1000;
}

/**
 * Applies exponential backoff (with optional jitter) around an async function.
 *
 * @param fn Function to execute.
 * @param options Retry configuration.
 * @returns Function result if successful.
 * @throws Last error if all retries fail.
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  // attempt=0 is the initial call; retries cover additional attempts.
  // total attempts = 1 + retries.
  for (let attempt = 0; attempt <= options.retries; attempt += 1) {
    try {
      return await fn();
    } catch (err: unknown) {
      if (attempt >= options.retries || !options.shouldRetry(err)) {
        throw err;
      }

      const exp = Math.pow(2, attempt);
      const rawDelay = options.baseDelayMs * exp;
      const capped = clamp(rawDelay, 0, options.maxDelayMs);
      const jitterFactor = options.jitter ? randomJitterFactor() : 1;
      const delayMs = Math.floor(capped * jitterFactor);

      options.onRetry?.({ attempt, delayMs, err });
      await sleep(delayMs);
    }
  }

  // Should be unreachable.
  throw new Error("withRetry exhausted without returning or throwing.");
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length ? value : undefined;
}

/**
 * Heuristic: determines whether a Google API call should be retried based on:
 * - HTTP status (429/5xx)
 * - transient network error codes
 * - rate limit reasons inside the error payload
 */
export function isRetryableGoogleApiError(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }

  const anyErr = err as {
    code?: unknown;
    response?: { status?: unknown; headers?: Record<string, unknown>; data?: unknown };
  };

  const status = asNumber(anyErr.response?.status);
  if (status && (status === 429 || status === 500 || status === 502 || status === 503 || status === 504)) {
    return true;
  }

  const code = asString(anyErr.code);
  if (code && ["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND", "ECONNREFUSED"].includes(code)) {
    return true;
  }

  // Some Google APIs return 403 for rate limiting; only retry when we can detect a rate limit reason.
  if (status === 403) {
    const data = anyErr.response?.data as
      | {
          error?: {
            errors?: Array<{ reason?: unknown }>;
          };
        }
      | undefined;

    const reasons = (data?.error?.errors ?? [])
      .map((e) => (typeof e.reason === "string" ? e.reason : undefined))
      .filter((r): r is string => Boolean(r));

    if (reasons.some((r) => r === "rateLimitExceeded" || r === "userRateLimitExceeded")) {
      return true;
    }
  }

  return false;
}

