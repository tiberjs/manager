import { fork, inject, onDispose, signal, token } from "@tiberjs/runner";
import { afterEach, describe, expect, it } from "vitest";
import {
  DurableGraph,
  DuplicateWorkflowError,
  ExecutionCancelledError,
  ExecutionIdentityConflictError,
  ExecutionFailedError,
  Manager,
  MemoryStore,
  Workflow,
  createManager,
  currentExecution,
} from "../src/index.js";
import type {
  ClaimedNode,
  ClaimNodeOptions,
  ManagerOptions,
  NodeRef,
  WorkflowInput,
  WorkflowOptions,
} from "../src/index.js";

const managers: Manager[] = [];

function create(store = new MemoryStore(), options: Partial<ManagerOptions> = {}): Manager {
  const manager = createManager({
    store,
    concurrency: 2,
    pollIntervalMs: 5,
    leaseDurationMs: 100,
    ...options,
  });
  managers.push(manager);
  return manager;
}

function decorateWorkflow<Value extends new () => object>(
  options: string | WorkflowOptions,
  value: Value,
): void {
  const decorator = typeof options === "string" ? Workflow(options) : Workflow(options);
  decorator(value, {} as ClassDecoratorContext<Value>);
}

function nextTurn(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  return promise;
}

afterEach(async () => {
  await Promise.all(managers.splice(0).map(async (manager) => manager.close()));
});

describe("durable DAG", () => {
  it("runs independent nodes concurrently and passes their results to a dependent node", async () => {
    const bothStarted = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const started = new Set<string>();

    class SearchWeb {
      async run(input: { query: string }): Promise<string> {
        started.add("web");
        if (started.size === 2) {
          bothStarted.resolve();
        }
        await release.promise;
        return `web:${input.query}`;
      }
    }

    class SearchPapers {
      async run(input: { query: string }): Promise<string> {
        started.add("papers");
        if (started.size === 2) {
          bothStarted.resolve();
        }
        await release.promise;
        return `papers:${input.query}`;
      }
    }

    class Summarize {
      run(input: { web: string; papers: string }): string {
        return `${input.web}|${input.papers}`;
      }
    }

    class Research extends DurableGraph<{ query: string }, string> {
      build(input: WorkflowInput<{ query: string }>): NodeRef<string> {
        const web = this.step("web", SearchWeb, input);
        const papers = this.step("papers", SearchPapers, input);
        return this.step("summary", Summarize, { web, papers });
      }
    }
    decorateWorkflow("research", Research);

    const store = new MemoryStore();
    const manager = create(store).register(Research);
    const execution = manager.run(Research, { query: "durable" });

    await bothStarted.promise;
    await expect(execution.status()).resolves.toBe("running");
    release.resolve();

    await expect(execution).resolves.toBe("web:durable|papers:durable");
    expect(await store.load(execution.id)).toMatchObject({
      status: "completed",
      nodes: {
        web: { status: "completed", attempt: 1 },
        papers: { status: "completed", attempt: 1 },
        summary: { status: "completed", attempt: 1 },
      },
    });
  });

  it("retries only the failed node and retains completed upstream results", async () => {
    let prepareRuns = 0;
    let processRuns = 0;

    class Prepare {
      run(input: number): number {
        prepareRuns += 1;
        return input + 1;
      }
    }

    class Process {
      run(input: number): number {
        processRuns += 1;
        if (processRuns === 1) {
          throw new Error("transient");
        }
        return input * 2;
      }
    }

    class RetryNode extends DurableGraph<number, number> {
      build(input: WorkflowInput<number>): NodeRef<number> {
        const prepared = this.step("prepare", Prepare, input);
        return this.step("process", Process, prepared);
      }
    }
    decorateWorkflow({ name: "retry-node", retry: { retries: 1 } }, RetryNode);

    const store = new MemoryStore();
    const manager = create(store).register(RetryNode);
    const execution = manager.run(RetryNode, 20);

    await expect(execution).resolves.toBe(42);
    expect(prepareRuns).toBe(1);
    expect(processRuns).toBe(2);
    expect(await store.load(execution.id)).toMatchObject({
      nodes: {
        prepare: { attempt: 1, failures: 0 },
        process: { attempt: 2, failures: 1 },
      },
    });
  });

  it("fails the workflow and never executes downstream nodes after retry exhaustion", async () => {
    let downstreamRuns = 0;

    class Fail {
      run(): never {
        throw new Error("permanent");
      }
    }

    class Downstream {
      run(input: unknown): unknown {
        downstreamRuns += 1;
        return input;
      }
    }

    class Failure extends DurableGraph<undefined, unknown> {
      build(input: WorkflowInput<undefined>): NodeRef<unknown> {
        const failed = this.step("fail", Fail, input);
        return this.step("downstream", Downstream, failed);
      }
    }
    decorateWorkflow("failure", Failure);

    const manager = create().register(Failure);
    const execution = manager.run(Failure, undefined);
    const failure = await execution.then(
      () => undefined,
      (error) => error,
    );

    expect(failure).toBeInstanceOf(ExecutionFailedError);
    expect(failure).toMatchObject({ error: { message: "permanent" } });
    expect(downstreamRuns).toBe(0);
  });

  it("rejects disconnected nodes when the workflow is registered", () => {
    class Identity {
      run(input: number): number {
        return input;
      }
    }

    class Disconnected extends DurableGraph<number, number> {
      build(input: WorkflowInput<number>): NodeRef<number> {
        this.step("orphan", Identity, input);
        return this.step("output", Identity, input);
      }
    }
    decorateWorkflow("disconnected", Disconnected);

    expect(() => create().register(Disconnected)).toThrow(/disconnected.*orphan/i);
  });
});

