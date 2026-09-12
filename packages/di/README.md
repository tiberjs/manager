# @tiberjs/di

A hierarchical dependency container. It builds objects on demand, caches each one, and disposes what it built when the container closes.

Requires **Node.js 24+**.

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
```

`Db` never mentions the container: `inject()` reads whichever container is constructing the object, and `onDispose()` registers cleanup with that same one.

## The four things you will do

**Register a value or interface.** A class needs no registration — it is its own token.

```ts
container.provide(Config, () => loadConfig());
```

**Resolve.** Constructed on first use, cached after that.

```ts
const db = container.resolve(Db);
```

**Scope.** A child sees its parent's providers and disposes only what it built itself.

```ts
const request = container.child();
request.provide(CurrentUser, () => user);
```

**Dispose.** `await using`, or `await container[Symbol.asyncDispose]()`. Cleanup runs in reverse construction order.

## Three things that will bite you

**A token is built by the nearest container that provides it.** A class nobody provides ends up at the root and is shared. So overriding `Config` in a child does not change a `Db` the root already owns — provide `Db` in the child too:

```ts
const test = container.child();
test.provide(Config, () => ({ url: "postgres://test" }));
test.provide(Db, () => new Db()); // without this, Db stays the root's
```

**Register before you resolve.** Replacing a provider whose instance this container already handed out raises `ProviderConflictError`, because the cached instance would keep winning. Override in a child instead.

**`inject()` needs an ambient container.** It works while an object is being constructed or disposed, inside `withContainer()`, inside a Runner execution bound to `ContainerKey`, and inside an execution whose attachment is a `ScopeHost`. A method called later with none of those raises. Capture what you need during construction, or use `container.resolve()` directly.

## API

### Tokens

|                         |                                                                            |
| ----------------------- | -------------------------------------------------------------------------- |
| `token<T>(description)` | A typed token for a value or interface. Same description, different token. |
| a class                 | Its own token, default-constructed when nothing provides it.               |

### `Container`

|                                 |                                                                                            |
| ------------------------------- | ------------------------------------------------------------------------------------------ |
| `provide(token, factory)`       | Register a factory; it receives the resolving container.                                   |
| `resolve(token)`                | Cached instance, or construct once and cache.                                              |
| `use(token, factory, dispose?)` | Acquire an inline resource once per container, with optional explicit cleanup.             |
| `defer(cleanup)`                | Register cleanup, including during this container's own teardown.                          |
| `child()`                       | A container that resolves through this one.                                                |
| `has(token)`                    | An explicit provider or a cached instance here or above — `false` for an unprovided class. |
| `resolutionGraph()`             | Who resolved what in this tree, for diagnostics.                                           |
| `disposeSync()`                 | Close a container that built nothing, without an `await`; `false` if it holds anything.    |

### Ambient access

Each reads the ambient container, so classes stay free of container plumbing. The container is found in this order: the one currently constructing, an explicit `ContainerKey` binding, then the execution's scope host.

|                                     |                                                                                           |
| ----------------------------------- | ----------------------------------------------------------------------------------------- |
| `inject(token)`                     | Resolve. On a host, resolves through the scope if one exists, otherwise the root.         |
| `scoped(token, factory, dispose?)`  | Acquire an inline resource in the ambient container, creating the host's scope if needed. |
| `onDispose(cleanup)`                | Register cleanup in the ambient container, creating the host's scope if needed.           |
| `currentContainer()`                | The ambient container; creates the host's scope; raises when there is none.               |
| `withContainer(container, handler)` | Run `handler` with `container` ambient. Overrides a host.                                 |
| `ContainerKey`                      | Runner context key, for binding a container to an execution yourself.                     |

### Scope host

A framework that runs many short executions gives each one a scope without paying for it up front: its Runner attachment declares `[scopeRoot]`, and the scope — `root.child()` — is created on the attachment by the first `currentContainer()`, `scoped()`, or `onDispose()`. An execution that only calls `inject()` never creates one. Whoever owns the attachment disposes `[executionScope]` when the execution ends.

```ts
import { executionScope, scopeRoot, type ScopeHost } from "@tiberjs/di";

class RequestContext implements ScopeHost {
  readonly [scopeRoot] = app.container;
  [executionScope]: Container | undefined = undefined;
}

// later, when the request ends:
await context[executionScope]?.[Symbol.asyncDispose]();
```

## Cleanup

For each constructed value, the first of: the `dispose` you passed, `Symbol.asyncDispose`/`Symbol.dispose`, `onClose()`. A value with none is just cached.

All cleanups run even if some fail; one failure is rethrown as-is, several arrive as an `AggregateError`.

## Errors

|                         |                                                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------------------------------ |
| `ResolutionError`       | No provider, or a cycle. Carries `reason` and `token`.                                                       |
| `ProviderConflictError` | `provide()` after that token was resolved here. Carries `token`.                                             |
| `ContainerClosedError`  | Used while `closing` or after `disposed`. Carries `state`.                                                   |
| `DisposalConflictError` | Two cleanup protocols on one value, or an explicit disposer for a value someone else owns. Carries `reason`. |

Errors from your own factories propagate unchanged.
