import { token } from "@tiberjs/di";
import { combinedError, contextKey, execute, fork, provide, signal, use } from "@tiberjs/runner";
import type { Job } from "@tiberjs/runner";
import { ActivationLostError, CheckpointIdentityConflictError } from "../errors.js";
import { fingerprint } from "../execution/record.js";
import type { CheckpointMutation, ExecutionStore } from "../persistence/store.js";

/** Injectable attempt-local checkpoint service. Operations are leaf effects, not durable child jobs. */
export interface CheckpointContext {
  checkpoint<Input, Output>(
    key: string,
    input: Input,
    operation: () => Output | PromiseLike<Output>,
  ): Job<Awaited<Output>>;
}
export const CheckpointContext = token<CheckpointContext>("tiberjs.durable.checkpoint-context");
const InsideCheckpoint = contextKey<boolean>("tiberjs.durable.inside-checkpoint");

interface InFlightCheckpoint {
  readonly fingerprint: string;
  readonly task: Job<unknown>;
}

export class CheckpointRuntime implements CheckpointContext {
  private readonly inFlight = new Map<string, InFlightCheckpoint>();

  constructor(
    private readonly store: ExecutionStore,
    private readonly executionId: string,
    private readonly activationId: string,
  ) {}

  checkpoint<Input, Output>(
    key: string,
    input: Input,
    operation: () => Output | PromiseLike<Output>,
  ): Job<Awaited<Output>> {
    if (typeof key !== "string" || key.length === 0)
      throw new TypeError("Checkpoint key must not be empty.");
    if (use(InsideCheckpoint))
      throw new TypeError("Checkpoint operations cannot contain nested checkpoints.");
    const inputFingerprint = fingerprint(structuredClone(input));
    const existing = this.inFlight.get(key);
    if (existing) {
      if (existing.fingerprint !== inputFingerprint)
        throw new CheckpointIdentityConflictError(this.executionId, key);
      return fork(async (): Promise<Awaited<Output>> => {
        await existing.task;
        // Read the committed value, not a mutable result already exposed to another caller.
        return await this.run(key, inputFingerprint, operation);
      });
    }
    const task = fork(async (): Promise<Awaited<Output>> => {
      try {
        return await this.run(key, inputFingerprint, operation);
      } finally {
        this.inFlight.delete(key);
      }
    });
    this.inFlight.set(key, { fingerprint: inputFingerprint, task });
    return task;
  }

  private async run<Output>(
    key: string,
    inputFingerprint: string,
    operation: () => Output | PromiseLike<Output>,
  ): Promise<Awaited<Output>> {
    const mutation: CheckpointMutation = {
      executionId: this.executionId,
      activationId: this.activationId,
      key,
      inputFingerprint,
      now: Date.now(),
    };
    const currentSignal = signal();
    currentSignal.throwIfAborted();
    const started = await this.store.beginCheckpoint(mutation);
    switch (started.status) {
      case "completed":
        currentSignal.throwIfAborted();
        return started.result as Awaited<Output>;
      case "conflict":
        throw new CheckpointIdentityConflictError(this.executionId, key);
      case "lost":
        throw new ActivationLostError(this.executionId);
      case "busy":
        throw new Error(
          `Checkpoint ${JSON.stringify(key)} is already reserved by this activation.`,
        );
      case "execute":
        break;
    }

    let result: Awaited<Output>;
    try {
      // beginCheckpoint may finish after this task was cancelled; release its reservation too.
      currentSignal.throwIfAborted();
      // A nested Runner boundary joins checkpoint-local forks before committing the result.
      // DI resources remain owned by the attempt container; checkpoint-local resources use
      // explicit disposal.
      result = await execute(
        { values: [provide(InsideCheckpoint, true)] },
        async (): Promise<Awaited<Output>> => await operation(),
      );
      currentSignal.throwIfAborted();
    } catch (error) {
      try {
        await this.store.releaseCheckpoint({ ...mutation, now: Date.now() });
      } catch (releaseError) {
        throw combinedError([error, releaseError], "Checkpoint operation and release failed.");
      }
      throw error;
    }
    if (!(await this.store.completeCheckpoint({ ...mutation, now: Date.now() }, result)))
      throw new ActivationLostError(this.executionId);
    currentSignal.throwIfAborted();
    return result;
  }
}
