import { setTimeout as delay } from "node:timers/promises";
import { ActivationLostError } from "../errors.js";
import type { ExecutionMutation, ExecutionStore, HeartbeatResult } from "../persistence/store.js";

export interface ActivationLeaseOptions {
  readonly store: ExecutionStore;
  readonly executionId: string;
  readonly activationId: string;
  readonly workerId: string;
  readonly durationMs: number;
  readonly intervalMs: number;
  readonly controller: AbortController;
}

/** Owns heartbeat I/O and joins it before activation finalization inspects its outcome. */
export class ActivationLease {
  private readonly stopping = new AbortController();
  private readonly finished: Promise<void>;
  result: HeartbeatResult | undefined;
  failure: { readonly error: unknown } | undefined;

  constructor(private readonly options: ActivationLeaseOptions) {
    this.finished = this.renew();
  }

  async stop(): Promise<void> {
    this.stopping.abort();
    await this.finished;
  }

  private async renew(): Promise<void> {
    while (!this.stopping.signal.aborted) {
      try {
        await delay(this.options.intervalMs, undefined, { signal: this.stopping.signal });
      } catch (error) {
        if (this.stopping.signal.aborted) return;
        this.failure = { error };
        this.options.controller.abort(error);
        return;
      }

      const now = Date.now();
      const mutation: ExecutionMutation = {
        executionId: this.options.executionId,
        activationId: this.options.activationId,
        now,
      };
      try {
        this.result = await this.options.store.heartbeat(
          mutation,
          this.options.workerId,
          now + this.options.durationMs,
        );
        if (this.result === "cancel-requested") {
          this.options.controller.abort(new DOMException("Execution cancelled", "AbortError"));
          return;
        }
        if (this.result === "lost") {
          this.options.controller.abort(new ActivationLostError(this.options.executionId));
          return;
        }
      } catch (error) {
        this.failure = { error };
        this.options.controller.abort(error);
        return;
      }
    }
  }
}
