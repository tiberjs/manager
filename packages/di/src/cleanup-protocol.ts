import { DisposalConflictError } from "./errors.js";

/** Releases one resource; a returned promise is awaited during disposal. */
export type Cleanup = () => unknown | Promise<unknown>;

/** Structural resource hook. Do not combine onClose with a symbol disposer. */
export interface ContainerObject {
  onClose?(): unknown | Promise<unknown>;
}

/**
 * How a constructed value is released, plus the conflict that must reject it.
 *
 * A conflicting shape still yields `cleanup`: the caller registers it to roll
 * back an object it will never hand out, then throws `conflict`.
 */
export interface CleanupPlan {
  readonly cleanup: Cleanup | undefined;
  readonly conflict: DisposalConflictError | undefined;
}

/**
 * Precedence is explicit disposer, then `Symbol.asyncDispose`/`Symbol.dispose`,
 * then `ContainerObject.onClose`. `onClose` beside a symbol disposer is
 * ambiguous and refused, unless an explicit disposer overrides both shapes.
 */
export function planCleanup<T>(
  value: T,
  explicitDispose?: (value: T) => unknown | Promise<unknown>,
): CleanupPlan {
  const asyncDispose = (value as Partial<AsyncDisposable>)[Symbol.asyncDispose];
  const dispose = (value as Partial<Disposable>)[Symbol.dispose];
  const onClose = (value as ContainerObject).onClose;
  const symbolDispose = typeof asyncDispose === "function" ? asyncDispose : dispose;

  const cleanup = explicitDispose
    ? () => explicitDispose(value)
    : typeof symbolDispose === "function"
      ? () => symbolDispose.call(value)
      : typeof onClose === "function"
        ? () => onClose.call(value)
        : undefined;
  const conflict =
    !explicitDispose && typeof onClose === "function" && typeof symbolDispose === "function"
      ? new DisposalConflictError("multiple-hooks")
      : undefined;

  return { cleanup, conflict };
}
