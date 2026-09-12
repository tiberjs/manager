export type ExecutionStatus =
  | "pending"
  | "running"
  | "cancelling"
  | "completed"
  | "failed"
  | "cancelled";

export interface SerializedError {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
  readonly cause?: SerializedError;
  readonly errors?: readonly SerializedError[];
}

export interface RetryPolicy {
  /** Number of retries after the first failed attempt. */
  readonly retries?: number;
  readonly delayMs?: number;
  readonly backoff?: number;
  readonly maxDelayMs?: number;
}

export interface StoredRetryPolicy {
  readonly retries: number;
  readonly delayMs: number;
  readonly backoff: number;
  readonly maxDelayMs: number;
}

export interface ExecutionOptions {
  /** Idempotency key scoped to the registered job name. */
  readonly key?: string;
  readonly retry?: RetryPolicy;
}

export interface DurableJobOptions {
  readonly name: string;
  readonly retry?: RetryPolicy;
}

export interface DurableJobHandler<Input, Output> {
  run(input: Input): Output | PromiseLike<Output>;
}

export type DurableJobConstructor = new () => DurableJobHandler<never, unknown>;
export type DurableJobInputOf<Definition extends DurableJobConstructor> =
  Parameters<InstanceType<Definition>["run"]> extends []
    ? undefined
    : Parameters<InstanceType<Definition>["run"]>[0];
export type DurableJobOutputOf<Definition extends DurableJobConstructor> = Awaited<
  ReturnType<InstanceType<Definition>["run"]>
>;

export interface Execution<T> extends PromiseLike<T> {
  readonly id: string;
  status(): Promise<ExecutionStatus>;
  history(): Promise<readonly StoredExecutionEvent[]>;
  cancel(reason?: unknown): Promise<void>;
}

export interface WrappedDurableJob<Input, Output> {
  run(input: Input, options?: ExecutionOptions): Execution<Output>;
  get(id: string): Execution<Output>;
}

/** Immutable admission data. Retry and input are snapshots fixed for the execution lifetime. */
export interface ExecutionSubmission {
  readonly id: string;
  readonly key?: string;
  readonly job: string;
  readonly input: unknown;
  readonly inputFingerprint: string;
  readonly retry: StoredRetryPolicy;
  readonly createdAt: number;
}

/** Materialized logical state. `revision` is the last appended semantic event sequence. */
export interface ExecutionProjection {
  readonly revision: number;
  readonly status: ExecutionStatus;
  readonly attempt: number;
  readonly failures: number;
  readonly availableAt: number;
  readonly updatedAt: number;
  readonly result?: unknown;
  readonly error?: SerializedError;
  readonly cancellationReason?: SerializedError;
}

/** Mutable worker ownership. It exists only while an attempt owns the execution. */
export interface ActivationLease {
  readonly activationId: string;
  readonly workerId: string;
  readonly leaseExpiresAt: number;
}

export type CheckpointRecord = {
  readonly key: string;
  readonly inputFingerprint: string;
} & (
  | { readonly status: "pending" }
  | { readonly status: "running"; readonly activationId: string }
  | { readonly status: "completed"; readonly result: unknown }
);

/** Aggregate read model assembled from immutable, projected, and operational persistence. */
export interface ExecutionRecord {
  readonly submission: ExecutionSubmission;
  readonly projection: ExecutionProjection;
  readonly activation?: ActivationLease;
  readonly checkpoints: Readonly<Record<string, CheckpointRecord>>;
}

interface EventBase {
  readonly at: number;
}

export type ExecutionEvent =
  | (EventBase & {
      readonly type: "execution-submitted";
      readonly submission: ExecutionSubmission;
    })
  | (EventBase & {
      readonly type: "attempt-started";
      readonly attempt: number;
      readonly activationId: string;
      readonly workerId: string;
    })
  | (EventBase & {
      readonly type: "attempt-failed";
      readonly attempt: number;
      readonly activationId: string;
      readonly failure: number;
      readonly error: SerializedError;
      readonly retryAt?: number;
    })
  | (EventBase & {
      readonly type: "attempt-released";
      readonly attempt: number;
      readonly activationId: string;
      readonly reason: "manager-shutdown";
    })
  | (EventBase & {
      readonly type: "activation-expired";
      readonly attempt: number;
      readonly activationId: string;
      readonly failure: number;
      readonly retryAt?: number;
    })
  | (EventBase & {
      readonly type: "cancellation-requested";
      readonly reason: SerializedError;
    })
  | (EventBase & {
      readonly type: "execution-cancelled";
      readonly activationId?: string;
    })
  | (EventBase & {
      readonly type: "execution-completed";
      readonly attempt: number;
      readonly activationId: string;
      readonly result: unknown;
    })
  | (EventBase & {
      readonly type: "checkpoint-declared";
      readonly key: string;
      readonly inputFingerprint: string;
    })
  | (EventBase & {
      readonly type: "checkpoint-completed";
      readonly key: string;
      readonly inputFingerprint: string;
      readonly activationId: string;
      readonly result: unknown;
    });

export interface StoredExecutionEvent {
  readonly executionId: string;
  readonly sequence: number;
  readonly event: ExecutionEvent;
}

export interface ExecutionInfo {
  readonly executionId: string;
  readonly job: string;
  readonly attempt: number;
  readonly signal: AbortSignal;
}
