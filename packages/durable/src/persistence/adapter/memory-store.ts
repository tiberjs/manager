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
import type { ExecutionTransition } from "../../execution/state.js";
import {
  beginExecutionCheckpoint,
  completeExecutionCheckpoint,
  releaseExecutionCheckpoint,
} from "../../execution/checkpoint-state.js";
import { commitTransition } from "../../execution/ledger.js";
import type {
  BeginCheckpointResult,
  CheckpointMutation,
  ClaimedExecution,
  ClaimExecutionOptions,
  CreateExecutionResult,
  ExecutionFailure,
  ExecutionMutation,
  ExecutionStore,
  HeartbeatResult,
} from "../store.js";
import type { ExecutionRecord, SerializedError, StoredExecutionEvent } from "../../types.js";

/** Clone-isolated reference adapter with an append-only semantic ledger. */
export class MemoryStore implements ExecutionStore {
  private readonly executions = new Map<string, ExecutionRecord>();
  private readonly ledger = new Map<string, StoredExecutionEvent[]>();

  async create(record: ExecutionRecord): Promise<CreateExecutionResult> {
    const id = record.submission.id;
    const existing = this.executions.get(id);
    if (existing) return { execution: structuredClone(existing), created: false };
    const stored = structuredClone(record);
    const execution = this.persist(undefined, {
      execution: stored,
      events: [
        {
          type: "execution-submitted",
          submission: stored.submission,
          at: stored.submission.createdAt,
        },
      ],
    });
    return { execution: structuredClone(execution), created: true };
  }

  async load(id: string): Promise<ExecutionRecord | null> {
    const execution = this.executions.get(id);
    return execution ? structuredClone(execution) : null;
  }

  async readEvents(id: string): Promise<readonly StoredExecutionEvent[]> {
    return structuredClone(this.ledger.get(id) ?? []);
  }

  async claim(options: ClaimExecutionOptions): Promise<ClaimedExecution | null> {
    const jobs = new Set(options.jobs);
    let selected: ExecutionRecord | undefined;
    for (const execution of this.executions.values()) {
      if (
        execution.projection.status !== "pending" ||
        execution.projection.availableAt > options.now ||
        !jobs.has(execution.submission.job)
      )
        continue;
      if (
        !selected ||
        execution.submission.createdAt < selected.submission.createdAt ||
        (execution.submission.createdAt === selected.submission.createdAt &&
          execution.submission.id < selected.submission.id)
      )
        selected = execution;
    }
    if (!selected) return null;
    const activationId = randomUUID();
    const transition = claimExecution(selected, options, activationId);
    if (!transition) return null;
    const execution = this.persist(selected, transition);
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
    if (transition.execution) {
      this.persist(current, { execution: transition.execution, events: [] });
    }
    return transition.result;
  }

  async complete(mutation: ExecutionMutation, result: unknown): Promise<boolean> {
    const storedResult = structuredClone(result);
    return this.update(mutation.executionId, (current) =>
      completeExecution(current, mutation, storedResult),
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
    const storedReason = structuredClone(reason);
    return this.update(id, (current) => cancelExecution(current, storedReason, now));
  }

  async recoverExpired(now: number): Promise<number> {
    let recovered = 0;
    for (const current of this.executions.values()) {
      const transition = recoverExpiredExecution(current, now);
      if (transition) {
        this.persist(current, transition);
        recovered += 1;
      }
    }
    return recovered;
  }

  async beginCheckpoint(mutation: CheckpointMutation): Promise<BeginCheckpointResult> {
    const current = this.executions.get(mutation.executionId);
    if (!current) return { status: "lost" };
    const checkpoint = beginExecutionCheckpoint(current, mutation);
    if (checkpoint.transition) this.persist(current, checkpoint.transition);
    return structuredClone(checkpoint.outcome);
  }

  async completeCheckpoint(mutation: CheckpointMutation, result: unknown): Promise<boolean> {
    const storedResult = structuredClone(result);
    return this.update(mutation.executionId, (current) =>
      completeExecutionCheckpoint(current, mutation, storedResult),
    );
  }

  async releaseCheckpoint(mutation: CheckpointMutation): Promise<boolean> {
    return this.update(mutation.executionId, (current) =>
      releaseExecutionCheckpoint(current, mutation),
    );
  }

  private update(
    id: string,
    transition: (current: ExecutionRecord) => ExecutionTransition | undefined,
  ): boolean {
    const current = this.executions.get(id);
    if (!current) return false;
    const updated = transition(current);
    if (!updated) return false;
    this.persist(current, updated);
    return true;
  }

  private persist(
    current: ExecutionRecord | undefined,
    transition: ExecutionTransition,
  ): ExecutionRecord {
    const committed = commitTransition(current, transition);
    const id = committed.execution.submission.id;
    const execution = structuredClone(committed.execution);
    this.executions.set(id, execution);
    if (committed.events.length > 0) {
      this.ledger.set(id, [...(this.ledger.get(id) ?? []), ...structuredClone(committed.events)]);
    }
    return execution;
  }
}
