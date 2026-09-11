import { LifecycleStateError } from "@tiberjs/runner";
import type { EventKey } from "./event-key.js";
import { FailureReporter } from "./failures/reporter.js";
import { Subscription } from "./subscriptions/subscription.js";
import { SubscriptionIndex } from "./subscriptions/subscription-index.js";
import type { EventBusOptions, EventListener, EventSubscribeOptions } from "./types.js";

const noop = (): void => {};

/**
 * Instance-local synchronous notifications, delivered in registration order.
 *
 * An emission reaches the subscribers present when it started, so a listener
 * that subscribes, unsubscribes, or closes affects only later emissions.
 */
export class EventBus implements Disposable {
  readonly #subscriptions = new SubscriptionIndex();
  readonly #reporter: FailureReporter;
  #closed = false;

  constructor(options?: EventBusOptions) {
    this.#reporter = new FailureReporter(options);
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

    // Each subscription has its own lifetime, even for the same callback.
    const subscription = new Subscription(
      key.id,
      listener as EventListener<never>,
      this.#subscriptions,
    );
    this.#subscriptions.add(key.id, subscription);
    if (signal) {
      subscription.bindAbort(signal);
    }

    return subscription.unsubscribe;
  }

  hasListeners<T>(key: EventKey<T>): boolean {
    return this.#subscriptions.hasSubscribers(key.id);
  }

  emit<T>(key: EventKey<T>, event: NoInfer<T>): void {
    if (this.#closed) {
      throw new LifecycleStateError("EventBus", "emit", "closed");
    }

    // Every listener runs, even after one fails; the reporter sees the emission once.
    const subscribers = this.#subscriptions.subscribers(key.id);
    let failures: unknown[] | undefined;
    for (let index = 0; index < subscribers.length; index++) {
      try {
        subscribers[index]!.listener(event as never);
      } catch (error) {
        (failures ??= []).push(error);
      }
    }

    if (failures) {
      this.#reporter.report(key.description, failures);
    }
  }

  /** Seal admission and drop every subscription. Idempotent. */
  close(): void {
    if (this.#closed) {
      return;
    }

    this.#closed = true;
    this.#subscriptions.clear();
  }

  [Symbol.dispose](): void {
    this.close();
  }
}
