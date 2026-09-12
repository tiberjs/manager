import type {
  ExecutionRecord,
  ExecutionStatus,
  SerializedError,
  StoredExecutionEvent,
} from "../types.js";

export interface CreateExecutionResult {
  readonly execution: ExecutionRecord;
  readonly created: boolean;
}

export interface ClaimExecutionOptions {
  readonly workerId: string;
  readonly jobs: readonly string[];
  readonly now: number;
  readonly leaseExpiresAt: number;
}

export interface ClaimedExecution {
  readonly execution: ExecutionRecord;
  readonly activationId: string;
}

export type HeartbeatResult = "renewed" | "cancel-requested" | "lost";

export interface ExecutionMutation {
  readonly executionId: string;
  readonly activationId: string;
  readonly now: number;
}

export interface ExecutionFailure extends ExecutionMutation {
  readonly error: SerializedError;
  readonly retryAt: number;
}

export interface CheckpointMutation extends ExecutionMutation {
  readonly key: string;
  readonly inputFingerprint: string;
}

export type BeginCheckpointResult =
  | { readonly status: "execute" }
  | { readonly status: "completed"; readonly result: unknown }
  | { readonly status: "busy" | "conflict" | "lost" };

/**
 * Atomic persisted-execution transitions. Implementations must fence mutations by activation and
 * enforce the state machine; generic read/modify/write storage is insufficient. Returned values
 * must be isolated from stored state.
 */
export interface ExecutionStore {
  create(record: ExecutionRecord): Promise<CreateExecutionResult>;
  load(id: string): Promise<ExecutionRecord | null>;
  readEvents(id: string): Promise<readonly StoredExecutionEvent[]>;
  claim(options: ClaimExecutionOptions): Promise<ClaimedExecution | null>;
  heartbeat(
    mutation: ExecutionMutation,
    workerId: string,
    leaseExpiresAt: number,
  ): Promise<HeartbeatResult>;
  /** Complete a live activation only after it owns no running checkpoint reservation. */
  complete(mutation: ExecutionMutation, result: unknown): Promise<boolean>;
  fail(failure: ExecutionFailure): Promise<boolean>;
  release(mutation: ExecutionMutation): Promise<boolean>;
  acknowledgeCancellation(mutation: ExecutionMutation): Promise<boolean>;
  cancel(id: string, reason: SerializedError, now: number): Promise<boolean>;
  recoverExpired(now: number): Promise<number>;

  /** Atomically fences ownership, checks input identity, and reserves or reuses a checkpoint. */
  beginCheckpoint(mutation: CheckpointMutation): Promise<BeginCheckpointResult>;
  /** Persist success only for the reserved key, matching input and live activation. */
  completeCheckpoint(mutation: CheckpointMutation, result: unknown): Promise<boolean>;
  /** Unreserve failed work without forgetting its input identity. */
  releaseCheckpoint(mutation: CheckpointMutation): Promise<boolean>;
}

export function terminal(status: ExecutionStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}
