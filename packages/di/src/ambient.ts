import { contextKey, peekState, provide, withContext, type ContextKey } from "@tiberjs/runner";
import type { RuntimeState } from "@tiberjs/runner";
import type { Container } from "./container.js";
import { activeContainer } from "./resources/active-container.js";
import type { Factory, InjectionToken } from "./tokens.js";

/** The execution-context binding that carries a container across executions. */
export const ContainerKey: ContextKey<Container> = contextKey<Container>("di.container");

/** The root a host's execution scope is created from. */
export const scopeRoot: unique symbol = Symbol("di.scope-root");
/** The execution scope itself, created on the host the first time it is needed. */
export const executionScope: unique symbol = Symbol("di.execution-scope");

/**
 * A runner attachment that hosts one execution's scope.
 *
 * The host declares `[scopeRoot]`; the scope is `root.child()`, created on
 * the host by the first `currentContainer()`, `scoped()`, or `onDispose()`
 * and disposed by whoever owns the host. An execution that only resolves
 * through `inject()` never creates one. An explicit `ContainerKey` binding
 * takes precedence over the host.
 */
export interface ScopeHost {
  readonly [scopeRoot]: Container;
  [executionScope]?: Container;
}

/** A host is recognized by the declared slot, not by whether a scope exists yet. */
function hostOf(state: RuntimeState): ScopeHost | undefined {
  const attachment = state.context.attachment;
  return typeof attachment === "object" && attachment !== null && scopeRoot in attachment
    ? (attachment as ScopeHost)
    : undefined;
}

function noContainer(): never {
  throw new Error(
    "No active container. This API requires construction, disposal, withContainer(), an execution bound to ContainerKey, or a ScopeHost attachment.",
  );
}

/**
 * The container ambient to this call, in precedence order: the one currently
 * constructing, an explicit `ContainerKey` binding, then the scope host.
 *
 * On a host, `create` decides what a missing scope means: a caller that may
 * register into the container needs the scope to exist; a caller that only
 * resolves does not, because a scope resolves through its root anyway.
 */
function ambientContainer(create: boolean): Container {
  const constructing = activeContainer.getStore();
  if (constructing) {
    return constructing;
  }
  const state = peekState();
  if (!state) {
    noContainer();
  }
  const bound = state.context.values.get(ContainerKey.id) as Container | undefined;
  if (bound) {
    return bound;
  }
  const host = hostOf(state);
  if (!host) {
    noContainer();
  }
  if (create) {
    return (host[executionScope] ??= host[scopeRoot].child());
  }
  return host[executionScope] ?? host[scopeRoot];
}

/** The ambient container, created on a host if it does not exist yet. */
export function currentContainer(): Container {
  return ambientContainer(true);
}

/** Resolve a dependency in the ambient container without creating a host's scope. */
export function inject<T>(token: InjectionToken<T>): T {
  return ambientContainer(false).resolve(token);
}

/** Acquire a resource once per container and release it when that container closes. */
export function scoped<T>(
  token: InjectionToken<T>,
  factory: Factory<T>,
  dispose?: (value: T) => unknown | Promise<unknown>,
): T {
  return currentContainer().use(token, factory, dispose);
}

/** Register LIFO cleanup in the ambient container. */
export function onDispose(cleanup: () => unknown | Promise<unknown>): void {
  currentContainer().defer(cleanup);
}

/**
 * Bind `container` as the ambient container for `handler`.
 *
 * The binding is always installed locally, so nested calls override an outer
 * construction container. With an active execution it is additionally published
 * on the context so derived executions observe the same container.
 */
export function withContainer<T>(container: Container, handler: () => T): T {
  if (peekState()) {
    return withContext([provide(ContainerKey, container)], () =>
      activeContainer.run(container, handler),
    );
  }

  return activeContainer.run(container, handler);
}
