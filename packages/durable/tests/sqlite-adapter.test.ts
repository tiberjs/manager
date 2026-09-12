import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inject, onDispose } from "@tiberjs/di";
import { signal } from "@tiberjs/runner";
import { afterEach, describe, expect, test } from "vitest";
import {
  CheckpointContext,
  DurableJob,
  Manager,
  SQLiteAdapter,
  createManager,
  currentExecution,
  replayExecutionLedger,
} from "../src/index.js";
import type { DurableJobConstructor, DurableJobOptions } from "../src/index.js";

const managers: Manager[] = [];
const adapters: SQLiteAdapter[] = [];
const directories: string[] = [];

async function databasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "tiberjs-durable-"));
  directories.push(directory);
  return join(directory, "executions.sqlite");
}

function adapter(path: string): SQLiteAdapter {
  const store = new SQLiteAdapter(path);
  adapters.push(store);
  return store;
}

function manager(store: SQLiteAdapter, autoStart = true): Manager {
  const instance = createManager({
    store,
    autoStart,
    pollIntervalMs: 1,
    leaseDurationMs: 1_000,
  });
  managers.push(instance);
  return instance;
}

function untilAborted(): Promise<never> {
  const current = signal();
  current.throwIfAborted();
  const deferred = Promise.withResolvers<never>();
  current.addEventListener("abort", () => deferred.reject(current.reason), { once: true });
  return deferred.promise;
}

function define<Value extends DurableJobConstructor>(
  options: string | DurableJobOptions,
  type: Value,
): Value {
  // The decorator ignores context; direct invocation keeps this runtime test parser-independent.
  const context = {} as ClassDecoratorContext<Value>;
  DurableJob(options)(type, context);
  return type;
}

afterEach(async () => {
  await Promise.all(managers.splice(0).map(async (value) => await value.close()));
  for (const value of adapters.splice(0)) value.close();
  await Promise.all(directories.splice(0).map(async (path) => await rm(path, { recursive: true })));
});

describe("SQLiteAdapter", () => {
  test("reopens a released execution and replays its completed checkpoint", async () => {
    const path = await databasePath();
    const firstAttemptBlocked = Promise.withResolvers<void>();
    let attempts = 0;
    let effects = 0;
    let constructions = 0;
    let disposals = 0;

    const Recovery = define(
      { name: "sqlite-recovery", retry: { retries: 1 } },
      class {
        private readonly checkpoints = inject(CheckpointContext);

        constructor() {
          constructions += 1;
          onDispose(() => {
            disposals += 1;
          });
        }

        async run(): Promise<number> {
          attempts += 1;
          const value = await this.checkpoints.checkpoint("stable", null, () => {
            effects += 1;
            return 21;
          });
          if (currentExecution().attempt === 1) {
            firstAttemptBlocked.resolve();
            await untilAborted();
          }
          return value * 2;
        }
      },
    );

    const firstStore = adapter(path);
    const firstManager = manager(firstStore);
    const execution = firstManager.wrap(Recovery).run(undefined);
    await firstAttemptBlocked.promise;
    await firstManager.close();
    firstStore.close();

    const secondStore = adapter(path);
    const secondManager = manager(secondStore, false);
    const recovery = secondManager.wrap(Recovery).get(execution.id);
    await secondManager.start();

    await expect(recovery).resolves.toBe(42);
    expect({ attempts, effects, constructions, disposals }).toEqual({
      attempts: 2,
      effects: 1,
      constructions: 2,
      disposals: 2,
    });
    const persisted = await secondStore.load(execution.id);
    expect(persisted).toMatchObject({
      projection: { status: "completed", attempt: 2, failures: 0, result: 42 },
      checkpoints: { stable: { status: "completed", result: 21 } },
    });
    expect(persisted?.activation).toBeUndefined();
    const history = await recovery.history();
    expect(history.map(({ event }) => event.type)).toEqual([
      "execution-submitted",
      "attempt-started",
      "checkpoint-declared",
      "checkpoint-completed",
      "attempt-released",
      "attempt-started",
      "execution-completed",
    ]);
    expect(replayExecutionLedger(history)).toMatchObject({
      projection: { status: "completed", attempt: 2, failures: 0, result: 42 },
      checkpoints: { stable: { status: "completed", result: 21 } },
    });
  });

  test("coordinates exclusive claims and fences a stale connection", async () => {
    const path = await databasePath();

    const Echo = define(
      { name: "sqlite-fencing", retry: { retries: 1 } },
      class {
        run(input: number): number {
          return input;
        }
      },
    );

    const first = adapter(path);
    const admission = manager(first, false).wrap(Echo).run(42);
    await expect(admission.status()).resolves.toBe("pending");
    const now = Date.now();
    const stale = await first.claim({
      workerId: "first",
      jobs: ["sqlite-fencing"],
      now,
      leaseExpiresAt: now + 10,
    });
    if (!stale) throw new Error("Expected the first SQLite claim.");

    const second = adapter(path);
    await expect(
      second.claim({
        workerId: "second",
        jobs: ["sqlite-fencing"],
        now: now + 1,
        leaseExpiresAt: now + 20,
      }),
    ).resolves.toBeNull();
    await expect(
      second.heartbeat(
        { executionId: admission.id, activationId: stale.activationId, now: now + 1 },
        "first",
        now + 20,
      ),
    ).resolves.toBe("renewed");
    expect((await second.readEvents(admission.id)).map(({ event }) => event.type)).toEqual([
      "execution-submitted",
      "attempt-started",
    ]);

    await expect(second.recoverExpired(now + 20)).resolves.toBe(1);
    const fresh = await second.claim({
      workerId: "second",
      jobs: ["sqlite-fencing"],
      now: now + 20,
      leaseExpiresAt: now + 100,
    });
    if (!fresh) throw new Error("Expected the recovered SQLite claim.");
    await expect(
      first.complete(
        { executionId: admission.id, activationId: stale.activationId, now: now + 21 },
        "stale",
      ),
    ).resolves.toBe(false);
    await expect(
      second.complete(
        { executionId: admission.id, activationId: fresh.activationId, now: now + 21 },
        "fresh",
      ),
    ).resolves.toBe(true);
  });

  test("persists cancellation history across reopen", async () => {
    const path = await databasePath();

    const NeverRun = define(
      "sqlite-cancellation",
      class {
        run(): never {
          throw new Error("must not run");
        }
      },
    );

    const firstStore = adapter(path);
    const firstManager = manager(firstStore, false);
    const execution = firstManager.wrap(NeverRun).run(undefined);
    await execution.cancel("not needed");
    await expect(execution.status()).resolves.toBe("cancelled");
    firstStore.close();

    const secondStore = adapter(path);
    const secondManager = manager(secondStore, false);
    const reopened = secondManager.wrap(NeverRun).get(execution.id);
    await expect(reopened.status()).resolves.toBe("cancelled");
    expect((await reopened.history()).map(({ event }) => event.type)).toEqual([
      "execution-submitted",
      "cancellation-requested",
      "execution-cancelled",
    ]);
  });
});
