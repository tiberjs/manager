import { ACTIVATION_EXPIRED } from "../errors.js";
import type {
  ClaimNodeOptions,
  HeartbeatResult,
  NodeFailure,
  NodeMutation,
} from "../persistence/store.js";
import { terminal } from "../persistence/store.js";
import type { ExecutionRecord, NodeRecord, SerializedError } from "../types.js";
import { retryAt } from "./retry.js";

export interface HeartbeatTransition {
  readonly result: HeartbeatResult;
  readonly execution?: ExecutionRecord;
}

export interface RecoveryTransition {
  readonly execution: ExecutionRecord;
  readonly recovered: number;
}

export function claimExecutionNode(
  execution: ExecutionRecord,
  nodeId: string,
  options: ClaimNodeOptions,
  activationId: string,
): ExecutionRecord | undefined {
  const node = execution.nodes[nodeId];
  if (
    !node ||
    terminal(execution.status) ||
    execution.status === "cancelling" ||
    node.status !== "ready" ||
    node.availableAt > options.now
  ) {
    return undefined;
  }

  const runningNode: NodeRecord = {
    ...node,
    status: "running",
    attempt: node.attempt + 1,
    activationId,
    workerId: options.workerId,
    leaseExpiresAt: options.leaseExpiresAt,
  };
  return {
    ...execution,
    status: "running",
    updatedAt: options.now,
    nodes: replaceNode(execution, runningNode),
  };
}

export function heartbeatExecutionNode(
  execution: ExecutionRecord,
  mutation: NodeMutation,
  workerId: string,
  leaseExpiresAt: number,
): HeartbeatTransition {
  const node = ownedNode(execution, mutation);
  if (!node || node.workerId !== workerId) {
    return { result: "lost" };
  }
  if (execution.status === "cancelling") {
    return { result: "cancel-requested" };
  }
  if (execution.status !== "running") {
    return { result: "lost" };
  }

  return {
    result: "renewed",
    execution: {
      ...execution,
      updatedAt: mutation.now,
      nodes: replaceNode(execution, { ...node, leaseExpiresAt }),
    },
  };
}

export function completeExecutionNode(
  execution: ExecutionRecord,
  mutation: NodeMutation,
  result: unknown,
): ExecutionRecord | undefined {
  const node = ownedNode(execution, mutation);
  if (!node || execution.status !== "running") {
    return undefined;
  }

  let updated: ExecutionRecord = {
    ...execution,
    updatedAt: mutation.now,
    nodes: replaceNode(
      execution,
      inactiveNode(node, "completed", {
        result,
        error: undefined,
      }),
    ),
  };
  updated = activateDependents(updated);
  const output = updated.nodes[updated.outputNodeId];
  if (output?.status === "completed") {
    return {
      ...updated,
      status: "completed",
      result: output.result,
    };
  }
  return {
    ...updated,
    status: hasRunningNodes(updated.nodes) ? "running" : "pending",
  };
}

export function failExecutionNode(
  execution: ExecutionRecord,
  failure: NodeFailure,
): ExecutionRecord | undefined {
  const node = ownedNode(execution, failure);
  if (!node || execution.status !== "running") {
    return undefined;
  }

  const failures = node.failures + 1;
  if (failures > node.retry.retries) {
    return terminalFailure(execution, node.id, failure.error, failures, failure.now);
  }

  const ready = inactiveNode(node, "ready", {
    failures,
    availableAt: failure.retryAt,
    error: failure.error,
  });
  const nodes = replaceNode(execution, ready);
  return {
    ...execution,
    status: hasRunningNodes(nodes) ? "running" : "pending",
    updatedAt: failure.now,
    nodes,
  };
}

export function releaseExecutionNode(
  execution: ExecutionRecord,
  mutation: NodeMutation,
): ExecutionRecord | undefined {
  const node = ownedNode(execution, mutation, false);
  if (!node || execution.status !== "running") {
    return undefined;
  }

  const ready = inactiveNode(node, "ready", { availableAt: mutation.now });
  const nodes = replaceNode(execution, ready);
  return {
    ...execution,
    status: hasRunningNodes(nodes) ? "running" : "pending",
    updatedAt: mutation.now,
    nodes,
  };
}

export function acknowledgeExecutionCancellation(
  execution: ExecutionRecord,
  mutation: NodeMutation,
): ExecutionRecord | undefined {
  const node = ownedNode(execution, mutation, false);
  if (!node || execution.status !== "cancelling") {
    return undefined;
  }

  const nodes = replaceNode(execution, inactiveNode(node, "cancelled"));
  return {
    ...execution,
    status: hasRunningNodes(nodes) ? "cancelling" : "cancelled",
    updatedAt: mutation.now,
    nodes,
  };
}

