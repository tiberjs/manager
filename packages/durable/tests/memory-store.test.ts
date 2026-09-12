import { describe, expect, test } from "vitest";
import { MemoryStore } from "../src/index.js";
import type { ClaimedExecution, ExecutionMutation, ExecutionRecord } from "../src/index.js";

function record(id: string, retries = 1): ExecutionRecord {
  return {
    id,
    job: "store-test",
    input: null,
    inputFingerprint: "input",
    status: "pending",
    attempt: 0,
    failures: 0,
    retry: { retries, delayMs: 0, backoff: 2, maxDelayMs: 30000 },
    availableAt: 0,
    checkpoints: {},
    createdAt: 0,
    updatedAt: 0,
  };
}
async function claim(store: MemoryStore, now = 0, leaseExpiresAt = 10): Promise<ClaimedExecution> {
  const claimed = await store.claim({
    workerId: "worker",
    jobs: ["store-test"],
    now,
    leaseExpiresAt,
  });
  if (!claimed) throw new Error("Expected claimable job.");
  return claimed;
}
function mutation(claimed: ClaimedExecution, now = 1): ExecutionMutation {
  return { executionId: claimed.execution.id, activationId: claimed.activationId, now };
}

describe("MemoryStore job transitions", () => {
  test("claim is exclusive and stale activations cannot overwrite recovered checkpoints or completion", async () => {
    const store = new MemoryStore();
    await store.create(record("fenced"));
    const stale = await claim(store);
    await expect(
      store.claim({ workerId: "other", jobs: ["store-test"], now: 1, leaseExpiresAt: 20 }),
    ).resolves.toBeNull();
    const oldCheckpoint = { ...mutation(stale), key: "effect", inputFingerprint: "value" };
    await expect(store.beginCheckpoint(oldCheckpoint)).resolves.toEqual({ status: "execute" });
    await expect(store.recoverExpired(10)).resolves.toBe(1);
    const fresh = await claim(store, 10, 100);
    const checkpoint = { ...mutation(fresh, 11), key: "effect", inputFingerprint: "value" };
    await expect(store.beginCheckpoint(checkpoint)).resolves.toEqual({ status: "execute" });
    await expect(store.completeCheckpoint({ ...oldCheckpoint, now: 11 }, "stale")).resolves.toBe(
      false,
    );
    await expect(store.complete(mutation(stale, 11), "stale")).resolves.toBe(false);
    await expect(store.completeCheckpoint(checkpoint, "fresh")).resolves.toBe(true);
    await expect(store.complete(mutation(fresh, 12), "fresh")).resolves.toBe(true);
    await expect(store.load("fenced")).resolves.toMatchObject({
      status: "completed",
      result: "fresh",
      attempt: 2,
      failures: 1,
      activationId: undefined,
      checkpoints: { effect: { status: "completed", result: "fresh" } },
    });
  });

  test("expired leases reject heartbeat and writes even before explicit recovery", async () => {
    const store = new MemoryStore();
    await store.create(record("expired"));
    const active = await claim(store);
    const expired = mutation(active, 10);
    await expect(store.heartbeat(expired, "worker", 100)).resolves.toBe("lost");
    await expect(store.complete(expired, 42)).resolves.toBe(false);
    await expect(
      store.beginCheckpoint({ ...expired, key: "x", inputFingerprint: "x" }),
    ).resolves.toEqual({ status: "lost" });
    await expect(store.recoverExpired(10)).resolves.toBe(1);
  });

  test("checkpoint reservations reject conflicting inputs and duplicate in-flight claims", async () => {
    const store = new MemoryStore();
    await store.create(record("identity"));
    const active = await claim(store);
    const checkpoint = { ...mutation(active), key: "__proto__", inputFingerprint: "first" };
    await expect(store.beginCheckpoint(checkpoint)).resolves.toEqual({ status: "execute" });
    await expect(store.beginCheckpoint(checkpoint)).resolves.toEqual({ status: "busy" });
    await expect(store.complete(mutation(active), "premature")).resolves.toBe(false);
    await expect(
      store.beginCheckpoint({ ...checkpoint, inputFingerprint: "different" }),
    ).resolves.toEqual({ status: "conflict" });
    await expect(
      store.completeCheckpoint({ ...checkpoint, inputFingerprint: "different" }, 42),
    ).resolves.toBe(false);
    await expect(store.releaseCheckpoint(checkpoint)).resolves.toBe(true);
    const released = await store.load(active.execution.id);
    expect(released?.status).toBe("running");
    expect(released?.checkpoints["__proto__"]).toMatchObject({ status: "pending" });
    await expect(
      store.beginCheckpoint({ ...checkpoint, inputFingerprint: "different" }),
    ).resolves.toEqual({ status: "conflict" });
    await expect(store.beginCheckpoint(checkpoint)).resolves.toEqual({ status: "execute" });
    await expect(store.completeCheckpoint(checkpoint, undefined)).resolves.toBe(true);
    await expect(store.beginCheckpoint(checkpoint)).resolves.toEqual({
      status: "completed",
      result: undefined,
    });
    await expect(store.completeCheckpoint(checkpoint, "overwrite")).resolves.toBe(false);
  });

  test("completed checkpoints survive retries but running reservations lose ownership", async () => {
    const store = new MemoryStore();
    await store.create(record("retry"));
    const active = await claim(store);
    const completed = { ...mutation(active), key: "done", inputFingerprint: "input" };
    await store.beginCheckpoint(completed);
    await store.completeCheckpoint(completed, { value: 42 });
    await store.beginCheckpoint({ ...completed, key: "unfinished" });
    await store.fail({
      ...mutation(active, 2),
      error: { name: "Error", message: "retry" },
      retryAt: 5,
    });
    await expect(
      store.claim({ workerId: "worker", jobs: ["store-test"], now: 4, leaseExpiresAt: 100 }),
    ).resolves.toBeNull();
    const retry = await claim(store, 5, 100);
    await expect(store.beginCheckpoint({ ...completed, ...mutation(retry, 6) })).resolves.toEqual({
      status: "completed",
      result: { value: 42 },
    });
    await expect(
      store.beginCheckpoint({ ...completed, ...mutation(retry, 6), key: "unfinished" }),
    ).resolves.toEqual({ status: "execute" });
  });

  test("cancellation rejects checkpoints and becomes terminal only on acknowledgement", async () => {
    const store = new MemoryStore();
    await store.create(record("cancel"));
    const active = await claim(store);
    await store.cancel("cancel", { name: "AbortError", message: "stop" }, 1);
    await expect(store.heartbeat(mutation(active, 2), "worker", 100)).resolves.toBe(
      "cancel-requested",
    );
    await expect(store.load("cancel")).resolves.toMatchObject({ status: "cancelling" });
    await expect(store.complete(mutation(active, 2), 42)).resolves.toBe(false);
    await expect(
      store.beginCheckpoint({ ...mutation(active, 2), key: "late", inputFingerprint: "input" }),
    ).resolves.toEqual({ status: "lost" });
    await expect(store.acknowledgeCancellation(mutation(active, 3))).resolves.toBe(true);
    await expect(store.load("cancel")).resolves.toMatchObject({
      status: "cancelled",
      activationId: undefined,
      workerId: undefined,
      leaseExpiresAt: undefined,
    });
    await expect(store.release(mutation(active, 4))).resolves.toBe(false);
  });

  test("expired cancellation and exhausted retries terminate without leftover ownership", async () => {
    const store = new MemoryStore();
    await store.create(record("cancelled"));
    const cancelled = await claim(store);
    await store.cancel(cancelled.execution.id, { name: "AbortError", message: "stop" }, 1);
    await store.create(record("failed", 0));
    await claim(store);
    await expect(store.recoverExpired(10)).resolves.toBe(2);
    await expect(store.load("cancelled")).resolves.toMatchObject({
      status: "cancelled",
      activationId: undefined,
    });
    await expect(store.load("failed")).resolves.toMatchObject({
      status: "failed",
      failures: 1,
      activationId: undefined,
    });
    await expect(store.recoverExpired(11)).resolves.toBe(0);
  });

  test("stored and replayed outputs are clone-isolated and serialization failure does not commit", async () => {
    const store = new MemoryStore();
    const source = record("isolation");
    await store.create(source);
    const active = await claim(store);
    const checkpoint = { ...mutation(active), key: "value", inputFingerprint: "input" };
    await store.beginCheckpoint(checkpoint);
    await expect(store.completeCheckpoint(checkpoint, () => 42)).rejects.toThrow();
    const result = { value: 42 };
    await store.completeCheckpoint(checkpoint, result);
    result.value = 0;
    const first = await store.beginCheckpoint(checkpoint);
    if (first.status !== "completed") throw new Error("Expected persisted checkpoint.");
    (first.result as { value: number }).value = -1;
    await expect(store.beginCheckpoint(checkpoint)).resolves.toEqual({
      status: "completed",
      result: { value: 42 },
    });
  });
});
