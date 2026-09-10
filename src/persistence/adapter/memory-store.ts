import { randomUUID } from "node:crypto";
import {
  acknowledgeExecutionCancellation,
  cancelExecution,
  claimExecutionNode,
  completeExecutionNode,
  failExecutionNode,
  heartbeatExecutionNode,
  recoverExpiredExecution,
  releaseExecutionNode,
} from "../../execution/state.js";
import type {
  ClaimedNode,
  ClaimNodeOptions,
  CreateExecutionResult,
  ExecutionStore,
  HeartbeatResult,
  NodeFailure,
  NodeMutation,
} from "../store.js";
import { terminal } from "../store.js";
import type { ExecutionRecord, NodeRecord, SerializedError } from "../../types.js";

/** In-process persistence with clone-isolated reads and atomic synchronous mutations. */
export class MemoryStore implements ExecutionStore {
  private readonly executions = new Map<string, ExecutionRecord>();

  async create(record: ExecutionRecord): Promise<CreateExecutionResult> {
    const existing = this.executions.get(record.id);
    if (existing) {
      return { execution: clone(existing), created: false };
    }

    const stored = clone(record);
    this.executions.set(stored.id, stored);
    return { execution: clone(stored), created: true };
  }

  async load(id: string): Promise<ExecutionRecord | null> {
    const execution = this.executions.get(id);
    return execution ? clone(execution) : null;
  }

  async claim(options: ClaimNodeOptions): Promise<ClaimedNode | null> {
    const selected = selectReadyNode(this.executions.values(), options);
    if (!selected) {
      return null;
    }

    const activationId = randomUUID();
    const execution = claimExecutionNode(
      selected.execution,
      selected.node.id,
      options,
      activationId,
    );
    if (!execution) {
      return null;
    }

    this.executions.set(execution.id, execution);
    return {
      execution: clone(execution),
      nodeId: selected.node.id,
      activationId,
    };
  }

  async heartbeat(
    mutation: NodeMutation,
    workerId: string,
    leaseExpiresAt: number,
  ): Promise<HeartbeatResult> {
    const current = this.executions.get(mutation.executionId);
    if (!current) {
      return "lost";
    }

    const transition = heartbeatExecutionNode(current, mutation, workerId, leaseExpiresAt);
    if (transition.execution) {
      this.executions.set(current.id, transition.execution);
    }
    return transition.result;
  }

  async complete(mutation: NodeMutation, result: unknown): Promise<boolean> {
    return this.update(mutation.executionId, (current) =>
      completeExecutionNode(current, mutation, clone(result)),
    );
  }

  async fail(failure: NodeFailure): Promise<boolean> {
    const storedFailure = { ...failure, error: clone(failure.error) };
    return this.update(failure.executionId, (current) => failExecutionNode(current, storedFailure));
  }

  async release(mutation: NodeMutation): Promise<boolean> {
    return this.update(mutation.executionId, (current) => releaseExecutionNode(current, mutation));
  }

  async acknowledgeCancellation(mutation: NodeMutation): Promise<boolean> {
    return this.update(mutation.executionId, (current) =>
      acknowledgeExecutionCancellation(current, mutation),
    );
  }

  async cancel(id: string, reason: SerializedError, now: number): Promise<boolean> {
    return this.update(id, (current) => cancelExecution(current, clone(reason), now));
  }

  async recoverExpired(now: number): Promise<number> {
    let recovered = 0;
    for (const [id, current] of this.executions) {
      const transition = recoverExpiredExecution(current, now);
      recovered += transition.recovered;
      if (transition.execution !== current) {
        this.executions.set(id, transition.execution);
      }
    }
    return recovered;
  }

  private update(
    id: string,
    transition: (current: ExecutionRecord) => ExecutionRecord | undefined,
  ): boolean {
    const current = this.executions.get(id);
    if (!current) {
      return false;
    }

    const updated = transition(current);
    if (!updated) {
      return false;
    }
    this.executions.set(id, updated);
    return true;
  }
}

interface SelectedNode {
  readonly execution: ExecutionRecord;
  readonly node: NodeRecord;
}

function selectReadyNode(
  executions: Iterable<ExecutionRecord>,
  options: ClaimNodeOptions,
): SelectedNode | undefined {
  const workflows = new Set(options.workflows);
  let selected: SelectedNode | undefined;

  for (const execution of executions) {
    if (
      terminal(execution.status) ||
      execution.status === "cancelling" ||
      !workflows.has(execution.workflow)
    ) {
      continue;
    }

    for (const node of Object.values(execution.nodes)) {
      if (node.status !== "ready" || node.availableAt > options.now) {
        continue;
      }
      if (
        !selected ||
        execution.createdAt < selected.execution.createdAt ||
        (execution.createdAt === selected.execution.createdAt && node.id < selected.node.id)
      ) {
        selected = { execution, node };
      }
    }
  }
  return selected;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
