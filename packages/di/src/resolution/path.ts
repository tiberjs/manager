import { ResolutionError } from "../errors.js";
import type { InjectionToken } from "../tokens.js";

/** One construction in flight: `owner` is building `token` right now. */
export interface ResolutionFrame {
  readonly owner: object;
  readonly token: InjectionToken<unknown>;
}

/**
 * The chain of constructions in flight under one container tree, newest last.
 *
 * A frame is a container and a token together, so the same token may be in
 * flight in two containers while a child decorates an ancestor's
 * implementation; only a container re-entering its own token is a cycle.
 */
export class ResolutionPath {
  readonly #frames: ResolutionFrame[] = [];

  /** The construction that whatever resolves next belongs to. */
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