describe("recovery and lifecycle", () => {
  it("keeps completed nodes and resumes only unfinished nodes in another manager", async () => {
    const store = new MemoryStore();
    const blocked = Promise.withResolvers<void>();
    let prepareRuns = 0;
    let finishRuns = 0;

    class Prepare {
      run(input: number): number {
        prepareRuns += 1;
        return input + 1;
      }
    }

    class Finish {
      async run(input: number): Promise<number> {
        finishRuns += 1;
        if (finishRuns === 1) {
          blocked.resolve();
          const current = signal();
          const cancelled = Promise.withResolvers<never>();
          current.addEventListener("abort", () => cancelled.reject(current.reason), {
            once: true,
          });
          return cancelled.promise;
        }
        return input * 2;
      }
    }

    class RecoverGraph extends DurableGraph<number, number> {
      build(input: WorkflowInput<number>): NodeRef<number> {
        const prepared = this.step("prepare", Prepare, input);
        return this.step("finish", Finish, prepared);
      }
    }
    decorateWorkflow("recover-graph", RecoverGraph);

    const first = create(store).register(RecoverGraph);
    const original = first.run(RecoverGraph, 20, { key: "recover:20" });
    await blocked.promise;
    await first.close();

    expect(await store.load(original.id)).toMatchObject({
      status: "pending",
      nodes: {
        prepare: { status: "completed", attempt: 1 },
        finish: { status: "ready", attempt: 1 },
      },
    });

    const second = create(store).register(RecoverGraph);
    await second.start();
    const recovered = second.get(RecoverGraph, original.id);

    await expect(recovered).resolves.toBe(42);
    expect(prepareRuns).toBe(1);
    expect(finishRuns).toBe(2);
  });

  it("waits after finding no additional ready work instead of polling continuously", async () => {
    class CountingStore extends MemoryStore {
      claims = 0;

      override async claim(options: ClaimNodeOptions): Promise<ClaimedNode | null> {
        this.claims += 1;
        return super.claim(options);
      }
    }

    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    class Wait {
      async run(): Promise<void> {
        started.resolve();
        await release.promise;
      }
    }
    class SingleNode extends DurableGraph<undefined, void> {
      build(input: WorkflowInput<undefined>): NodeRef<void> {
        return this.step("wait", Wait, input);
      }
    }
    decorateWorkflow("single-node", SingleNode);

    const store = new CountingStore();
    const execution = create(store, { pollIntervalMs: 1_000 })
      .register(SingleNode)
      .run(SingleNode, undefined);
    await started.promise;
    await nextTurn();
    const settledClaims = store.claims;
    await nextTurn();

    expect(store.claims).toBe(settledClaims);
    release.resolve();
    await expect(execution).resolves.toBeUndefined();
  });

  it("propagates cancellation through Runner and waits for the active node to stop", async () => {
    const started = Promise.withResolvers<void>();
    let stopped = false;

    class Wait {
      async run(): Promise<void> {
        const current = signal();
        const cancelled = Promise.withResolvers<void>();
        current.addEventListener(
          "abort",
          () => {
            stopped = true;
            cancelled.reject(current.reason);
          },
          { once: true },
        );
        started.resolve();
        await cancelled.promise;
      }
    }

    class Cancel extends DurableGraph<undefined, void> {
      build(input: WorkflowInput<undefined>): NodeRef<void> {
        return this.step("wait", Wait, input);
      }
    }
    decorateWorkflow("cancel", Cancel);

    const manager = create().register(Cancel);
    const execution = manager.run(Cancel, undefined);
    await started.promise;

    await execution.cancel("not needed");

    await expect(execution).rejects.toBeInstanceOf(ExecutionCancelledError);
    expect(stopped).toBe(true);
    await expect(execution.status()).resolves.toBe("cancelled");
  });

  it("finishes durable cancellation when manager shutdown overlaps node unwinding", async () => {
    const started = Promise.withResolvers<void>();

    class Wait {
      async run(): Promise<void> {
        const current = signal();
        const cancelled = Promise.withResolvers<void>();
        current.addEventListener("abort", () => cancelled.reject(current.reason), { once: true });
        started.resolve();
        await cancelled.promise;
      }
    }

    class CancelDuringClose extends DurableGraph<undefined, void> {
      build(input: WorkflowInput<undefined>): NodeRef<void> {
        return this.step("wait", Wait, input);
      }
    }
    decorateWorkflow("cancel-during-close", CancelDuringClose);

    const store = new MemoryStore();
    const manager = create(store).register(CancelDuringClose);
    const execution = manager.run(CancelDuringClose, undefined);
    const rejection = execution.then(
      () => undefined,
      (error) => error,
    );
    await started.promise;

    await execution.cancel("stop");
    await manager.close();

    await expect(rejection).resolves.toBeInstanceOf(ExecutionCancelledError);
    await expect(store.load(execution.id)).resolves.toMatchObject({ status: "cancelled" });
  });

  it("runs node handlers in a Runner scope with DI, child joining, cleanup, and metadata", async () => {
    const Value = token<number>("test.value");
    let childCompleted = false;
    let disposed = false;
    let observed: ReturnType<typeof currentExecution> | undefined;

    class ManagedNode {
      private readonly value = inject(Value);

      run(input: number): number {
        observed = currentExecution();
        onDispose(() => {
          disposed = true;
        });
        fork(async () => {
          await Promise.resolve();
          childCompleted = true;
        });
        return input + this.value;
      }
    }

    class RunnerNode extends DurableGraph<number, number> {
      build(input: WorkflowInput<number>): NodeRef<number> {
        return this.step("managed", ManagedNode, input);
      }
    }
    decorateWorkflow("runner-node", RunnerNode);

    const manager = create()
      .provide(Value, () => 2)
      .register(RunnerNode);
    const execution = manager.run(RunnerNode, 40);

    await expect(execution).resolves.toBe(42);
    expect(childCompleted).toBe(true);
    expect(disposed).toBe(true);
    expect(observed).toMatchObject({
      executionId: execution.id,
      workflow: "runner-node",
      nodeId: "managed",
      attempt: 1,
    });
  });

  it("deduplicates identical keyed input and rejects conflicting input", async () => {
    let runs = 0;

    class Echo {
      run(input: number): number {
        runs += 1;
        return input;
      }
    }

    class Keyed extends DurableGraph<number, number> {
      build(input: WorkflowInput<number>): NodeRef<number> {
        return this.step("echo", Echo, input);
      }
    }
    decorateWorkflow("keyed", Keyed);

    const manager = create().register(Keyed);
    const first = manager.run(Keyed, 42, { key: "answer" });
    const duplicate = manager.run(Keyed, 42, { key: "answer" });
    const conflict = manager.run(Keyed, 7, { key: "answer" });

    expect(duplicate.id).toBe(first.id);
    await expect(Promise.all([first, duplicate])).resolves.toEqual([42, 42]);
    await expect(conflict).rejects.toBeInstanceOf(ExecutionIdentityConflictError);
    expect(runs).toBe(1);
  });
});