export function cancelExecution(
  execution: ExecutionRecord,
  reason: SerializedError,
  now: number,
): ExecutionRecord | undefined {
  if (terminal(execution.status)) {
    return undefined;
  }

  const nodes = Object.fromEntries(
    Object.entries(execution.nodes).map(([nodeId, node]) => [
      nodeId,
      node.status === "blocked" || node.status === "ready" ? inactiveNode(node, "cancelled") : node,
    ]),
  );
  return {
    ...execution,
    status: hasRunningNodes(nodes) ? "cancelling" : "cancelled",
    updatedAt: now,
    nodes,
    cancellationReason: reason,
  };
}

export function recoverExpiredExecution(current: ExecutionRecord, now: number): RecoveryTransition {
  if (terminal(current.status)) {
    return { execution: current, recovered: 0 };
  }

  let execution = current;
  let recovered = 0;
  for (const node of Object.values(current.nodes)) {
    if (
      node.status !== "running" ||
      node.leaseExpiresAt === undefined ||
      node.leaseExpiresAt > now
    ) {
      continue;
    }

    recovered += 1;
    if (execution.status === "cancelling") {
      execution = {
        ...execution,
        updatedAt: now,
        nodes: replaceNode(execution, inactiveNode(node, "cancelled")),
      };
      continue;
    }

    const failures = node.failures + 1;
    if (failures > node.retry.retries) {
      execution = terminalFailure(execution, node.id, ACTIVATION_EXPIRED, failures, now);
      break;
    }

    const ready = inactiveNode(node, "ready", {
      failures,
      availableAt: retryAt(node.retry, failures, now),
      error: ACTIVATION_EXPIRED,
    });
    execution = {
      ...execution,
      updatedAt: now,
      nodes: replaceNode(execution, ready),
    };
  }

  if (execution.status === "cancelling" && !hasRunningNodes(execution.nodes)) {
    execution = { ...execution, status: "cancelled", updatedAt: now };
  } else if (!terminal(execution.status) && execution !== current) {
    execution = {
      ...execution,
      status: hasRunningNodes(execution.nodes) ? "running" : "pending",
      updatedAt: now,
    };
  }
  return { execution, recovered };
}

function ownedNode(
  execution: ExecutionRecord,
  mutation: NodeMutation,
  requireLease = true,
): NodeRecord | undefined {
  const node = execution.nodes[mutation.nodeId];
  if (
    !node ||
    node.status !== "running" ||
    node.activationId !== mutation.activationId ||
    (requireLease && node.leaseExpiresAt !== undefined && node.leaseExpiresAt <= mutation.now)
  ) {
    return undefined;
  }
  return node;
}

function replaceNode(
  execution: ExecutionRecord,
  node: NodeRecord,
): Readonly<Record<string, NodeRecord>> {
  return { ...execution.nodes, [node.id]: node };
}

function activateDependents(execution: ExecutionRecord): ExecutionRecord {
  let changed = false;
  const nodes = { ...execution.nodes };
  for (const [id, node] of Object.entries(nodes)) {
    if (
      node.status === "blocked" &&
      node.dependencies.every((dependency) => nodes[dependency]?.status === "completed")
    ) {
      nodes[id] = { ...node, status: "ready" };
      changed = true;
    }
  }
  return changed ? { ...execution, nodes } : execution;
}

function terminalFailure(
  execution: ExecutionRecord,
  failedNodeId: string,
  error: SerializedError,
  failures: number,
  now: number,
): ExecutionRecord {
  const nodes = Object.fromEntries(
    Object.entries(execution.nodes).map(([id, node]) => {
      if (id === failedNodeId) {
        return [id, inactiveNode(node, "failed", { failures, error })];
      }
      return [id, node.status === "completed" ? node : inactiveNode(node, "cancelled")];
    }),
  );
  return {
    ...execution,
    status: "failed",
    updatedAt: now,
    nodes,
    error,
  };
}

function hasRunningNodes(nodes: Readonly<Record<string, NodeRecord>>): boolean {
  return Object.values(nodes).some((node) => node.status === "running");
}

function inactiveNode(
  node: NodeRecord,
  status: "ready" | "completed" | "failed" | "cancelled",
  changes: Partial<NodeRecord> = {},
): NodeRecord {
  return {
    ...node,
    ...changes,
    status,
    activationId: undefined,
    workerId: undefined,
    leaseExpiresAt: undefined,
  };
}
