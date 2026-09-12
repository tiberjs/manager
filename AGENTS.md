# Working on the TiberJS manager workspace

This repository is a pnpm workspace of three independently published packages built on `@tiberjs/runner`. There is no root package; every package owns its own manifest, entry point, and version.

```text
manager/
├── packages/durable/    # @tiberjs/durable  — durable jobs on top of Runner attempts
├── packages/di/         # @tiberjs/di       — hierarchical container and resource ownership
└── packages/eventbus/   # @tiberjs/eventbus — typed synchronous in-process notifications
```

- `packages/durable` (`@tiberjs/durable`, formerly `@tiberjs/manager`): logical job identity, persisted input/results, optional dynamic checkpoints, retries, leases, cancellation, and recovery. Runner owns every process-local attempt. There is no graph declaration or DAG scheduler.
- `packages/di` (`@tiberjs/di`): a hierarchical container that constructs objects, caches them per container, resolves through parents, detects cycles, and disposes the resources it owns.
- `packages/eventbus` (`@tiberjs/eventbus`): a typed subscription map delivering in-process notifications synchronously to its subscribers.

Each package owns a `README.md` that documents it for consumers; the root `README.md` is only a workspace index. This file is the contributor contract — keep user-facing usage prose in the package READMEs, and update a package's README with any change to its public surface.

Each package is independent. Consume dependencies through package exports, never sibling source or a parent workspace link; check installed package exports, not the latest sibling source API. No package depends on server, HTTP, WebSocket, gRPC, brokers, queue, cron, or transport packages. `di` and `eventbus` must not depend on `durable`; `durable` may depend on `di` for attempt-local containers. Cross-package reuse inside this workspace still goes through package exports.

## Runner versions

All three packages target the published `@tiberjs/runner` 0.3 line. Runner owns execution; `@tiberjs/di` owns dependency construction and cleanup. `durable` depends on the published DI 0.1 line and binds one fresh container to each attempt.

There is no packed-artifact override any more; every runner dependency resolves from npm.

## CI and publishing

`ci.yml` runs on pushes to `main` and on pull requests: frozen install, check, build, test, and pack for all three packages.

`publish.yml` is dispatched manually with the package directory to publish, runs only from `main`, rebuilds and retests the workspace, then runs `npm publish --access public --provenance` in that directory. It authenticates through npm trusted publishing with GitHub OIDC (`id-token: write`) and must not receive `NPM_TOKEN` or `NODE_AUTH_TOKEN`. After a package's bootstrap release, register repository `tiberjs/manager`, workflow `publish.yml`, and GitHub environment `npm` as that package's trusted publisher. Bump the package version in source before dispatching; publishing an existing version must fail.

## `@tiberjs/durable`

### Package boundary

- `packages/durable/src/manager.ts`: registration, typed `wrap()`/`run()`/`get()`, handles, and lifecycle facade.
- `packages/durable/src/job/definition.ts`: standard `@Job` metadata and stable names.
- `packages/durable/src/job/registry.ts`: atomic registration, retry defaults, and handler lookup; never constructs handlers.
- `packages/durable/src/execution/handle.ts`: awaitable execution handle.
- `packages/durable/src/execution/record.ts`: input snapshot, identity/fingerprint, initial state and retry precedence.
- `packages/durable/src/execution/retry.ts`: retry normalization and backoff.
- `packages/durable/src/execution/state.ts`: pure immutable job transitions and ownership fencing.
- `packages/durable/src/execution/checkpoint-state.ts`: pure checkpoint reservation, identity, and result transitions.
- `packages/durable/src/runtime/worker.ts`: job claiming, activation concurrency, wakeups, shutdown.
- `packages/durable/src/runtime/job-activation.ts`: Runner attempt, fenced completion and cancellation acknowledgement.
- `packages/durable/src/runtime/lease.ts`: heartbeat renewal, interruption, and joined lease-monitor shutdown.
- `packages/durable/src/runtime/attempt.ts`: fresh Runner Job and DI container, handler construction, cleanup, ambient metadata.
- `packages/durable/src/runtime/checkpoint.ts`: injectable `DurableExecution` and Runner-owned checkpoint Jobs.
- `packages/durable/src/persistence/store.ts`: atomic persistence SPI.
- `packages/durable/src/persistence/adapter/memory-store.ts`: clone-isolated reference adapter.
- `packages/durable/src/types.ts`: named public job, execution, checkpoint, retry, and persisted-record contracts.
- `packages/durable/src/index.ts` and `packages/durable/src/errors.ts`: the single public entry and the named error types it re-exports.
- `packages/durable/tests/`: public behavior, pure transitions, store fencing/recovery, Runner ownership, and compile-time inference.

