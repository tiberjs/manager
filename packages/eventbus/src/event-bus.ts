import { addAbortListener } from "node:events";
import { LifecycleStateError, combinedError } from "@tiberjs/runner";
import type { EventKey } from "./event-key.js";

/** Notifications are delivered synchronously and cannot return asynchronous work. */
export type EventListener<T> = (event: T) => undefined;

/** Details identifying a failed event delivery. */
export interface EventErrorContext {
  readonly event: string;
}

export interface EventBusOptions {
  /** Synchronous diagnostics; any asynchronous work remains caller-owned. */
  readonly onError?: (error: unknown, context: EventErrorContext) => undefined;
}

export interface EventSubscribeOptions {
  /** Aborting unsubscribes. An already-aborted signal subscribes nothing. */
  readonly signal?: AbortSignal;
}

type Subscription = {
  readonly listener: EventListener<never>;
  /** Abort registration owned by this subscription; released by either removal path. */
  abort: Disposable | undefined;
};

const noop = (): void => {};

/**
 * Instance-local synchronous notifications, delivered in registration order.
 * Subscribers present when an emission starts receive it; subscription changes
 * affect the next one. Listener errors are reported without changing the
 * publisher's result, and delivery keeps the publisher's execution context
 * because it never leaves the emitting call chain.
 */
export class EventBus implements Disposable {
  #listeners: Map<symbol, Set<Subscription>> | undefined;
  #closed = false;
  readonly #onError: EventBusOptions["onError"];

  constructor(options?: EventBusOptions) {
    const onError = options?.onError;
    if (onError !== undefined && typeof onError !== "function") {
      throw new TypeError("EventBus onError must be a function.");
    }
    this.#onError = onError;
  }

  on<T>(
    key: EventKey<T>,
    listener: EventListener<NoInfer<T>>,
    options?: EventSubscribeOptions,
  ): () => void {
    if (this.#closed) {
      throw new LifecycleStateError("EventBus", "on", "closed");
    }

    const signal = options?.signal;
    if (signal?.aborted) {
      return noop;
    }

    const listeners = (this.#listeners ??= new Map());
    let subscribers = listeners.get(key.id);
    if (!subscribers) {
      listeners.set(key.id, (subscribers = new Set()));
    }

    // Each subscription has its own lifetime, even for the same callback.
    const subscription: Subscription = {
      listener: listener as EventListener<never>,
      abort: undefined,
    };
    subscribers.add(subscription);

    const unsubscribe = (): void => {
      // Releasing the abort registration here keeps a manual unsubscribe from
      // retaining the signal, and an abort from retaining the bus.
      subscription.abort?.[Symbol.dispose]();
      subscription.abort = undefined;
      if (!subscribers.delete(subscription)) {
        return;
      }

      if (subscribers.size === 0 && listeners.get(key.id) === subscribers) {
        listeners.delete(key.id);
      }
    };

    if (signal) {
      subscription.abort = addAbortListener(signal, unsubscribe);
    }

    return unsubscribe;
  }

  hasListeners<T>(key: EventKey<T>): boolean {
    return (this.#listeners?.get(key.id)?.size ?? 0) > 0;
  }

  emit<T>(key: EventKey<T>, event: NoInfer<T>): void {
    if (this.#closed) {
      throw new LifecycleStateError("EventBus", "emit", "closed");
    }

    const subscribers = this.#listeners?.get(key.id);
    if (!subscribers?.size) {
      return;
    }

    // Snapshot membership before user code can subscribe, unsubscribe, re-emit,
    // or close the bus. Independent listeners all run, even after a failure.
    const snapshot = [...subscribers];
    let failures: unknown[] | undefined;
    for (const subscription of snapshot) {
      try {
        subscription.listener(event as never);
      } catch (error) {
        (failures ??= []).push(error);
      }
    }

    if (failures) {
      this.#report(key.description, combinedError(failures, "Event listener failed."));
    }
  }

  /** Seal admission and drop every subscription. Idempotent. */
  close(): void {
    if (this.#closed) {
      return;
    }

    this.#closed = true;
    const listeners = this.#listeners;
    this.#listeners = undefined;
    for (const subscribers of listeners?.values() ?? []) {
      for (const subscription of subscribers) {
        subscription.abort?.[Symbol.dispose]();
        subscription.abort = undefined;
      }

      subscribers.clear();
    }

    listeners?.clear();
  }

  [Symbol.dispose](): void {
    this.close();
  }

  #report(description: string, failure: unknown): void {
    if (!this.#onError) {
      reportAsynchronously(failure);
      return;
    }

    try {
      this.#onError(failure, { event: description });
    } catch (reporterError) {
      // A broken reporter cannot be trusted to have observed the failure, so
      // both surface asynchronously rather than reaching the publisher.
      reportAsynchronously(failure);
      reportAsynchronously(reporterError);
    }
  }
}

function reportAsynchronously(error: unknown): void {
  // Surface the original error as an unhandled one instead of swallowing it.
  queueMicrotask(() => {
    throw error;
  });
}
