import { addAbortListener } from "node:events";
import type { EventListener } from "../types.js";

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
   * The subscriber-facing end, returned by `on` and invoked by an abort: leaves
   * the membership and releases the abort registration. Removing once, from
   * either direction, is what keeps a manual unsubscribe from retaining the
   * signal and an abort from retaining the bus. Later calls do nothing.
   */
  readonly unsubscribe = (): void => {
    this.#detach()?.remove(this.#keyId, this);
  };

  /**
   * The membership-facing end, for a membership that is already dropping this
   * subscription: releases the abort registration without removing itself, so
   * clearing never re-enters the membership being cleared. It leaves the
   * membership entry standing, so it is never the way to cancel a subscription;
   * every other caller wants `unsubscribe`. Later calls do nothing.
   */
  releaseWithoutRemoval(): void {
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
