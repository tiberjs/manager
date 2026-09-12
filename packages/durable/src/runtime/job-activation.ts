import { combinedError } from "@tiberjs/runner";
import { serializeError } from "../errors.js";
import { retryAt } from "../execution/retry.js";
import type { ClaimedExecution, ExecutionStore, ExecutionMutation } from "../persistence/store.js";
import type { DurableJobRegistry } from "../job/registry.js";
import { executeJobAttempt } from "./attempt.js";
import type { AttemptProvider } from "./attempt.js";
import { ActivationLease } from "./lease.js";

export interface JobActivationOptions {
  readonly store: ExecutionStore;
  readonly registry: DurableJobRegistry;
  readonly providers: readonly AttemptProvider[];
  readonly workerId: string;
  readonly leaseDurationMs: number;
  readonly heartbeatIntervalMs: number;
  readonly isClosing: () => boolean;
}

type AttemptOutcome =
  | { readonly status: "succeeded"; readonly result: unknown }
  | { readonly status: "failed"; readonly error: unknown };

/** Executes, heartbeats, and commits one claimed job after Runner teardown. */
export class JobActivationRunner {
  private readonly options: JobActivationOptions;

  constructor(options: JobActivationOptions) {
    this.options = options;
  }

  async run(claimed: ClaimedExecution, controller: AbortController): Promise<void> {
    const registered = this.options.registry.find(claimed.execution.job);
    if (!registered) {
      throw new Error(`Registered job is missing ${claimed.execution.job}.`);
    }
    const mutation: ExecutionMutation = {
      executionId: claimed.execution.id,
      activationId: claimed.activationId,
      now: Date.now(),
    };
    const heartbeat = new ActivationLease({
      store: this.options.store,
      executionId: claimed.execution.id,
      activationId: claimed.activationId,
      workerId: this.options.workerId,
      durationMs: this.options.leaseDurationMs,
      intervalMs: this.options.heartbeatIntervalMs,
      controller,
    });
    let outcome: AttemptOutcome;

    try {
      outcome = {
        status: "succeeded",
        result: await executeJobAttempt({
          executionId: claimed.execution.id,
          job: registered.name,
          activationId: claimed.activationId,
          store: this.options.store,
          attempt: claimed.execution.attempt,
          handler: registered.type,
          input: claimed.execution.input,
          signal: controller.signal,
          providers: this.options.providers,
        }),
      };
    } catch (error) {
      outcome = { status: "failed", error };
    } finally {
      await heartbeat.stop();
    }

    if (heartbeat.failure) {
      const infrastructureError = heartbeat.failure.error;
      if (
        outcome.status === "failed" &&
        (Object.is(outcome.error, infrastructureError) ||
          (outcome.error instanceof AggregateError &&
            outcome.error.errors.includes(infrastructureError)))
      ) {
        throw outcome.error;
      }
      throw combinedError(
        outcome.status === "failed" ? [infrastructureError, outcome.error] : [infrastructureError],
        "Heartbeat and job teardown failed.",
      );
    }
    if (heartbeat.result === "lost") {
      return undefined;
    }

    const now = Date.now();
    const currentMutation = { ...mutation, now };
    const current = await this.options.store.load(claimed.execution.id);
    if (!current || current.status === "cancelled") {
      return undefined;
    }
    if (current.status === "cancelling" || heartbeat.result === "cancel-requested") {
      await this.options.store.acknowledgeCancellation(currentMutation);
      return undefined;
    }
    let persisted: boolean;
    if (this.options.isClosing() && controller.signal.aborted) {
      persisted = await this.options.store.release(currentMutation);
    } else if (outcome.status === "succeeded") {
      persisted = await this.options.store.complete(currentMutation, outcome.result);
    } else {
      const failureNumber = claimed.execution.failures + 1;
      persisted = await this.options.store.fail({
        ...currentMutation,
        error: serializeError(outcome.error),
        retryAt: retryAt(claimed.execution.retry, failureNumber, now),
      });
    }
    if (!persisted) {
      // Cancellation can win after the state read but before the fenced terminal write.
      await this.options.store.acknowledgeCancellation({ ...mutation, now: Date.now() });
    }
  }
}
