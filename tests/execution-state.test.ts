import { describe, expect, test } from "vitest";
import {
  claimExecutionNode,
  completeExecutionNode,
  failExecutionNode,
} from "../src/execution/state.js";
import type { ClaimNodeOptions, ExecutionRecord, NodeRecord } from "../src/index.js";

function node(
  id: string,
  status: NodeRecord["status"],
  dependencies: readonly string[] = [],
): NodeRecord {
  return {
    id,
    dependencies,
    status,
    attempt: status === "running" ? 1 : 0,
    failures: 0,
    retry: { retries: 0, delayMs: 0, backoff: 2, maxDelayMs: 30_000 },
    availableAt: 0,
    ...(status === "running"
      ? { activationId: `${id}-activation`, workerId: "worker", leaseExpiresAt: 100 }
      : {}),
  };
}

function record(nodes: readonly NodeRecord[], outputNodeId: string): ExecutionRecord {
  return {
    id: "execution",
    workflow: "state-test",
    input: null,
    inputFingerprint: "input",
    outputNodeId,
    status: nodes.some((value) => value.status === "running") ? "running" : "pending",
    nodes: Object.fromEntries(nodes.map((value) => [value.id, value])),
    createdAt: 0,
    updatedAt: 0,
  };
}

const claimOptions: ClaimNodeOptions = {
  workerId: "worker",
  workflows: ["state-test"],
  now: 1,
  leaseExpiresAt: 100,
};

describe("execution state transitions", () => {
  test("claiming produces a new running record without mutating the source", () => {
    const source = record([node("result", "ready")], "result");

    const claimed = claimExecutionNode(source, "result", claimOptions, "activation");

    expect(claimed).toMatchObject({
      status: "running",
      updatedAt: 1,
      nodes: {
        result: {
          status: "running",
          attempt: 1,
          activationId: "activation",
          workerId: "worker",
          leaseExpiresAt: 100,
        },
      },
    });
    expect(source).toMatchObject({
      status: "pending",
      updatedAt: 0,
      nodes: { result: { status: "ready", attempt: 0 } },
    });
    expect(source.nodes.result).not.toHaveProperty("activationId");
  });

  test("completion activates satisfied dependents without mutating the running record", () => {
    const source = record(
      [node("prepare", "running"), node("finish", "blocked", ["prepare"])],
      "finish",
    );

    const completed = completeExecutionNode(
      source,
      {
        executionId: source.id,
        nodeId: "prepare",
        activationId: "prepare-activation",
        now: 2,
      },
      21,
    );

    expect(completed).toMatchObject({
      status: "pending",
      updatedAt: 2,
      nodes: {
        prepare: { status: "completed", result: 21, activationId: undefined },
        finish: { status: "ready" },
      },
    });
    expect(source.nodes.prepare).toMatchObject({
      status: "running",
      activationId: "prepare-activation",
    });
    expect(source.nodes.finish).toMatchObject({ status: "blocked" });
  });

  test("terminal failure cancels sibling ownership without mutating the source", () => {
    const source = record(
      [
        node("first", "running"),
        node("second", "running"),
        node("join", "blocked", ["first", "second"]),
      ],
      "join",
    );

    const failed = failExecutionNode(source, {
      executionId: source.id,
      nodeId: "first",
      activationId: "first-activation",
      now: 2,
      retryAt: 2,
      error: { name: "Error", message: "failed" },
    });

    expect(failed).toMatchObject({
      status: "failed",
      nodes: {
        first: { status: "failed", activationId: undefined },
        second: {
          status: "cancelled",
          activationId: undefined,
          workerId: undefined,
          leaseExpiresAt: undefined,
        },
        join: { status: "cancelled" },
      },
    });
    expect(source.nodes.second).toMatchObject({
      status: "running",
      activationId: "second-activation",
    });
  });
});
