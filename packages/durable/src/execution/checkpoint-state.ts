import type { BeginCheckpointResult, CheckpointMutation } from "../persistence/store.js";
import type { CheckpointRecord, ExecutionRecord } from "../types.js";
import { ownsExecution } from "./state.js";

export interface CheckpointTransition {
  readonly outcome: BeginCheckpointResult;
  readonly execution?: ExecutionRecord;
}

export function beginExecutionCheckpoint(
  execution: ExecutionRecord,
  mutation: CheckpointMutation,
): CheckpointTransition {
  if (!ownsExecution(execution, mutation) || execution.status !== "running")
    return { outcome: { status: "lost" } };
  if (mutation.key.length === 0) throw new TypeError("Checkpoint key must not be empty.");
  const existing = Object.hasOwn(execution.checkpoints, mutation.key)
    ? execution.checkpoints[mutation.key]
    : undefined;
  if (existing) {
    if (existing.inputFingerprint !== mutation.inputFingerprint)
      return { outcome: { status: "conflict" } };
    if (existing.status === "completed")
      return { outcome: { status: "completed", result: existing.result } };
    if (existing.status === "running" && existing.activationId === mutation.activationId)
      return { outcome: { status: "busy" } };
  }
  const checkpoint: CheckpointRecord = {
    key: mutation.key,
    inputFingerprint: mutation.inputFingerprint,
    status: "running",
    activationId: mutation.activationId,
  };
  return {
    outcome: { status: "execute" },
    execution: {
      ...execution,
      updatedAt: mutation.now,
      checkpoints: { ...execution.checkpoints, [mutation.key]: checkpoint },
    },
  };
}

export function completeExecutionCheckpoint(
  execution: ExecutionRecord,
  mutation: CheckpointMutation,
  result: unknown,
): ExecutionRecord | undefined {
  if (!ownsCheckpoint(execution, mutation)) return undefined;
  return {
    ...execution,
    updatedAt: mutation.now,
    checkpoints: {
      ...execution.checkpoints,
      [mutation.key]: {
        key: mutation.key,
        inputFingerprint: mutation.inputFingerprint,
        status: "completed",
        result,
      },
    },
  };
}

export function releaseExecutionCheckpoint(
  execution: ExecutionRecord,
  mutation: CheckpointMutation,
): ExecutionRecord | undefined {
  if (!ownsCheckpoint(execution, mutation)) return undefined;
  return {
    ...execution,
    updatedAt: mutation.now,
    checkpoints: {
      ...execution.checkpoints,
      [mutation.key]: {
        key: mutation.key,
        inputFingerprint: mutation.inputFingerprint,
        status: "pending",
      },
    },
  };
}

function ownsCheckpoint(execution: ExecutionRecord, mutation: CheckpointMutation): boolean {
  if (
    !ownsExecution(execution, mutation) ||
    execution.status !== "running" ||
    !Object.hasOwn(execution.checkpoints, mutation.key)
  )
    return false;
  const checkpoint = execution.checkpoints[mutation.key];
  return (
    checkpoint?.status === "running" &&
    checkpoint.activationId === mutation.activationId &&
    checkpoint.inputFingerprint === mutation.inputFingerprint
  );
}
