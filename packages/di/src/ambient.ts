import { contextKey, peekState, provide, withContext, type ContextKey } from "@tiberjs/runner";
import { activeContainer } from "./active-container.js";
import type { Container } from "./container.js";
import type { Factory, InjectionToken } from "./tokens.js";

/** The execution-context binding that carries a container across executions. */
export const ContainerKey: ContextKey<Container> = contextKey<Container>("di.container");

/** Construction container first, otherwise the current execution's binding. */
export function currentContainer(): Container {
  const constructing = activeContainer.getStore();
  if (constructing) {
    return constructing;
  }

  // One state read and one frame walk: inject() runs on request paths, and a
  // bound container is never undefined, so absence needs no separate probe.
  const bound = peekState()?.context.values.get(ContainerKey.id) as Container | undefined;
  if (!bound) {
    throw new Error(
      "No active container. This API requires construction, disposal, withContainer(), or an execution bound to ContainerKey.",
    );
  }

  return bound;
}

/** Resolve a dependency during construction or inside a bound execution. */
export function inject<T>(token: InjectionToken<T>): T {
  return currentContainer().resolve(token);
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
