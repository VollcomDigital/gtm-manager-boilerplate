import assert from "node:assert/strict";
import test from "node:test";
import { isRetryableGoogleApiError, withRetry } from "../lib/retry";

test("retry soak: repeated transient bursts eventually succeed", async () => {
  const runs = 25;
  for (let i = 0; i < runs; i += 1) {
    let attempts = 0;
    const value = await withRetry(
      async () => {
        attempts += 1;
        if (attempts < 3) {
          throw { response: { status: 429 } };
        }
        return i;
      },
      {
        retries: 4,
        baseDelayMs: 0,
        maxDelayMs: 0,
        jitter: false,
        shouldRetry: isRetryableGoogleApiError
      }
    );

    assert.equal(value, i);
    assert.equal(attempts, 3);
  }
});

