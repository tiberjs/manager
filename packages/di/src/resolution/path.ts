import { ResolutionError } from "../errors.js";
import type { InjectionToken } from "../tokens.js";

/** One construction in flight: `owner` is building `token` right now. */
export interface ResolutionFrame {
  readonly owner: object;
  readonly token: InjectionToken<unknown>;
}

/**
 * The chain of constructions in flight under one container tree.
 *
 * Construction is synchronous, so nested resolution is a stack, and the open
 * frame is the dependant of whatever resolves next.
 *
 * A frame is identified by container and token together. An ancestor without a
 * local provider builds its own instance of a class token, so the same token
 * may legitimately be in flight in two containers while a child decorates an
 * ancestor's implementation; only a container re-entering a token it is
 * already constructing is a cycle.
 *
 * Owned by the root container rather than by its diagnostics, so cycles are
 * still reported once the resolution graph is gone.
 */
export class ResolutionPath {
  readonly #frames: ResolutionFrame[] = [];

  /** The construction a resolution observed now belongs to, if any. */
  get current(): ResolutionFrame | undefined {
    return this.#frames[this.#frames.length - 1];
  }

  /** Rejects a container that re-enters a token it is already constructing. */
  enter(owner: object, token: InjectionToken<unknown>): void {
    for (const frame of this.#frames) {
      if (frame.owner === owner && frame.token === token) {
        throw new ResolutionError("circular-dependency", token);
      }
    }

    this.#frames.push({ owner, token });
  }

  /** A failed attempt leaves no trace, so the token stays resolvable. */
  exit(): void {
    this.#frames.pop();
  }
}
