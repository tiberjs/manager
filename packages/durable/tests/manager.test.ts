import { inject, onDispose, token } from "@tiberjs/di";
import { fork, signal } from "@tiberjs/runner";
import { afterEach, describe, expect, it } from "vitest";
import {
  DuplicateJobError,
  CheckpointContext,
  DurableJob,
  ExecutionCancelledError,
  ExecutionFailedError,
  ExecutionIdentityConflictError,
  Manager,
  MemoryStore,
  createManager,
  currentExecution,
} from "../src/index.js";
import type {
  ClaimedExecution,
  ClaimExecutionOptions,
  DurableJobConstructor,
  DurableJobOptions,
  ExecutionMutation,
  ManagerOptions,
} from "../src/index.js";

const managers: Manager[] = [];
function create(store = new MemoryStore(), options: Partial<ManagerOptions> = {}): Manager {
  const manager = createManager({
    store,
    concurrency: 2,
    pollIntervalMs: 5,
    leaseDurationMs: 1000,
    ...options,
  });
  managers.push(manager);
  return manager;
}
function define<Value extends DurableJobConstructor>(
  options: string | DurableJobOptions,
  type: Value,
): Value {
  DurableJob(options)(type, {} as ClassDecoratorContext<Value>);
  return type;
}
function untilAborted(): Promise<never> {
  const current = signal();
  current.throwIfAborted();
  const deferred = Promise.withResolvers<never>();
  current.addEventListener("abort", () => deferred.reject(current.reason), { once: true });
  return deferred.promise;
}
function nextTurn(): Promise<void> {
  const deferred = Promise.withResolvers<void>();
  setImmediate(deferred.resolve);
  return deferred.promise;
}
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.close()));
});