Do not copy Runner execution, TaskGroup, DI, cancellation, or resource lifecycle machinery into this package. Durable adapters implement the public SPI without becoming core dependencies.

### Ownership and durability

```text
durable → logical job identity, leases, retry, durable cancellation, checkpoint records
Runner  → one attempt's execution context, child Jobs, and cooperative cancellation
DI      → one attempt's dependency construction, caching, and cleanup
```

A job is a reconstructable class with a `run(input)` method and a stable `@Job` name. `wrap(Type)` binds a class to a manager; it does not serialize code or closures. Input is cloned synchronously at submission. No required base class and no graph compilation.

On recovery the handler starts at entry. Only successful persisted checkpoints skip operations; local variables, closures, ordinary promises, sleeps, resources, and forked tasks are ephemeral. Do not claim automatic deterministic replay, instruction-level resume, production persistence from MemoryStore, or exactly-once external effects.

Checkpoint keys must identify logical effects independently of execution timing. Include all changing operation arguments in checkpoint input. Same key with different input fails even after an unsuccessful operation. Completed `undefined` is distinct from missing. Object-prototype names are valid keys.

Checkpoint operations are leaves: nested checkpoints are rejected. Orchestrate in the handler using ordinary loops, branches, and Runner forks. Each operation has a nested Runner boundary, while its resources remain owned by the attempt container; checkpoint-local resources use explicit disposal. A checkpoint commits after its child Jobs join. A job commits only after its own Runner descendants join and container cleanup succeeds. A genuine checkpoint failure fails the attempt even if the handler catches the returned Job; same-attempt recovery belongs inside the operation, while durable retry starts a new attempt. Already committed checkpoints survive subsequent job or cleanup failure.

### Public contracts

- Use standard TC39 decorators, never legacy `experimentalDecorators` or `reflect-metadata`.
- `JobInputOf` and `JobOutputOf` infer handler types; parameterless jobs use `undefined` input.
- `Execution<T>` remains `PromiseLike`, preserving `id`, `status()`, and `cancel()`.
- `DurableExecution` is a package-owned DI token; user providers must not replace its attempt-local service. Its checkpoint method returns a Runner `Job`.
- `currentExecution()` exposes execution ID, job name, attempt, and live signal.
- Attempt-container disposal must retain the attempt's Runner context after its child Jobs have closed.
- Admission failures are retained by handles until observation; constructing a handle must not create an unhandled rejection.
- Equal job/key/input joins the existing execution; differing input raises an identity conflict.
- Registration validates the entire batch before mutating indexes or constructing a handler.
- Retry precedence is manager defaults < job options < execution options, field by field.
- Worker concurrency bounds jobs, not ordinary forked tasks or individual checkpoints.
- Inputs/results must support structured cloning plus the configured store's serialization constraints.
- Job names and checkpoint keys/schemas are durable identities. Use a new job name for incompatible code/schema changes; retain old registered handlers until old jobs drain.
- The former graph API/record format is removed. Do not introduce compatibility aliases or silently reinterpret old records.
- The package rename from `@tiberjs/manager` to `@tiberjs/durable` is a clean cutover. Do not publish an alias package or re-export shim.

### Atomic persistence invariants

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

### Failure and lifecycle

- Preserve handler and independent cleanup errors. Infrastructure/store failures must not be represented as successful execution.
- Heartbeat failures must retain independent teardown errors. Cached infrastructure failures apply only to the attempt that produced them.
- Cancellation is cooperative: forward Runner signals to cancellable operations and observe them before irreversible effects.
- `close()` stops claims, joins even a claim already in flight, aborts/joins local attempts, and releases unfinished jobs. Never start a handler for a claim arriving after shutdown.
- A process crash cannot run cleanup. Resource recovery outside the process is the owning service's responsibility.
- `get()` joins existing work; dedicated workers must call `start()` explicitly. `run()` auto-starts unless configured otherwise.

## `@tiberjs/di`

DI owns object construction, per-container caching, parent lookup, cycle detection, and disposal of the resources it owns. That is the whole mandate.

### Package boundary

