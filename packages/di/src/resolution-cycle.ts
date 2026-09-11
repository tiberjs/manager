import { ResolutionError } from "./errors.js";
import type { InjectionToken } from "./tokens.js";

/**
 * The tokens one container is constructing right now.
 *
 * Per container by design: an ancestor without a local provider builds its own
 * instance of a class token, so the same token may legitimately be in flight in
 * two containers while a child decorates an ancestor's implementation.
 */
export class ResolutionCycle {
  #active: Set<InjectionToken<unknown>> | undefined;

  /** Rejects a token that re-enters its own construction. */
  enter(token: InjectionToken<unknown>): void {
    const active = (this.#active ??= new Set());
    if (active.has(token)) {
      throw new ResolutionError("circular-dependency", token);
    }
    active.add(token);
  }

  /** A failed attempt leaves no trace, so the token stays resolvable. */
  exit(token: InjectionToken<unknown>): void {
    this.#active?.delete(token);
  }

  clear(): void {
    this.#active = undefined;
  }
}
