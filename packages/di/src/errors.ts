import { describeToken, type InjectionToken } from "./tokens.js";

/** A container resolution failure; provider exceptions propagate unchanged. */
export class ResolutionError extends Error {
  constructor(
    readonly reason: "missing-provider" | "circular-dependency",
    readonly token: InjectionToken<unknown>,
    options?: ErrorOptions,
  ) {
    super(
      reason === "missing-provider"
        ? `No provider registered for token "${describeToken(token)}". Use provide(token, factory) for values/interfaces.`
        : `Circular dependency while resolving "${describeToken(token)}".`,
      options,
    );
    this.name = "ResolutionError";
  }
}

/** Resource admission failed because this container's teardown has begun. */
export class ContainerClosedError extends Error {
  constructor(
    readonly state: "closing" | "disposed",
    options?: ErrorOptions,
  ) {
    super(state === "closing" ? "Container is closing." : "Container has been disposed.", options);
    this.name = "ContainerClosedError";
  }
}

/** An object must have exactly one disposal owner and one automatic close protocol. */
export class DisposalConflictError extends Error {
  constructor(readonly reason: "multiple-hooks" | "already-owned") {
    super(
      reason === "multiple-hooks"
        ? "ContainerObject.onClose cannot coexist with Symbol.asyncDispose or Symbol.dispose."
        : "An explicit disposer cannot take ownership of an already-owned resource.",
    );
    this.name = "DisposalConflictError";
  }
}
