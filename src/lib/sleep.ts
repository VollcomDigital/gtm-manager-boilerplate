/**
 * Sleep helper used for retry/backoff.
 *
 * @param ms Milliseconds to wait.
 * @returns Promise that resolves after the delay.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
