import { describe, expect, test } from "vitest";
import { MemoryStore } from "../src/index.js";
import type {
  ClaimedNode,
  ExecutionRecord,
  NodeMutation,
  NodeRecord,
  SerializedError,
} from "../src/index.js";

const failure: SerializedError = { name: "Error", message: "failed" };

function node(id: string, dependencies: readonly string[] = [], retries = 1): NodeRecord {
  return {
    id,
    dependencies,
    status: dependencies.length === 0 ? "ready" : "blocked",
    attempt: 0,
    failures: 0,
    retry: { retries, delayMs: 0, backoff: 2, maxDelayMs: 30_000 },
    availableAt: 0,
  };
}

function record(id: string, nodes: readonly NodeRecord[], outputNodeId: string): ExecutionRecord {
  return {
    id,
    workflow: "store-test",
    input: null,
    inputFingerprint: "input",
    outputNodeId,
    status: "pending",
    nodes: Object.fromEntries(nodes.map((value) => [value.id, value])),
    createdAt: 0,
    updatedAt: 0,
  };
}

async function claim(
  store: MemoryStore,
  workerId: string,
  now: number,
  leaseExpiresAt: number,
): Promise<ClaimedNode> {
  const claimed = await store.claim({
    workerId,
    workflows: ["store-test"],
    now,
    leaseExpiresAt,
  });
  if (!claimed) {
    throw new Error("Expected a ready node to be claimed.");
  }
  return claimed;
}

function mutation(claimed: ClaimedNode, now: number): NodeMutation {
  return {
    executionId: claimed.execution.id,
    nodeId: claimed.nodeId,
    activationId: claimed.activationId,
    now,
  };
}

describe("MemoryStore activation state", () => {
  test("recovering one expired parallel node keeps the execution running", async () => {
    const store = new MemoryStore();
    await store.create(
      record("parallel", [node("a"), node("b"), node("join", ["a", "b"])], "join"),
    );

    const expired = await claim(store, "worker-a", 0, 10);
    const live = await claim(store, "worker-b", 0, 100);

    await expect(store.recoverExpired(10)).resolves.toBe(1);
    expect(await store.load("parallel")).toMatchObject({
      status: "running",
      nodes: {
        a: {
          status: "ready",
          attempt: 1,
          failures: 1,
          availableAt: 10,
          activationId: undefined,
          workerId: undefined,
          leaseExpiresAt: undefined,
        },
        b: {
          status: "running",
          activationId: live.activationId,
          workerId: "worker-b",
          leaseExpiresAt: 100,
        },
        join: { status: "blocked" },
      },
    });
    expect(expired.nodeId).toBe("a");
    expect(live.nodeId).toBe("b");
  });

  test("a recovered node rejects completion from its stale activation", async () => {
    const store = new MemoryStore();
    await store.create(record("fenced", [node("result")], "result"));

    const stale = await claim(store, "old-worker", 0, 10);
    await store.recoverExpired(10);
    const current = await claim(store, "new-worker", 10, 100);

    await expect(store.complete(mutation(stale, 11), "stale")).resolves.toBe(false);
    await expect(store.complete(mutation(current, 12), "current")).resolves.toBe(true);
    expect(await store.load("fenced")).toMatchObject({
      status: "completed",
      result: "current",
      nodes: {
        result: {
          status: "completed",
          attempt: 2,
          failures: 1,
          result: "current",
          activationId: undefined,
        },
      },
    });
  });

  test("terminal failure clears ownership from concurrently running siblings", async () => {
    const store = new MemoryStore();
    await store.create(
      record("failed", [node("a", [], 0), node("b", [], 0), node("join", ["a", "b"], 0)], "join"),
    );

    const failed = await claim(store, "worker-a", 0, 100);
    const sibling = await claim(store, "worker-b", 0, 100);
    await expect(store.fail({ ...mutation(failed, 1), error: failure, retryAt: 1 })).resolves.toBe(
      true,
    );

    expect(await store.load("failed")).toMatchObject({
      status: "failed",
      nodes: {
        a: { status: "failed", activationId: undefined, workerId: undefined },
        b: {
          status: "cancelled",
          activationId: undefined,
          workerId: undefined,
          leaseExpiresAt: undefined,
        },
        join: { status: "cancelled" },
      },
    });
    await expect(store.complete(mutation(sibling, 2), "late")).resolves.toBe(false);
  });

  test("cancellation becomes terminal only after every running activation acknowledges it", async () => {
    const store = new MemoryStore();
    await store.create(record("cancel", [node("a"), node("b"), node("join", ["a", "b"])], "join"));

    const first = await claim(store, "worker-a", 0, 100);
    const second = await claim(store, "worker-b", 0, 100);
    await store.cancel("cancel", { name: "AbortError", message: "stop" }, 1);
    await expect(store.heartbeat(mutation(first, 2), "worker-a", 200)).resolves.toBe(
      "cancel-requested",
    );

    await expect(store.acknowledgeCancellation(mutation(first, 2))).resolves.toBe(true);
    await expect(store.load("cancel")).resolves.toMatchObject({
      status: "cancelling",
      nodes: {
        a: { status: "cancelled", activationId: undefined },
        b: { status: "running", activationId: second.activationId },
        join: { status: "cancelled" },
      },
    });

    await expect(store.acknowledgeCancellation(mutation(second, 3))).resolves.toBe(true);
    await expect(store.load("cancel")).resolves.toMatchObject({
      status: "cancelled",
      nodes: {
        a: { status: "cancelled", activationId: undefined },
        b: { status: "cancelled", activationId: undefined },
        join: { status: "cancelled", activationId: undefined },
      },
    });
  });
});
