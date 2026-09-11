import { ProviderConflictError } from "./errors.js";
import type { Factory, InjectionToken } from "./tokens.js";

/** One container's providers and the instances it has constructed. */
export class ProviderRegistry {
  #factories: Map<InjectionToken<unknown>, Factory<unknown>> | undefined;
  #instances: Map<InjectionToken<unknown>, unknown> | undefined;

  /** Whether this container has ever cached an instance of its own. */
  get hasInstances(): boolean {
    return this.#instances !== undefined;
  }

  /** An explicit provider or a cached instance, never a constructibility probe. */
  has(token: InjectionToken<unknown>): boolean {
    return (this.#instances?.has(token) ?? false) || (this.#factories?.has(token) ?? false);
  }

  /** Distinguishes a cached `undefined` from a missing instance. */
  hasInstance(token: InjectionToken<unknown>): boolean {
    return this.#instances?.has(token) ?? false;
  }

  instance<T>(token: InjectionToken<T>): T {
    return this.#instances?.get(token) as T;
  }

  hasFactory(token: InjectionToken<unknown>): boolean {
    return this.#factories?.has(token) ?? false;
  }

  factory<T>(token: InjectionToken<T>): Factory<T> | undefined {
    return this.#factories?.get(token) as Factory<T> | undefined;
  }

  /**
   * Replacing a factory whose instance this container already handed out is
   * rejected: the cached instance would silently win. Override in a child.
   */
  provide<T>(token: InjectionToken<T>, factory: Factory<T>): void {
    if (this.#instances?.has(token)) {
      throw new ProviderConflictError(token);
    }
    (this.#factories ??= new Map()).set(token, factory as Factory<unknown>);
  }

  cache(token: InjectionToken<unknown>, value: unknown): void {
    (this.#instances ??= new Map()).set(token, value);
  }

  /** Disposal makes the container unusable, so its storage is released. */
  clear(): void {
    this.#factories = undefined;
    this.#instances = undefined;
  }
}
