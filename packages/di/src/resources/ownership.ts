/** A permanently refused value, boxed so it is never mistaken for an owner. */
class Rejection {
  constructor(readonly error: unknown) {}
}

// Keyed by root so surviving children share ownership without initializing a
// closed ancestor's resources.
const registriesByRoot = new WeakMap<object, OwnershipRegistry>();

/**
 * At most one disposal owner per object, shared across one container tree.
 *
 * Liveness is the registry's own state: an owner reports that its cleanup
 * drained, and the registry never asks an owner about itself.
 */
export class OwnershipRegistry {
  readonly #entries = new WeakMap<object, object>();
  readonly #drained = new WeakSet<object>();

  /** Every container descending from `root` claims into the same registry. */
  static forRoot(root: object): OwnershipRegistry {
    let registry = registriesByRoot.get(root);
    if (!registry) {
      registriesByRoot.set(root, (registry = new OwnershipRegistry()));
    }

    return registry;
  }

  /**
   * Whether someone is still responsible for releasing `value`. An owner that
   * already drained leaves the value adoptable again.
   *
   * Rethrows the cached rejection of a refused shape, so every later alias of
   * that object fails identically.
   */
  hasLiveOwner(value: object): boolean {
    const entry = this.#entries.get(value);
    if (entry instanceof Rejection) {
      throw entry.error;
    }

    return entry !== undefined && !this.#drained.has(entry);
  }

  claim(value: object, owner: object): void {
    this.#entries.set(value, owner);
  }

  /** `owner` finished its cleanup: every value it claimed is unowned again. */
  release(owner: object): void {
    this.#drained.add(owner);
  }

  /** Refusal is permanent: `value` can never gain a disposal owner afterwards. */
  reject(value: object, error: unknown): void {
    this.#entries.set(value, new Rejection(error));
  }
}
