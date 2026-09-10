import type { Execution, ExecutionRecord, ExecutionStatus } from "../types.js";

export interface ExecutionHost {
  load(id: string): Promise<ExecutionRecord>;
  wait<T>(id: string): Promise<T>;
  cancel(id: string, reason?: unknown): Promise<void>;
}

export class ManagedExecution<T> implements Execution<T> {
  readonly id: string;
  private readonly host: ExecutionHost;
  private readonly admission: Promise<{ readonly error: unknown } | undefined>;
  private resultPromise: Promise<T> | undefined;

  constructor(id: string, host: ExecutionHost, ready: Promise<unknown>) {
    this.id = id;
    this.host = host;
    // Handles may be observed later; retain admission errors without an unowned rejection.
    this.admission = ready.then(
      () => undefined,
      (error: unknown) => ({ error }),
    );
  }

  // oxlint-disable-next-line unicorn/no-thenable -- Durable executions are intentionally awaitable.
  then<Result = T, Failure = never>(
    onfulfilled?: ((value: T) => Result | PromiseLike<Result>) | null,
    onrejected?: ((reason: unknown) => Failure | PromiseLike<Failure>) | null,
  ): Promise<Result | Failure> {
    return this.result().then(onfulfilled, onrejected);
  }

  async status(): Promise<ExecutionStatus> {
    await this.waitUntilReady();
    return (await this.host.load(this.id)).status;
  }

  async cancel(reason?: unknown): Promise<void> {
    await this.waitUntilReady();
    await this.host.cancel(this.id, reason);
  }

  private result(): Promise<T> {
    return (this.resultPromise ??= this.waitUntilReady().then(() => this.host.wait<T>(this.id)));
  }

  private async waitUntilReady(): Promise<void> {
    const failure = await this.admission;
    if (failure) {
      throw failure.error;
    }
  }
}
