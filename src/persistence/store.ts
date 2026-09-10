import type { ExecutionRecord, ExecutionStatus, SerializedError } from "../types.js";

export interface CreateExecutionResult {
  readonly execution: ExecutionRecord;
  readonly created: boolean;
}

export interface ClaimNodeOptions {
  readonly workerId: string;
  readonly workflows: readonly string[];
  readonly now: number;
  readonly leaseExpiresAt: number;
}

export interface ClaimedNode {
  readonly execution: ExecutionRecord;
  readonly nodeId: string;
  readonly activationId: string;
}

export type HeartbeatResult = "renewed" | "cancel-requested" | "lost";

export interface NodeMutation {
  readonly executionId: string;
  readonly nodeId: string;
  readonly activationId: string;
  readonly now: number;
}

export interface NodeFailure extends NodeMutation {
  readonly error: SerializedError;
  readonly retryAt: number;
}

/** Persistence and atomic state transitions for the built-in DAG runtime. */
export interface ExecutionStore {
  create(record: ExecutionRecord): Promise<CreateExecutionResult>;
  load(id: string): Promise<ExecutionRecord | null>;

  claim(options: ClaimNodeOptions): Promise<ClaimedNode | null>;
  heartbeat(
    mutation: NodeMutation,
    workerId: string,
    leaseExpiresAt: number,
  ): Promise<HeartbeatResult>;
  complete(mutation: NodeMutation, result: unknown): Promise<boolean>;
  fail(failure: NodeFailure): Promise<boolean>;
  release(mutation: NodeMutation): Promise<boolean>;
  acknowledgeCancellation(mutation: NodeMutation): Promise<boolean>;

  cancel(id: string, reason: SerializedError, now: number): Promise<boolean>;
  recoverExpired(now: number): Promise<number>;
}

export function terminal(status: ExecutionStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}
