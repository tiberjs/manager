import { ACTIVATION_EXPIRED } from "../errors.js";
import type {
  ClaimExecutionOptions,
  ExecutionMutation,
  ExecutionFailure,
  HeartbeatResult,
} from "../persistence/store.js";
import { terminal } from "../persistence/store.js";
import type { CheckpointRecord, ExecutionRecord, SerializedError } from "../types.js";
import { retryAt } from "./retry.js";

export interface HeartbeatTransition {
  readonly result: HeartbeatResult;
  readonly execution?: ExecutionRecord;
}

/** Checks both logical ownership and the live lease; elapsed leases cannot be resurrected. */
export function ownsExecution(
  execution: ExecutionRecord,
  mutation: ExecutionMutation,
  requireLease = true,
): boolean {
  return (
    execution.id === mutation.executionId &&
    (execution.status === "running" || execution.status === "cancelling") &&
    execution.activationId === mutation.activationId &&
    (!requireLease ||
      (execution.leaseExpiresAt !== undefined && execution.leaseExpiresAt > mutation.now))
  );
}

export function claimExecution(
  execution: ExecutionRecord,
  options: ClaimExecutionOptions,
  activationId: string,
): ExecutionRecord | undefined {
  if (
    execution.status !== "pending" ||
    execution.availableAt > options.now ||
    !options.jobs.includes(execution.job)
  )
    return undefined;
  return {
    ...execution,
    status: "running",
    attempt: execution.attempt + 1,
    activationId,
    workerId: options.workerId,
    leaseExpiresAt: options.leaseExpiresAt,
    updatedAt: options.now,
  };
}

export function heartbeatExecution(
  execution: ExecutionRecord,
  mutation: ExecutionMutation,
  workerId: string,
  leaseExpiresAt: number,
): HeartbeatTransition {
  if (!ownsExecution(execution, mutation) || execution.workerId !== workerId)
    return { result: "lost" };
  if (execution.status === "cancelling") return { result: "cancel-requested" };
  return {
    result: "renewed",
    execution: { ...execution, leaseExpiresAt, updatedAt: mutation.now },
  };
}

export function completeExecution(
  execution: ExecutionRecord,
  mutation: ExecutionMutation,
  result: unknown,
): ExecutionRecord | undefined {
  if (
    !ownsExecution(execution, mutation) ||
    execution.status !== "running" ||
    Object.values(execution.checkpoints).some((checkpoint) => checkpoint.status === "running")
  )
    return undefined;
  return inactiveExecution(execution, {
    status: "completed",
    result,
    error: undefined,
    updatedAt: mutation.now,
  });
}

export function failExecution(
  execution: ExecutionRecord,
  failure: ExecutionFailure,
): ExecutionRecord | undefined {
  if (!ownsExecution(execution, failure) || execution.status !== "running") return undefined;
  const failures = execution.failures + 1;
  return inactiveExecution(execution, {
    status: failures > execution.retry.retries ? "failed" : "pending",
    failures,
    availableAt: failure.retryAt,
    error: failure.error,
    updatedAt: failure.now,
  });
}

export function releaseExecution(
  execution: ExecutionRecord,
  mutation: ExecutionMutation,
): ExecutionRecord | undefined {
  if (!ownsExecution(execution, mutation, false) || execution.status !== "running")
    return undefined;
  return inactiveExecution(execution, {
    status: "pending",
    availableAt: mutation.now,
    updatedAt: mutation.now,
  });
}

export function acknowledgeExecutionCancellation(
  execution: ExecutionRecord,
  mutation: ExecutionMutation,
): ExecutionRecord | undefined {
  if (!ownsExecution(execution, mutation, false) || execution.status !== "cancelling")
    return undefined;
  return inactiveExecution(execution, { status: "cancelled", updatedAt: mutation.now });
}

export function cancelExecution(
  execution: ExecutionRecord,
  reason: SerializedError,
  now: number,
): ExecutionRecord | undefined {
  if (terminal(execution.status) || execution.status === "cancelling") return undefined;
  if (execution.status === "running")
    return { ...execution, status: "cancelling", cancellationReason: reason, updatedAt: now };
  return inactiveExecution(execution, {
    status: "cancelled",
    cancellationReason: reason,
    updatedAt: now,
  });
}

export function recoverExpiredExecution(
  execution: ExecutionRecord,
  now: number,
): ExecutionRecord | undefined {
  if (
    (execution.status !== "running" && execution.status !== "cancelling") ||
    execution.leaseExpiresAt === undefined ||
    execution.leaseExpiresAt > now
  )
    return undefined;
  if (execution.status === "cancelling")
    return inactiveExecution(execution, { status: "cancelled", updatedAt: now });
  const failures = execution.failures + 1;
  return inactiveExecution(execution, {
    status: failures > execution.retry.retries ? "failed" : "pending",
    failures,
    availableAt: retryAt(execution.retry, failures, now),
    error: ACTIVATION_EXPIRED,
    updatedAt: now,
  });
}

function inactiveExecution(
  execution: ExecutionRecord,
  changes: Partial<ExecutionRecord>,
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
    ...changes,
    checkpoints: checkpoints ?? execution.checkpoints,
    activationId: undefined,
    workerId: undefined,
    leaseExpiresAt: undefined,
  };
}
