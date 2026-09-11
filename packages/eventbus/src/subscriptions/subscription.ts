import { addAbortListener } from "node:events";
import type { EventListener } from "../types.js";

/** The membership a subscription removes itself from, without knowing its layout. */
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

  /** Leaves the membership and releases the abort registration. Returned by `on`. */
  readonly unsubscribe = (): void => {
    this.#detach()?.remove(this.#keyId, this);
  };

  /**
   * For a membership that is already dropping this subscription: releases the
   * abort registration without removing itself, so clearing cannot re-enter
   * the membership being cleared. Anything else wants `unsubscribe`.
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
