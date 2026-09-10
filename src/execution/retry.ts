import type { RetryPolicy, StoredRetryPolicy } from "../types.js";

const DEFAULT_MAX_DELAY = 30_000;

export function normalizePolicy(
  policy: RetryPolicy | undefined,
  fallback?: StoredRetryPolicy,
): StoredRetryPolicy {
  const retries = policy?.retries ?? fallback?.retries ?? 0;
  const delayMs = policy?.delayMs ?? fallback?.delayMs ?? 0;
  const backoff = policy?.backoff ?? fallback?.backoff ?? 2;
  const maxDelayMs = policy?.maxDelayMs ?? fallback?.maxDelayMs ?? DEFAULT_MAX_DELAY;

  assertInteger(retries, "retries");
  assertNonNegative(delayMs, "delayMs");
  assertPositive(backoff, "backoff");
  assertNonNegative(maxDelayMs, "maxDelayMs");
  return { retries, delayMs, backoff, maxDelayMs };
}

export function retryAt(policy: StoredRetryPolicy, failure: number, now: number): number {
  const delay = Math.min(
    policy.delayMs * policy.backoff ** Math.max(0, failure - 1),
    policy.maxDelayMs,
  );
  return now + delay;
}

function assertInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer.`);
  }
}

function assertNonNegative(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name} must be a finite non-negative number.`);
  }
}

function assertPositive(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 1) {
    throw new TypeError(`${name} must be a finite number greater than or equal to 1.`);
  }
}
