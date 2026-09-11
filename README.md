# TiberJS manager

A pnpm workspace of three independently published packages built on [Runner](https://github.com/tiberjs/runner).

| Package                                  | Purpose                                                                                   |
| ---------------------------------------- | ----------------------------------------------------------------------------------------- |
| [`@tiberjs/durable`](packages/durable)   | Run Runner handlers as durable jobs with retries, cancellation, and optional checkpoints. |
| [`@tiberjs/di`](packages/di)             | Hierarchical dependency container that constructs, caches, and disposes what it owns.     |
| [`@tiberjs/eventbus`](packages/eventbus) | Typed, synchronous, in-process notifications.                                             |

All three require **Node.js 24+** and compiled TypeScript with standard decorators (for example, `target: "ES2023"` and `module: "NodeNext"`), not legacy `experimentalDecorators`. Node does not run decorator syntax directly. `@tiberjs/durable` uses `@tiberjs/runner` `^0.1.1`; `@tiberjs/di` and `@tiberjs/eventbus` use `^0.2.0`, which is not published yet and resolves to the packed artifact in `vendor/` inside this workspace.

## `@tiberjs/durable`

Run Runner handlers as jobs with retries, cancellation, and optional checkpoints. Use ordinary classes, branches, and loops—no workflow base class or graph definition.

**Storage:** the included `MemoryStore` is in-memory only. Jobs survive process restarts only with a durable [`ExecutionStore`](packages/durable/src/persistence/store.ts) implementation; this package does not ship one yet.

### Installation

```sh
pnpm add @tiberjs/durable @tiberjs/runner
```

### Quick start

Add `@Job` to a class with a `run(input)` method, then wrap it with a manager:

```ts
import { forkGroup } from "@tiberjs/runner";
import { Job, MemoryStore, createManager } from "@tiberjs/durable";

@Job({ name: "research:v1", retry: { retries: 3, delayMs: 250 } })
class Research {
  async run(input: { query: string }): Promise<string> {
    const results = await forkGroup(
      () => Promise.resolve(`web:${input.query}`),
      () => Promise.resolve(`papers:${input.query}`),
    );
    return results.join("\n");
  }
}

await using manager = createManager({ store: new MemoryStore(), concurrency: 8 });
const research = manager.wrap(Research);
const execution = research.run({ query: "structured concurrency" }, { key: "research:42" });

console.log(execution.id);
console.log(await execution);
```

`wrap()` registers the handler and infers its input and result types. `run()` starts the local worker automatically; `concurrency` limits the number of active jobs. Each attempt creates a fresh handler in a Runner scope, so Runner DI, child tasks, and cleanup work as usual.

### Manage executions

The value returned by `run()` is an awaitable `Execution<T>`, with an ID and controls:

| Operation                          | Purpose                                                                         |
| ---------------------------------- | ------------------------------------------------------------------------------- |
| `await execution`                  | Wait for the result; reject if the job fails or is cancelled.                   |
| `await execution.status()`         | Read `pending`, `running`, `cancelling`, `completed`, `failed`, or `cancelled`. |
| `await execution.cancel(reason)`   | Request cancellation.                                                           |
| `await research.get(execution.id)` | Retrieve the result of an existing execution.                                   |

The optional `key` prevents duplicate submissions within a job name. Submitting the same key and input joins the existing execution; different input raises `ExecutionIdentityConflictError`. Input is snapshotted at submission and compared by serialized representation, so keep input schemas and field ordering stable.

#### Retries

`retries: 3` permits the initial attempt plus three retries. Set defaults on the manager, override them in `@Job`, or override them for one execution:

```ts
const result = await research.run(
  { query: "structured concurrency" },
  { retry: { retries: 5, delayMs: 1_000 } },
);
```

Retry fields are merged in that order. Failed attempts and expired worker leases consume retry budget; graceful shutdown does not. Without checkpoints, every retry runs the entire handler again.

### Keep completed work with checkpoints

Inject `DurableExecution` and wrap an operation in `checkpoint(key, input, operation)`. On retry, a completed checkpoint returns its stored result instead of repeating the operation:

```ts
import { inject, signal } from "@tiberjs/runner";
import { DurableExecution, Job } from "@tiberjs/durable";

@Job({ name: "page-length:v1", retry: { retries: 2 } })
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

#### Recovery limits

Recovery starts at the beginning of the handler and reuses completed checkpoint results. It does **not** restore JavaScript locals, stacks, or running tasks. Code outside checkpoints runs again; put external effects and nondeterministic decisions inside checkpoints.

External effects are **at least once**, not exactly once: an operation can succeed before its result is saved. For writes to external services, use an idempotency key derived from the execution ID and checkpoint key, or a coordinated transaction. `currentExecution()` exposes the execution ID inside a job.

Use a new job name, such as `page-length:v2`, for incompatible handler or checkpoint changes, and keep old handlers registered until their jobs drain. Durable timers, signals, and detached child jobs are not supported.

### Workers and shutdown

Every worker must register the handlers it can execute. For a dedicated worker, disable automatic startup and start it explicitly:

```ts
await using worker = createManager({ store, autoStart: false, concurrency: 8 });
worker.register(Research, PageLength);
await worker.start();
// Keep this scope open for the worker's lifetime.
```

Here, `store` is your `ExecutionStore` implementation. Workers in separate processes need shared durable storage. `get()` retrieves existing work but does not start a worker.

Configure dependencies with `manager.provide(Token, factory)` before starting jobs. Cancellation is cooperative: pass Runner's `signal()` to APIs such as `fetch`. A job remains `cancelling` until its attempt unwinds.

`await manager.close()`—also called by `await using`—stops claiming jobs, cancels and joins local attempts, and releases unfinished jobs for recovery while preserving checkpoints and retry budget. A process crash cannot run cleanup.

## `@tiberjs/di`

A container builds objects, caches each one for the container that constructed it, and disposes the resources it owns. It runs nothing: no jobs, no cancellation, no events, and no startup phase.

```sh
pnpm add @tiberjs/di @tiberjs/runner
```

```ts
import { Container, inject, onDispose, token } from "@tiberjs/di";

const Config = token<{ url: string }>("config");

class Db {
  readonly config = inject(Config);

  constructor() {
    onDispose(() => this.close());
  }

  close(): void {}
}

await using container = new Container();
container.provide(Config, () => ({ url: "postgres://localhost" }));

const db = container.resolve(Db);
console.log(db.config.url);
```

- `token<T>(description)` creates a typed token for a value that needs a factory. A class is its own token and is default-constructed when no provider is registered.
- `provide(token, factory)` registers a factory; the factory receives the resolving container.
- `resolve(token)` constructs on first use and returns the cached instance afterwards. A resolution cycle is reported as an error naming the participating tokens.
- `inject(token)` resolves from the container that is currently constructing—typically in a field initializer or constructor body—so classes stay free of container plumbing.
- `child()` creates a container that sees its parent's providers. A token is built and cached by the nearest container that provides it—a class with no provider ends up at the root—so a child owns, and disposes, only what it provides itself. A child never mutates its parent.
- `onDispose(cleanup)` registers cleanup on the container constructing the current object. Disposal is LIFO over that container's own resources, runs once, and never reaches into a parent or a sibling.
- `await using`—or `await container[Symbol.asyncDispose]()`—disposes the container. Independent cleanup failures are reported together; afterwards every use raises `ContainerClosedError`.

There is no startup or readiness barrier: DI never eagerly instantiates, never orders initialization for you, and has no `start()`. Order initialization yourself with ordinary awaited code before the work that depends on it, and run anything long-lived in your own Runner job.

## `@tiberjs/eventbus`

Typed notifications between components in one process. A bus is an object you own, not a global.

```sh
pnpm add @tiberjs/eventbus @tiberjs/runner
```

```ts
import { EventBus, eventKey } from "@tiberjs/eventbus";

const UserCreated = eventKey<{ id: string }>("user.created");

using bus = new EventBus({ onError: (error, { event }) => void console.error(event, error) });

const controller = new AbortController();
bus.on(UserCreated, (user) => void console.log("welcome", user.id), {
  signal: controller.signal,
});

bus.emit(UserCreated, { id: "u1" });
console.log(bus.hasListeners(UserCreated)); // true

controller.abort(); // or call the unsubscribe function returned by on()
```

- `eventKey<T>(description)` creates the event identity and fixes its payload type. Two keys with the same description are still different events.
- `on(key, listener, options?)` subscribes in delivery order and returns an idempotent unsubscribe function. Passing `signal` unsubscribes on abort; an already-aborted signal subscribes nothing.
- `emit(key, event)` returns `void`. `hasListeners(key)` reports whether anyone is subscribed.
- `close()`—also called by `using`—clears every subscription. It is synchronous and idempotent; afterwards `on` and `emit` throw Runner's `LifecycleStateError`, and `hasListeners` reports `false`.

**Delivery is synchronous.** `emit` calls each listener inline on the publisher's stack and returns when the last one returns. There is no queue, no flush, and no async listener: a listener runs in the publisher's Runner context, so `use()` and `signal()` inside it observe the emitting execution. `emit` works on a snapshot of the subscribers, so subscribing or unsubscribing during delivery affects later emissions only.

Anything that must await, retry, or outlive the publisher belongs in a caller-owned Runner job—fork it from the listener instead of making the listener async:

```ts
import { fork } from "@tiberjs/runner";

bus.on(UserCreated, (user) => void fork(() => sendWelcomeEmail(user.id)));
```

`fork` needs an active Runner job, and the listener has one whenever the publisher emits from inside a job. The bus itself never starts, joins, or awaits anything.

A listener that throws never stops the other listeners and never changes the publisher's result. Failures from one `emit` are collected and reported once to `onError`, or surfaced as an unhandled error when no reporter is configured.

## Development

Commands run from the workspace root:

```sh
pnpm install --frozen-lockfile
pnpm format
pnpm check
pnpm build
pnpm test
```

Run one package's suite with `pnpm test --project @tiberjs/di`.
