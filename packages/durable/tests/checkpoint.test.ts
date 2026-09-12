import { inject } from "@tiberjs/di";
import { execute, fork, signal } from "@tiberjs/runner";
import { afterEach, describe, expect, it } from "vitest";
import { DurableExecution, Job, Manager, MemoryStore, currentExecution } from "../src/index.js";
import type { BeginCheckpointResult, CheckpointMutation, JobConstructor } from "../src/index.js";

const managers: Manager[] = [];
function wrap<Value extends JobConstructor>(type: Value, store = new MemoryStore()) {
  Job("checkpoint-test")(type, {} as ClassDecoratorContext<Value>);
  const manager = new Manager({ store, pollIntervalMs: 2, leaseDurationMs: 1000 });
  managers.push(manager);
  return manager.wrap(type);
}
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.close()));
});

describe("durable checkpoints", () => {
  it("returns persisted results to concurrent joiners despite mutation by the first consumer", async () => {
    let calls = 0;
    const execution = wrap(
      class {
        readonly durable = inject(DurableExecution);
        async run(): Promise<number> {
          const first = this.durable.checkpoint("shared", null, () => {
            calls += 1;
            return { value: 42 };
          });
          const mutated = first.then((value) => {
            value.value = 99;
          });
          const joined = this.durable.checkpoint("shared", null, () => {
            calls += 1;
            return { value: -1 };
          });
          await mutated;
          return (await joined).value;
        }
      },
    ).run(undefined);
    await expect(execution).resolves.toBe(42);
    expect(calls).toBe(1);
  });

  it("releases a reservation when cancellation wins while beginCheckpoint is pending", async () => {
    const reserved = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    class ReservationGate extends MemoryStore {
      delayed = false;
      override async beginCheckpoint(mutation: CheckpointMutation): Promise<BeginCheckpointResult> {
        const outcome = await super.beginCheckpoint(mutation);
        if (!this.delayed) {
          this.delayed = true;
          reserved.resolve();
          await release.promise;
        }
        return outcome;
      }
    }
    let effects = 0;
    const execution = wrap(
      class {
        readonly durable = inject(DurableExecution);
        async run(): Promise<number> {
          const first = this.durable.checkpoint("reserved", null, () => {
            effects += 1;
            return 0;
          });
          const rejected = first.then(
            () => undefined,
            (error: unknown) => error,
          );
          await reserved.promise;
          first.cancel("cancel one task");
          release.resolve();
          await rejected;
          return this.durable.checkpoint("reserved", null, () => {
            effects += 1;
            return 42;
          });
        }
      },
      new ReservationGate(),
    ).run(undefined);
    await expect(execution).resolves.toBe(42);
    expect(effects).toBe(1);
  });

  it("rebuilds a dynamic agent loop from persisted model and tool results", async () => {
    let modelCalls = 0;
    let toolCalls = 0;
    let handlerRuns = 0;
    const execution = wrap(
      class {
        readonly durable = inject(DurableExecution);
        async run(): Promise<number> {
          handlerRuns += 1;
          let value = 0;
          for (let turn = 0; turn < 3; turn += 1) {
            const plan = await this.durable.checkpoint(`model:${turn}`, { turn, value }, () => {
              modelCalls += 1;
              return { tool: "add", amount: turn + 1 };
            });
            value = await this.durable.checkpoint(
              `tool:${turn}:${plan.tool}`,
              { value, plan },
              () => {
                toolCalls += 1;
                return value + plan.amount;
              },
            );
            if (turn === 1 && currentExecution().attempt === 1)
              throw new Error("crash after committed tool");
          }
          return value;
        }
      },
    ).run(undefined, { retry: { retries: 1 } });
    await expect(execution).resolves.toBe(6);
    expect([handlerRuns, modelCalls, toolCalls]).toEqual([2, 3, 3]);
  });

  it("keeps checkpoint identity after failure and rejects changed input on retry", async () => {
    let effects = 0;
    const execution = wrap(
      class {
        readonly durable = inject(DurableExecution);
        async run(): Promise<number> {
          return this.durable.checkpoint("effect", currentExecution().attempt, () => {
            effects += 1;
            throw new Error("uncertain effect");
          });
        }
      },
    ).run(undefined, { retry: { retries: 1 } });
    await expect(execution).rejects.toMatchObject({
      error: { name: "CheckpointIdentityConflictError" },
    });
    expect(effects).toBe(1);
  });

  it("deduplicates concurrent equal keys while allowing independent parallel effects", async () => {
    let sameCalls = 0;
    const both = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let active = 0;
    const execution = wrap(
      class {
        readonly durable = inject(DurableExecution);
        async run(): Promise<number[]> {
          const operation = async (): Promise<number> => {
            sameCalls += 1;
            active += 1;
            if (active === 2) both.resolve();
            await release.promise;
            return 21;
          };
          return Promise.all([
            this.durable.checkpoint("same", 1, operation),
            this.durable.checkpoint("same", 1, operation),
            this.durable.checkpoint("other", 1, operation),
          ]);
        }
      },
    ).run(undefined);
    await both.promise;
    release.resolve();
    await expect(execution).resolves.toEqual([21, 21, 21]);
    expect(sameCalls).toBe(2);
  });

  it("replays undefined and prototype-named keys without repeating effects", async () => {
    let calls = 0;
    await expect(
      wrap(
        class {
          readonly durable = inject(DurableExecution);
          async run(): Promise<undefined> {
            const operation = (): undefined => {
              calls += 1;
              return undefined;
            };
            await this.durable.checkpoint("__proto__", null, operation);
            return this.durable.checkpoint("__proto__", null, operation);
          }
        },
      ).run(undefined),
    ).resolves.toBeUndefined();
    expect(calls).toBe(1);
  });

  it("does not expose persisted results to mutations of returned values", async () => {
    await expect(
      wrap(
        class {
          readonly durable = inject(DurableExecution);
          async run(): Promise<number> {
            const result = await this.durable.checkpoint("value", null, () => ({ count: 42 }));
            result.count = 100;
            return (await this.durable.checkpoint("value", null, () => ({ count: -1 }))).count;
          }
        },
      ).run(undefined),
    ).resolves.toBe(42);
  });

  it("joins checkpoint-local forks and refuses to commit their unobserved failures", async () => {
    let operations = 0;
    const store = new MemoryStore();
    const execution = wrap(
      class {
        readonly durable = inject(DurableExecution);
        async run(): Promise<number> {
          return this.durable.checkpoint("child", null, () => {
            operations += 1;
            fork(() => {
              if (operations === 1) throw new Error("child failed");
            });
            return 42;
          });
        }
      },
      store,
    ).run(undefined, { retry: { retries: 1 } });
    await expect(execution).resolves.toBe(42);
    expect(operations).toBe(2);
    await expect(store.load(execution.id)).resolves.toMatchObject({
      checkpoints: { child: { status: "completed", result: 42 } },
    });
  });

  it("does not hide an unawaited checkpoint failure from the job boundary", async () => {
    const failed = Promise.withResolvers<void>();
    const execution = wrap(
      class {
        readonly durable = inject(DurableExecution);
        async run(): Promise<void> {
          this.durable.checkpoint("unobserved", null, () => {
            failed.resolve();
            throw new Error("unobserved failure");
          });
          await failed.promise;
        }
      },
    ).run(undefined);
    await expect(execution).rejects.toMatchObject({ error: { message: "unobserved failure" } });
  });

  it("retries a rejected checkpoint in a new attempt even when the handler catches it", async () => {
    let handlerRuns = 0;
    let calls = 0;
    const execution = wrap(
      class {
        readonly durable = inject(DurableExecution);
        async run(): Promise<number> {
          handlerRuns += 1;
          try {
            return await this.durable.checkpoint("try", 21, () => {
              calls += 1;
              if (currentExecution().attempt === 1) {
                throw new Error("temporary");
              }
              return 42;
            });
          } catch {
            // A genuine child failure has already failed this Runner attempt.
            return -1;
          }
        }
      },
    ).run(undefined, { retry: { retries: 1 } });
    await expect(execution).resolves.toBe(42);
    expect([handlerRuns, calls]).toEqual([2, 2]);
  });

  it("prevents recursive checkpoint operations rather than deadlocking on their reservation", async () => {
    const execution = wrap(
      class {
        readonly durable = inject(DurableExecution);
        async run(): Promise<number> {
          return this.durable.checkpoint("recursive", null, () =>
            this.durable.checkpoint("recursive", null, () => 42),
          );
        }
      },
    ).run(undefined);
    await expect(execution).rejects.toMatchObject({ error: { name: "TypeError" } });
  });

  it("cancels in-flight effects without recording success", async () => {
    const started = Promise.withResolvers<void>();
    const store = new MemoryStore();
    const execution = wrap(
      class {
        readonly durable = inject(DurableExecution);
        async run(): Promise<number> {
          return this.durable.checkpoint("cancel", null, async () => {
            const aborted = Promise.withResolvers<void>();
            signal().addEventListener("abort", () => aborted.resolve(), { once: true });
            started.resolve();
            await aborted.promise;
            return 42;
          });
        }
      },
      store,
    ).run(undefined);
    const rejected = expect(execution).rejects.toMatchObject({ name: "ExecutionCancelledError" });
    await started.promise;
    await execution.cancel();
    await rejected;
    await expect(store.load(execution.id)).resolves.toMatchObject({
      status: "cancelled",
      checkpoints: { cancel: { status: "running", activationId: undefined } },
    });
  });

  it("rejects durable metadata access inside an unrelated Runner execution", async () => {
    await expect(
      execute({ signal: new AbortController().signal, attachment: undefined }, () =>
        currentExecution(),
      ),
    ).rejects.toBeInstanceOf(Error);
  });
});
