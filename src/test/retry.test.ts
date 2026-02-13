import assert from "node:assert/strict";
import test from "node:test";
import { isRetryableGoogleApiError, withRetry } from "../lib/retry";

test("withRetry: retries then succeeds", async () => {
  let calls = 0;
  const result = await withRetry(
    async () => {
      calls += 1;
      if (calls < 3) {
        throw new Error("transient");
      }
      return "ok";
    },
    {
      retries: 5,
      baseDelayMs: 0,
      maxDelayMs: 0,
      jitter: false,
      shouldRetry: () => true
    }
  );

  assert.equal(result, "ok");
  assert.equal(calls, 3);
});

test("isRetryableGoogleApiError: true for 429", () => {
  const err = { response: { status: 429 } };
  assert.equal(isRetryableGoogleApiError(err), true);
});

test("isRetryableGoogleApiError: true for 403 rateLimitExceeded", () => {
  const err = {
    response: {
      status: 403,
      data: {
        error: {
          errors: [{ reason: "rateLimitExceeded" }]
        }
      }
    }
  };
  assert.equal(isRetryableGoogleApiError(err), true);
});

test("isRetryableGoogleApiError: false for non-transient 400", () => {
  const err = { response: { status: 400 } };
  assert.equal(isRetryableGoogleApiError(err), false);
});

