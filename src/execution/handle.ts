import type { Execution, ExecutionRecord, ExecutionStatus } from "../types.js";

export interface ExecutionHost {
  load(id: string): Promise<ExecutionRecord>;
  wait<T>(id: string): Promise<T>;
  cancel(id: string, reason?: unknown): Promise<void>;
}

export class ManagedExecution<T> implements Execution<T> {
  readonly id: string;
  private readonly host: ExecutionHost;
  private readonly ready: Promise<void>;
  private resultPromise: Promise<T> | undefined;

  constructor(id: string, host: ExecutionHost, ready: Promise<unknown>) {
    this.id = id;
    this.host = host;
    this.ready = ready.then(() => undefined);
  }

  // oxlint-disable-next-line unicorn/no-thenable -- Durable executions are intentionally awaitable.
  then<Result = T, Failure = never>(
    onfulfilled?: ((value: T) => Result | PromiseLike<Result>) | null,
    onrejected?: ((reason: unknown) => Failure | PromiseLike<Failure>) | null,
  ): Promise<Result | Failure> {
    return this.result().then(onfulfilled, onrejected);
  }

  async status(): Promise<ExecutionStatus> {
    await this.ready;
    return (await this.host.load(this.id)).status;
  }

  async cancel(reason?: unknown): Promise<void> {
    await this.ready;
    await this.host.cancel(this.id, reason);
  }

  private result(): Promise<T> {
    return (this.resultPromise ??= this.ready.then(() => this.host.wait<T>(this.id)));
  }
}
