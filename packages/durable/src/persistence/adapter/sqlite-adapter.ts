import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { deserialize, serialize } from "node:v8";
import {
  beginExecutionCheckpoint,
  completeExecutionCheckpoint,
  releaseExecutionCheckpoint,
} from "../../execution/checkpoint-state.js";
import { commitTransition } from "../../execution/ledger.js";
import {
  acknowledgeExecutionCancellation,
  cancelExecution,
  claimExecution,
  completeExecution,
  failExecution,
  heartbeatExecution,
  recoverExpiredExecution,
  releaseExecution,
} from "../../execution/state.js";
import type { ExecutionTransition } from "../../execution/state.js";
import type {
  ActivationLease,
  CheckpointRecord,
  ExecutionEvent,
  ExecutionProjection,
  ExecutionRecord,
  ExecutionStatus,
  ExecutionSubmission,
  SerializedError,
  StoredExecutionEvent,
  StoredRetryPolicy,
} from "../../types.js";
import type {
  BeginCheckpointResult,
  CheckpointMutation,
  ClaimedExecution,
  ClaimExecutionOptions,
  CreateExecutionResult,
  ExecutionFailure,
  ExecutionMutation,
  ExecutionStore,
  HeartbeatResult,
} from "../store.js";

const SCHEMA_VERSION = 1;

export interface SQLiteAdapterOptions {
  readonly busyTimeoutMs?: number;
}

/** File-backed atomic ledger, projection, checkpoint, and activation storage. */
export class SQLiteAdapter implements ExecutionStore, Disposable {
  private readonly database: DatabaseSync;

