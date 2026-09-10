# @tiberjs/manager

`@tiberjs/manager` runs explicit durable DAGs on `@tiberjs/runner`.

Manager owns persisted graph state, dependency scheduling, retries, cancellation, and lease recovery. Runner executes each node attempt and owns its process-local child tasks, dependency-injection scope, cancellation signal, and cleanup.

Arbitrary promises and `await` expressions are not checkpoints. A completed DAG node is the durable boundary.

The implementation keeps these ownership boundaries explicit:

```text
Manager facade
→ WorkflowRegistry
→ DurableWorker
   → NodeActivationRunner
      → Runner node attempt

MemoryStore
→ pure execution-state transitions
```

`Manager` does not implement scheduling or node execution. `MemoryStore` owns in-memory isolation and atomic replacement, while `execution/state.ts` owns the transport-independent state machine.

## Installation

```sh
pnpm add @tiberjs/manager @tiberjs/runner
```

Node.js 20 or newer is required.

## Define a workflow

A workflow is a pure graph declaration. `build()` receives a symbolic input reference and returns the output node reference; it does not execute handlers.

```ts
import {
  DurableGraph,
  MemoryStore,
  Workflow,
  createManager,
  type NodeRef,
  type WorkflowInput,
} from "@tiberjs/manager";

interface ResearchInput {
  query: string;
}

class SearchWeb {
  async run(input: ResearchInput): Promise<string[]> {
    return searchWeb(input.query);
  }
}

class SearchPapers {
  async run(input: ResearchInput): Promise<string[]> {
    return searchPapers(input.query);
  }
}

class Summarize {
  async run(input: { web: string[]; papers: string[] }): Promise<string> {
    return summarize([...input.web, ...input.papers]);
  }
}

@Workflow({
  name: "research",
  retry: { retries: 3, delayMs: 250, backoff: 2, maxDelayMs: 10_000 },
})
class Research extends DurableGraph<ResearchInput, string> {
  build(input: WorkflowInput<ResearchInput>): NodeRef<string> {
    const web = this.step("web", SearchWeb, input);
    const papers = this.step("papers", SearchPapers, input);
    return this.step("summary", Summarize, { web, papers });
  }
}
```

Dependencies are inferred from `NodeRef` values nested in a node's input. `web` and `papers` are ready together; `summary` becomes ready only after both complete. Step IDs are durable identities and must remain stable across deployments while unfinished executions exist.

Registration rejects duplicate step IDs, references from another graph, invalid outputs, and disconnected nodes.

Registration snapshots retry options and plain object/array step bindings. Mutating declaration objects afterward does not change the compiled workflow.

## Run and resume

```ts
await using manager = createManager({
  store: new MemoryStore(),
  concurrency: 8,
});

manager.register(Research);

const execution = manager.run(
  Research,
  { query: "structured concurrency" },
  { key: "research:42" },
);

const report = await execution;
```

`Execution<T>` is `PromiseLike<T>` and exposes:

```ts
interface Execution<T> extends PromiseLike<T> {
  readonly id: string;
  status(): Promise<ExecutionStatus>;
  cancel(reason?: unknown): Promise<void>;
}
```

Use `get()` to join a persisted execution after registering its workflow:

```ts
const resumed = manager.get(Research, executionId);
const report = await resumed;
```

Workers only claim nodes for workflows registered in that process. `run()` starts the worker automatically unless `autoStart` is `false`; call `start()` explicitly in dedicated worker processes.

## Node attempts use Runner

Every claimed node runs inside `runner.execute()` with a fresh resource scope. Handler classes can use Runner's ambient DI and structured-concurrency APIs:

```ts
import { fork, inject, onDispose, signal, token } from "@tiberjs/runner";
import { currentExecution } from "@tiberjs/manager";

const Database = token<DatabaseClient>("database");

class PersistReport {
  private readonly database = inject(Database);

  constructor() {
    onDispose(() => this.database.release());
  }

  async run(report: string): Promise<string> {
    const { executionId, nodeId, attempt } = currentExecution();

    fork(async () => audit({ executionId, nodeId, attempt }));
    await this.database.put(report, { signal: signal() });
    return report;
  }
}

manager.provide(Database, () => createDatabaseClient());
```

A node is not durably complete until its handler returns and Runner has joined its child tasks. The attempt scope is then disposed before Manager persists the result. Cancellation aborts Runner's signal and remains cooperative: pass `signal()` to cancellable APIs and check it around irreversible work.

If handler execution and scope disposal both fail, Manager preserves both failures in the durable `SerializedError.errors` list.

## Retry and recovery

Retry policy can be set at four levels. Higher levels replace only the fields they specify:

```text
manager default
  < workflow @Workflow(...)
  < node this.step(..., { retry })
  < execution manager.run(..., { retry })
```

`retries: 3` means one initial attempt plus at most three retries. A failed node retries independently; completed upstream nodes and their results remain persisted. Exhausting a node's retries fails the execution and cancels unfinished sibling/downstream nodes.

A claim has both a worker ID and a unique activation ID. Heartbeats renew its lease. Completion, failure, release, and cancellation acknowledgement are fenced by that activation ID, so a stale worker cannot overwrite a newer attempt.

After a worker disappears:

```text
lease expires
→ store recovers the running node
→ node becomes ready at its retry time
→ another registered worker claims a new attempt
→ completed nodes are not rerun
```

Execution is at least once. A worker can perform an external side effect and die before persisting node completion. Make side effects idempotent or commit them transactionally with the backing store.

## Stable execution keys

A key is scoped to the workflow name and produces a stable execution ID.

```ts
const first = manager.run(Research, input, { key: "research:42" });
const duplicate = manager.run(Research, input, { key: "research:42" });

first.id === duplicate.id;
```

The duplicate joins the existing execution. Reusing the key with different input fails with `ExecutionIdentityConflictError`. A stable key deduplicates execution records; it does not provide exactly-once external effects.

## Store contract

`ExecutionStore` persists the full execution record and implements atomic node transitions:

- idempotent execution creation and loading;
- ready-node claim;
- lease heartbeat;
- fenced completion, failure, release, and cancellation acknowledgement;
- execution cancellation;
- expired-lease recovery.

`MemoryStore` is the reference state machine and validates persistence boundaries with `structuredClone()`. It supports recovery between Manager instances sharing that store, but it does not survive process restart. Production stores must preserve the same atomic transitions in durable storage.

Inputs, node results, and errors must be serializable by the selected store.

## Lifecycle

`close()` stops claiming nodes, aborts and joins local attempts, and releases unfinished nodes for another worker. It does not discard completed results. `Manager` implements `AsyncDisposable`.

Terminal execution states are `completed`, `failed`, and `cancelled`. Cancellation can temporarily expose `cancelling` while running attempts unwind.

## Development

```sh
pnpm install
pnpm check
pnpm build
pnpm test
```

Rspack emits the Node.js ESM runtime bundle. TypeScript emits declarations and declaration maps.
