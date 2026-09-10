# Working on @tiberjs/manager

`@tiberjs/manager` is the durable DAG scheduler for TiberJS. It persists workflow and node state, schedules dependency-ready nodes, retries failed attempts, propagates cancellation, and recovers expired leases. Every node attempt executes through `@tiberjs/runner`.

## Repository boundary

- `src/manager.ts`: public composition root, execution submission, handles, and lifecycle facade.
- `src/execution/`: durable execution model.
  - `handle.ts`: awaitable execution handle.
  - `record.ts`: initial record, retry precedence, identity, and fingerprints.
  - `retry.ts`: retry normalization and backoff calculation.
  - `state.ts`: pure immutable execution/node state transitions.
- `src/persistence/`: persistence boundary.
  - `store.ts`: persistence SPI and atomic transition contracts.
  - `adapter/memory-store.ts`: clone-isolated in-process persistence and ready-node selection.
- `src/runtime/`: process-local worker execution.
  - `worker.ts`: ready-node claiming, concurrency ownership, wakeups, and shutdown.
  - `node-activation.ts`: one claim's input resolution, heartbeat, execution, and commit.
  - `attempt.ts`: Runner scope, handler execution, cleanup, and ambient metadata.
- `src/workflow/`: workflow definitions.
  - `definition.ts`: `@Workflow`, typed DAG declaration, compilation, and bindings.
  - `registry.ts`: atomic workflow compilation, validation, and lookup.
- `src/types.ts`: public workflow, execution, node, retry, and persisted-record types.
- `tests/`: public behavior, pure transitions, recovery, fencing, and lifecycle tests.

Manager is an independent package repository. Depend on Runner through its published package exports. Never import `runner/src`, create a parent workspace link, or copy Runner execution, TaskGroup, cancellation, DI, or lifecycle machinery into Manager.

Manager must not depend on server, HTTP, WebSocket, gRPC, broker, queue, cron, or transport packages. Persistent stores and transports adapt to Manager's public SPI rather than becoming Manager core dependencies.

## Ownership model

The boundary is fixed:

```text
Manager
→ durable execution identity and records
→ DAG dependency scheduling
→ node retry and lease recovery
→ durable cancellation state

Runner
→ one node attempt's ExecutionContext
→ TaskGroup child ownership
→ cancellation signal
→ DI resource scope and cleanup
```

Arbitrary promises and `await` expressions are not durable checkpoints. Only a successfully persisted completed node is a checkpoint. Never imply instruction-level resume, closure serialization, or exactly-once execution.

## Public contracts

- Workflows are named classes decorated with `@Workflow` and extending `DurableGraph<Input, Output>`.
- `build()` is a pure graph declaration. It may create symbolic nodes but must not perform user work or access execution-scoped ambient APIs.
- Step IDs and workflow names are durable identities. Do not silently rename or reinterpret them while persisted executions may exist.
- Dependencies come from `NodeRef` values nested in step inputs. A node becomes ready only after every dependency is completed.
- Registration must reject malformed graphs before mutating Manager registration state.
- Step handlers are reconstructable class tokens. Instantiate them inside the attempt's Runner scope, not during graph compilation.
- A node is not complete until Runner joins its child tasks and the attempt scope disposes successfully.
- `Execution<T>` is intentionally `PromiseLike`, not a `Promise`; preserve `id`, `status()`, and `cancel()`.
- Stable keys are scoped to workflow names. Equal workflow/key/input joins the existing execution; conflicting input fails.
- Inputs and node outputs cross a persistence boundary and must be serializable by the configured store.

## State-machine invariants

Execution terminal states are `completed`, `failed`, and `cancelled`; terminal records never transition again.

For every node:

