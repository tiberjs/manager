export type ExecutionStatus =
  | "pending"
  | "running"
  | "cancelling"
  | "completed"
  | "failed"
  | "cancelled";

export type NodeStatus = "blocked" | "ready" | "running" | "completed" | "failed" | "cancelled";

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
  /** Idempotency key scoped to the workflow definition. */
  readonly key?: string;
  readonly retry?: RetryPolicy;
}

export interface StepOptions {
  readonly retry?: RetryPolicy;
}

export interface WorkflowOptions {
  readonly name: string;
  readonly retry?: RetryPolicy;
}

declare const NODE_VALUE: unique symbol;

/** A symbolic value produced by the workflow input or a completed DAG node. */
export interface NodeRef<T> {
  readonly [NODE_VALUE]: (value: T) => T;
}

export type WorkflowInput<T> = NodeRef<T>;

export type InputBinding<T> =
  | NodeRef<T>
  | (T extends readonly (infer Item)[]
      ? readonly InputBinding<Item>[]
      : T extends object
        ? { readonly [Key in keyof T]: InputBinding<T[Key]> }
        : T);

export interface StepHandler<Input, Output> {
  run(input: Input): Output | PromiseLike<Output>;
}

export type StepConstructor<Input = unknown, Output = unknown> = new () => StepHandler<
  Input,
  Output
>;

export interface WorkflowShape<Input, Output> {
  build(input: WorkflowInput<Input>): NodeRef<Output>;
}

export type WorkflowConstructor = new () => object;

export type WorkflowInputOf<Workflow extends WorkflowConstructor> =
  InstanceType<Workflow> extends { build(input: infer Input): unknown }
    ? Input extends NodeRef<infer Value>
      ? Value
      : never
    : never;

export type WorkflowOutputOf<Workflow extends WorkflowConstructor> =
  InstanceType<Workflow> extends { build(input: never): infer Output }
    ? Output extends NodeRef<infer Value>
      ? Value
      : never
    : never;

export interface Execution<T> extends PromiseLike<T> {
  readonly id: string;
  status(): Promise<ExecutionStatus>;
  cancel(reason?: unknown): Promise<void>;
}

export interface NodeRecord {
  readonly id: string;
  readonly dependencies: readonly string[];
  readonly status: NodeStatus;
  readonly attempt: number;
  readonly failures: number;
  readonly retry: StoredRetryPolicy;
  readonly availableAt: number;
  readonly activationId?: string;
  readonly workerId?: string;
  readonly leaseExpiresAt?: number;
  readonly result?: unknown;
  readonly error?: SerializedError;
}

export interface ExecutionRecord {
  readonly id: string;
  readonly key?: string;
  readonly workflow: string;
  readonly input: unknown;
  readonly inputFingerprint: string;
  readonly outputNodeId: string;
  readonly status: ExecutionStatus;
  readonly nodes: Readonly<Record<string, NodeRecord>>;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly result?: unknown;
  readonly error?: SerializedError;
  readonly cancellationReason?: SerializedError;
}

export interface ExecutionInfo {
  readonly executionId: string;
  readonly workflow: string;
  readonly nodeId: string;
  readonly attempt: number;
  readonly signal: AbortSignal;
}
