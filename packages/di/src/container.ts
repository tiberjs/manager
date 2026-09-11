import { ContainerClosedError, ResolutionError } from "./errors.js";
import { OwnershipRegistry } from "./ownership.js";
import { ProviderRegistry } from "./provider-registry.js";
import { ResolutionCycle } from "./resolution-cycle.js";
import { ResolutionTracker, type ResolutionGraph } from "./resolution-graph.js";
import { ResourceOwner } from "./resource-owner.js";
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
  readonly #providers = new ProviderRegistry();
  readonly #cycle = new ResolutionCycle();
  /** Diagnostics live on the root; a child records into its root's tracker. */
  #graph: ResolutionTracker | undefined;
  #resources: ResourceOwner | undefined;
  #disposePromise: Promise<void> | undefined;
  #disposed = false;

  constructor(parent?: Container) {
    this.#parent = parent;
    this.#root = parent ? parent.#root : this;
  }

  get #owner(): ResourceOwner {
    if (!this.#resources) {
      this.#assertNotDisposed();
      this.#resources = new ResourceOwner(this, OwnershipRegistry.forRoot(this.#root));
    }
    return this.#resources;
  }

  /** Undefined once the root is gone, so a surviving child cannot repopulate it. */
  get #tracker(): ResolutionTracker | undefined {
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

  /** Register a provider before the token is resolved here. */
  provide<T>(token: InjectionToken<T>, factory: Factory<T>): void {
    this.#assertOpen();
    this.#providers.provide(token, factory);
  }

  has(token: InjectionToken<unknown>): boolean {
    return this.#providers.has(token) || (this.#parent?.has(token) ?? false);
  }

  /** Resolve local cache/provider, then ancestors; default classes live at root. */
  resolve<T>(token: InjectionToken<T>): T {
    this.#assertNotDisposed();
    if (this.#providers.hasInstance(token)) {
      this.#tracker?.record(this, token);
      return this.#providers.instance(token);
    }

    // Ancestors own their own admission; a closing child may still read singletons.
    if (!this.#providers.hasFactory(token) && this.#parent) {
      return this.#parent.resolve(token);
    }
    this.#assertOpen();

    return this.#acquire(token, () => {
      const factory = this.#providers.factory(token);
      if (factory) {
        return factory(this);
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
    if (this.#providers.hasInstance(token)) {
      this.#tracker?.record(this, token);
      return this.#providers.instance(token);
    }

    this.#assertOpen();
    return this.#acquire(token, factory, dispose);
  }

  /** Register LIFO cleanup, including cleanup acquired during teardown itself. */
  defer(cleanup: () => unknown | Promise<unknown>): void {
    this.#owner.defer(cleanup);
  }

  /**
   * Close an untouched container without allocating an asynchronous disposal
   * barrier. Returns false without mutation if resources or instances exist;
   * await asynchronous disposal instead. Repeated synchronous disposal of an
   * untouched container is safe.
   */
  disposeSync(): boolean {
    if (this.#resources || this.#providers.hasInstances) {
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

    this.#disposePromise = this.#owner.close().finally(() => {
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
    this.#providers.clear();
    this.#cycle.clear();

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
    const graph = this.#tracker;
    // A cycle is still an attempt worth reporting, so record before guarding.
    graph?.record(this, token);
    this.#cycle.enter(token);
    graph?.enter(this, token);

    try {
      const value = this.#owner.construct(factory, dispose);
      this.#providers.cache(token, value);

      return value;
    } finally {
      this.#cycle.exit(token);
      graph?.exit();
    }
  }
}
