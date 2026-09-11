/** The public contracts of a bus: its listeners, its options, and its diagnostics. */

/**
 * A subscriber. Delivery is synchronous and inline on the publisher's call
 * chain, so a listener that needs to await forks its own job instead.
 */
export type EventListener<T> = (event: T) => undefined;

export interface EventBusOptions {
  /**
   * Receives one report per emission, after every listener ran; the publisher
   * never sees it. Without a reporter a listener failure surfaces as an
   * unhandled error. A non-function rejects construction with a `TypeError`.
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
