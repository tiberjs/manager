import { combinedError } from "@tiberjs/runner";
import type { Cleanup } from "./cleanup-protocol.js";
import { ContainerClosedError } from "./errors.js";

/** Runs one cleanup callback with the owner's ambient binding installed. */
export type CleanupInvoker = (cleanup: Cleanup) => unknown;

/**
 * LIFO cleanup storage drained exactly once.
 *
 * Knows nothing about containers or ambient state: every callback runs through
 * the invoker its owner supplied.
 */
export class DisposalQueue {
  #cleanups: Cleanup[] | undefined;
  #closing: Promise<void> | undefined;
  #disposed = false;

  constructor(private readonly invoke: CleanupInvoker) {}

  get closing(): boolean {
    return this.#closing !== undefined;
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  /** Cleanup registered while draining is drained too, still LIFO. */
  defer(cleanup: Cleanup): void {
    if (this.#disposed) {
      throw new ContainerClosedError("disposed");
    }
    (this.#cleanups ??= []).push(cleanup);
  }

  /** Every caller joins the single drain and observes its outcome. */
  close(): Promise<void> {
    if (this.#closing) {
      return this.#closing;
    }

    const { promise, resolve, reject } = Promise.withResolvers<void>();
    this.#closing = promise;
    void this.#drain().then(resolve, reject);

    return promise;
  }

  async #drain(): Promise<void> {
    // Yield past a synchronous factory that initiated disposal before returning its resource.
    await Promise.resolve();

    const errors: unknown[] = [];
    while (this.#cleanups?.length) {
      try {
        await this.invoke(this.#cleanups.pop()!);
      } catch (error) {
        errors.push(error);
      }
    }

    this.#disposed = true;
    this.#cleanups = undefined;

    // Independent failures keep their identity, in drain order.
    if (errors.length) {
      throw combinedError(errors, "Errors during disposal.");
    }
  }
}
