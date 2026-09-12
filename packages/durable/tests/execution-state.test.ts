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
    submission: {
      id: "job",
      job: "state",
      input: null,
      inputFingerprint: "input",
      retry: { retries: 1, delayMs: 5, backoff: 2, maxDelayMs: 100 },
      createdAt: 0,
    },
    projection: {
      revision: 1,
      status: "pending",
      attempt: 0,
      failures: 0,
      availableAt: 0,
      updatedAt: 0,
    },
    checkpoints: {},
  };
}
const options = { workerId: "worker", jobs: ["state"], now: 1, leaseExpiresAt: 10 };
const mutation = { executionId: "job", activationId: "activation", now: 2 };

describe("immutable execution state transitions", () => {
  test("a claim does not mutate a retained pending snapshot", () => {
    const source = Object.freeze(pending());
    const claimed = claimExecution(source, options, "activation");
    expect(claimed?.execution).toMatchObject({
      projection: { status: "running", attempt: 1 },
      activation: { activationId: "activation" },
    });
    expect(claimed?.events).toEqual([
      {
        type: "attempt-started",
        attempt: 1,
        activationId: "activation",
        workerId: "worker",
        at: 1,
      },
    ]);
    expect(source.projection.status).toBe("pending");
    expect(
      claimExecution(source, { ...options, jobs: ["unregistered"] }, "activation"),
    ).toBeUndefined();
  });

  test("retry retains completed results and clears operational ownership", () => {
    const source: ExecutionRecord = {
      ...pending(),
      projection: {
        ...pending().projection,
        status: "running",
      },
      activation: {
        activationId: "activation",
        workerId: "worker",
        leaseExpiresAt: 10,
      },
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
    const failed = failExecution(source, {
      ...mutation,
      error: { name: "Error", message: "again" },
      retryAt: 7,
    });
    expect(failed?.execution).toMatchObject({
      projection: {
        status: "pending",
        availableAt: 7,
        failures: 1,
      },
      activation: undefined,
      checkpoints: {
        done: { status: "completed", result: 42 },
        unfinished: { status: "pending" },
      },
    });
    expect(failed?.events).toMatchObject([
      {
        type: "attempt-failed",
        activationId: "activation",
        failure: 1,
        retryAt: 7,
      },
    ]);
    expect(source.checkpoints.unfinished).toMatchObject({ activationId: "activation" });
    expect(source.projection.status).toBe("running");
  });

  test("completion waits until the activation owns no running checkpoints", () => {
    const claimed = claimExecution(pending(), options, "activation");
    if (!claimed) throw new Error("Expected claim.");
    const withCheckpoint: ExecutionRecord = {
      ...claimed.execution,
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
      )?.execution,
    ).toMatchObject({ projection: { status: "completed", result: 42 } });
  });

  test("terminal results cannot be changed by completion or lease recovery", () => {
    const claimed = claimExecution(pending(), options, "activation");
    if (!claimed) throw new Error("Expected claim.");
    const completed = completeExecution(claimed.execution, mutation, 42);
    if (!completed) throw new Error("Expected completion.");
    expect(completeExecution(completed.execution, mutation, 0)).toBeUndefined();
    expect(recoverExpiredExecution(completed.execution, 100)).toBeUndefined();
    expect(completed.execution.projection.result).toBe(42);
  });
});
