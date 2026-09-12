import { randomUUID } from "node:crypto";
import { ManagerClosedError } from "../errors.js";
import type { ClaimedExecution, ExecutionStore } from "../persistence/store.js";
import type { DurableJobRegistry } from "../job/registry.js";
import type { AttemptProvider } from "./attempt.js";
import { JobActivationRunner } from "./job-activation.js";

export interface WorkerOptions {
  readonly store: ExecutionStore;
  readonly registry: DurableJobRegistry;
  readonly providers: readonly AttemptProvider[];
  readonly concurrency: number;
  readonly leaseDurationMs: number;
  readonly pollIntervalMs: number;
}

export interface WorkerFailure {
  readonly error: unknown;
}

interface AttemptFailure extends WorkerFailure {
  readonly attempt: number;
}

interface ActiveExecution {
  readonly executionId: string;
  readonly controller: AbortController;
  readonly promise: Promise<void>;
}

const MANAGER_CLOSED = new ManagerClosedError();

/** Owns job claiming, local activation concurrency, wakeups, and worker shutdown. */
export class DurableWorker {
  private readonly store: ExecutionStore;
  private readonly registry: DurableJobRegistry;
  private readonly concurrency: number;
  private readonly leaseDurationMs: number;
  private readonly workerId = randomUUID();
  private readonly wakeSignal: PollSignal;
  private readonly activationRunner: JobActivationRunner;
  private readonly active = new Map<string, ActiveExecution>();
  private readonly executionFailures = new Map<string, AttemptFailure>();
  private startPromise: Promise<void> | undefined;
  private workerPromise: Promise<void> | undefined;
  private workerFailure: WorkerFailure | undefined;
  private closePromise: Promise<void> | undefined;
  private closing = false;

  constructor(options: WorkerOptions) {
    this.store = options.store;
    this.registry = options.registry;
    this.concurrency = positiveInteger(options.concurrency, "concurrency");
    this.leaseDurationMs = positiveNumber(options.leaseDurationMs, "leaseDurationMs");
    const pollIntervalMs = positiveNumber(options.pollIntervalMs, "pollIntervalMs");
    this.wakeSignal = new PollSignal(pollIntervalMs);
    this.activationRunner = new JobActivationRunner({
      store: options.store,
      registry: options.registry,
      providers: options.providers,
      workerId: this.workerId,
      leaseDurationMs: this.leaseDurationMs,
      heartbeatIntervalMs: Math.max(1, Math.floor(this.leaseDurationMs / 3)),
      isClosing: () => this.closing,
    });
  }

  start(): Promise<void> {
    return (this.startPromise ??= this.startWorker());
  }

  wake(): void {
    this.wakeSignal.wake();
  }

  waitForChange(): Promise<void> {
    return this.wakeSignal.wait();
  }

  failureFor(executionId: string, attempt: number): WorkerFailure | undefined {
    const failure = this.executionFailures.get(executionId);
    return failure?.attempt === attempt ? failure : this.workerFailure;
  }

  abortExecution(executionId: string, reason: unknown): void {
    for (const active of this.active.values()) {
      if (active.executionId === executionId) {
        active.controller.abort(reason);
      }
    }
  }

  close(): Promise<void> {
    return (this.closePromise ??= this.closeWorker());
  }

  private async startWorker(): Promise<void> {
    await this.store.recoverExpired(Date.now());
    if (this.closing) {
      return;
    }

    this.workerPromise = this.workerLoop().catch((error: unknown) => {
      this.workerFailure = { error };
      this.wakeSignal.wake();
    });
    this.wakeSignal.wake();
  }

  private async workerLoop(): Promise<void> {
    while (!this.closing) {
      await this.store.recoverExpired(Date.now());

      while (!this.closing && this.active.size < this.concurrency) {
        const now = Date.now();
        const claimed = await this.store.claim({
          workerId: this.workerId,
          jobs: this.registry.names,
          now,
          leaseExpiresAt: now + this.leaseDurationMs,
        });
        if (!claimed) {
          break;
        }
        if (this.closing) {
          const mutation = {
            executionId: claimed.execution.id,
            activationId: claimed.activationId,
            now: Date.now(),
          };
          if (!(await this.store.release(mutation))) {
            await this.store.acknowledgeCancellation({ ...mutation, now: Date.now() });
          }
          break;
        }
        this.track(claimed);
      }

      if (!this.closing) {
        await this.wakeSignal.wait();
      }
    }
  }

  private track(claimed: ClaimedExecution): void {
    const controller = new AbortController();
    const promise = this.activationRunner
      .run(claimed, controller)
      .catch((error: unknown) => {
        const previous = this.executionFailures.get(claimed.execution.id);
        if (!previous || previous.attempt <= claimed.execution.attempt) {
          this.executionFailures.set(claimed.execution.id, {
            error,
            attempt: claimed.execution.attempt,
          });
        }
      })
      .finally(() => {
        this.active.delete(claimed.activationId);
        this.wakeSignal.wake();
      });
    this.active.set(claimed.activationId, {
      executionId: claimed.execution.id,
      controller,
      promise,
    });
  }

  private async closeWorker(): Promise<void> {
    this.closing = true;
    this.wakeSignal.wake();
    for (const active of this.active.values()) {
      active.controller.abort(MANAGER_CLOSED);
    }
    await this.startPromise;
    await this.workerPromise;
    await Promise.allSettled([...this.active.values()].map((active) => active.promise));
  }
}

class PollSignal {
  private readonly intervalMs: number;
  private readonly listeners = new Set<() => void>();

  constructor(intervalMs: number) {
    this.intervalMs = intervalMs;
  }

  wait(): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    const finish = (): void => {
      clearTimeout(timer);
      this.listeners.delete(finish);
      resolve();
    };
    const timer = setTimeout(finish, this.intervalMs);
    this.listeners.add(finish);
    return promise;
  }

  wake(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer.`);
  }
  return value;
}

function positiveNumber(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${name} must be a finite positive number.`);
  }
  return value;
}