  constructor(path: string | URL, options: SQLiteAdapterOptions = {}) {
    const busyTimeoutMs = options.busyTimeoutMs ?? 5_000;
    if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0) {
      throw new TypeError("SQLite busyTimeoutMs must be a non-negative safe integer.");
    }
    this.database = new DatabaseSync(path);
    try {
      this.database.exec(`
        PRAGMA foreign_keys = ON;
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        PRAGMA busy_timeout = ${busyTimeoutMs};
      `);
      this.initializeSchema();
    } catch (error) {
      if (this.database.isOpen) this.database.close();
      throw error;
    }
  }

  async create(record: ExecutionRecord): Promise<CreateExecutionResult> {
    return this.writeTransaction(() => {
      const existing = this.loadUnsafe(record.submission.id);
      if (existing) return { execution: existing, created: false };
      const transition: ExecutionTransition = {
        execution: record,
        events: [
          {
            type: "execution-submitted",
            submission: record.submission,
            at: record.submission.createdAt,
          },
        ],
      };
      const committed = commitTransition(undefined, transition);
      this.insertSubmission(committed.execution.submission);
      this.insertProjection(committed.execution.projection, committed.execution.submission.id);
      this.updateCheckpoints(
        { ...committed.execution, checkpoints: Object.create(null) },
        committed.execution,
      );
      this.insertEvents(committed.events);
      return { execution: committed.execution, created: true };
    });
  }

  async load(id: string): Promise<ExecutionRecord | null> {
    return this.readTransaction(() => this.loadUnsafe(id));
  }

  async readEvents(id: string): Promise<readonly StoredExecutionEvent[]> {
    return this.readTransaction(() => {
      const rows = this.database
        .prepare(
          `SELECT sequence, event
             FROM durable_execution_events
            WHERE execution_id = ?
            ORDER BY sequence`,
        )
        .all(id);
      return rows.map((row): StoredExecutionEvent => ({
        executionId: id,
        sequence: integerColumn(row, "sequence"),
        event: decodeEvent(blobColumn(row, "event")),
      }));
    });
  }

  async claim(options: ClaimExecutionOptions): Promise<ClaimedExecution | null> {
    if (options.jobs.length === 0) return null;
    return this.writeTransaction(() => {
      const placeholders = options.jobs.map(() => "?").join(", ");
      const selected = this.database
        .prepare(
          `SELECT s.id
             FROM durable_execution_submissions AS s
             JOIN durable_execution_projections AS p ON p.execution_id = s.id
            WHERE p.status = 'pending'
              AND p.available_at <= ?
              AND s.job IN (${placeholders})
            ORDER BY s.created_at, s.id
            LIMIT 1`,
        )
        .get(options.now, ...options.jobs);
      if (!selected) return null;
      const current = this.requireExecution(stringColumn(selected, "id"));
      const activationId = randomUUID();
      const transition = claimExecution(current, options, activationId);
      if (!transition) return null;
      const execution = this.persist(current, transition);
      return { execution, activationId };
    });
  }

  async heartbeat(
    mutation: ExecutionMutation,
    workerId: string,
    leaseExpiresAt: number,
  ): Promise<HeartbeatResult> {
    return this.writeTransaction(() => {
      const current = this.loadUnsafe(mutation.executionId);
      if (!current) return "lost";
      const heartbeat = heartbeatExecution(current, mutation, workerId, leaseExpiresAt);
      if (heartbeat.execution) {
        this.persist(current, { execution: heartbeat.execution, events: [] });
      }
      return heartbeat.result;
    });
  }

  async complete(mutation: ExecutionMutation, result: unknown): Promise<boolean> {
    return this.update(mutation.executionId, (current) =>
      completeExecution(current, mutation, cloneSerializable(result)),
    );
  }

  async fail(failure: ExecutionFailure): Promise<boolean> {
    const stored = { ...failure, error: cloneSerializable(failure.error) };
    return this.update(failure.executionId, (current) => failExecution(current, stored));
  }

  async release(mutation: ExecutionMutation): Promise<boolean> {
    return this.update(mutation.executionId, (current) => releaseExecution(current, mutation));
  }

  async acknowledgeCancellation(mutation: ExecutionMutation): Promise<boolean> {
    return this.update(mutation.executionId, (current) =>
      acknowledgeExecutionCancellation(current, mutation),
    );
  }

  async cancel(id: string, reason: SerializedError, now: number): Promise<boolean> {
    const storedReason = cloneSerializable(reason);
    return this.update(id, (current) => cancelExecution(current, storedReason, now));
  }

  async recoverExpired(now: number): Promise<number> {
    return this.writeTransaction(() => {
      const rows = this.database
        .prepare(
          `SELECT p.execution_id
             FROM durable_execution_projections AS p
             JOIN durable_activation_leases AS l ON l.execution_id = p.execution_id
            WHERE p.status IN ('running', 'cancelling')
              AND l.lease_expires_at <= ?`,
        )
        .all(now);
      let recovered = 0;
      for (const row of rows) {
        const current = this.requireExecution(stringColumn(row, "execution_id"));
        const transition = recoverExpiredExecution(current, now);
        if (transition) {
          this.persist(current, transition);
          recovered += 1;
        }
      }
      return recovered;
    });
  }

  async beginCheckpoint(mutation: CheckpointMutation): Promise<BeginCheckpointResult> {
    return this.writeTransaction(() => {
      const current = this.loadUnsafe(mutation.executionId);
      if (!current) return { status: "lost" };
      const checkpoint = beginExecutionCheckpoint(current, mutation);
      if (checkpoint.transition) this.persist(current, checkpoint.transition);
      return cloneSerializable(checkpoint.outcome);
    });
  }

  async completeCheckpoint(mutation: CheckpointMutation, result: unknown): Promise<boolean> {
    return this.update(mutation.executionId, (current) =>
      completeExecutionCheckpoint(current, mutation, cloneSerializable(result)),
    );
  }

  async releaseCheckpoint(mutation: CheckpointMutation): Promise<boolean> {
    return this.update(mutation.executionId, (current) =>
      releaseExecutionCheckpoint(current, mutation),
    );
  }

  close(): void {
    if (this.database.isOpen) this.database.close();
  }

  [Symbol.dispose](): void {
    this.close();
  }

  private initializeSchema(): void {
    const version = integerColumn(
      this.database.prepare("PRAGMA user_version").get(),
      "user_version",
    );
    if (version !== 0 && version !== SCHEMA_VERSION) {
      this.database.close();
      throw new Error(`Unsupported durable SQLite schema version ${version}.`);
    }
    if (version === SCHEMA_VERSION) return;
    this.database.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE durable_execution_submissions (
        id TEXT PRIMARY KEY,
        execution_key TEXT,
        job TEXT NOT NULL,
        input BLOB NOT NULL,
        input_fingerprint TEXT NOT NULL,
        retry_retries INTEGER NOT NULL,
        retry_delay_ms INTEGER NOT NULL,
        retry_backoff REAL NOT NULL,
        retry_max_delay_ms INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX durable_submission_claim_order
        ON durable_execution_submissions(job, created_at, id);
      CREATE TABLE durable_execution_projections (
        execution_id TEXT PRIMARY KEY REFERENCES durable_execution_submissions(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'cancelling', 'completed', 'failed', 'cancelled')),
        attempt INTEGER NOT NULL,
        failures INTEGER NOT NULL,
        available_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        result BLOB,
        error BLOB,
        cancellation_reason BLOB
      ) STRICT;
      CREATE INDEX durable_execution_schedule
        ON durable_execution_projections(status, available_at, execution_id);
      CREATE TABLE durable_activation_leases (
        execution_id TEXT PRIMARY KEY REFERENCES durable_execution_submissions(id) ON DELETE CASCADE,
        activation_id TEXT NOT NULL UNIQUE,
        worker_id TEXT NOT NULL,
        lease_expires_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX durable_activation_expiration
        ON durable_activation_leases(lease_expires_at);
      CREATE TABLE durable_checkpoint_projections (
        execution_id TEXT NOT NULL REFERENCES durable_execution_submissions(id) ON DELETE CASCADE,
        checkpoint_key TEXT NOT NULL,
        input_fingerprint TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed')),
        activation_id TEXT,
        result BLOB,
        PRIMARY KEY (execution_id, checkpoint_key),
        CHECK ((status = 'running') = (activation_id IS NOT NULL)),
        CHECK ((status = 'completed') = (result IS NOT NULL))
      ) STRICT;
      CREATE TABLE durable_execution_events (
        execution_id TEXT NOT NULL REFERENCES durable_execution_submissions(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        type TEXT NOT NULL,
        at INTEGER NOT NULL,
        event BLOB NOT NULL,
        PRIMARY KEY (execution_id, sequence)
      ) STRICT;
      PRAGMA user_version = ${SCHEMA_VERSION};
      COMMIT;
    `);
  }

  private update(
    id: string,
    transition: (current: ExecutionRecord) => ExecutionTransition | undefined,
  ): Promise<boolean> {
    return Promise.resolve(
      this.writeTransaction(() => {
        const current = this.loadUnsafe(id);
        if (!current) return false;
        const updated = transition(current);
        if (!updated) return false;
        this.persist(current, updated);
        return true;
      }),
    );
  }

  private persist(current: ExecutionRecord, transition: ExecutionTransition): ExecutionRecord {
    const committed = commitTransition(current, transition);
    const { execution } = committed;
    this.updateProjection(execution.projection, execution.submission.id);
    this.updateActivation(execution.submission.id, current.activation, execution.activation);
    this.updateCheckpoints(current, execution);
    this.insertEvents(committed.events);
    return execution;
  }

  private insertSubmission(submission: ExecutionSubmission): void {
    this.database
      .prepare(
        `INSERT INTO durable_execution_submissions (
          id, execution_key, job, input, input_fingerprint,
          retry_retries, retry_delay_ms, retry_backoff, retry_max_delay_ms, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        submission.id,
        submission.key ?? null,
        submission.job,
        encode(submission.input),
        submission.inputFingerprint,
        submission.retry.retries,
        submission.retry.delayMs,
        submission.retry.backoff,
        submission.retry.maxDelayMs,
        submission.createdAt,
      );
  }

  private insertProjection(projection: ExecutionProjection, executionId: string): void {
    this.database
      .prepare(
        `INSERT INTO durable_execution_projections (
          execution_id, revision, status, attempt, failures, available_at, updated_at,
          result, error, cancellation_reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(executionId, ...projectionValues(projection));
  }

  private updateProjection(projection: ExecutionProjection, executionId: string): void {
    const updated = this.database
      .prepare(
        `UPDATE durable_execution_projections
            SET revision = ?, status = ?, attempt = ?, failures = ?, available_at = ?,
                updated_at = ?, result = ?, error = ?, cancellation_reason = ?
          WHERE execution_id = ?`,
      )
      .run(...projectionValues(projection), executionId);
    if (updated.changes !== 1) throw new Error(`Execution projection ${executionId} was lost.`);
  }

  private updateActivation(
    executionId: string,
    current: ActivationLease | undefined,
    next: ActivationLease | undefined,
  ): void {
    if (current === next) return;
    if (current && next) {
      const updated = this.database
        .prepare(
          `UPDATE durable_activation_leases
              SET activation_id = ?, worker_id = ?, lease_expires_at = ?
            WHERE execution_id = ?`,
        )
        .run(next.activationId, next.workerId, next.leaseExpiresAt, executionId);
      if (updated.changes !== 1) throw new Error(`Activation lease ${executionId} was lost.`);
      return;
    }
    if (current) {
      this.database
        .prepare("DELETE FROM durable_activation_leases WHERE execution_id = ?")
        .run(executionId);
    }
    if (!next) return;
    this.database
      .prepare(
        `INSERT INTO durable_activation_leases (
          execution_id, activation_id, worker_id, lease_expires_at
        ) VALUES (?, ?, ?, ?)`,
      )
      .run(executionId, next.activationId, next.workerId, next.leaseExpiresAt);
  }

  private updateCheckpoints(current: ExecutionRecord, next: ExecutionRecord): void {
    const statement = this.database.prepare(
      `INSERT INTO durable_checkpoint_projections (
        execution_id, checkpoint_key, input_fingerprint, status, activation_id, result
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (execution_id, checkpoint_key) DO UPDATE SET
        input_fingerprint = excluded.input_fingerprint,
        status = excluded.status,
        activation_id = excluded.activation_id,
        result = excluded.result`,
    );
    for (const [key, checkpoint] of Object.entries(next.checkpoints)) {
      if (current.checkpoints[key] === checkpoint) continue;
      statement.run(
        next.submission.id,
        key,
        checkpoint.inputFingerprint,
        checkpoint.status,
        checkpoint.status === "running" ? checkpoint.activationId : null,
        checkpoint.status === "completed" ? encode(checkpoint.result) : null,
      );
    }
  }

  private insertEvents(events: readonly StoredExecutionEvent[]): void {
    if (events.length === 0) return;
    const statement = this.database.prepare(
      `INSERT INTO durable_execution_events (execution_id, sequence, type, at, event)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const stored of events) {
      statement.run(
        stored.executionId,
        stored.sequence,
        stored.event.type,
        stored.event.at,
        encode(stored.event),
      );
    }
  }

  private loadUnsafe(id: string): ExecutionRecord | null {
    const submissionRow = this.database
      .prepare("SELECT * FROM durable_execution_submissions WHERE id = ?")
      .get(id);
    if (!submissionRow) return null;
    const projectionRow = this.database
      .prepare("SELECT * FROM durable_execution_projections WHERE execution_id = ?")
      .get(id);
    if (!projectionRow) throw new Error(`Execution projection ${id} is missing.`);
    const activationRow = this.database
      .prepare("SELECT * FROM durable_activation_leases WHERE execution_id = ?")
      .get(id);
    const checkpointRows = this.database
      .prepare("SELECT * FROM durable_checkpoint_projections WHERE execution_id = ?")
      .all(id);
    const checkpoints: Record<string, CheckpointRecord> = Object.create(null);
    for (const row of checkpointRows) {
      const checkpoint = decodeCheckpoint(row);
      checkpoints[checkpoint.key] = checkpoint;
    }
    return {
      submission: decodeSubmission(submissionRow),
      projection: decodeProjection(projectionRow),
      ...(activationRow ? { activation: decodeActivation(activationRow) } : {}),
      checkpoints,
    };
  }

  private requireExecution(id: string): ExecutionRecord {
    const execution = this.loadUnsafe(id);
    if (!execution) throw new Error(`Execution ${id} disappeared during a transaction.`);
    return execution;
  }

  private writeTransaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      if (this.database.isTransaction) this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private readTransaction<T>(operation: () => T): T {
    this.database.exec("BEGIN");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      if (this.database.isTransaction) this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

function projectionValues(projection: ExecutionProjection) {
  return [
    projection.revision,
    projection.status,
    projection.attempt,
    projection.failures,
    projection.availableAt,
    projection.updatedAt,
    projection.status === "completed" ? encode(projection.result) : null,
    projection.error ? encode(projection.error) : null,
    projection.cancellationReason ? encode(projection.cancellationReason) : null,
  ] as const;
}

function encode(value: unknown): Uint8Array {
  return serialize(value);
}

function decode(blob: Uint8Array): unknown {
  return deserialize(blob);
}

function cloneSerializable<T>(value: T): T {
  return deserialize(serialize(value));
}

function decodeSubmission(row: Record<string, unknown>): ExecutionSubmission {
  const key = nullableStringColumn(row, "execution_key");
  return {
    id: stringColumn(row, "id"),
    ...(key === null ? {} : { key }),
    job: stringColumn(row, "job"),
    input: decode(blobColumn(row, "input")),
    inputFingerprint: stringColumn(row, "input_fingerprint"),
    retry: {
      retries: integerColumn(row, "retry_retries"),
      delayMs: numberColumn(row, "retry_delay_ms"),
      backoff: numberColumn(row, "retry_backoff"),
      maxDelayMs: numberColumn(row, "retry_max_delay_ms"),
    },
    createdAt: numberColumn(row, "created_at"),
  };
}

function decodeProjection(row: Record<string, unknown>): ExecutionProjection {
  const status = statusColumn(row, "status");
  const error = nullableBlobColumn(row, "error");
  const cancellationReason = nullableBlobColumn(row, "cancellation_reason");
  const result = nullableBlobColumn(row, "result");
  return {
    revision: integerColumn(row, "revision"),
    status,
    attempt: integerColumn(row, "attempt"),
    failures: integerColumn(row, "failures"),
    availableAt: numberColumn(row, "available_at"),
    updatedAt: numberColumn(row, "updated_at"),
    ...(status === "completed" ? { result: decodeRequired(result, "result") } : {}),
    ...(error ? { error: parseSerializedError(decode(error)) } : {}),
    ...(cancellationReason
      ? { cancellationReason: parseSerializedError(decode(cancellationReason)) }
      : {}),
  };
}

function decodeActivation(row: Record<string, unknown>): ActivationLease {
  return {
    activationId: stringColumn(row, "activation_id"),
    workerId: stringColumn(row, "worker_id"),
    leaseExpiresAt: numberColumn(row, "lease_expires_at"),
  };
}

function decodeCheckpoint(row: Record<string, unknown>): CheckpointRecord {
  const key = stringColumn(row, "checkpoint_key");
  const inputFingerprint = stringColumn(row, "input_fingerprint");
  const status = stringColumn(row, "status");
  if (status === "pending") return { key, inputFingerprint, status };
  if (status === "running") {
    return { key, inputFingerprint, status, activationId: stringColumn(row, "activation_id") };
  }
  if (status === "completed") {
    return {
      key,
      inputFingerprint,
      status,
      result: decodeRequired(nullableBlobColumn(row, "result"), "checkpoint result"),
    };
  }
  throw new Error(`Invalid checkpoint status ${JSON.stringify(status)}.`);
}

function decodeEvent(blob: Uint8Array): ExecutionEvent {
  return parseExecutionEvent(decode(blob));
}

function parseExecutionEvent(value: unknown): ExecutionEvent {
  const event = objectValue(value, "execution event");
  const type = stringValue(event.type, "execution event type");
  const at = numberValue(event.at, "execution event timestamp");
  switch (type) {
    case "execution-submitted":
      return { type, at, submission: parseSubmission(event.submission) };
    case "attempt-started":
      return {
        type,
        at,
        attempt: integerValue(event.attempt, "attempt"),
        activationId: stringValue(event.activationId, "activation ID"),
        workerId: stringValue(event.workerId, "worker ID"),
      };
    case "attempt-failed": {
      const retryAt = optionalNumberValue(event.retryAt, "retry timestamp");
      return {
        type,
        at,
        attempt: integerValue(event.attempt, "attempt"),
        activationId: stringValue(event.activationId, "activation ID"),
        failure: integerValue(event.failure, "failure"),
        error: parseSerializedError(event.error),
        ...(retryAt === undefined ? {} : { retryAt }),
      };
    }
    case "attempt-released":
      if (event.reason !== "manager-shutdown") {
        throw new Error("Invalid attempt release reason.");
      }
      return {
        type,
        at,
        attempt: integerValue(event.attempt, "attempt"),
        activationId: stringValue(event.activationId, "activation ID"),
        reason: event.reason,
      };
    case "activation-expired": {
      const retryAt = optionalNumberValue(event.retryAt, "retry timestamp");
      return {
        type,
        at,
        attempt: integerValue(event.attempt, "attempt"),
        activationId: stringValue(event.activationId, "activation ID"),
        failure: integerValue(event.failure, "failure"),
        ...(retryAt === undefined ? {} : { retryAt }),
      };
    }
    case "cancellation-requested":
      return { type, at, reason: parseSerializedError(event.reason) };
    case "execution-cancelled": {
      const activationId = optionalStringValue(event.activationId, "activation ID");
      return { type, at, ...(activationId === undefined ? {} : { activationId }) };
    }
    case "execution-completed":
      if (!Object.hasOwn(event, "result"))
        throw new Error("Execution completion result is missing.");
      return {
        type,
        at,
        attempt: integerValue(event.attempt, "attempt"),
        activationId: stringValue(event.activationId, "activation ID"),
        result: event.result,
      };
    case "checkpoint-declared":
      return {
        type,
        at,
        key: stringValue(event.key, "checkpoint key"),
        inputFingerprint: stringValue(event.inputFingerprint, "checkpoint input fingerprint"),
      };
    case "checkpoint-completed":
      if (!Object.hasOwn(event, "result")) throw new Error("Checkpoint result is missing.");
      return {
        type,
        at,
        key: stringValue(event.key, "checkpoint key"),
        inputFingerprint: stringValue(event.inputFingerprint, "checkpoint input fingerprint"),
        activationId: stringValue(event.activationId, "activation ID"),
        result: event.result,
      };
    default:
      throw new Error(`Unknown execution event ${JSON.stringify(type)}.`);
  }
}

function parseSubmission(value: unknown): ExecutionSubmission {
  const submission = objectValue(value, "execution submission");
  const key = optionalStringValue(submission.key, "execution key");
  return {
    id: stringValue(submission.id, "execution ID"),
    ...(key === undefined ? {} : { key }),
    job: stringValue(submission.job, "job name"),
    input: submission.input,
    inputFingerprint: stringValue(submission.inputFingerprint, "input fingerprint"),
    retry: parseRetryPolicy(submission.retry),
    createdAt: numberValue(submission.createdAt, "created timestamp"),
  };
}

function parseRetryPolicy(value: unknown): StoredRetryPolicy {
  const retry = objectValue(value, "retry policy");
  return {
    retries: integerValue(retry.retries, "retries"),
    delayMs: numberValue(retry.delayMs, "retry delay"),
    backoff: numberValue(retry.backoff, "retry backoff"),
    maxDelayMs: numberValue(retry.maxDelayMs, "maximum retry delay"),
  };
}

function parseSerializedError(value: unknown): SerializedError {
  const error = objectValue(value, "serialized error");
  const stack = optionalStringValue(error.stack, "error stack");
  const cause = error.cause === undefined ? undefined : parseSerializedError(error.cause);
  let errors: readonly SerializedError[] | undefined;
  if (error.errors !== undefined) {
    if (!Array.isArray(error.errors))
      throw new Error("Serialized aggregate errors must be an array.");
    errors = error.errors.map(parseSerializedError);
  }
  return {
    name: stringValue(error.name, "error name"),
    message: stringValue(error.message, "error message"),
    ...(stack === undefined ? {} : { stack }),
    ...(cause === undefined ? {} : { cause }),
    ...(errors === undefined ? {} : { errors }),
  };
}

function statusColumn(row: Record<string, unknown>, name: string): ExecutionStatus {
  const status = stringColumn(row, name);
  switch (status) {
    case "pending":
    case "running":
    case "cancelling":
    case "completed":
    case "failed":
    case "cancelled":
      return status;
    default:
      throw new Error(`Invalid execution status ${JSON.stringify(status)}.`);
  }
}

type UnknownObject = Record<string, unknown>;

function objectValue(value: unknown, name: string): UnknownObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid ${name}.`);
  }
  return value as UnknownObject;
}

function stringColumn(row: Record<string, unknown> | undefined, name: string): string {
  if (!row) throw new Error(`SQLite column ${name} is missing.`);
  return stringValue(row[name], `SQLite column ${name}`);
}

function nullableStringColumn(row: Record<string, unknown>, name: string): string | null {
  const value = row[name];
  if (value === null) return null;
  return stringValue(value, `SQLite column ${name}`);
}

function numberColumn(row: Record<string, unknown> | undefined, name: string): number {
  if (!row) throw new Error(`SQLite column ${name} is missing.`);
  return numberValue(row[name], `SQLite column ${name}`);
}

function integerColumn(row: Record<string, unknown> | undefined, name: string): number {
  if (!row) throw new Error(`SQLite column ${name} is missing.`);
  return integerValue(row[name], `SQLite column ${name}`);
}

function blobColumn(row: Record<string, unknown>, name: string): Uint8Array {
  const value = row[name];
  if (!(value instanceof Uint8Array)) throw new Error(`SQLite column ${name} is not a blob.`);
  return value;
}

function nullableBlobColumn(row: Record<string, unknown>, name: string): Uint8Array | null {
  const value = row[name];
  if (value === null) return null;
  if (!(value instanceof Uint8Array)) throw new Error(`SQLite column ${name} is not a blob.`);
  return value;
}

function stringValue(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`Invalid ${name}.`);
  return value;
}

function optionalStringValue(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  return stringValue(value, name);
}

function numberValue(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Invalid ${name}.`);
  return value;
}

function integerValue(value: unknown, name: string): number {
  const number = numberValue(value, name);
  if (!Number.isSafeInteger(number)) throw new Error(`Invalid ${name}.`);
  return number;
}

function optionalNumberValue(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  return numberValue(value, name);
}

function decodeRequired(value: Uint8Array | null, name: string): unknown {
  if (!value) throw new Error(`SQLite ${name} is missing.`);
  return decode(value);
}
