import type { Subscription, SubscriptionRemoval } from "./subscription.js";

type Bucket = {
  readonly subscribers: Set<Subscription>;
  /** Delivery order of the current membership; invalidated by every change. */
  order: readonly Subscription[] | undefined;
};

const NONE: readonly Subscription[] = [];

/** Per-key subscriber membership, in registration order, with empty keys dropped. */
export class SubscriptionIndex implements SubscriptionRemoval {
  #buckets: Map<symbol, Bucket> | undefined;

  add(keyId: symbol, subscription: Subscription): void {
    const buckets = (this.#buckets ??= new Map());
    let bucket = buckets.get(keyId);
    if (!bucket) {
      buckets.set(keyId, (bucket = { subscribers: new Set(), order: undefined }));
    }

    bucket.subscribers.add(subscription);
    bucket.order = undefined;
  }

  remove(keyId: symbol, subscription: Subscription): void {
    const bucket = this.#buckets?.get(keyId);
    if (!bucket?.subscribers.delete(subscription)) {
      return;
    }

    bucket.order = undefined;
    if (bucket.subscribers.size === 0) {
      this.#buckets?.delete(keyId);
    }
  }

  /** Whether a key has subscribers. Emptiness is this membership's fact to state. */
  hasSubscribers(keyId: symbol): boolean {
    return (this.#buckets?.get(keyId)?.subscribers.size ?? 0) > 0;
  }

  /**
   * The subscribers a delivery must reach. Materialized once per membership, so a
   * walk in progress keeps the membership it started with while listeners
   * subscribe, unsubscribe, or close, and repeated emissions copy nothing —
   * including the sole-subscriber case, which therefore needs no separate path.
   */
  subscribers(keyId: symbol): readonly Subscription[] {
    const bucket = this.#buckets?.get(keyId);
    if (!bucket) {
      return NONE;
    }

    return (bucket.order ??= [...bucket.subscribers]);
  }

  /** Drop every subscription, releasing the abort registrations they hold. */
  clear(): void {
    const buckets = this.#buckets;
    this.#buckets = undefined;
    for (const bucket of buckets?.values() ?? []) {
      for (const subscription of bucket.subscribers) {
        subscription.releaseWithoutRemoval();
      }

      bucket.subscribers.clear();
      bucket.order = undefined;
    }

    buckets?.clear();
  }
}
