# @tiberjs/manager

Durable job management around `@tiberjs/runner`, with optional dynamic checkpoints. No graph declaration or workflow base class is required.

Manager persists logical job identity, input, result, retries, cancellation, leases, and checkpoint records. Each attempt reconstructs the registered handler inside a fresh Runner execution. Runner owns DI, child tasks, cancellation signals, and cleanup.

**MemoryStore does not survive process restart.** It is the clone-isolated reference adapter. Production durability requires an `ExecutionStore` backed by durable storage; this package does not yet ship one.

## Installation

```sh
pnpm add @tiberjs/manager @tiberjs/runner
```

Use Node.js 24 or newer.

## Wrap a Runner handler

```ts
import { forkGroup } from "@tiberjs/runner";
import { Job, MemoryStore, createManager } from "@tiberjs/manager";

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
const research = manager.wrap(Research); // registers code without constructing the handler
const execution = research.run({ query: "structured concurrency" }, { key: "research:42" });
const report = await execution;
const sameReport = await research.get(execution.id);
```

`@Job` is a standard TC39 class decorator. Classes need only a `run(input)` method; input and awaited output types are inferred. Parameterless handlers receive `undefined` through `run(undefined)`.

Compile decorators before running on Node (for example, TypeScript with `target: "ES2023"` and `module: "NodeNext"`). Node 24 does not execute decorator syntax directly; do not enable legacy `experimentalDecorators`.

The wrapper persists a stable job name and serializable input, not a function or closure. Each worker must register the same handler code to recover that name. Constructors and Runner DI execute only inside an attempt.

`manager.register(...types)`, `manager.run(Type, input, options)`, and `manager.get(Type, id)` expose the equivalent unbound operations. Batch registration validates every definition before admitting any of them. `wrap(Type)` registers one type and returns typed `run()`/`get()` methods.

## Execution handles

`Execution<T>` is `PromiseLike<T>`, not a `Promise`:

Admission failures (such as a missing execution in `get()`) are retained by the handle without an unhandled promise rejection. They surface when you await the handle or call `status()`/`cancel()`.

```ts
interface Execution<T> extends PromiseLike<T> {
  readonly id: string;
  status(): Promise<ExecutionStatus>;
  cancel(reason?: unknown): Promise<void>;
}
```

An execution key is scoped to the job name. Equal name/key/input joins the existing execution; different input raises `ExecutionIdentityConflictError`. Input is snapshotted at submission. Identity compares its serialized representation, not semantic equality of arbitrary objects; retain stable field ordering and input schemas.

A worker claims only registered jobs. `run()` starts the local worker unless `autoStart: false`; use `manager.start()` for dedicated recovery workers. `get()` joins a stored execution but does not start a worker itself.

## Optional dynamic checkpoints

Without checkpoints, retry starts the **entire handler** again. Checkpoints memoize completed effects as the handler runs, including effects selected by ordinary branches and loops.

```ts
import { inject } from "@tiberjs/runner";
import { DurableExecution, Job } from "@tiberjs/manager";

@Job({ name: "accumulator:v1", retry: { retries: 2 } })
class Accumulator {
  readonly durable = inject(DurableExecution);

  async run(input: { turns: number }): Promise<number> {
    let total = 0;
    for (let turn = 0; turn < input.turns; turn += 1) {
      const plan = await this.durable.checkpoint(`plan:${turn}`, { turn, total }, () => ({
        tool: "add",
        amount: turn + 1,
      }));
      total = await this.durable.checkpoint(
        `tool:${turn}:${plan.tool}`,
        { total, plan },
        () => total + plan.amount,
      );
    }
    return total;
  }
}
```

For an agent, the plan operation is a model call and the tool operation performs the selected external action. The example uses local computations to remain runnable without a provider.

```ts
checkpoint<Input, Output>(
  key: string,
  input: Input,
  operation: () => Output | PromiseLike<Output>,
): Task<Awaited<Output>>
```

- Keys are unique logical effect identities within a job; use stable turn/tool-call IDs, not random values or completion order.
- `input` is the identity payload. Include all changing arguments used by the operation; the closure is not serialized or inspected.
- A first call atomically reserves the key and input fingerprint before executing.
- A completed key returns its persisted result, including `undefined`, without invoking the operation.
- The same key with different input raises `CheckpointIdentityConflictError`, even after an unsuccessful operation.
- Concurrent matching calls within an attempt join the same in-flight operation and read its committed result, not another caller's mutable return value. Different keys can run concurrently using Runner `forkGroup()`.
- A failed operation releases its reservation but retains input identity. A caught failure may be retried explicitly; otherwise job retry policy applies.
- Operations are leaf effects: nested checkpoints are rejected. Put orchestration and checkpoints in the job handler, not inside another checkpoint operation.
- A checkpoint has a nested Runner task boundary: its child tasks are joined and unobserved failures checked before result commit. DI resources remain owned by the job's scope. Use explicit `using`/`await using` for resources that must close before an individual checkpoint commits.
- Checkpoint tasks are owned by Runner. Await them; returning from the job cancels and joins unfinished work rather than creating detached durable jobs.

