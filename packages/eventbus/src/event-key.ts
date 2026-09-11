/** A typed event identity. Equal descriptions do not imply equal events. */
export interface EventKey<T> {
  readonly id: symbol;
  readonly description: string;
  /** Phantom carrier; never present at runtime. */
  readonly _type?: T;
}

export function eventKey<T>(description: string): EventKey<T> {
  return Object.freeze({ id: Symbol(description), description });
}
