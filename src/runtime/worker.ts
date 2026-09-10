import { randomUUID } from "node:crypto";
import { ManagerClosedError } from "../errors.js";
import type { ClaimedNode, ExecutionStore } from "../persistence/store.js";
import type { WorkflowRegistry } from "../workflow/registry.js";
import type { AttemptProvider } from "./attempt.js";
import { NodeActivationRunner } from "./node-activation.js";

export interface WorkerOptions {
  readonly store: ExecutionStore;
  readonly registry: WorkflowRegistry;
  readonly providers: readonly AttemptProvider[];
  readonly concurrency: number;
  readonly leaseDurationMs: number;
  readonly pollIntervalMs: number;
}

export interface WorkerFailure {
  readonly error: unknown;
}

interface ActiveNode {
  readonly executionId: string;
  readonly controller: AbortController;
  readonly promise: Promise<void>;
}

const MANAGER_CLOSED = new ManagerClosedError();

/** Owns node claiming, local activation concurrency, wakeups, and worker shutdown. */
export class DurableWorker {
  private readonly store: ExecutionStore;
  private readonly registry: WorkflowRegistry;
  private readonly concurrency: number;
  private readonly leaseDurationMs: number;
  private readonly workerId = randomUUID();
  private readonly wakeSignal: PollSignal;
  private readonly activationRunner: NodeActivationRunner;
  private readonly active = new Map<string, ActiveNode>();
  private readonly executionFailures = new Map<string, WorkerFailure>();
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
    this.activationRunner = new NodeActivationRunner({
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

  failureFor(executionId: string): WorkerFailure | undefined {
    return this.executionFailures.get(executionId) ?? this.workerFailure;
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
      for (const node of this.active.values()) {
        this.executionFailures.set(node.executionId, { error });
      }
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
          workflows: this.registry.names,
          now,
          leaseExpiresAt: now + this.leaseDurationMs,
        });
        if (!claimed) {
          break;
        }
        this.track(claimed);
      }

      if (!this.closing) {
        await this.wakeSignal.wait();
      }
    }
  }

  private track(claimed: ClaimedNode): void {
    const controller = new AbortController();
    const promise = this.activationRunner
      .run(claimed, controller)
      .then((failure) => {
        if (failure) {
          this.abortExecution(failure.executionId, failure.reason);
        }
      })
      .catch((error: unknown) => {
        this.executionFailures.set(claimed.execution.id, { error });
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
    await Promise.allSettled([...this.active.values()].map((active) => active.promise));
    await this.workerPromise;
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
