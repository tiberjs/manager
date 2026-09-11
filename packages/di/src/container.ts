import { ContainerClosedError, ResolutionError } from "./errors.js";
import { ResolutionTracker, type ResolutionGraph } from "./resolution/graph.js";
import { ResolutionPath } from "./resolution/path.js";
import { ProviderRegistry } from "./resolution/providers.js";
import { ResourceOwner } from "./resources/owner.js";
import { OwnershipRegistry } from "./resources/ownership.js";
import type { Factory, InjectionToken } from "./tokens.js";

/**
 * How far this container has travelled through its own teardown. `closing`
 * lasts from the first asynchronous disposal until that drain settles;
 * synchronous disposal of an untouched container skips straight to `disposed`.
 */
type ContainerPhase = "open" | "closing" | "disposed";

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
  /** Shared with the whole tree: one construction chain, cycles and all. */
  readonly #path: ResolutionPath;
  /** Diagnostics live on the root; a child records into its root's tracker. */
  #graph: ResolutionTracker | undefined;
  #resources: ResourceOwner | undefined;
  /** The single asynchronous teardown every later caller joins. */
  #disposal: Promise<void> | undefined;
  #phase: ContainerPhase = "open";

  constructor(parent?: Container) {
    this.#parent = parent;
    this.#root = parent ? parent.#root : this;
    this.#path = parent ? parent.#path : new ResolutionPath();
  }

  get #owner(): ResourceOwner {
    if (!this.#resources) {
      // Teardown still registers cleanup, but a drained container never again
      // builds an owner whose queue nothing would drain.
      this.#admitRetainedAccess();
      this.#resources = new ResourceOwner(this, OwnershipRegistry.forRoot(this.#root));
    }
    return this.#resources;
  }

  /** Undefined once the root is gone, so a surviving child cannot repopulate it. */
  get #tracker(): ResolutionTracker | undefined {
    if (this.#root.#phase === "disposed") {
      return undefined;
    }

    return (this.#root.#graph ??= new ResolutionTracker());
  }

  /** A child container resolves application singletons through its parent. */
  child(): Container {
    this.#admitNewAcquisition();
    return new Container(this);
  }

  /** Includes failed attempts and active children, but never disposed containers. */
  resolutionGraph(): ResolutionGraph {
    return this.#root.#graph?.snapshot() ?? { nodes: [], edges: [] };
  }

  /** Register a provider before the token is resolved here. */
  provide<T>(token: InjectionToken<T>, factory: Factory<T>): void {
    this.#admitNewAcquisition();
    this.#providers.provide(token, factory);
  }

  has(token: InjectionToken<unknown>): boolean {
    return this.#providers.has(token) || (this.#parent?.has(token) ?? false);
  }

  /** Resolve local cache/provider, then ancestors; default classes live at root. */
  resolve<T>(token: InjectionToken<T>): T {
    if (this.#providers.hasInstance(token)) {
      this.#admitRetainedAccess();
      this.#tracker?.record(this, token, this.#path.current);

      return this.#providers.instance(token);
    }

    // Ancestors own their own admission; a closing child may still read singletons.
    if (!this.#providers.hasFactory(token) && this.#parent) {
      this.#admitRetainedAccess();
      return this.#parent.resolve(token);
    }

    this.#admitNewAcquisition();

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
    if (this.#providers.hasInstance(token)) {
      this.#admitRetainedAccess();
      this.#tracker?.record(this, token, this.#path.current);

      return this.#providers.instance(token);
    }

    this.#admitNewAcquisition();

    return this.#acquire(token, factory, dispose);
  }

  /**
   * Register LIFO cleanup, including cleanup acquired during teardown itself.
   *
   * Deliberately blind to the container phase: a resource released mid-drain
   * may still register its own cleanup, and only the queue knows whether it
   * has anything left to run.
   */
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
    if (this.#phase !== "disposed") {
      this.#clearResolution();
    }
    return true;
  }

  /** Close acquisition synchronously, then clear resolution storage after teardown. */
  [Symbol.asyncDispose](): Promise<void> {
    if (this.#phase === "open") {
      this.#phase = "closing";
      this.#disposal = this.#owner.close().finally(() => {
        this.#clearResolution();
      });
    }

    // Already disposed without a drain: the outcome is a settled join point too.
    return (this.#disposal ??= Promise.resolve());
  }

  /** What this container already holds stays readable until the drain settles. */
  #admitRetainedAccess(): void {
    if (this.#phase === "disposed") {
      throw new ContainerClosedError("disposed");
    }
  }

  /** Providers, children, and construction stop the moment teardown begins. */
  #admitNewAcquisition(): void {
    const phase = this.#phase;
    if (phase !== "open") {
      throw new ContainerClosedError(phase);
    }
  }

  #clearResolution(): void {
    this.#phase = "disposed";
    this.#providers.clear();

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
    // A cycle is still an attempt worth reporting, so record before guarding.
    this.#tracker?.record(this, token, this.#path.current);
    this.#path.enter(this, token);

    try {
      const value = this.#owner.construct(factory, dispose);
      this.#providers.cache(token, value);

      return value;
    } finally {
      this.#path.exit();
    }
  }
}
