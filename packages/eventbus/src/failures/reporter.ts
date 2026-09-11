import { combinedError } from "@tiberjs/runner";
import type { EventBusOptions } from "../types.js";

/**
 * Routes the failures one emission collected, never back at the publisher.
 * Without a reporter a failure is surfaced as an unhandled error, loudly on
 * purpose: an owner of a long-lived bus is expected to supply `onError`.
 */
export class FailureReporter {
  readonly #onError: EventBusOptions["onError"];

  constructor(options?: EventBusOptions) {
    const onError = options?.onError;
    if (onError !== undefined && typeof onError !== "function") {
      throw new TypeError("EventBus onError must be a function.");
    }

    this.#onError = onError;
  }

  /** Reports once per emission: a sole failure by identity, several aggregated. */
  report(event: string, failures: readonly unknown[]): void {
    const failure = combinedError(failures, "Event listener failed.");
    if (!this.#onError) {
      reportAsynchronously(failure);
      return;
    }

    try {
      this.#onError(failure, { event });
    } catch (reporterError) {
      // A broken reporter cannot be trusted to have observed the failure, so
      // both surface asynchronously rather than reaching the publisher.
      reportAsynchronously(failure);
      reportAsynchronously(reporterError);
    }
  }
}

function reportAsynchronously(error: unknown): void {
  // Reaches Node as an uncaught exception instead of being swallowed.
  queueMicrotask(() => {
    throw error;
  });
}
