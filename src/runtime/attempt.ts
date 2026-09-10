import {
  Scope,
  combinedError,
  currentAttachment,
  currentState,
  execute,
  runWith,
  signal,
} from "@tiberjs/runner";
import type { Factory, InjectionToken, RuntimeState } from "@tiberjs/runner";
import type { ExecutionInfo, JobConstructor } from "../types.js";
import type { ExecutionStore } from "../persistence/store.js";
import { CheckpointRuntime, DurableExecution } from "./checkpoint.js";

const EXECUTION_ATTACHMENT = Symbol("tiberjs.manager.execution");

interface ManagerAttachment {
  readonly [EXECUTION_ATTACHMENT]: true;
  readonly executionId: string;
  readonly job: string;
  readonly attempt: number;
}

export interface AttemptProvider<T = unknown> {
  readonly token: InjectionToken<T>;
  readonly factory: Factory<T>;
}

export interface JobAttempt {
  readonly executionId: string;
  readonly job: string;
  readonly activationId: string;
  readonly attempt: number;
  readonly handler: JobConstructor;
  readonly store: ExecutionStore;
  readonly input: unknown;
  readonly signal: AbortSignal;
  readonly providers: readonly AttemptProvider[];
}

/** Wrap one logical job attempt in an independently owned Runner scope. */
export async function executeJobAttempt(options: JobAttempt): Promise<unknown> {
  const scope = new Scope(undefined, { startup: true });
  for (const provider of options.providers) {
    scope.provide(provider.token, provider.factory);
  }
  scope.provide(
    DurableExecution,
    () => new CheckpointRuntime(options.store, options.executionId, options.activationId),
  );

  const attachment: ManagerAttachment = {
    [EXECUTION_ATTACHMENT]: true,
    executionId: options.executionId,
    job: options.job,
    attempt: options.attempt,
  };

  let result: unknown;
  let errors: unknown[] | undefined;
  let state: RuntimeState | undefined;
  try {
    result = await execute({ signal: options.signal, attachment, scope }, async () => {
      state = currentState();
      const handler = scope.use(options.handler, () => new options.handler());
      if (scope.startupPending) {
        await scope.start();
      } else {
        scope.sealStartup();
      }
      return handler.run(options.input as never);
    });
  } catch (error) {
    (errors ??= []).push(error);
  }

  try {
    if (state) {
      await runWith(state, () => scope[Symbol.asyncDispose]());
    } else {
      await scope[Symbol.asyncDispose]();
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
  const attachment = currentAttachment<ManagerAttachment | undefined>();
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
