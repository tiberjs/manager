import { ACTIVATION_EXPIRED } from "../errors.js";
import type { ExecutionTransition } from "./state.js";
import type {
  CheckpointRecord,
  ExecutionProjection,
  ExecutionRecord,
  StoredExecutionEvent,
} from "../types.js";

export interface CommittedTransition {
  readonly execution: ExecutionRecord;
  readonly events: readonly StoredExecutionEvent[];
}

export function commitTransition(
  current: ExecutionRecord | undefined,
  transition: ExecutionTransition,
): CommittedTransition {
  const executionId = transition.execution.submission.id;
  const revision = current?.projection.revision ?? 0;
  const events = transition.events.map((event, index): StoredExecutionEvent => ({
    executionId,
    sequence: revision + index + 1,
    event,
  }));
  return {
    execution: {
      ...transition.execution,
      projection: {
        ...transition.execution.projection,
        revision: revision + events.length,
      },
    },
    events,
  };
}

/** Rebuilds semantic state; live leases and checkpoint reservations are operational overlays. */
export function replayExecutionLedger(events: readonly StoredExecutionEvent[]): ExecutionRecord {
  let execution: ExecutionRecord | undefined;
  for (const stored of events) {
    if (stored.sequence !== (execution?.projection.revision ?? 0) + 1) {
      throw new Error(`Execution ledger sequence ${stored.sequence} is not contiguous.`);
    }
    if (execution && stored.executionId !== execution.submission.id) {
      throw new Error("Execution ledger contains more than one execution ID.");
    }
    const { event } = stored;
    if (event.type === "execution-submitted") {
      if (execution) throw new Error("Execution ledger contains duplicate submission events.");
      if (event.submission.id !== stored.executionId) {
        throw new Error("Execution submission ID does not match its ledger envelope.");
      }
      execution = {
        submission: event.submission,
        projection: {
          revision: stored.sequence,
          status: "pending",
          attempt: 0,
          failures: 0,
          availableAt: event.at,
          updatedAt: event.at,
        },
        checkpoints: {},
      };
      continue;
    }
    if (!execution) throw new Error("Execution ledger must begin with a submission event.");
    const projection: ExecutionProjection = {
      ...execution.projection,
      revision: stored.sequence,
      updatedAt: event.at,
    };
    switch (event.type) {
      case "attempt-started":
        execution = {
          ...execution,
          projection: { ...projection, status: "running", attempt: event.attempt },
        };
        break;
      case "attempt-failed":
        execution = {
          ...execution,
          projection: {
            ...projection,
            status: event.retryAt === undefined ? "failed" : "pending",
            failures: event.failure,
            ...(event.retryAt === undefined ? {} : { availableAt: event.retryAt }),
            error: event.error,
          },
        };
        break;
      case "attempt-released":
        execution = {
          ...execution,
          projection: { ...projection, status: "pending", availableAt: event.at },
        };
        break;
      case "activation-expired":
        execution = {
          ...execution,
          projection: {
            ...projection,
            status: event.retryAt === undefined ? "failed" : "pending",
            failures: event.failure,
            ...(event.retryAt === undefined ? {} : { availableAt: event.retryAt }),
            error: ACTIVATION_EXPIRED,
          },
        };
        break;
      case "cancellation-requested":
        execution = {
          ...execution,
          projection: {
            ...projection,
            status: projection.status === "running" ? "cancelling" : projection.status,
            cancellationReason: event.reason,
          },
        };
        break;
      case "execution-cancelled":
        execution = { ...execution, projection: { ...projection, status: "cancelled" } };
        break;
      case "execution-completed":
        execution = {
          ...execution,
          projection: {
            ...projection,
            status: "completed",
            result: event.result,
            error: undefined,
          },
        };
        break;
      case "checkpoint-declared":
        execution = {
          ...execution,
          projection,
          checkpoints: {
            ...execution.checkpoints,
            [event.key]: {
              key: event.key,
              inputFingerprint: event.inputFingerprint,
              status: "pending",
            },
          },
        };
        break;
      case "checkpoint-completed":
        execution = {
          ...execution,
          projection,
          checkpoints: {
            ...execution.checkpoints,
            [event.key]: {
              key: event.key,
              inputFingerprint: event.inputFingerprint,
              status: "completed",
              result: event.result,
            },
          },
        };
        break;
    }
  }
  if (!execution) throw new Error("Execution ledger is empty.");
  return execution;
}

export function withoutOperationalState(execution: ExecutionRecord): ExecutionRecord {
  let checkpoints: Record<string, CheckpointRecord> | undefined;
  for (const [key, checkpoint] of Object.entries(execution.checkpoints)) {
    if (checkpoint.status === "running") {
      checkpoints ??= { ...execution.checkpoints };
      checkpoints[key] = {
        key,
        inputFingerprint: checkpoint.inputFingerprint,
        status: "pending",
      };
    }
  }
  return {
    ...execution,
    activation: undefined,
    checkpoints: checkpoints ?? execution.checkpoints,
  };
}
