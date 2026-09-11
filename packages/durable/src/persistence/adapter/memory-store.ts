import { randomUUID } from "node:crypto";
import {
  acknowledgeExecutionCancellation,
  cancelExecution,
  claimExecution,
  completeExecution,
  failExecution,
  heartbeatExecution,
  recoverExpiredExecution,
  releaseExecution,
} from "../../execution/state.js";
import {
  beginExecutionCheckpoint,
  completeExecutionCheckpoint,
  releaseExecutionCheckpoint,
} from "../../execution/checkpoint-state.js";
import type {
  BeginCheckpointResult,
  CheckpointMutation,
  ClaimedExecution,
  ClaimExecutionOptions,
  CreateExecutionResult,
  ExecutionStore,
  HeartbeatResult,
  ExecutionFailure,
  ExecutionMutation,
} from "../store.js";
import type { ExecutionRecord, SerializedError } from "../../types.js";

/** Clone-isolated reference adapter; all read/modify/write operations are synchronous and atomic. */
export class MemoryStore implements ExecutionStore {
  private readonly executions = new Map<string, ExecutionRecord>();

  async create(record: ExecutionRecord): Promise<CreateExecutionResult> {
    const existing = this.executions.get(record.id);
    if (existing) return { execution: structuredClone(existing), created: false };
    const stored = structuredClone(record);
    this.executions.set(stored.id, stored);
    return { execution: structuredClone(stored), created: true };
  }

  async load(id: string): Promise<ExecutionRecord | null> {
    const execution = this.executions.get(id);
    return execution ? structuredClone(execution) : null;
  }

  async claim(options: ClaimExecutionOptions): Promise<ClaimedExecution | null> {
    const jobs = new Set(options.jobs);
    let selected: ExecutionRecord | undefined;
    for (const execution of this.executions.values()) {
      if (
        execution.status !== "pending" ||
        execution.availableAt > options.now ||
        !jobs.has(execution.job)
      )
        continue;
      if (
        !selected ||
        execution.createdAt < selected.createdAt ||
        (execution.createdAt === selected.createdAt && execution.id < selected.id)
      )
        selected = execution;
    }
    if (!selected) return null;
    const activationId = randomUUID();
    const execution = claimExecution(selected, options, activationId);
    if (!execution) return null;
    this.executions.set(execution.id, execution);
    return { execution: structuredClone(execution), activationId };
  }

  async heartbeat(
    mutation: ExecutionMutation,
    workerId: string,
    leaseExpiresAt: number,
  ): Promise<HeartbeatResult> {
    const current = this.executions.get(mutation.executionId);
    if (!current) return "lost";
    const transition = heartbeatExecution(current, mutation, workerId, leaseExpiresAt);
    if (transition.execution) this.executions.set(current.id, transition.execution);
    return transition.result;
  }

  async complete(mutation: ExecutionMutation, result: unknown): Promise<boolean> {
    return this.update(mutation.executionId, (current) =>
      completeExecution(current, mutation, structuredClone(result)),
    );
  }

  async fail(failure: ExecutionFailure): Promise<boolean> {
    const stored = { ...failure, error: structuredClone(failure.error) };
    return this.update(failure.executionId, (current) => failExecution(current, stored));
  }

  async release(mutation: ExecutionMutation): Promise<boolean> {
    return this.update(mutation.executionId, (current) => releaseExecution(current, mutation));
  }

  async acknowledgeCancellation(mutation: ExecutionMutation): Promise<boolean> {
    return this.update(mutation.executionId, (current) =>
      acknowledgeExecutionCancellation(current, mutation),
    );
  }

  async cancel(id: string, reason: SerializedError, now: number): Promise<boolean> {
    return this.update(id, (current) => cancelExecution(current, structuredClone(reason), now));
  }

  async recoverExpired(now: number): Promise<number> {
    let recovered = 0;
    for (const [id, current] of this.executions) {
      const execution = recoverExpiredExecution(current, now);
      if (execution) {
        this.executions.set(id, execution);
        recovered += 1;
      }
    }
    return recovered;
  }

  async beginCheckpoint(mutation: CheckpointMutation): Promise<BeginCheckpointResult> {
    const current = this.executions.get(mutation.executionId);
    if (!current) return { status: "lost" };
    const transition = beginExecutionCheckpoint(current, mutation);
    if (transition.execution) this.executions.set(current.id, transition.execution);
    return structuredClone(transition.outcome);
  }

  async completeCheckpoint(mutation: CheckpointMutation, result: unknown): Promise<boolean> {
    return this.update(mutation.executionId, (current) =>
      completeExecutionCheckpoint(current, mutation, structuredClone(result)),
    );
  }

  async releaseCheckpoint(mutation: CheckpointMutation): Promise<boolean> {
    return this.update(mutation.executionId, (current) =>
      releaseExecutionCheckpoint(current, mutation),
    );
  }

  private update(
    id: string,
    transition: (current: ExecutionRecord) => ExecutionRecord | undefined,
  ): boolean {
    const current = this.executions.get(id);
    if (!current) return false;
    const updated = transition(current);
    if (!updated) return false;
    this.executions.set(id, updated);
    return true;
  }
}
