import { combinedError } from "@tiberjs/runner";
import { ContainerClosedError } from "../errors.js";
import type { Cleanup } from "./cleanup.js";

/** Runs one cleanup callback with the owner's ambient binding installed. */
export type CleanupInvoker = (cleanup: Cleanup) => unknown;

/**
 * LIFO cleanup storage for one owner, drained once. Knows nothing about
 * containers: every callback runs through the invoker its owner supplied.
 */
export class DisposalQueue {
  #cleanups: Cleanup[] | undefined;
  #drained = false;

  constructor(private readonly invoke: CleanupInvoker) {}

  /** Cleanup registered while draining is drained too; after that nothing would run it. */
  defer(cleanup: Cleanup): void {
    if (this.#drained) {
      throw new ContainerClosedError("disposed");
    }
    (this.#cleanups ??= []).push(cleanup);
  }

  /** Drains in reverse registration order, retaining independent failures. */
  async close(): Promise<void> {
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

    this.#drained = true;
    this.#cleanups = undefined;

    // Independent failures keep their identity, in drain order.
    if (errors.length) {
      throw combinedError(errors, "Errors during disposal.");
    }
  }
}
