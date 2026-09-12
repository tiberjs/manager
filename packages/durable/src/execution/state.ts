import { ACTIVATION_EXPIRED } from "../errors.js";
import type {
  ClaimExecutionOptions,
  ExecutionFailure,
  ExecutionMutation,
  HeartbeatResult,
} from "../persistence/store.js";
import { terminal } from "../persistence/store.js";
import type {
  CheckpointRecord,
  ExecutionEvent,
  ExecutionProjection,
  ExecutionRecord,
  SerializedError,
} from "../types.js";
import { retryAt } from "./retry.js";

export interface ExecutionTransition {
  readonly execution: ExecutionRecord;
  readonly events: readonly ExecutionEvent[];
}

export interface HeartbeatTransition {
  readonly result: HeartbeatResult;
  readonly execution?: ExecutionRecord;
}

/** Checks logical ownership and, by default, the live lease. */
export function ownsExecution(
  execution: ExecutionRecord,
  mutation: ExecutionMutation,
  requireLease = true,
): boolean {
  const { activation } = execution;
  return (
    execution.submission.id === mutation.executionId &&
    (execution.projection.status === "running" || execution.projection.status === "cancelling") &&
    activation?.activationId === mutation.activationId &&
    (!requireLease || activation.leaseExpiresAt > mutation.now)
  );
}

export function claimExecution(
  execution: ExecutionRecord,
  options: ClaimExecutionOptions,
  activationId: string,
): ExecutionTransition | undefined {
  const { projection, submission } = execution;
  if (
    projection.status !== "pending" ||
    projection.availableAt > options.now ||
    !options.jobs.includes(submission.job)
  )
    return undefined;
  const attempt = projection.attempt + 1;
  return {
    execution: {
      ...execution,
      projection: { ...projection, status: "running", attempt, updatedAt: options.now },
      activation: {
        activationId,
        workerId: options.workerId,
        leaseExpiresAt: options.leaseExpiresAt,
      },
    },
    events: [
      {
        type: "attempt-started",
        attempt,
        activationId,
        workerId: options.workerId,
        at: options.now,
      },
    ],
  };
}

export function heartbeatExecution(
  execution: ExecutionRecord,
  mutation: ExecutionMutation,
  workerId: string,
  leaseExpiresAt: number,
): HeartbeatTransition {
  if (!ownsExecution(execution, mutation) || execution.activation?.workerId !== workerId)
    return { result: "lost" };
  if (execution.projection.status === "cancelling") return { result: "cancel-requested" };
  return {
    result: "renewed",
    execution: {
      ...execution,
      projection: { ...execution.projection, updatedAt: mutation.now },
      activation: { ...execution.activation, leaseExpiresAt },
    },
  };
}

export function completeExecution(
  execution: ExecutionRecord,
  mutation: ExecutionMutation,
  result: unknown,
): ExecutionTransition | undefined {
  if (
    !ownsExecution(execution, mutation) ||
    execution.projection.status !== "running" ||
    Object.values(execution.checkpoints).some((checkpoint) => checkpoint.status === "running")
  )
    return undefined;
  return {
    execution: inactiveExecution(execution, {
      status: "completed",
      result,
      error: undefined,
      updatedAt: mutation.now,
    }),
    events: [
      {
        type: "execution-completed",
        attempt: execution.projection.attempt,
        activationId: mutation.activationId,
        result,
        at: mutation.now,
      },
    ],
  };
}

export function failExecution(
  execution: ExecutionRecord,
  failure: ExecutionFailure,
): ExecutionTransition | undefined {
  if (!ownsExecution(execution, failure) || execution.projection.status !== "running")
    return undefined;
  const failures = execution.projection.failures + 1;
  const retrying = failures <= execution.submission.retry.retries;
  return {
    execution: inactiveExecution(execution, {
      status: retrying ? "pending" : "failed",
      failures,
      ...(retrying ? { availableAt: failure.retryAt } : {}),
      error: failure.error,
      updatedAt: failure.now,
    }),
    events: [
      {
        type: "attempt-failed",
        attempt: execution.projection.attempt,
        activationId: failure.activationId,
        failure: failures,
        error: failure.error,
        ...(retrying ? { retryAt: failure.retryAt } : {}),
        at: failure.now,
      },
    ],
  };
}

