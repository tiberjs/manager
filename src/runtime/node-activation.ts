import { ActivationLostError, serializeError } from "../errors.js";
import { retryAt } from "../execution/retry.js";
import type {
  ClaimedNode,
  ExecutionStore,
  HeartbeatResult,
  NodeMutation,
} from "../persistence/store.js";
import type { WorkflowRegistry } from "../workflow/registry.js";
import { resolveBinding } from "../workflow/definition.js";
import { executeNodeAttempt } from "./attempt.js";
import type { AttemptProvider } from "./attempt.js";

export interface NodeActivationOptions {
  readonly store: ExecutionStore;
  readonly registry: WorkflowRegistry;
  readonly providers: readonly AttemptProvider[];
  readonly workerId: string;
  readonly leaseDurationMs: number;
  readonly heartbeatIntervalMs: number;
  readonly isClosing: () => boolean;
}

export interface TerminalNodeFailure {
  readonly executionId: string;
  readonly reason: unknown;
}

interface Heartbeat {
  readonly stop: AbortController;
  finished: Promise<void>;
  result: HeartbeatResult | undefined;
  error: unknown;
}

/** Resolves, executes, heartbeats, and commits one claimed node activation. */
export class NodeActivationRunner {
  private readonly options: NodeActivationOptions;

  constructor(options: NodeActivationOptions) {
    this.options = options;
  }

  async run(
    claimed: ClaimedNode,
    controller: AbortController,
  ): Promise<TerminalNodeFailure | undefined> {
    const registered = this.options.registry.find(claimed.execution.workflow);
    const definition = registered?.graph.nodes.get(claimed.nodeId);
    const node = claimed.execution.nodes[claimed.nodeId];
    if (!registered || !definition || !node) {
      throw new Error(
        `Registered graph is missing ${claimed.execution.workflow}/${claimed.nodeId}.`,
      );
    }

    const input = resolveBinding(
      definition.input,
      registered.graph,
      claimed.execution.input,
      dependencyResults(claimed, definition.dependencies),
    );
    const mutation: NodeMutation = {
      executionId: claimed.execution.id,
      nodeId: claimed.nodeId,
      activationId: claimed.activationId,
      now: Date.now(),
    };
    const heartbeat = this.startHeartbeat(mutation, controller);
    let result: unknown;
    let failure: unknown;
    let failed = false;

    try {
      result = await executeNodeAttempt({
        executionId: claimed.execution.id,
        workflow: registered.graph.name,
        nodeId: claimed.nodeId,
        attempt: node.attempt,
        handler: definition.handler,
        input,
        signal: controller.signal,
        providers: this.options.providers,
      });
    } catch (error) {
      failed = true;
      failure = error;
    } finally {
      heartbeat.stop.abort();
      await heartbeat.finished;
    }

    if (heartbeat.error !== undefined) {
      failed = true;
      failure = heartbeat.error;
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
    if (this.options.isClosing() && controller.signal.aborted) {
      await this.options.store.release(currentMutation);
      return undefined;
    }

    if (!failed) {
      await this.options.store.complete(currentMutation, result);
      return undefined;
    }

    const failureNumber = node.failures + 1;
    const persisted = await this.options.store.fail({
      ...currentMutation,
      error: serializeError(failure),
      retryAt: retryAt(node.retry, failureNumber, now),
    });
    if (!persisted) {
      return undefined;
    }

    const updated = await this.options.store.load(claimed.execution.id);
    return updated?.status === "failed" ? { executionId: updated.id, reason: failure } : undefined;
  }

  private startHeartbeat(mutation: NodeMutation, controller: AbortController): Heartbeat {
    const heartbeat: Heartbeat = {
      stop: new AbortController(),
      finished: Promise.resolve(),
      result: undefined,
      error: undefined,
    };
    heartbeat.finished = this.heartbeatLoop(mutation, controller, heartbeat);
    return heartbeat;
  }

  private async heartbeatLoop(
    mutation: NodeMutation,
    controller: AbortController,
    heartbeat: Heartbeat,
  ): Promise<void> {
    while (!heartbeat.stop.signal.aborted) {
      try {
        await delay(this.options.heartbeatIntervalMs, heartbeat.stop.signal);
      } catch (error) {
        if (heartbeat.stop.signal.aborted) {
          return;
        }
        heartbeat.error = error;
        controller.abort(error);
        return;
      }

      const now = Date.now();
      try {
        heartbeat.result = await this.options.store.heartbeat(
          { ...mutation, now },
          this.options.workerId,
          now + this.options.leaseDurationMs,
        );
        if (heartbeat.result === "cancel-requested") {
          controller.abort(new DOMException("Execution cancelled", "AbortError"));
          return;
        }
        if (heartbeat.result === "lost") {
          controller.abort(new ActivationLostError(mutation.executionId, mutation.nodeId));
          return;
        }
      } catch (error) {
        heartbeat.error = error;
        controller.abort(error);
        return;
      }
    }
  }
}

function dependencyResults(
  claimed: ClaimedNode,
  dependencies: readonly string[],
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    dependencies.map((dependency) => {
      const completed = claimed.execution.nodes[dependency];
      if (!completed || completed.status !== "completed") {
        throw new Error(`Dependency ${JSON.stringify(dependency)} is not completed.`);
      }
      return [dependency, completed.result];
    }),
  );
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const onAbort = (): void => {
    clearTimeout(timer);
    reject(signal.reason);
  };
  const timer = setTimeout(() => {
    signal.removeEventListener("abort", onAbort);
    resolve();
  }, milliseconds);
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) {
    onAbort();
  }
  return promise;
}
