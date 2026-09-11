import { activeContainer } from "./active-container.js";
import { type Cleanup, planCleanup } from "./cleanup-protocol.js";
import type { Container } from "./container.js";
import { DisposalQueue } from "./disposal-queue.js";
import { ContainerClosedError, DisposalConflictError } from "./errors.js";
import type { DisposalOwner, OwnershipRegistry } from "./ownership.js";

/**
 * The resources one container owns: it binds the ambient container around
 * construction and teardown, claims each constructed value at most once, and
 * releases what it claimed in LIFO order. It resolves nothing.
 */
export class ResourceOwner implements DisposalOwner {
  readonly #queue: DisposalQueue;

  constructor(
    private readonly container: Container,
    private readonly ownership: OwnershipRegistry,
  ) {
    this.#queue = new DisposalQueue((cleanup) => activeContainer.run(container, cleanup));
  }

  get disposed(): boolean {
    return this.#queue.disposed;
  }

  /** Teardown has begun: no further resource may be admitted. */
  assertOpen(): void {
    if (this.#queue.closing) {
      throw new ContainerClosedError(this.#queue.disposed ? "disposed" : "closing");
    }
  }

  assertNotDisposed(): void {
    if (this.#queue.disposed) {
      throw new ContainerClosedError("disposed");
    }
  }

  defer(cleanup: Cleanup): void {
    this.#queue.defer(cleanup);
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
    return this.#queue.close();
  }

  #adopt<T>(value: T, explicitDispose?: (value: T) => unknown | Promise<unknown>): void {
    if (value === null || (typeof value !== "object" && typeof value !== "function")) {
      if (explicitDispose) {
        this.defer(() => explicitDispose(value));
      }
      return;
    }

    const target = value as object;
    if (this.ownership.liveOwner(target)) {
      // An alias of a live resource borrows it; a second disposer would double-release.
      if (explicitDispose) {
        throw new DisposalConflictError("already-owned");
      }
      return;
    }

    const plan = planCleanup(value, explicitDispose);
    if (plan.cleanup) {
      this.defer(plan.cleanup);
      this.ownership.claim(target, this);
    }
    // Registered cleanup above survives refusal, because the value is never returned.
    if (plan.conflict) {
      this.ownership.reject(target, plan.conflict);
      throw plan.conflict;
    }
  }
}