export function releaseExecution(
  execution: ExecutionRecord,
  mutation: ExecutionMutation,
): ExecutionTransition | undefined {
  if (!ownsExecution(execution, mutation, false) || execution.projection.status !== "running")
    return undefined;
  return {
    execution: inactiveExecution(execution, {
      status: "pending",
      availableAt: mutation.now,
      updatedAt: mutation.now,
    }),
    events: [
      {
        type: "attempt-released",
        attempt: execution.projection.attempt,
        activationId: mutation.activationId,
        reason: "manager-shutdown",
        at: mutation.now,
      },
    ],
  };
}

export function acknowledgeExecutionCancellation(
  execution: ExecutionRecord,
  mutation: ExecutionMutation,
): ExecutionTransition | undefined {
  if (!ownsExecution(execution, mutation, false) || execution.projection.status !== "cancelling")
    return undefined;
  return {
    execution: inactiveExecution(execution, {
      status: "cancelled",
      updatedAt: mutation.now,
    }),
    events: [
      {
        type: "execution-cancelled",
        activationId: mutation.activationId,
        at: mutation.now,
      },
    ],
  };
}

export function cancelExecution(
  execution: ExecutionRecord,
  reason: SerializedError,
  now: number,
): ExecutionTransition | undefined {
  const { projection } = execution;
  if (terminal(projection.status) || projection.status === "cancelling") return undefined;
  const requested: ExecutionEvent = { type: "cancellation-requested", reason, at: now };
  if (projection.status === "running") {
    return {
      execution: {
        ...execution,
        projection: {
          ...projection,
          status: "cancelling",
          cancellationReason: reason,
          updatedAt: now,
        },
      },
      events: [requested],
    };
  }
  return {
    execution: inactiveExecution(execution, {
      status: "cancelled",
      cancellationReason: reason,
      updatedAt: now,
    }),
    events: [requested, { type: "execution-cancelled", at: now }],
  };
}

export function recoverExpiredExecution(
  execution: ExecutionRecord,
  now: number,
): ExecutionTransition | undefined {
  const { activation, projection, submission } = execution;
  if (
    (projection.status !== "running" && projection.status !== "cancelling") ||
    !activation ||
    activation.leaseExpiresAt > now
  )
    return undefined;
  if (projection.status === "cancelling") {
    return {
      execution: inactiveExecution(execution, { status: "cancelled", updatedAt: now }),
      events: [{ type: "execution-cancelled", activationId: activation.activationId, at: now }],
    };
  }
  const failures = projection.failures + 1;
  const retrying = failures <= submission.retry.retries;
  const availableAt = retryAt(submission.retry, failures, now);
  return {
    execution: inactiveExecution(execution, {
      status: retrying ? "pending" : "failed",
      failures,
      ...(retrying ? { availableAt } : {}),
      error: ACTIVATION_EXPIRED,
      updatedAt: now,
    }),
    events: [
      {
        type: "activation-expired",
        attempt: projection.attempt,
        activationId: activation.activationId,
        failure: failures,
        ...(retrying ? { retryAt: availableAt } : {}),
        at: now,
      },
    ],
  };
}

function inactiveExecution(
  execution: ExecutionRecord,
  changes: Partial<ExecutionProjection>,
): ExecutionRecord {
  let checkpoints: Record<string, CheckpointRecord> | undefined;
  for (const [key, checkpoint] of Object.entries(execution.checkpoints)) {
    if (checkpoint.status === "running") {
      checkpoints ??= { ...execution.checkpoints };
      checkpoints[key] = {
        key: checkpoint.key,
        inputFingerprint: checkpoint.inputFingerprint,
        status: "pending",
      };
    }
  }
  return {
    ...execution,
    projection: { ...execution.projection, ...changes },
    checkpoints: checkpoints ?? execution.checkpoints,
    activation: undefined,
  };
}
