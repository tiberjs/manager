import type { Factory, InjectionToken } from "@tiberjs/runner";
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
  Execution,
  ExecutionOptions,
  ExecutionRecord,
  RetryPolicy,
  JobConstructor,
  JobInputOf,
  JobOutputOf,
  WrappedJob,
} from "./types.js";
import { DurableWorker } from "./runtime/worker.js";
import { JobRegistry } from "./job/registry.js";

export interface ManagerOptions {
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
  private readonly registry: JobRegistry;
  private readonly providers: AttemptProvider[] = [];
  private readonly worker: DurableWorker;
  private readonly submissions = new Set<Promise<unknown>>();
  private closePromise: Promise<void> | undefined;
  private closing = false;

  constructor(options: ManagerOptions) {
    this.store = options.store;
    this.autoStart = options.autoStart ?? true;
    this.registry = new JobRegistry(normalizePolicy(options.retry));
    this.worker = new DurableWorker({
      store: options.store,
      registry: this.registry,
      providers: this.providers,
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

  register(...types: JobConstructor[]): this {
    this.assertOpen();
    if (this.registry.register(types)) {
      this.worker.wake();
    }
    return this;
  }

  wrap<Job extends JobConstructor>(type: Job): WrappedJob<JobInputOf<Job>, JobOutputOf<Job>> {
    this.register(type);
    return {
      run: (input, options) => this.run(type, input, options),
      get: (id) => this.get(type, id),
    };
  }

  run<Job extends JobConstructor>(
    type: Job,
    input: JobInputOf<Job>,
    options: ExecutionOptions = {},
  ): Execution<JobOutputOf<Job>> {
    this.assertOpen();
    const registered = this.registry.get(type);
    const record = createExecutionRecord(registered, input, options, Date.now());

    const ready = this.trackSubmission(
      this.store.create(record).then(async ({ execution }) => {
        if (
          execution.job !== record.job ||
          execution.inputFingerprint !== record.inputFingerprint
        ) {
          throw new ExecutionIdentityConflictError(execution.id);
        }
        if (this.autoStart && !this.closing && !terminal(execution.status)) {
          await this.worker.start();
        }
        this.worker.wake();
      }),
    );
    return new ManagedExecution(record.id, this, ready);
  }

  get<Job extends JobConstructor>(type: Job, id: string): Execution<JobOutputOf<Job>> {
    this.assertOpen();
    const registered = this.registry.get(type);
    const ready = this.load(id).then((execution) => {
      if (execution.job !== registered.name) {
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

  async wait<T>(id: string): Promise<T> {
    while (true) {
      const execution = await this.load(id);
      switch (execution.status) {
        case "completed":
          return execution.result as T;
        case "failed":
          throw new ExecutionFailedError(
            id,
            execution.error ?? serializeError("Unknown execution failure"),
          );
        case "cancelled":
          throw new ExecutionCancelledError(
            id,
            execution.cancellationReason ?? serializeError("Cancelled"),
          );
        case "pending":
        case "running":
        case "cancelling": {
          const failure = this.worker.failureFor(id, execution.attempt);
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
