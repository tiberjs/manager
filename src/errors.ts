import type { SerializedError } from "./types.js";

export class ExecutionFailedError extends Error {
  readonly error: SerializedError;

  constructor(id: string, error: SerializedError) {
    super(`Execution ${id} failed: ${error.message}`);
    this.name = "ExecutionFailedError";
    this.error = error;
  }
}

export class ExecutionCancelledError extends Error {
  readonly reason: SerializedError;

  constructor(id: string, reason: SerializedError) {
    super(`Execution ${id} was cancelled: ${reason.message}`);
    this.name = "ExecutionCancelledError";
    this.reason = reason;
  }
}

export class DuplicateWorkflowError extends Error {
  constructor(name: string) {
    super(`A workflow named ${JSON.stringify(name)} is already registered.`);
    this.name = "DuplicateWorkflowError";
  }
}

export class ExecutionIdentityConflictError extends Error {
  constructor(id: string) {
    super(`Execution ${id} already exists with different input.`);
    this.name = "ExecutionIdentityConflictError";
  }
}

export class ManagerClosedError extends Error {
  constructor() {
    super("Manager is closed.");
    this.name = "ManagerClosedError";
  }
}

export class ActivationLostError extends Error {
  constructor(executionId: string, nodeId: string) {
    super(`Activation for ${executionId}/${nodeId} lost ownership.`);
    this.name = "ActivationLostError";
  }
}

export function serializeError(value: unknown, depth = 0): SerializedError {
  if (value instanceof Error) {
    const cause =
      depth < 4 && value.cause !== undefined ? serializeError(value.cause, depth + 1) : undefined;
    const errors =
      depth < 4 && value instanceof AggregateError
        ? value.errors.map((error) => serializeError(error, depth + 1))
        : undefined;
    return {
      name: value.name || "Error",
      message: value.message,
      ...(value.stack ? { stack: value.stack } : {}),
      ...(cause ? { cause } : {}),
      ...(errors && errors.length > 0 ? { errors } : {}),
    };
  }
  return {
    name: "Error",
    message: typeof value === "string" ? value : String(value),
  };
}

export const ACTIVATION_EXPIRED: SerializedError = {
  name: "ActivationExpiredError",
  message: "The node activation lease expired before completion.",
};
