import { AsyncLocalStorage } from "node:async_hooks";
import { combinedError } from "@tiberjs/runner";
import type { Container } from "./container.js";
import { ContainerClosedError, DisposalConflictError } from "./errors.js";

type Cleanup = () => unknown | Promise<unknown>;

/** Structural resource hook. Do not combine onClose with a symbol disposer. */
export interface ContainerObject {
  onClose?(): unknown | Promise<unknown>;
}

/** The container active during resource construction or teardown. */
export const activeContainer = new AsyncLocalStorage<Container>();

type ResourceOwners = WeakMap<object, ResourceLifecycle | { rejected: unknown }>;

// Surviving children share ownership without initializing a closed parent's lifecycle.
const ownershipByRoot = new WeakMap<Container, ResourceOwners>();

/** LIFO resource ownership and disposal; no dependency resolution. */
export class ResourceLifecycle {
  #disposers: Cleanup[] | undefined;
  /** Lazily cached ownership shared by every lifecycle in the container tree. */
  #ownership: ResourceOwners | undefined;
  #closing: Promise<void> | undefined;
  #disposed = false;

  constructor(
    private readonly container: Container,
    private readonly root: Container,
  ) {}

  get #owners(): ResourceOwners {
    if (!this.#ownership) {
      let owners = ownershipByRoot.get(this.root);
      if (!owners) {
        owners = new WeakMap();
        ownershipByRoot.set(this.root, owners);
      }
      this.#ownership = owners;
    }
    return this.#ownership;
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  assertOpen(): void {
    if (this.#closing) {
      throw new ContainerClosedError(this.#disposed ? "disposed" : "closing");
    }
  }

  assertNotDisposed(): void {
    if (this.#disposed) {
      throw new ContainerClosedError("disposed");
    }
  }

  defer(cleanup: Cleanup): void {
    this.assertNotDisposed();
    (this.#disposers ??= []).push(cleanup);
  }

  /** Construct with ambient resolution bound, then take disposal ownership. */
  construct<T>(
    factory: (container: Container) => T,
    dispose?: (value: T) => unknown | Promise<unknown>,
  ): T {
    const value = activeContainer.run(this.container, factory, this.container);
    this.#adopt(value, dispose);

    return value;
  }

  close(): Promise<void> {
    if (this.#closing) {
      return this.#closing;
    }

    const { promise, resolve, reject } = Promise.withResolvers<void>();
    this.#closing = promise;
    void this.#dispose().then(resolve, reject);

    return promise;
  }

  async #dispose(): Promise<void> {
    // Yield past a synchronous factory that initiated disposal before returning its resource.
    await Promise.resolve();

    const errors: unknown[] = [];
    while (this.#disposers?.length) {
      try {
        await activeContainer.run(this.container, this.#disposers.pop()!);
      } catch (error) {
        errors.push(error);
      }
    }

    this.#disposed = true;
    this.#disposers = undefined;

    if (errors.length) {
      throw combinedError(errors, "Errors during disposal.");
    }
  }

  #adopt<T>(value: T, explicitDispose?: (value: T) => unknown | Promise<unknown>): void {
    if (value === null || (typeof value !== "object" && typeof value !== "function")) {
      if (explicitDispose) {
        this.defer(() => explicitDispose(value));
      }
      return;
    }

    const owners = this.#owners;
    const owner = owners.get(value);
    if (owner) {
      if (!(owner instanceof ResourceLifecycle)) {
        throw owner.rejected;
      }
      if (!owner.#disposed) {
        if (explicitDispose) {
          throw new DisposalConflictError("already-owned");
        }
        return;
      }
    }

    const asyncDispose = (value as Partial<AsyncDisposable>)[Symbol.asyncDispose];
    const dispose = (value as Partial<Disposable>)[Symbol.dispose];
    const onClose = (value as ContainerObject).onClose;
    const symbolDispose = typeof asyncDispose === "function" ? asyncDispose : dispose;
    // Preserve cleanup even if hook admission fails. On a conflicting shape the symbol
    // protocol wins solely for rollback; the object is never returned to its consumer.
    const cleanup = explicitDispose
      ? () => explicitDispose(value)
      : typeof symbolDispose === "function"
        ? () => symbolDispose.call(value)
        : typeof onClose === "function"
          ? () => onClose.call(value)
          : undefined;
    if (cleanup) {
      this.defer(cleanup);
      owners.set(value, this);
    }

    // An explicit disposer is the caller's override for third-party shapes.
    if (!explicitDispose && typeof onClose === "function" && typeof symbolDispose === "function") {
      const conflict = new DisposalConflictError("multiple-hooks");
      // Cache the rejection so every later alias of this shape fails identically.
      owners.set(value, { rejected: conflict });
      throw conflict;
    }
  }
}
