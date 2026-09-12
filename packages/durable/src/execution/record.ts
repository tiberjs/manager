import { createHash, randomUUID } from "node:crypto";
import { serialize } from "node:v8";
import type { ExecutionOptions, ExecutionRecord } from "../types.js";
import type { RegisteredDurableJob } from "../job/registry.js";
import { normalizePolicy } from "./retry.js";

export function createExecutionRecord(
  job: RegisteredDurableJob,
  input: unknown,
  options: ExecutionOptions,
  now: number,
): ExecutionRecord {
  if (options.key !== undefined && (typeof options.key !== "string" || options.key.length === 0)) {
    throw new TypeError("Execution key must not be empty.");
  }
  const snapshot = structuredClone(input);
  return {
    submission: {
      id: options.key
        ? createHash("sha256")
            .update(JSON.stringify([job.name, options.key]))
            .digest("hex")
        : randomUUID(),
      ...(options.key ? { key: options.key } : {}),
      job: job.name,
      input: snapshot,
      inputFingerprint: fingerprint(snapshot),
      retry: normalizePolicy(options.retry, job.retry),
      createdAt: now,
    },
    projection: {
      revision: 0,
      status: "pending",
      attempt: 0,
      failures: 0,
      availableAt: now,
      updatedAt: now,
    },
    checkpoints: {},
  };
}

/** Fingerprints the persisted input representation, not live references captured by a closure. */
export function fingerprint(value: unknown): string {
  return createHash("sha256").update(serialize(value)).digest("hex");
}