describe("validation and failure boundaries", () => {
  it("validates a registration batch before committing any workflow", async () => {
    class Identity {
      run(input: number): number {
        return input;
      }
    }

    class First extends DurableGraph<number, number> {
      build(input: WorkflowInput<number>): NodeRef<number> {
        return this.step("first", Identity, input);
      }
    }

    class Conflict extends DurableGraph<number, number> {
      build(input: WorkflowInput<number>): NodeRef<number> {
        return this.step("conflict", Identity, input);
      }
    }

    decorateWorkflow("atomic-registration", First);
    decorateWorkflow("atomic-registration", Conflict);

    const manager = create();
    expect(() => manager.register(First, Conflict)).toThrow(DuplicateWorkflowError);
    expect(() => manager.run(First, 42)).toThrow();

    manager.register(First);
    await expect(manager.run(First, 42)).resolves.toBe(42);
  });

  it("rejects invalid reusable retry policy during registration", () => {
    class Identity {
      run(input: number): number {
        return input;
      }
    }

    class InvalidRetry extends DurableGraph<number, number> {
      build(input: WorkflowInput<number>): NodeRef<number> {
        return this.step("identity", Identity, input, { retry: { backoff: 0 } });
      }
    }
    decorateWorkflow("invalid-retry", InvalidRetry);

    expect(() => create().register(InvalidRetry)).toThrow(TypeError);
  });

  it("rejects cyclic step input bindings during graph compilation", () => {
    class Identity {
      run(input: unknown): unknown {
        return input;
      }
    }

    class CyclicInput extends DurableGraph<undefined, unknown> {
      build(_input: WorkflowInput<undefined>): NodeRef<unknown> {
        const binding: { self?: unknown } = {};
        binding.self = binding;
        return this.step("cyclic", Identity, binding);
      }
    }
    decorateWorkflow("cyclic-input", CyclicInput);

    expect(() => create().register(CyclicInput)).toThrow(TypeError);
  });

  it("persists both handler and cleanup failures from a node attempt", async () => {
    const operationFailure = new Error("operation failed");
    const cleanupFailure = new Error("cleanup failed");

    class Broken {
      constructor() {
        onDispose(() => {
          throw cleanupFailure;
        });
      }

      run(): never {
        throw operationFailure;
      }
    }

    class FailurePair extends DurableGraph<undefined, never> {
      build(input: WorkflowInput<undefined>): NodeRef<never> {
        return this.step("broken", Broken, input);
      }
    }
    decorateWorkflow("failure-pair", FailurePair);

    const store = new MemoryStore();
    const execution = create(store).register(FailurePair).run(FailurePair, undefined);
    const rejected = await execution.then(
      () => undefined,
      (error) => error,
    );

    expect(rejected).toBeInstanceOf(ExecutionFailedError);
    expect(rejected).toMatchObject({
      error: {
        name: "AggregateError",
        errors: [{ message: "operation failed" }, { message: "cleanup failed" }],
      },
    });
    await expect(store.load(execution.id)).resolves.toMatchObject({
      status: "failed",
      nodes: { broken: { status: "failed" } },
    });
  });

  it("persists retry precedence from manager through execution overrides", async () => {
    class Identity {
      run(input: number): number {
        return input;
      }
    }

    const nodeRetry = { delayMs: 20 };
    const workflowRetry = { retries: 2 };

    class RetryPrecedence extends DurableGraph<number, number> {
      build(input: WorkflowInput<number>): NodeRef<number> {
        return this.step("identity", Identity, input, { retry: nodeRetry });
      }
    }
    decorateWorkflow({ name: "retry-precedence", retry: workflowRetry }, RetryPrecedence);
    workflowRetry.retries = 99;

    const store = new MemoryStore();
    const manager = create(store, {
      autoStart: false,
      retry: { retries: 1, delayMs: 10, backoff: 2, maxDelayMs: 100 },
    }).register(RetryPrecedence);
    nodeRetry.delayMs = 999;
    const execution = manager.run(RetryPrecedence, 42, { retry: { backoff: 3 } });

    await expect(execution.status()).resolves.toBe("pending");
    await expect(store.load(execution.id)).resolves.toMatchObject({
      nodes: {
        identity: {
          retry: { retries: 2, delayMs: 20, backoff: 3, maxDelayMs: 100 },
        },
      },
    });
  });

  it("snapshots declared object inputs when the workflow is registered", async () => {
    const configuration = { offset: 1 };

    class AddOffset {
      run(input: { value: number; configuration: { offset: number } }): number {
        return input.value + input.configuration.offset;
      }
    }

    class Snapshot extends DurableGraph<number, number> {
      build(input: WorkflowInput<number>): NodeRef<number> {
        return this.step("add", AddOffset, { value: input, configuration });
      }
    }
    decorateWorkflow("snapshot", Snapshot);

    const manager = create().register(Snapshot);
    configuration.offset = 100;

    await expect(manager.run(Snapshot, 41)).resolves.toBe(42);
  });

  it("supports step IDs that overlap object prototype property names", async () => {
    class Identity {
      run(input: number): number {
        return input;
      }
    }

    class PrototypeNamed extends DurableGraph<number, number> {
      build(input: WorkflowInput<number>): NodeRef<number> {
        return this.step("__proto__", Identity, input);
      }
    }
    decorateWorkflow("prototype-named", PrototypeNamed);

    const store = new MemoryStore();
    const execution = create(store).register(PrototypeNamed).run(PrototypeNamed, 42);

    await expect(execution).resolves.toBe(42);
    const persisted = await store.load(execution.id);
    expect(Object.hasOwn(persisted?.nodes ?? {}, "__proto__")).toBe(true);
  });
});