- `packages/di/src/index.ts`: the single public entry.
- `packages/di/src/container.ts`: the hierarchical container composing the parts below: topology, parent lookup, and the one lifecycle phase that decides admission.
- `packages/di/src/ambient.ts`: `currentContainer()`, `inject()`, `scoped()`, `onDispose()`, `withContainer()`, and the `ContainerKey` context binding.
- `packages/di/src/tokens.ts`: token identity for classes and opaque tokens, and token descriptions for diagnostics.
- `packages/di/src/errors.ts`: the named resolution, provider, disposal, and closed-container errors.
- `packages/di/src/resolution/providers.ts`: a container's own factories and cached instances, and provider replacement rejection.
- `packages/di/src/resolution/path.ts`: the one in-flight construction chain per container tree; reports a cycle when the same container/token pair reenters, and is the frame source for diagnostics.
- `packages/di/src/resolution/graph.ts`: root-local resolution diagnostics and the public graph snapshot.
- `packages/di/src/resources/owner.ts`: the resources one container owns, composing the parts below; publishes no lifecycle state.
- `packages/di/src/resources/queue.ts`: LIFO cleanup storage and the single drain, owning only the rule that registration closes after that drain.
- `packages/di/src/resources/cleanup.ts`: `ContainerObject` and cleanup discovery across explicit disposer, symbol disposers, and `onClose`.
- `packages/di/src/resources/ownership.ts`: one disposal owner per value across a container tree, including cached admission rejections.
- `packages/di/src/resources/active-container.ts`: the ambient binding for the container currently constructing or tearing down.
- `packages/di/tests/`: hierarchy ownership and caching, cycle reporting, LIFO disposal and aggregated failures, use after close, ambient binding, and graph snapshots.

### Ownership and behavior

- It owns no execution: no Job, no TaskGroup, no cancellation, no signals, no retries, no scheduling. A container is a data structure that builds objects; anything that runs belongs to a caller-owned Runner Job.
- It owns no events. Wire notifications with `@tiberjs/eventbus` or an explicit callback; the container never broadcasts construction or disposal.
- It owns no startup or readiness barrier. Runner's `onStart`/`start()`/`sealStartup()`/`startupPending`/`StartupContext` concept is deliberately removed, not pending reimplementation: initialization ordering is the caller's, expressed as ordinary awaited code before the work that needs it. Do not reintroduce a lifecycle phase, an eager-instantiation pass, or an `isReady` flag.
- Resolution is lazy and memoized. A token is constructed and cached by the nearest container that provides it; without a local provider the lookup delegates to the parent, so a default-constructed class token lives at the root. A container owns and disposes only what it constructed, and a child never mutates its parent.
- Registration precedes resolution. `provide()` may replace an unresolved factory, but replacing one whose instance this container already handed out raises `ProviderConflictError`: the cached instance would win and the new provider would never run. A child container is the supported override, including for test doubles. `has()` reports an explicit provider or a cached instance, so it answers `false` for a class that `resolve()` would still default-construct; do not widen it into a constructibility probe.
- Cycle detection is per container by design. An ancestor without a local provider builds its own instance of a class token, so a descendant-provided token can legitimately be under construction in two containers at once — that is how a child decorates an ancestor's implementation. Do not replace the per-container guard with a tree-wide one; it would reject decoration, and the cycle is still reported before any unbounded recursion.
- Ambient lookup is on request paths. `currentContainer()` reads the construction store, then takes one runner state read and one context-frame walk; do not reintroduce a presence probe before the read, because a bound container is never `undefined`.
- Disposal is LIFO over the resources that container owns, and never reaches into a parent or a sibling. Disposal runs once; a container is unusable afterwards.
- Independent disposal failures go through runner's `combinedError(errors, message)`: one failure is rethrown by identity, several become an `AggregateError` in LIFO order. Use after close raises `ContainerClosedError`, carrying `closing` or `disposed`; that is the one state runner's `LifecycleState` does not name. Reuse runner's error model everywhere it does, and do not grow a parallel hierarchy beyond it.
- Cycles are a resolution-time error naming the participating tokens, not a stack overflow and not a lazily broken edge.
- Ambient access resolves the container active for the current construction or the current runner execution context; no module-level singleton and no implicit global fallback container.

## `@tiberjs/eventbus`

EventBus is a subscription map, not a process.

### Package boundary

- `packages/eventbus/src/index.ts`: the single public entry.
- `packages/eventbus/src/event-bus.ts`: the public bus: admission, synchronous delivery, and close.
- `packages/eventbus/src/event-key.ts`: typed event identity and its factory; keys carry no behavior.
- `packages/eventbus/src/types.ts`: the public listener, subscribe, option, and error-context contracts.
- `packages/eventbus/src/subscriptions/subscription.ts`: one subscription's lifetime, including its abort registration and at-most-once release.
- `packages/eventbus/src/subscriptions/subscription-index.ts`: per-key subscriber membership in registration order, stable across an emission.
- `packages/eventbus/src/failures/reporter.ts`: routes collected listener failures to `onError`, or asynchronously as unhandled errors.
- `packages/eventbus/tests/`: delivery order, revocation, snapshot stability during delivery, failure reporting, and use after close.

