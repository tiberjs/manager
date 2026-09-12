import { Container, ContainerKey } from "@tiberjs/di";
import type { Factory, InjectionToken } from "@tiberjs/di";
import {
  combinedError,
  currentAttachment,
  currentState,
  execute,
  provide,
  runWith,
  signal,
} from "@tiberjs/runner";
import type { RuntimeState } from "@tiberjs/runner";
import type { DurableJobConstructor, ExecutionInfo } from "../types.js";
import type { ExecutionStore } from "../persistence/store.js";
import { CheckpointRuntime, CheckpointContext } from "./checkpoint.js";

const EXECUTION_ATTACHMENT = Symbol("tiberjs.durable.execution");

interface AttemptAttachment {
  readonly [EXECUTION_ATTACHMENT]: true;
  readonly executionId: string;
  readonly job: string;
  readonly attempt: number;
}

export interface AttemptProvider<T = unknown> {
  readonly token: InjectionToken<T>;
  readonly factory: Factory<T>;
}

export interface AttemptOptions {
  readonly executionId: string;
  readonly job: string;
  readonly activationId: string;
  readonly attempt: number;
  readonly handler: DurableJobConstructor;
  readonly store: ExecutionStore;
  readonly input: unknown;
  readonly signal: AbortSignal;
  readonly providers: readonly AttemptProvider[];
}

/** Wrap one logical job attempt in independently owned Runner and DI boundaries. */
export async function executeJobAttempt(options: AttemptOptions): Promise<unknown> {
  const container = new Container();
  for (const provider of options.providers) {
    container.provide(provider.token, provider.factory);
  }
  container.provide(
    CheckpointContext,
    () => new CheckpointRuntime(options.store, options.executionId, options.activationId),
  );

  const attachment: AttemptAttachment = {
    [EXECUTION_ATTACHMENT]: true,
    executionId: options.executionId,
    job: options.job,
    attempt: options.attempt,
  };

  let result: unknown;
  let errors: unknown[] | undefined;
  let state: RuntimeState | undefined;
  try {
    result = await execute(
      {
        signal: options.signal,
        attachment,
        values: [provide(ContainerKey, container)],
      },
      async () => {
        state = currentState();
        const handler = container.use(options.handler, () => new options.handler());
        return handler.run(options.input as never);
      },
    );
  } catch (error) {
    (errors ??= []).push(error);
  }

  try {
    if (state) {
      await runWith(state, () => container[Symbol.asyncDispose]());
    } else {
      await container[Symbol.asyncDispose]();
    }
  } catch (error) {
    (errors ??= []).push(error);
  }

  if (errors) {
    throw combinedError(errors, "Job execution and cleanup failed.");
  }
  return result;
}

export function currentExecution(): ExecutionInfo {
  const attachment = currentAttachment<AttemptAttachment | undefined>();
  if (!attachment?.[EXECUTION_ATTACHMENT]) {
    throw new Error("The current Runner execution is not a durable job.");
  }
  return {
    executionId: attachment.executionId,
    job: attachment.job,
    attempt: attachment.attempt,
    signal: signal(),
  };
}
