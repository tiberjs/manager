# @tiberjs/di

A hierarchical dependency container for Node.js. It constructs objects on demand, caches each one for the container that built it, and disposes the resources it owns when that container closes.

It is a data structure, not a framework: no jobs, no scheduling, no events, and no startup phase. Anything that runs belongs in your own [Runner](https://github.com/tiberjs/runner) job.

Requires **Node.js 24+**. No decorators and no `reflect-metadata`: dependencies are declared by calling `inject()`.

## Installation

```sh
pnpm add @tiberjs/di @tiberjs/runner
```

## Quick start

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

`Db` never mentions the container. `inject()` reads whichever container is constructing the object, so classes stay plain, and `onDispose()` registers cleanup with that same container.

## Tokens

| Export                                                          | Purpose                                                                                                                                   |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `token<T>(description)`                                         | Create a typed token for a value or interface that has no runtime class. Two tokens with the same description are still different tokens. |
| A class                                                         | Usable as its own token, with no registration at all.                                                                                     |
| `Token<T>`, `Constructor<T>`, `InjectionToken<T>`, `Factory<T>` | Type-level contracts: `InjectionToken<T>` is a class or a `Token<T>`, and `Factory<T>` is `(container: Container) => T`.                  |

## `Container`

`new Container(parent?)` creates a container. You normally create the root yourself and derive the rest with `child()`.

| Method                                   | Behavior                                                                                                                                                                                                |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `provide(token, factory)`                | Register a factory for this container. The factory receives the resolving container. Register before the token is resolved here.                                                                        |
| `has(token)`                             | `true` when this container or an ancestor has an explicit provider or a cached instance. It answers `false` for a class with no provider, even though `resolve()` would still construct one.            |
| `resolve(token)`                         | Return the cached instance, or construct it once and cache it. Throws `ResolutionError` for a token with no provider, or for a resolution cycle.                                                        |
| `use(token, factory, dispose?)`          | Acquire an inline resource once per container, keyed by `token`, without registering a provider. `dispose` overrides the automatic protocol below.                                                      |
| `defer(cleanup)`                         | Register a cleanup callback with this container, including during its own teardown.                                                                                                                     |
| `child()`                                | Create a container that resolves through this one.                                                                                                                                                      |
| `resolutionGraph()`                      | A snapshot of who resolved what in this container tree, for diagnostics and dependency visualization.                                                                                                   |
| `disposeSync()`                          | Close a container that never resolved or deferred anything, avoiding an `await`. Returns `false` and changes nothing when the container holds instances or cleanups; dispose it asynchronously instead. |
| `await container[Symbol.asyncDispose]()` | Dispose the container. Also invoked by `await using`.                                                                                                                                                   |

## Ambient access

These read the container that is currently constructing an object, or — outside construction — the container bound to the current Runner execution.

| Export                              | Behavior                                                                                                                                                      |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inject(token)`                     | `currentContainer().resolve(token)`. Use it in field initializers and constructor bodies.                                                                     |
| `scoped(token, factory, dispose?)`  | `currentContainer().use(...)`.                                                                                                                                |
| `onDispose(cleanup)`                | `currentContainer().defer(cleanup)`.                                                                                                                          |
| `currentContainer()`                | The ambient container. Throws when there is none; there is no implicit global container.                                                                      |
| `withContainer(container, handler)` | Run `handler` with `container` ambient. Inside a Runner execution the binding is also published on the context, so derived executions see the same container. |
| `ContainerKey`                      | The Runner context key `withContainer()` publishes, for binding a container when you build a context yourself.                                                |

## Disposal

A container disposes the resources it constructed, in reverse construction order, exactly once. It never touches a parent's or a sibling's resources, and after disposal every use of it raises `ContainerClosedError`.

Cleanup is discovered in this order for each constructed value:

1. the `dispose` callback you passed to `use()` or `scoped()`;
2. `Symbol.asyncDispose` or `Symbol.dispose` on the value;
3. `onClose()` — the `ContainerObject` interface — on the value.

An object that has both `onClose()` and a symbol disposer is rejected with `DisposalConflictError`, as is handing an explicit `dispose` for a value another container already owns. Values with no cleanup protocol are simply cached. Independent cleanup failures are all run and then reported together: a single failure is rethrown as-is, several arrive as an `AggregateError` in disposal order.

## What you need to know to use it correctly

**Resolution is lazy and memoized.** Nothing is constructed until something resolves it, and the result is cached. There is no eager instantiation pass.

**The nearest provider owns the instance.** A token is built and cached by the closest container that provides it; without a local provider the lookup walks to the parent, so a class with no provider anywhere ends up at the root and is shared. A child therefore owns — and disposes — only what it provides itself, and never mutates its parent.

**Register before you resolve.** `provide()` may replace a factory that has not been used yet, but replacing one whose instance this container already handed out raises `ProviderConflictError`: the cached instance would keep winning and the new factory would never run. To override a token, including with a test double, use `child()` — and remember the nearest-provider rule: a class the child does not provide is still built and cached by the root, override or not.

```ts
const test = container.child();
test.provide(Config, () => ({ url: "postgres://test" }));
test.provide(Db, () => new Db()); // without this, Db resolves at the root and never sees the override

const db = test.resolve(Db); // built by `test`, injects the test Config, disposed with `test`
```

**Cycles are reported, not tolerated.** `a → b → a` inside one container raises `ResolutionError` naming the token, rather than overflowing the stack. The guard is per container, so a child may legitimately construct its own instance of a token an ancestor is also building — that is how a child decorates an ancestor's implementation.

**There is no startup or readiness barrier.** The container has no `start()`, never orders initialization for you, and exposes no `isReady`. Order initialization with ordinary awaited code before the work that depends on it, and run anything long-lived as your own Runner job.

## Errors

| Error                   | Raised when                                                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `ResolutionError`       | A token has no provider (`reason: "missing-provider"`) or participates in a cycle (`reason: "circular-dependency"`). Carries `token`. |
| `ProviderConflictError` | `provide()` would replace a provider whose instance was already handed out. Carries `token`.                                          |
| `ContainerClosedError`  | A container is used while `closing` or after it is `disposed`. Carries `state`.                                                       |
| `DisposalConflictError` | A value declares two cleanup protocols, or an explicit disposer targets an already-owned value. Carries `reason`.                     |

Exceptions thrown by your own factories propagate unchanged.
