# Working on @tiberjs/manager

`@tiberjs/manager` wraps registered Runner handlers as durable jobs. Manager owns logical job identity, persisted input/results, optional dynamic checkpoints, retries, cancellation, and lease recovery. Runner owns every process-local attempt. There is no graph declaration or DAG scheduler.

## Repository boundary

- `src/manager.ts`: registration, typed `wrap()`/`run()`/`get()`, handles, and lifecycle facade.
- `src/job/definition.ts`: standard `@Job` metadata and stable names.
- `src/job/registry.ts`: atomic registration, retry defaults, and handler lookup; never constructs handlers.
- `src/execution/handle.ts`: awaitable execution handle.
- `src/execution/record.ts`: input snapshot, identity/fingerprint, initial state and retry precedence.
- `src/execution/retry.ts`: retry normalization and backoff.
- `src/execution/state.ts`: pure immutable job transitions and ownership fencing.
- `src/execution/checkpoint-state.ts`: pure checkpoint reservation, identity, and result transitions.
- `src/runtime/worker.ts`: job claiming, activation concurrency, wakeups, shutdown.
- `src/runtime/job-activation.ts`: Runner attempt, fenced completion and cancellation acknowledgement.
- `src/runtime/lease.ts`: heartbeat renewal, interruption, and joined lease-monitor shutdown.
- `src/runtime/attempt.ts`: fresh Runner scope, handler construction, startup, cleanup, ambient metadata.
- `src/runtime/checkpoint.ts`: injectable `DurableExecution` and Runner-owned checkpoint operations.
- `src/persistence/store.ts`: atomic persistence SPI.
- `src/persistence/adapter/memory-store.ts`: clone-isolated reference adapter.
- `src/types.ts`: named public job, execution, checkpoint, retry, and persisted-record contracts.
- `tests/`: public behavior, pure transitions, store fencing/recovery, Runner ownership, and compile-time inference.

Manager is independent. Consume Runner through published exports, never sibling source or a parent workspace link. Do not copy Runner execution, TaskGroup, DI, cancellation, or resource lifecycle machinery. Check the installed Runner package's exports, not just the latest sibling source API.

No dependencies on server, HTTP, WebSocket, gRPC, brokers, queue, cron, or transport packages. Durable adapters implement the public SPI without becoming Manager core dependencies.

## Ownership and durability

```text
Manager → logical job identity, leases, retry, durable cancellation, checkpoint records
Runner  → one attempt's context, TaskGroup, cooperative signal, DI scope, cleanup
```

A job is a reconstructable class with a `run(input)` method and a stable `@Job` name. `wrap(Type)` binds a class to a Manager; it does not serialize code or closures. Input is cloned synchronously at submission. No required base class and no graph compilation.

On recovery the handler starts at entry. Only successful persisted checkpoints skip operations; local variables, closures, ordinary promises, sleeps, resources, and forked tasks are ephemeral. Do not claim automatic deterministic replay, instruction-level resume, production persistence from MemoryStore, or exactly-once external effects.

Checkpoint keys must identify logical effects independently of execution timing. Include all changing operation arguments in checkpoint input. Same key with different input fails even after an unsuccessful operation. Completed `undefined` is distinct from missing. Object-prototype names are valid keys.

Checkpoint operations are leaves: nested checkpoints are rejected. Orchestrate in the handler using ordinary loops, branches, and Runner forks. Each operation has a nested Runner task boundary, but DI resources remain job-scoped; checkpoint-local resources use explicit disposal. A checkpoint commits after its child tasks join. A job commits only after its own Runner children join and scope cleanup succeeds. Already committed checkpoints survive subsequent job/cleanup failure.

## Public contracts

- Use standard TC39 decorators, never legacy `experimentalDecorators` or `reflect-metadata`.
- `JobInputOf` and `JobOutputOf` infer handler types; parameterless jobs use `undefined` input.
- `Execution<T>` remains `PromiseLike`, preserving `id`, `status()`, and `cancel()`.
- `DurableExecution` is a Manager-owned DI token; user providers must not replace its attempt-local service.
- `currentExecution()` exposes execution ID, job name, attempt, and live signal.
- Scope disposal must retain the attempt's Runner context, with an already-closed TaskGroup.
- Admission failures are retained by handles until observation; constructing a handle must not create an unhandled rejection.
- Equal job/key/input joins the existing execution; differing input raises an identity conflict.
- Registration validates the entire batch before mutating indexes or constructing a handler.
- Retry precedence is Manager defaults < job options < execution options, field by field.
- Worker concurrency bounds jobs, not ordinary forked tasks or individual checkpoints.
- Inputs/results must support structured cloning plus the configured store's serialization constraints.
- Job names and checkpoint keys/schemas are durable identities. Use a new job name for incompatible code/schema changes; retain old registered handlers until old jobs drain.
- The former graph API/record format is removed. Do not introduce compatibility aliases or silently reinterpret old records.

