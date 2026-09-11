import { addAbortListener } from "node:events";

/** Notifications are delivered synchronously and cannot return asynchronous work. */
export type EventListener<T> = (event: T) => undefined;

/** The membership a subscription removes itself from; it knows nothing of its layout. */
export interface SubscriptionRemoval {
  remove(keyId: symbol, subscription: Subscription): void;
}

/** One subscription: its listener, its optional abort registration, and its removal. */
export class Subscription {
  readonly listener: EventListener<never>;
  readonly #keyId: symbol;
  #removal: SubscriptionRemoval | undefined;
  #abort: Disposable | undefined;

  constructor(keyId: symbol, listener: EventListener<never>, removal: SubscriptionRemoval) {
    this.#keyId = keyId;
    this.listener = listener;
    this.#removal = removal;
  }

  /** Aborting unsubscribes. Bind only after the subscription joined its membership. */
  bindAbort(signal: AbortSignal): void {
    this.#abort = addAbortListener(signal, this.unsubscribe);
  }

  /**
   * Removes once, from either direction: releasing the abort registration keeps a
   * manual unsubscribe from retaining the signal, and dropping the membership
   * reference keeps an abort from retaining the bus. Later calls do nothing.
   */
  readonly unsubscribe = (): void => {
    this.#detach()?.remove(this.#keyId, this);
  };

  /** Retire a subscription its membership is already dropping. */
  discard(): void {
    this.#detach();
  }

  #detach(): SubscriptionRemoval | undefined {
    this.#abort?.[Symbol.dispose]();
    this.#abort = undefined;
    const removal = this.#removal;
    this.#removal = undefined;
    return removal;
  }
}
