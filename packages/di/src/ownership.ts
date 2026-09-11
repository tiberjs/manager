/** The owner state ownership needs: whether its cleanup has already drained. */
export interface DisposalOwner {
  readonly disposed: boolean;
}

type Entry = DisposalOwner | { readonly rejected: unknown };

// Keyed by root so surviving children share ownership without initializing a
// closed ancestor's resources.
const registriesByRoot = new WeakMap<object, OwnershipRegistry>();

/** At most one disposal owner per object, shared across one container tree. */
export class OwnershipRegistry {
  readonly #entries = new WeakMap<object, Entry>();

  /** Every container descending from `root` claims into the same registry. */
  static forRoot(root: object): OwnershipRegistry {
    let registry = registriesByRoot.get(root);
    if (!registry) {
      registriesByRoot.set(root, (registry = new OwnershipRegistry()));
    }

    return registry;
  }

  /**
   * The owner still responsible for `value`, or undefined when it is unowned or
   * its owner already drained and left the value adoptable again.
   *
   * Rethrows the cached rejection of a refused shape, so every later alias of
   * that object fails identically.
   */
  liveOwner(value: object): DisposalOwner | undefined {
    const entry = this.#entries.get(value);
    if (!entry) {
      return undefined;
    }
    if ("rejected" in entry) {
      throw entry.rejected;
    }

    return entry.disposed ? undefined : entry;
  }

  claim(value: object, owner: DisposalOwner): void {
    this.#entries.set(value, owner);
  }

  /** Refusal is permanent: `value` can never gain a disposal owner afterwards. */
  reject(value: object, error: unknown): void {
    this.#entries.set(value, { rejected: error });
  }
}
