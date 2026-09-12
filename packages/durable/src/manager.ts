import type { Container, Factory, InjectionToken } from "@tiberjs/di";
import type { AttemptProvider } from "./runtime/attempt.js";
import {
  ExecutionCancelledError,
  ExecutionFailedError,
  ExecutionIdentityConflictError,
  ManagerClosedError,
  serializeError,
} from "./errors.js";
import { ManagedExecution } from "./execution/handle.js";
import type { ExecutionHost } from "./execution/handle.js";
import { createExecutionRecord } from "./execution/record.js";
import { normalizePolicy } from "./execution/retry.js";
import type { ExecutionStore } from "./persistence/store.js";
import { terminal } from "./persistence/store.js";
import type {
  DurableJobConstructor,
  DurableJobInputOf,
  DurableJobOutputOf,
  Execution,
  ExecutionOptions,
  ExecutionRecord,
  RetryPolicy,
  StoredExecutionEvent,
  WrappedDurableJob,
} from "./types.js";
import { DurableWorker } from "./runtime/worker.js";
import { DurableJobRegistry } from "./job/registry.js";

export interface ManagerOptions {
  /** Optional application container inherited by every attempt; the Manager never disposes it. */
  readonly parentContainer?: Container;
  readonly store: ExecutionStore;
  readonly concurrency?: number;
  readonly leaseDurationMs?: number;
  readonly pollIntervalMs?: number;
  readonly retry?: RetryPolicy;
  readonly autoStart?: boolean;
}

const MANAGER_CLOSED = new ManagerClosedError();

/** Public composition root for reconstructable jobs and durable Runner execution handles. */
export class Manager implements ExecutionHost, AsyncDisposable {
  private readonly store: ExecutionStore;
  private readonly autoStart: boolean;
  private readonly registry: DurableJobRegistry;
  private readonly providers: AttemptProvider[] = [];
  private readonly worker: DurableWorker;
  private readonly submissions = new Set<Promise<unknown>>();
  private closePromise: Promise<void> | undefined;
  private closing = false;

  constructor(options: ManagerOptions) {
    this.store = options.store;
    this.autoStart = options.autoStart ?? true;
    this.registry = new DurableJobRegistry(normalizePolicy(options.retry));
    this.worker = new DurableWorker({
      store: options.store,
      registry: this.registry,
      providers: this.providers,
      parentContainer: options.parentContainer,
      concurrency: options.concurrency ?? 1,
      leaseDurationMs: options.leaseDurationMs ?? 30_000,
      pollIntervalMs: options.pollIntervalMs ?? 100,
    });
  }

  provide<T>(token: InjectionToken<T>, factory: Factory<T>): this {
    this.assertOpen();
    this.providers.push({ token, factory });
    return this;
  }

  register(...types: DurableJobConstructor[]): this {
    this.assertOpen();
    if (this.registry.register(types)) {
      this.worker.wake();
    }
    return this;
  }

  wrap<Definition extends DurableJobConstructor>(
    type: Definition,
  ): WrappedDurableJob<DurableJobInputOf<Definition>, DurableJobOutputOf<Definition>> {
    this.register(type);
    return {
      run: (input, options) => this.run(type, input, options),
      get: (id) => this.get(type, id),
    };
  }

  run<Definition extends DurableJobConstructor>(
    type: Definition,
    input: DurableJobInputOf<Definition>,
    options: ExecutionOptions = {},
  ): Execution<DurableJobOutputOf<Definition>> {
    this.assertOpen();
    const registered = this.registry.get(type);
    const record = createExecutionRecord(registered, input, options, Date.now());

    const ready = this.trackSubmission(
      this.store.create(record).then(async ({ execution }) => {
        if (
          execution.submission.job !== record.submission.job ||
          execution.submission.inputFingerprint !== record.submission.inputFingerprint
        ) {
          throw new ExecutionIdentityConflictError(execution.submission.id);
        }
        if (this.autoStart && !this.closing && !terminal(execution.projection.status)) {
          await this.worker.start();
        }
        this.worker.wake();
      }),
    );
    return new ManagedExecution(record.submission.id, this, ready);
  }

  get<Definition extends DurableJobConstructor>(
    type: Definition,
    id: string,
  ): Execution<DurableJobOutputOf<Definition>> {
    this.assertOpen();
    const registered = this.registry.get(type);
    const ready = this.load(id).then((execution) => {
      if (execution.submission.job !== registered.name) {
        throw new ExecutionIdentityConflictError(id);
      }
    });
    return new ManagedExecution(id, this, ready);
  }

  start(): Promise<void> {
    this.assertOpen();
    return this.worker.start();
  }

  async load(id: string): Promise<ExecutionRecord> {
    const execution = await this.store.load(id);
    if (!execution) {
      throw new Error(`Execution ${id} does not exist.`);
    }
    return execution;
  }

  async history(id: string): Promise<readonly StoredExecutionEvent[]> {
    return await this.store.readEvents(id);
  }

  async wait<T>(id: string): Promise<T> {
    while (true) {
      const execution = await this.load(id);
      switch (execution.projection.status) {
        case "completed":
          return execution.projection.result as T;
        case "failed":
          throw new ExecutionFailedError(
            id,
            execution.projection.error ?? serializeError("Unknown execution failure"),
          );
        case "cancelled":
          throw new ExecutionCancelledError(
            id,
            execution.projection.cancellationReason ?? serializeError("Cancelled"),
          );
        case "pending":
        case "running":
        case "cancelling": {
          const failure = this.worker.failureFor(id, execution.projection.attempt);
          if (failure) {
            throw failure.error;
          }
          await this.worker.waitForChange();
          break;
        }
      }
    }
  }

  async cancel(
    id: string,
    reason: unknown = new DOMException("Execution cancelled", "AbortError"),
  ): Promise<void> {
    const cancelled = await this.store.cancel(id, serializeError(reason), Date.now());
    if (cancelled) {
      this.worker.abortExecution(id, reason);
      this.worker.wake();
    }
  }

  close(): Promise<void> {
    return (this.closePromise ??= this.closeManager());
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  private async closeManager(): Promise<void> {
    this.closing = true;
    const workerClose = this.worker.close();
    await Promise.allSettled(this.submissions);
    await workerClose;
  }

  private trackSubmission<T>(submission: Promise<T>): Promise<T> {
    this.submissions.add(submission);
    const remove = (): void => {
      this.submissions.delete(submission);
    };
    void submission.then(remove, remove);
    return submission;
  }

  private assertOpen(): void {
    if (this.closing) {
      throw MANAGER_CLOSED;
    }
  }
}

export function createManager(options: ManagerOptions): Manager {
  return new Manager(options);
}
