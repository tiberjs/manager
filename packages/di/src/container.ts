import { ContainerClosedError, ProviderConflictError, ResolutionError } from "./errors.js";
import { ResolutionTracker, type ResolutionGraph } from "./resolution-graph.js";
import { ResourceLifecycle } from "./resources.js";
import type { Factory, InjectionToken } from "./tokens.js";

/**
 * A hierarchical dependency container and resource owner.
 *
 * Child containers resolve ancestor providers while retaining ownership of
 * their own resources. Initialization ordering belongs to the caller; a
 * container only constructs, caches, and disposes.
 */
export class Container {
  readonly #parent: Container | undefined;
  readonly #root: Container;
  #graph: ResolutionTracker | undefined;
  #resources: ResourceLifecycle | undefined;
  #instances: Map<InjectionToken<unknown>, unknown> | undefined;
  #factories: Map<InjectionToken<unknown>, Factory<unknown>> | undefined;
  #resolving: Set<InjectionToken<unknown>> | undefined;
  #disposePromise: Promise<void> | undefined;
  #disposed = false;

  constructor(parent?: Container) {
    this.#parent = parent;
    this.#root = parent ? parent.#root : this;
  }

  get #resourceLifecycle(): ResourceLifecycle {
    if (!this.#resources) {
      this.#assertNotDisposed();
      this.#resources = new ResourceLifecycle(this, this.#root);
    }
    return this.#resources;
  }

  get #resolutionTracker(): ResolutionTracker | undefined {
    if (this.#root.#disposed || this.#root.#resources?.disposed) {
      return undefined;
    }

    return (this.#root.#graph ??= new ResolutionTracker());
  }

  /** A child container resolves application singletons through its parent. */
  child(): Container {
    this.#assertOpen();
    return new Container(this);
  }

  /** Includes failed attempts and active children, but never disposed containers. */
  resolutionGraph(): ResolutionGraph {
    return this.#root.#graph?.snapshot() ?? { nodes: [], edges: [] };
  }

  /**
   * Register a provider before the token is resolved here. Replacing a factory
   * whose instance this container already handed out is rejected, because the
   * cached instance would silently win; override in a child container instead.
   */
  provide<T>(token: InjectionToken<T>, factory: Factory<T>): void {
    this.#assertOpen();
    if (this.#instances?.has(token)) {
      throw new ProviderConflictError(token);
    }
    (this.#factories ??= new Map()).set(token, factory as Factory<unknown>);
  }

  has(token: InjectionToken<unknown>): boolean {
    return (
      (this.#instances?.has(token) ?? false) ||
      (this.#factories?.has(token) ?? false) ||
      (this.#parent?.has(token) ?? false)
    );
  }

  /** Resolve local cache/provider, then ancestors; default classes live at root. */
  resolve<T>(token: InjectionToken<T>): T {
    this.#assertNotDisposed();
    if (this.#instances?.has(token)) {
      this.#resolutionTracker?.record(this, token);
      return this.#instances.get(token) as T;
    }

    // Ancestors own their own admission; a closing child may still read singletons.
    if (!this.#factories?.has(token) && this.#parent) {
      return this.#parent.resolve(token);
    }
    this.#assertOpen();

    return this.#acquire(token, () => {
      const factory = this.#factories?.get(token);
      if (factory) {
        return factory(this) as T;
      }
      if (typeof token === "function") {
        return new token();
      }

      throw new ResolutionError("missing-provider", token);
    });
  }

  /**
   * Acquire inline resources once per container, with explicit or automatic
   * disposal. Like a provider factory, `factory` receives this container.
   */
  use<T>(
    token: InjectionToken<T>,
    factory: Factory<T>,
    dispose?: (value: T) => unknown | Promise<unknown>,
  ): T {
    this.#assertNotDisposed();
    if (this.#instances?.has(token)) {
      this.#resolutionTracker?.record(this, token);
      return this.#instances.get(token) as T;
    }

    this.#assertOpen();
    return this.#acquire(token, factory, dispose);
  }

  /** Register LIFO cleanup, including cleanup acquired during teardown itself. */
  defer(cleanup: () => unknown | Promise<unknown>): void {
    this.#resourceLifecycle.defer(cleanup);
  }

  /**
   * Close an untouched container without allocating an asynchronous disposal
   * barrier. Returns false without mutation if resources or instances exist;
   * await asynchronous disposal instead. Repeated synchronous disposal of an
   * untouched container is safe.
   */
  disposeSync(): boolean {
    if (this.#resources || this.#instances) {
      return false;
    }
    if (!this.#disposed) {
      this.#clearResolution();
    }
    return true;
  }

  /** Close acquisition synchronously, then clear resolution storage after teardown. */
  [Symbol.asyncDispose](): Promise<void> {
    if (this.#disposed && !this.#resources) {
      return (this.#disposePromise ??= Promise.resolve());
    }
    if (this.#disposePromise) {
      return this.#disposePromise;
    }

    this.#disposePromise = this.#resourceLifecycle.close().finally(() => {
      this.#clearResolution();
    });

    return this.#disposePromise;
  }

  #assertNotDisposed(): void {
    if (this.#disposed) {
      throw new ContainerClosedError("disposed");
    }
    this.#resources?.assertNotDisposed();
  }

  #assertOpen(): void {
    if (this.#disposed) {
      throw new ContainerClosedError("disposed");
    }
    this.#resources?.assertOpen();
  }

  #clearResolution(): void {
    this.#disposed = true;
    this.#instances = undefined;
    this.#factories = undefined;
    this.#resolving = undefined;

    if (this === this.#root) {
      this.#graph = undefined;
    } else {
      this.#root.#graph?.remove(this);
    }
  }

  #acquire<T>(
    token: InjectionToken<T>,
    factory: Factory<T>,
    dispose?: (value: T) => unknown | Promise<unknown>,
  ): T {
    const graph = this.#resolutionTracker;
    const id = graph?.record(this, token);
    const resolving = (this.#resolving ??= new Set());
    if (resolving.has(token)) {
      throw new ResolutionError("circular-dependency", token);
    }

    resolving.add(token);
    if (id !== undefined) {
      graph!.stack.push(id);
    }

    try {
      const value = this.#resourceLifecycle.construct(factory, dispose);
      (this.#instances ??= new Map()).set(token, value);

      return value;
    } finally {
      resolving.delete(token);
      if (id !== undefined) {
        graph!.stack.pop();
      }
    }
  }
}
