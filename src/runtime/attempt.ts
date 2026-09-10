import { Scope, combinedError, currentAttachment, execute, signal } from "@tiberjs/runner";
import type { Factory, InjectionToken } from "@tiberjs/runner";
import type { ExecutionInfo, StepConstructor } from "../types.js";

const EXECUTION_ATTACHMENT = Symbol("tiberjs.manager.execution");

interface ManagerAttachment {
  readonly [EXECUTION_ATTACHMENT]: true;
  readonly executionId: string;
  readonly workflow: string;
  readonly nodeId: string;
  readonly attempt: number;
}

export interface AttemptProvider<T = unknown> {
  readonly token: InjectionToken<T>;
  readonly factory: Factory<T>;
}

export interface NodeAttempt {
  readonly executionId: string;
  readonly workflow: string;
  readonly nodeId: string;
  readonly attempt: number;
  readonly handler: StepConstructor;
  readonly input: unknown;
  readonly signal: AbortSignal;
  readonly providers: readonly AttemptProvider[];
}

/** Execute one durable node activation inside an independently owned Runner scope. */
export async function executeNodeAttempt(options: NodeAttempt): Promise<unknown> {
  const scope = new Scope(undefined, { startup: true });
  for (const provider of options.providers) {
    scope.provide(provider.token, provider.factory);
  }

  const attachment: ManagerAttachment = {
    [EXECUTION_ATTACHMENT]: true,
    executionId: options.executionId,
    workflow: options.workflow,
    nodeId: options.nodeId,
    attempt: options.attempt,
  };

  let result: unknown;
  let errors: unknown[] | undefined;
  try {
    result = await execute({ signal: options.signal, attachment, scope }, async () => {
      const handler = scope.use(options.handler, () => new options.handler());
      if (scope.startupPending) {
        await scope.start();
      } else {
        scope.sealStartup();
      }
      return handler.run(options.input);
    });
  } catch (error) {
    (errors ??= []).push(error);
  }

  try {
    await scope[Symbol.asyncDispose]();
  } catch (error) {
    (errors ??= []).push(error);
  }

  if (errors) {
    throw combinedError(errors, "Node execution and cleanup failed.");
  }
  return result;
}

export function currentExecution(): ExecutionInfo {
  const attachment = currentAttachment<ManagerAttachment>();
  if (!attachment[EXECUTION_ATTACHMENT]) {
    throw new Error("The current Runner execution is not a durable DAG node.");
  }
  return {
    executionId: attachment.executionId,
    workflow: attachment.workflow,
    nodeId: attachment.nodeId,
    attempt: attachment.attempt,
    signal: signal(),
  };
}