## Atomic persistence invariants

- `pending` jobs are claimable only when `availableAt <= now` and their job name is registered.
- Claim atomically increments attempt and assigns fresh activation ID, worker ID, and lease. One logical job has at most one live stored owner.
- Mutations validate execution ID + activation ID. Success/failure/checkpoint writes additionally require a live lease. Heartbeat also validates worker ID.
- Expired leases cannot be resurrected by heartbeat. Stale workers cannot overwrite newer attempts or checkpoint results.
- `beginCheckpoint` atomically validates owner, input identity, and reservation. Same active reservation is busy; completed keys return clone-isolated results.
- Checkpoint completion atomically stores result and completed status. Release retains input identity but removes reservation ownership.
- Failed attempts and expired leases consume retry budget. Graceful shutdown releases without consuming that budget. Both preserve completed checkpoint results.
- Inactive/terminal jobs and unfinished checkpoints do not retain activation ownership. Completed checkpoints never change.
- Terminal job states are `completed`, `failed`, and `cancelled`; no later transitions are allowed.
- Cancellation first persists the request and then aborts local work. Acknowledge only after Runner teardown, or recover cancellation after an abandoned lease expires.
- Cancellation can race any final write. A rejected result/failure/release transition must not strand an already-unwound attempt in `cancelling`.
- Atomic means transaction or compare-and-set, not generic CRUD read/modify/write. Adapter reads must not expose mutable store references.

MemoryStore is a synchronous atomic in-memory reference adapter, not production durability. External effects remain at least once; use unambiguous execution/checkpoint-derived idempotency keys or coordinated transactions. Fencing protects stored state, not outside services.

## Failure and lifecycle

- Preserve handler and independent cleanup errors. Infrastructure/store failures must not be represented as successful execution.
- Heartbeat failures must retain independent teardown errors. Cached infrastructure failures apply only to the attempt that produced them.
- Cancellation is cooperative: forward Runner signals to cancellable operations and observe them before irreversible effects.
- `close()` stops claims, joins even a claim already in flight, aborts/joins local attempts, and releases unfinished jobs. Never start a handler for a claim arriving after shutdown.
- A process crash cannot run cleanup. Resource recovery outside the process is the owning service's responsibility.
- `get()` joins existing work; dedicated workers must call `start()` explicitly. `run()` auto-starts unless configured otherwise.

## Implementation and verification

- Define ownership and commitment before changing a public/store contract. Reuse existing patterns and keep atomic transitions in the pure state layer.
- Keep distinct responsibilities in the directories above; do not flatten persistence adapters into the SPI directory.
- Use `Promise.withResolvers()` for deferred promises. Avoid allocation and work in polling, heartbeat, and common completed-result paths.
- Dynamic process-local membership uses Map/Set; persisted checkpoint tables use safe string-keyed records.
- Relative imports use `.js` for NodeNext. Export named concrete contracts rather than deriving consumer types from implementation functions.
- Do not spawn subagents unless the user explicitly asks.

Use Node 24 and the pnpm version pinned in `package.json`. From `manager/`:

```sh
pnpm install --frozen-lockfile
pnpm format
pnpm check
pnpm build
pnpm test
```

Rspack builds the ESM runtime and cleans dist; TypeScript emits declarations. Verify consumers against built exports and the installed/published Runner package.

Permanent tests must defend observable contracts, boundaries, ownership, concurrency, and real failure modes. Use deferred gates instead of sleeps for races. Observe expected rejections before triggering them. Keep explicit clocks in pure/store tests. Test both job-wide retry and completed-checkpoint reuse, lease fencing, input conflicts, serialization isolation, cancellation/commit and shutdown/claim races, cleanup failures, and typed wrappers. Run the full suite for runtime or store changes; use a throwaway actual-process smoke for process restart claims.
