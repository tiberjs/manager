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
  cancel(reason?: unknown): Promise<void>;
}

export interface WrappedDurableJob<Input, Output> {
  run(input: Input, options?: ExecutionOptions): Execution<Output>;
  get(id: string): Execution<Output>;
}

export type CheckpointRecord = {
  readonly key: string;
  readonly inputFingerprint: string;
} & (
  | { readonly status: "pending" }
  | { readonly status: "running"; readonly activationId: string }
  | { readonly status: "completed"; readonly result: unknown }
);

export interface ExecutionRecord {
  readonly id: string;
  readonly key?: string;
  readonly job: string;
  readonly input: unknown;
  readonly inputFingerprint: string;
  readonly status: ExecutionStatus;
  readonly attempt: number;
  readonly failures: number;
  readonly retry: StoredRetryPolicy;
  readonly availableAt: number;
  readonly activationId?: string;
  readonly workerId?: string;
  readonly leaseExpiresAt?: number;
  readonly checkpoints: Readonly<Record<string, CheckpointRecord>>;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly result?: unknown;
  readonly error?: SerializedError;
  readonly cancellationReason?: SerializedError;
}

export interface ExecutionInfo {
  readonly executionId: string;
  readonly job: string;
  readonly attempt: number;
  readonly signal: AbortSignal;
}