### Delivery and ownership

- `emit` is synchronous: it walks the current subscriber snapshot and calls each listener inline. There is no mailbox, no queue, no hidden Job, no scheduling, no backpressure, and no async listener contract. The publisher's execution context is preserved because nothing is deferred.
- A listener that needs to await or run in the background forks its own caller-owned Runner Job. The bus never keeps work alive, never joins anything, and never awaits a listener's return value.
- It is not a global singleton. Whoever constructs a bus owns it and closes it; `close()` is synchronous, idempotent, and exposed as `Symbol.dispose`. There is no ambient default instance, no async close or flush, and no cross-process fanout.
- Subscription is explicitly revocable, by the returned unsubscribe or by an `AbortSignal`. `emit` snapshots the subscriber set, so subscribing, unsubscribing, or closing during delivery affects later emissions only; the in-flight emit is unaffected.
- Independent listener failures are collected and reported once through runner's `combinedError(errors, message)` after every listener ran, routed to the optional `onError` reporter or otherwise surfaced asynchronously as an unhandled error. One throwing listener never cancels delivery to the rest and never changes the publisher's result. Use after close raises runner's `LifecycleStateError`.
- The unreported path is loud on purpose: a microtask rethrow reaches Node as an `uncaughtException` and can end the process. Never silently swallow a listener failure to soften that. Any owner wiring application-wide notifications supplies `onError`; document that requirement wherever a bus is constructed for a long-lived process.
- A listener that emits on a bus another listener just closed fails with `LifecycleStateError`, and that failure is reported as the outer emission's listener failure. Keep it that way: the listener really did throw, and silently tolerating emits on a closed bus would hide the mistake.
- `emit` delivers a sole subscriber directly and snapshots only when several are registered. Keep both paths observably identical; the snapshot exists for membership stability, not for delivery semantics.
- Event identity is a typed key, not a bare string, so payload types are checked at the call site. Keys carry no behavior.

## Implementation and verification

- Define ownership and commitment before changing a public/store contract. Reuse existing patterns and keep atomic transitions in the pure state layer.
- Keep distinct responsibilities in the directories above; do not flatten persistence adapters into the SPI directory.
- Each package exposes exactly one public entry, `src/index.ts`. Deep imports across packages are not a supported contract.
- Use `Promise.withResolvers()` for deferred promises. Avoid allocation and work in polling, heartbeat, emit, resolution-cache-hit, and common completed-result paths.
- Dynamic process-local membership uses Map/Set; persisted checkpoint tables use safe string-keyed records.
- Relative imports use `.js` for NodeNext. Export named concrete contracts rather than deriving consumer types from implementation functions.
- Do not spawn subagents unless the user explicitly asks.

Use Node 24 and the pnpm version pinned in the root `package.json`. Commands run from the workspace root, not from a package:

```sh
pnpm install --frozen-lockfile
pnpm format
pnpm check
pnpm build
pnpm test
```

`pnpm build` runs each package's build: Rspack bundles the ESM runtime through the shared `../../rspack.config.mjs` and cleans `dist`, then TypeScript emits declarations from `tsconfig.build.json`. `pnpm check` is lint, format check, and a per-package `tsc --noEmit`. Vitest runs one project per package, so a single package's suite is `pnpm test --project @tiberjs/di`. Verify consumers against built exports and the installed Runner package. Packages are versioned and published independently; `@tiberjs/durable` publishes under its new name, replacing `@tiberjs/manager`.

Permanent tests must defend observable contracts, boundaries, ownership, concurrency, and real failure modes. Use deferred gates instead of sleeps for races. Observe expected rejections before triggering them. Keep explicit clocks in pure/store tests. For durable, test both job-wide retry and completed-checkpoint reuse, lease fencing, input conflicts, serialization isolation, cancellation/commit and shutdown/claim races, cleanup failures, and typed wrappers; run the full suite for runtime or store changes and use a throwaway actual-process smoke for process restart claims. For di, test ownership and caching across the container hierarchy, cycle reporting, LIFO disposal order, aggregated disposal failure, and use after close. For eventbus, test delivery order, subscription changes during emit, listener failure aggregation, unsubscribe and signal-driven removal, and use after close. Do not add tests that re-run one path with different parameters or pin private wiring, incidental wording, or static defaults.