## Recovery semantics

```text
attempt 1: handler entry → model checkpoint committed → tool checkpoint committed → crash
attempt 2: handler entry → model result reused → tool result reused → new effects → complete
```

This is keyed result reuse, **not automatic deterministic workflow replay**. JavaScript locals, stacks, closures, ordinary promises, Runner scopes, and `fork()` tasks are not persisted. Code between checkpoints executes again. Keep branching dependent on persisted input/results; place nondeterministic decisions and external effects inside checkpoints. Changes to control flow, checkpoint meaning, or output schemas require a new job identity (for example `research:v2`) while old jobs drain with old code.

Execution is **at least once**. An external effect may succeed before its checkpoint commit is acknowledged; it can run again after recovery. Supply an external idempotency key derived unambiguously from execution ID and checkpoint key, or coordinate the external effect transactionally. Activation fencing protects store writes, not external systems.

There are no durable timers, signals, detached child jobs, or instruction-level resume. Ordinary sleeps consume the active attempt and start over on retry.

## Runner ownership and DI

Handlers can use `inject()`, `onStart()`, `onDispose()`, `fork()`, `forkGroup()`, `signal()`, and other Runner APIs unchanged. Configure providers with `manager.provide(Token, factory)` before starting work. Manager reserves the `DurableExecution` token for its attempt-local checkpoint service.

`currentExecution()` returns `{ executionId, job, attempt, signal }` only within a managed job. Each attempt gets a new scope and handler instance. Manager commits the **job result only after** Runner joins children and the scope disposes successfully. Completed checkpoints remain committed even if subsequent job cleanup fails; their resources must not depend on that later cleanup succeeding. Handler and cleanup failures are preserved together in `SerializedError.errors`.

Disposal runs in the attempt's Runner context, so cleanup can access `currentExecution()`, `signal()`, and already-resolved dependencies. The task group is already closed; cleanup must not start new child work. Heartbeat failures retain independent cleanup failures, and cached worker errors apply only to the affected attempt.

Cancellation is cooperative: pass Runner's `signal()` to cancellable APIs. Durable state remains `cancelling` until the active attempt unwinds; a disappeared worker is handled by lease recovery. `close()` stops claims, aborts and joins local attempts, and releases unfinished jobs without consuming retry budget or discarding checkpoints. A process crash cannot run cleanup.

## Retry policy

Field-wise precedence:

```text
Manager defaults < @Job retry options < run(..., { retry })
```

`retries: 3` allows one initial attempt and three retries. Failures and expired leases consume retry budget; graceful worker shutdown does not. Failed attempts restart at handler entry while completed checkpoint results remain available. Retry exhaustion fails the job. No checkpoint-specific scheduler or separate retry policy is involved.

## Persistence contract and architecture

```text
Manager → JobRegistry
        → DurableWorker → JobActivationRunner → Runner attempt
                                             → CheckpointRuntime
MemoryStore → pure job and checkpoint transitions
```

- `src/job/`: decorator metadata and atomic registration.
- `src/execution/`: records, handles, retries, pure job/checkpoint state transitions.
- `src/runtime/`: worker ownership, activation finalization, Runner wrapping, checkpoint execution. `lease.ts` owns heartbeat renewal and interruption.
- `src/persistence/store.ts`: `ExecutionStore` SPI.
- `src/persistence/adapter/memory-store.ts`: in-process reference adapter.

The SPI provides atomic create, claim, heartbeat, completion, failure, release, cancellation, lease recovery, and checkpoint reservation/completion/release. Mutations are fenced by execution ID, activation ID, and lease; checkpoint mutations also validate key and input fingerprint. Completing a checkpoint atomically stores its result with completed status. Completing a job stores its terminal result atomically. Cancellation and terminal states reject subsequent success writes.

Inputs and checkpoint/job results must support structured cloning; the selected store may impose further serialization constraints. Returned store records must not share mutable references with stored data. Durable adapters must implement these transitions transactionally or through compare-and-set, not separate unprotected reads and writes.

The former graph API and record format are removed, with no compatibility aliases. Existing graph records cannot be reinterpreted as job records; drain or explicitly migrate them before switching storage.

## Development

```sh
pnpm install
pnpm format
pnpm check
pnpm build
pnpm test
```

Rspack emits the runtime bundle and TypeScript emits declarations. Consumers import published package exports, never sibling Runner source.
