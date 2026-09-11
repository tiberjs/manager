import { createHash, randomUUID } from "node:crypto";
import { serialize } from "node:v8";
import type { ExecutionOptions, ExecutionRecord } from "../types.js";
import type { RegisteredJob } from "../job/registry.js";
import { normalizePolicy } from "./retry.js";

export function createExecutionRecord(
  job: RegisteredJob,
  input: unknown,
  options: ExecutionOptions,
  now: number,
): ExecutionRecord {
  if (options.key !== undefined && (typeof options.key !== "string" || options.key.length === 0)) {
    throw new TypeError("Execution key must not be empty.");
  }
  const snapshot = structuredClone(input);
  return {
    id: options.key
      ? createHash("sha256")
          .update(JSON.stringify([job.name, options.key]))
          .digest("hex")
      : randomUUID(),
    ...(options.key ? { key: options.key } : {}),
    job: job.name,
    input: snapshot,
    inputFingerprint: fingerprint(snapshot),
    status: "pending",
    attempt: 0,
    failures: 0,
    retry: normalizePolicy(options.retry, job.retry),
    availableAt: now,
    checkpoints: {},
    createdAt: now,
    updatedAt: now,
  };
}

/** Fingerprints the persisted input representation, not live references captured by a closure. */
export function fingerprint(value: unknown): string {
  return createHash("sha256").update(serialize(value)).digest("hex");
}
