/** The public contracts of a bus: its listeners, its options, and its diagnostics. */

/**
 * A subscriber. Notifications are delivered synchronously, inline on the
 * publisher's call chain, and cannot return asynchronous work: a listener that
 * needs to await forks its own caller-owned job.
 */
export type EventListener<T> = (event: T) => undefined;

export interface EventBusOptions {
  /**
   * Receives one failure per emission, after every listener ran, never the
   * publisher. Synchronous diagnostics; any asynchronous work remains
   * caller-owned. Without it a listener failure surfaces as an unhandled error,
   * so an owner of a long-lived bus is expected to supply it. A value that is
   * not a function rejects construction with a `TypeError`.
   */
  readonly onError?: (error: unknown, context: EventErrorContext) => undefined;
}

/** Details identifying a failed event delivery. */
export interface EventErrorContext {
  readonly event: string;
}

export interface EventSubscribeOptions {
  /** Aborting unsubscribes. An already-aborted signal subscribes nothing. */
  readonly signal?: AbortSignal;
}
