import { describe, expect, test } from "vitest";
import {
  claimExecution,
  completeExecution,
  failExecution,
  recoverExpiredExecution,
} from "../src/execution/state.js";
import type { ExecutionRecord } from "../src/index.js";

function pending(): ExecutionRecord {
  return {
    id: "job",
    job: "state",
    input: null,
    inputFingerprint: "input",
    status: "pending",
    attempt: 0,
    failures: 0,
    retry: { retries: 1, delayMs: 5, backoff: 2, maxDelayMs: 100 },
    availableAt: 0,
    checkpoints: {},
    createdAt: 0,
    updatedAt: 0,
  };
}
const options = { workerId: "worker", jobs: ["state"], now: 1, leaseExpiresAt: 10 };
const mutation = { executionId: "job", activationId: "activation", now: 2 };

describe("immutable job state transitions", () => {
  test("a claim does not mutate a retained pending snapshot", () => {
    const source = Object.freeze(pending());
    const active = claimExecution(source, options, "activation");
    expect(active).toMatchObject({ status: "running", attempt: 1, activationId: "activation" });
    expect(source.status).toBe("pending");
    expect(
      claimExecution(source, { ...options, jobs: ["unregistered"] }, "activation"),
    ).toBeUndefined();
  });

  test("retry retains committed results and clears ownership without changing a previous snapshot", () => {
    const source: ExecutionRecord = {
      ...pending(),
      status: "running",
      activationId: "activation",
      workerId: "worker",
      leaseExpiresAt: 10,
      checkpoints: {
        done: { key: "done", inputFingerprint: "x", status: "completed", result: 42 },
        unfinished: {
          key: "unfinished",
          inputFingerprint: "x",
          status: "running",
          activationId: "activation",
        },
      },
    };
    Object.freeze(source);
    Object.freeze(source.checkpoints);
    const retry = failExecution(source, {
      ...mutation,
      error: { name: "Error", message: "again" },
      retryAt: 7,
    });
    expect(retry).toMatchObject({
      status: "pending",
      availableAt: 7,
      activationId: undefined,
      checkpoints: {
        done: { status: "completed", result: 42 },
        unfinished: { status: "pending" },
      },
    });
    expect(source.checkpoints.unfinished).toMatchObject({ activationId: "activation" });
    expect(source.status).toBe("running");
  });

  test("completion waits until the activation owns no running checkpoints", () => {
    const active = claimExecution(pending(), options, "activation");
    if (!active) throw new Error("Expected claim.");
    const withCheckpoint: ExecutionRecord = {
      ...active,
      checkpoints: {
        effect: {
          key: "effect",
          inputFingerprint: "x",
          status: "running",
          activationId: "activation",
        },
      },
    };
    expect(completeExecution(withCheckpoint, mutation, 42)).toBeUndefined();
    expect(
      completeExecution(
        {
          ...withCheckpoint,
          checkpoints: {
            effect: { key: "effect", inputFingerprint: "x", status: "pending" },
          },
        },
        mutation,
        42,
      ),
    ).toMatchObject({ status: "completed", result: 42 });
  });

  test("terminal results cannot be changed by completion or lease recovery", () => {
    const active = claimExecution(pending(), options, "activation");
    if (!active) throw new Error("Expected claim.");
    const completed = completeExecution(active, mutation, 42);
    if (!completed) throw new Error("Expected completion.");
    expect(completeExecution(completed, mutation, 0)).toBeUndefined();
    expect(recoverExpiredExecution(completed, 100)).toBeUndefined();
    expect(completed.result).toBe(42);
  });
});
