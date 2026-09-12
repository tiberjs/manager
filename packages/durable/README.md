# @tiberjs/durable

Run [Runner](https://github.com/tiberjs/runner) handlers as durable jobs: submit work by logical identity, let it retry after a crash, cancel it while it runs, and keep completed steps with checkpoints. Jobs are ordinary classes with branches and loops — there is no workflow base class and no graph to declare.

Requires **Node.js 24+** and TypeScript compiled with standard decorators (for example `target: "ES2023"`, `module: "NodeNext"`), not legacy `experimentalDecorators`. Node does not run decorator syntax directly.

**Storage:** the included `MemoryStore` is in-memory only. Jobs survive process restarts only with a durable [`ExecutionStore`](src/persistence/store.ts) implementation; this package does not ship one yet.

## Installation

```sh
pnpm add @tiberjs/durable @tiberjs/di @tiberjs/runner
```

## Quick start

Add `@DurableJob` to a class with a `run(input)` method, then wrap it with a manager:

```ts
import { fork } from "@tiberjs/runner";
import { DurableJob, MemoryStore, createManager } from "@tiberjs/durable";

@DurableJob({ name: "research:v1", retry: { retries: 3, delayMs: 250 } })
class Research {
  async run(input: { query: string }): Promise<string> {
    const results = await Promise.all([
      fork(() => Promise.resolve(`web:${input.query}`)),
      fork(() => Promise.resolve(`papers:${input.query}`)),
    ]);
    return results.join("\n");
  }
}

await using manager = createManager({ store: new MemoryStore(), concurrency: 8 });
const research = manager.wrap(Research);
const execution = research.run({ query: "structured concurrency" }, { key: "research:42" });

console.log(execution.id);
console.log(await execution);
```

`wrap()` registers the handler and infers its input and result types. `run()` starts the local worker automatically; `concurrency` limits the number of active jobs. Each attempt owns a fresh DI container for its handler and manager-provided dependencies. Runner owns its execution context, cancellation, and descendants; container cleanup completes before the result is committed.

### Execution model

| Concept         | Lifetime and owner                                                                                               |
| --------------- | ---------------------------------------------------------------------------------------------------------------- |
| `@DurableJob`   | Reconstructable handler definition registered in every worker; its stable name is the persisted identity.        |
| `Execution<T>`  | Store-backed logical run that can span process restarts and multiple attempts.                                   |
| Runner `Job<T>` | Process-local structured-concurrency boundary for one attempt, forked operation, or checkpoint; never persisted. |
| DI `Container`  | Fresh for one attempt; owns the handler, resolved providers, and LIFO cleanup.                                   |

After a worker claims an execution, it starts the lease heartbeat and creates one Runner Job with the claim's abort signal. The Job attachment carries durable execution metadata, while `ContainerKey` binds the attempt container to the Job and every descendant. Runner joins the handler's child Jobs first; durable then disposes the container inside the captured Runner context, stops the heartbeat, and finally performs the fenced completion, failure, cancellation acknowledgement, or shutdown release.

## Manage executions

The value returned by `run()` is an awaitable `Execution<T>`, with an ID and controls:

| Operation                          | Purpose                                                                         |
| ---------------------------------- | ------------------------------------------------------------------------------- |
| `await execution`                  | Wait for the result; reject if the job fails or is cancelled.                   |
| `await execution.status()`         | Read `pending`, `running`, `cancelling`, `completed`, `failed`, or `cancelled`. |
| `await execution.cancel(reason)`   | Request cancellation.                                                           |
| `await research.get(execution.id)` | Retrieve the result of an existing execution.                                   |

The optional `key` prevents duplicate submissions within a job name. Submitting the same key and input joins the existing execution; different input raises `ExecutionIdentityConflictError`. Input is snapshotted at submission and compared by serialized representation, so keep input schemas and field ordering stable.

### Retries

`retries: 3` permits the initial attempt plus three retries. Set defaults on the manager, override them in `@DurableJob`, or override them for one execution:

```ts
const result = await research.run(
  { query: "structured concurrency" },
  { retry: { retries: 5, delayMs: 1_000 } },
);
```

Retry fields are merged in that order. Failed attempts and expired worker leases consume retry budget; graceful shutdown does not. Without checkpoints, every retry runs the entire handler again.

## Keep completed work with checkpoints

Inject `DurableExecution` and wrap an operation in `checkpoint(key, input, operation)`. On retry, a completed checkpoint returns its stored result instead of repeating the operation:

```ts
import { inject } from "@tiberjs/di";
import { signal } from "@tiberjs/runner";
import { DurableExecution, DurableJob } from "@tiberjs/durable";

@DurableJob({ name: "page-length:v1", retry: { retries: 2 } })
class PageLength {
  readonly durable = inject(DurableExecution);

  async run(input: { url: string }): Promise<number> {
    const page = await this.durable.checkpoint("fetch-page", input, async () => {
      const response = await fetch(input.url, { signal: signal() });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.text();
    });

    return page.length;
  }
}
```

Run `PageLength` with `manager.wrap(PageLength).run({ url })`, just like the first example.

- Use stable keys within each job. In loops, include a turn or item ID.
- Include all changing operation arguments in checkpoint input. Reusing a key with different input raises `CheckpointIdentityConflictError`.
- Await checkpoints and keep them unnested. Put branches, loops, and parallel orchestration in the handler.
- Inputs and results must support structured cloning and the store's serialization format.

A genuine failure that escapes a checkpoint operation fails the current Runner attempt, even if the handler catches the returned Job's rejection. Put same-attempt retry or fallback logic inside the operation; a durable retry starts the handler again in a new attempt. Cancelling only the checkpoint Job releases its reservation without turning that cancellation into a genuine attempt failure.

### Recovery limits

Recovery starts at the beginning of the handler and reuses completed checkpoint results. It does **not** restore JavaScript locals, stacks, or running tasks. Code outside checkpoints runs again; put external effects and nondeterministic decisions inside checkpoints.

External effects are **at least once**, not exactly once: an operation can succeed before its result is saved. For writes to external services, use an idempotency key derived from the execution ID and checkpoint key, or a coordinated transaction. `currentExecution()` exposes the execution ID inside a job.

Use a new job name, such as `page-length:v2`, for incompatible handler or checkpoint changes, and keep old handlers registered until their jobs drain. Durable timers, signals, and detached child jobs are not supported.

## Workers and shutdown

Every worker must register the handlers it can execute. For a dedicated worker, disable automatic startup and start it explicitly:

```ts
await using worker = createManager({ store, autoStart: false, concurrency: 8 });
worker.register(Research, PageLength);
await worker.start();
// Keep this scope open for the worker's lifetime.
```

Here, `store` is your `ExecutionStore` implementation. Workers in separate processes need shared durable storage. `get()` retrieves existing work but does not start a worker.

Configure attempt-local dependencies with `manager.provide(Token, factory)` using tokens from `@tiberjs/di` before starting jobs. Cancellation is cooperative: pass Runner's `signal()` to APIs such as `fetch`. A job remains `cancelling` until its attempt unwinds.

`await manager.close()` — also called by `await using` — stops claiming jobs, cancels and joins local attempts, and releases unfinished jobs for recovery while preserving checkpoints and retry budget. A process crash cannot run cleanup.