- `blocked` has unmet dependencies.
- `ready` is claimable only when `availableAt <= now`.
- Claim atomically changes one ready node to running, increments `attempt`, and assigns a fresh `activationId`, `workerId`, and lease.
- Running-node mutations are fenced by `executionId + nodeId + activationId`. Heartbeat additionally verifies `workerId`.
- Completion persists the result and activates newly satisfied dependents in one store mutation.
- Retry increments `failures` but never reruns completed upstream nodes.
- Exhausted retry fails the execution and cancels every unfinished node.
- Cancelled, failed, completed, blocked, and ready nodes must not retain activation ownership fields.
- Execution status must agree with node state: any active node implies `running` unless cancellation is in progress; no active node implies `pending` until terminal.
- Lease recovery applies the same retry accounting and fencing rules as an observed attempt failure.

`MemoryStore` is the executable reference for these rules, not production durability. Store methods are atomic transition operations, not generic CRUD. A persistent implementation must reject stale activations and must not expose partially applied transitions.

## Failure and cancellation

- Preserve the original operation error and cleanup errors; combine independent failures rather than dropping either.
- Treat store/worker failures as infrastructure failures. Do not rewrite them as successful node completion.
- Cancellation is cooperative. Abort the Runner signal, let Runner cancel and join children, dispose the scope, then acknowledge durable cancellation.
- Manager shutdown stops claims, aborts and joins local attempts, and releases unfinished owned nodes. It must retain completed node results.
- At-least-once is the delivery guarantee. External side effects must be idempotent or transactionally coordinated with durable storage.

## Implementation rules

- Establish validation, ownership, commitment, and post-failure state before changing a public or store boundary.
- Validate reusable configuration and complete workflow batches before mutating runtime state.
- Keep scheduling decisions in Manager and atomic transitions in `ExecutionStore`; do not split one transition across both layers.
- Prefer `Record` for persisted static node tables and `Map`/`Set` for dynamic process-local membership.
- Use `Promise.withResolvers()` for deferred promises.
- Avoid allocations and repeated computation in polling, heartbeat, claim, and node-completion paths.
- Relative imports include `.js` for NodeNext resolution.
- Standard TC39 decorators only. Do not enable legacy `experimentalDecorators` or add `reflect-metadata`.
- Remove obsolete exports and paths instead of adding compatibility shims.
- Extract helpers for coherent responsibilities and invariants, not line-count targets.

## Toolchain

Use Node 24 and the pnpm version pinned in `package.json`. Run commands from `manager/`:

| Command                          | Purpose                           |
| -------------------------------- | --------------------------------- |
| `pnpm install --frozen-lockfile` | Reproduce dependencies            |
| `pnpm lint`                      | Run Oxlint; warnings fail         |
| `pnpm format`                    | Format maintained files           |
| `pnpm format:check`              | Check formatting                  |
| `pnpm typecheck`                 | Typecheck source and tests        |
| `pnpm check`                     | Lint, format check, and typecheck |
| `pnpm build`                     | Bundle ESM and emit declarations  |
| `pnpm test`                      | Run the Manager suite             |

Rspack emits the ESM runtime bundle and TypeScript emits declarations. Verify consumer behavior against built `dist`; consumers must not rely on repository source conditions.

## Tests and verification

- Test public observable behavior and persisted state transitions, not private wiring or incidental error wording.
- Every permanent test must fail for a plausible regression.
- Cover dependency gating, parallel readiness, retry precedence/accounting, lease expiry, stale activation fencing, cancellation acknowledgement, shutdown release, serialization boundaries, and simultaneous node outcomes.
- Observe expected rejections before triggering cancellation or failure to avoid unhandled-rejection races.
- Use deferred gates instead of sleeps for concurrency ordering. Keep the polling interval small only where the worker loop is under test.
- Test `MemoryStore` directly for atomic state-machine edges; test `Manager` for orchestration and Runner ownership.
- Keep clocks and shared stores isolated. Prefer explicit timestamps in direct store tests.
- After behavioral changes run `pnpm format`, `pnpm check`, `pnpm build`, and the relevant tests. Run the full suite for scheduling, cancellation, recovery, or store-contract changes.