describe("durable Runner jobs", () => {
  it("does not poison a new attempt with a previous activation infrastructure failure", async () => {
    const resumed = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const unavailable = new Error("commit unavailable");
    class RecoverableStore extends MemoryStore {
      rejected = false;
      override async complete(mutation: ExecutionMutation, result: unknown): Promise<boolean> {
        if (!this.rejected) {
          this.rejected = true;
          await super.release(mutation);
          throw unavailable;
        }
        return super.complete(mutation, result);
      }
    }
    const Echo = define(
      "recover-infrastructure",
      class {
        async run(): Promise<number> {
          if (currentExecution().attempt > 1) {
            resumed.resolve();
            await finish.promise;
          }
          return 42;
        }
      },
    );
    const manager = create(new RecoverableStore());
    const wrapped = manager.wrap(Echo);
    const original = wrapped.run(undefined);
    await expect(original).rejects.toBe(unavailable);
    await resumed.promise;
    const fresh = wrapped.get(original.id);
    const result = fresh.then(
      () => "completed",
      (error: unknown) => error,
    );
    await nextTurn();
    finish.resolve();
    await expect(result).resolves.toBe("completed");
  });

  it("preserves cleanup failure when the heartbeat aborts an attempt", async () => {
    const infrastructureFailure = new Error("heartbeat unavailable");
    const cleanupFailure = new Error("cleanup failed");
    class FailedHeartbeatStore extends MemoryStore {
      override async heartbeat(): Promise<never> {
        throw infrastructureFailure;
      }
    }
    const Wait = define(
      "heartbeat-cleanup",
      class {
        constructor() {
          onDispose(() => {
            throw cleanupFailure;
          });
        }
        async run(): Promise<void> {
          await untilAborted();
        }
      },
    );
    const execution = create(new FailedHeartbeatStore(), { leaseDurationMs: 60 })
      .wrap(Wait)
      .run(undefined);
    const failure = await execution.then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(AggregateError);
    if (!(failure instanceof AggregateError)) throw new Error("Expected combined failure.");
    expect(failure.errors).toContain(cleanupFailure);
  });

  it("keeps Runner context available during job resource disposal", async () => {
    let disposedJob: string | undefined;
    const Resource = token<number>("cleanup-value");
    const Cleanup = define(
      "cleanup-context",
      class {
        readonly value = inject(Resource);
        constructor() {
          onDispose(() => {
            disposedJob = currentExecution().job;
            expect(inject(Resource)).toBe(42);
            expect(signal().aborted).toBe(false);
          });
        }
        run(): number {
          return 42;
        }
      },
    );
    await expect(
      create()
        .provide(Resource, () => 42)
        .wrap(Cleanup)
        .run(undefined),
    ).resolves.toBe(42);
    expect(disposedJob).toBe("cleanup-context");
  });

  it("acknowledges a cancelled claim arriving after shutdown", async () => {
    const claimed = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    class SlowStore extends MemoryStore {
      override async claim(options: ClaimExecutionOptions): Promise<ClaimedExecution | null> {
        const result = await super.claim(options);
        if (result) {
          claimed.resolve();
          await release.promise;
        }
        return result;
      }
    }
    let runs = 0;
    const Echo = define(
      "late-cancel",
      class {
        run(): void {
          runs += 1;
        }
      },
    );
    const manager = create(new SlowStore());
    const execution = manager.wrap(Echo).run(undefined);
    await claimed.promise;
    await execution.cancel("stop before handler");
    const closing = manager.close();
    release.resolve();
    await closing;
    expect(runs).toBe(0);
    await expect(execution.status()).resolves.toBe("cancelled");
  });

  it("acknowledges cancellation racing with the final result commit", async () => {
    const committing = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    class CommitGateStore extends MemoryStore {
      override async complete(mutation: ExecutionMutation, result: unknown): Promise<boolean> {
        committing.resolve();
        await release.promise;
        return super.complete(mutation, result);
      }
    }
    const Echo = define(
      "commit-race",
      class {
        run(): number {
          return 42;
        }
      },
    );
    const execution = create(new CommitGateStore(), { leaseDurationMs: 60_000 })
      .wrap(Echo)
      .run(undefined);
    await committing.promise;
    await execution.cancel("too late for handler, not for commit");
    release.resolve();
    await nextTurn();
    await expect(execution.status()).resolves.toBe("cancelled");
    await expect(execution).rejects.toBeInstanceOf(ExecutionCancelledError);
  });

  it("wraps ordinary handlers while Runner owns dynamic parallel work", async () => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let count = 0;
    const Research = define(
      "research",
      class {
        async run(query: string): Promise<string> {
          const results = await Promise.all(
            ["web", "papers"].map((source) =>
              fork(async () => {
                count += 1;
                if (count === 2) started.resolve();
                await release.promise;
                return `${source}:${query}`;
              }),
            ),
          );
          return results.join("|");
        }
      },
    );
    const wrapped = create().wrap(Research);
    const execution = wrapped.run("durable");
    await started.promise;
    await expect(execution.status()).resolves.toBe("running");
    release.resolve();
    await expect(execution).resolves.toBe("web:durable|papers:durable");
    await expect(wrapped.get(execution.id)).resolves.toBe("web:durable|papers:durable");
  });

  it("retries the entire ordinary handler with a fresh DI container", async () => {
    let constructions = 0;
    let effects = 0;
    let disposals = 0;
    const Retry = define(
      { name: "retry", retry: { retries: 1 } },
      class {
        constructor() {
          constructions += 1;
          onDispose(() => {
            disposals += 1;
          });
        }
        run(input: number): number {
          effects += 1;
          if (currentExecution().attempt === 1) throw new Error("transient");
          return input * 2;
        }
      },
    );
    await expect(create().wrap(Retry).run(21)).resolves.toBe(42);
    expect([constructions, effects, disposals]).toEqual([2, 2, 2]);
  });

  it("persists a genuine Runner child failure as an attempt failure", async () => {
    let runs = 0;
    const store = new MemoryStore();
    const Retried = define(
      { name: "runner-child-retry", retry: { retries: 1 } },
      class {
        run(): number {
          runs += 1;
          if (runs === 1) {
            fork(() => {
              throw new Error("child failed");
            });
            return -1;
          }
          return 42;
        }
      },
    );
    const execution = create(store).wrap(Retried).run(undefined);
    await expect(execution).resolves.toBe(42);
    await expect(store.load(execution.id)).resolves.toMatchObject({
      status: "completed",
      attempt: 2,
      failures: 1,
      result: 42,
    });
  });

  it("exhausts retries without executing code after the failure", async () => {
    let runs = 0;
    let after = false;
    const Broken = define(
      "broken",
      class {
        run(input: boolean): void {
          runs += 1;
          if (input) throw new Error("permanent");
          after = true;
        }
      },
    );
    await expect(
      create()
        .wrap(Broken)
        .run(true, { retry: { retries: 1 } }),
    ).rejects.toMatchObject({
      name: "ExecutionFailedError",
      error: { message: "permanent" },
    });
    expect(runs).toBe(2);
    expect(after).toBe(false);
  });

  it("replays dynamic checkpoints after shutdown in a different manager", async () => {
    const blocked = Promise.withResolvers<void>();
    let plans = 0;
    let tools = 0;
    let runs = 0;
    const Agent = define(
      "agent",
      class {
        readonly durable = inject(CheckpointContext);
        async run(input: number): Promise<number> {
          runs += 1;
          const plan = await this.durable.checkpoint("plan", input, () => {
            plans += 1;
            return { tool: "double", value: input + 1 };
          });
          const result = await this.durable.checkpoint(`tool:${plan.tool}`, plan, () => {
            tools += 1;
            return plan.value * 2;
          });
          if (runs === 1) {
            blocked.resolve();
            await untilAborted();
          }
          return result;
        }
      },
    );
    const store = new MemoryStore();
    const first = create(store);
    const original = first.wrap(Agent).run(20);
    await blocked.promise;
    await first.close();
    await expect(store.load(original.id)).resolves.toMatchObject({
      status: "pending",
      failures: 0,
      checkpoints: {
        plan: { status: "completed" },
        "tool:double": { status: "completed", result: 42 },
      },
    });
    const second = create(store);
    const wrapped = second.wrap(Agent);
    await second.start();
    await expect(wrapped.get(original.id)).resolves.toBe(42);
    expect([runs, plans, tools]).toEqual([2, 1, 1]);
  });

  it("waits after no additional work rather than continuously polling", async () => {
    class CountingStore extends MemoryStore {
      claims = 0;
      override async claim(options: ClaimExecutionOptions): Promise<ClaimedExecution | null> {
        this.claims += 1;
        return super.claim(options);
      }
    }
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const Wait = define(
      "wait",
      class {
        async run(): Promise<void> {
          started.resolve();
          await release.promise;
        }
      },
    );
    const store = new CountingStore();
    const execution = create(store, { pollIntervalMs: 1000 }).wrap(Wait).run(undefined);
    await started.promise;
    await nextTurn();
    const claims = store.claims;
    await nextTurn();
    expect(store.claims).toBe(claims);
    release.resolve();
    await expect(execution).resolves.toBeUndefined();
  });

  it("acknowledges cancellation only after Runner children and cleanup unwind", async () => {
    const started = Promise.withResolvers<void>();
    const cleanupStarted = Promise.withResolvers<void>();
    const releaseCleanup = Promise.withResolvers<void>();
    let childStopped = false;
    const Wait = define(
      "cancel",
      class {
        constructor() {
          onDispose(async () => {
            cleanupStarted.resolve();
            await releaseCleanup.promise;
          });
        }
        async run(): Promise<void> {
          fork(async () => {
            try {
              await untilAborted();
            } finally {
              childStopped = true;
            }
          });
          started.resolve();
          await untilAborted();
        }
      },
    );
    const execution = create().wrap(Wait).run(undefined);
    const rejection = execution.then(
      () => undefined,
      (error: unknown) => error,
    );
    await started.promise;
    await execution.cancel("stop");
    await cleanupStarted.promise;
    await expect(execution.status()).resolves.toBe("cancelling");
    expect(childStopped).toBe(true);
    releaseCleanup.resolve();
    await expect(rejection).resolves.toBeInstanceOf(ExecutionCancelledError);
    await expect(execution.status()).resolves.toBe("cancelled");
  });

  it("finishes cancellation when shutdown overlaps unwinding", async () => {
    const started = Promise.withResolvers<void>();
    const Wait = define(
      "cancel-close",
      class {
        async run(): Promise<void> {
          started.resolve();
          await untilAborted();
        }
      },
    );
    const store = new MemoryStore();
    const manager = create(store);
    const execution = manager.wrap(Wait).run(undefined);
    const rejection = execution.then(
      () => undefined,
      (error: unknown) => error,
    );
    await started.promise;
    await execution.cancel();
    await manager.close();
    await expect(rejection).resolves.toBeInstanceOf(ExecutionCancelledError);
    await expect(store.load(execution.id)).resolves.toMatchObject({ status: "cancelled" });
  });

  it("provides attempt DI and metadata and commits only after cleanup", async () => {
    const Value = token<number>("value");
    let childCompleted = false;
    let disposed = false;
    const Managed = define(
      "managed",
      class {
        readonly value = inject(Value);
        run(input: number): number {
          expect(currentExecution()).toMatchObject({ job: "managed", attempt: 1 });
          onDispose(() => {
            disposed = true;
          });
          fork(async () => {
            await Promise.resolve();
            childCompleted = true;
          });
          return input + this.value;
        }
      },
    );
    await expect(
      create()
        .provide(Value, () => 2)
        .wrap(Managed)
        .run(40),
    ).resolves.toBe(42);
    expect(childCompleted).toBe(true);
    expect(disposed).toBe(true);
  });

  it("deduplicates keyed input and rejects conflicting input across managers", async () => {
    let runs = 0;
    const Echo = define(
      "keyed",
      class {
        run(input: number): number {
          runs += 1;
          return input;
        }
      },
    );
    const store = new MemoryStore();
    const first = create(store).wrap(Echo).run(42, { key: "answer" });
    const wrapped = create(store).wrap(Echo);
    const duplicate = wrapped.run(42, { key: "answer" });
    const conflict = wrapped.run(7, { key: "answer" });
    const rejected = expect(conflict).rejects.toBeInstanceOf(ExecutionIdentityConflictError);
    expect(duplicate.id).toBe(first.id);
    await expect(Promise.all([first, duplicate])).resolves.toEqual([42, 42]);
    await rejected;
    expect(runs).toBe(1);
  });

  it("snapshots input at submission before an asynchronous store accepts it", async () => {
    const Echo = define(
      "snapshot",
      class {
        run(input: { value: number }): number {
          return input.value;
        }
      },
    );
    const input = { value: 42 };
    const execution = create().wrap(Echo).run(input);
    input.value = 99;
    await expect(execution).resolves.toBe(42);
  });

  it("validates a registration batch without constructing or partially registering jobs", async () => {
    let constructions = 0;
    const First = define(
      "atomic",
      class {
        constructor() {
          constructions += 1;
        }
        run(input: number): number {
          return input;
        }
      },
    );
    const Conflict = define(
      "atomic",
      class {
        run(): void {}
      },
    );
    const manager = create();
    expect(() => manager.register(First, Conflict)).toThrow(DuplicateJobError);
    expect(() => manager.run(First, 42)).toThrow();
    expect(constructions).toBe(0);
    await expect(manager.wrap(First).run(42)).resolves.toBe(42);
  });

  it("rejects invalid reusable retry policy before admission", () => {
    const Broken = define(
      { name: "invalid-retry", retry: { backoff: 0 } },
      class {
        run(): void {}
      },
    );
    expect(() => create().wrap(Broken)).toThrow(TypeError);
  });

  it("preserves handler and cleanup failures", async () => {
    const Broken = define(
      "failure-pair",
      class {
        constructor() {
          onDispose(() => {
            throw new Error("cleanup");
          });
        }
        run(): never {
          throw new Error("operation");
        }
      },
    );
    const failure = await create()
      .wrap(Broken)
      .run(undefined)
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(ExecutionFailedError);
    expect(failure).toMatchObject({
      error: { name: "AggregateError", errors: [{ message: "operation" }, { message: "cleanup" }] },
    });
  });

  it("applies execution retry overrides over snapshotted job and manager policies", async () => {
    let attempts = 0;
    const retry = { retries: 1 };
    const Retried = define(
      { name: "precedence", retry },
      class {
        run(): number {
          attempts += 1;
          if (attempts < 3) throw new Error("again");
          return attempts;
        }
      },
    );
    retry.retries = 0;
    await expect(
      create(undefined, { retry: { retries: 0 } })
        .wrap(Retried)
        .run(undefined, { retry: { retries: 2 } }),
    ).resolves.toBe(3);
  });

  it("releases a claim that returns after shutdown without running the handler", async () => {
    const claimed = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    class SlowStore extends MemoryStore {
      override async claim(options: ClaimExecutionOptions): Promise<ClaimedExecution | null> {
        const result = await super.claim(options);
        if (result) {
          claimed.resolve();
          await release.promise;
        }
        return result;
      }
    }
    let runs = 0;
    const Echo = define(
      "slow-claim",
      class {
        run(): void {
          runs += 1;
        }
      },
    );
    const store = new SlowStore();
    const manager = create(store);
    const execution = manager.wrap(Echo).run(undefined);
    await claimed.promise;
    const closing = manager.close();
    release.resolve();
    await closing;
    expect(runs).toBe(0);
    await expect(store.load(execution.id)).resolves.toMatchObject({
      status: "pending",
      activationId: undefined,
    });
  });
});
