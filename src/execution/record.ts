import { createHash, randomUUID } from "node:crypto";
import { serialize } from "node:v8";
import type {
  ExecutionOptions,
  ExecutionRecord,
  NodeRecord,
  StoredRetryPolicy,
  WorkflowConstructor,
  WorkflowInputOf,
} from "../types.js";
import type { CompiledWorkflow } from "../workflow/definition.js";
import { normalizePolicy } from "./retry.js";

export function createExecutionRecord<Workflow extends WorkflowConstructor>(
  graph: CompiledWorkflow,
  input: WorkflowInputOf<Workflow>,
  options: ExecutionOptions,
  defaultRetry: StoredRetryPolicy,
  now: number,
): ExecutionRecord {
  if (options.key !== undefined && options.key.length === 0) {
    throw new TypeError("Execution key must not be empty.");
  }

  const workflowRetry = normalizePolicy(graph.retry, defaultRetry);
  const nodes = Object.create(null) as Record<string, NodeRecord>;
  for (const node of graph.nodes.values()) {
    nodes[node.id] = {
      id: node.id,
      dependencies: node.dependencies,
      status: node.dependencies.length === 0 ? "ready" : "blocked",
      attempt: 0,
      failures: 0,
      retry: normalizePolicy(options.retry, normalizePolicy(node.retry, workflowRetry)),
      availableAt: now,
    };
  }

  return {
    id: options.key ? keyedExecutionId(graph.name, options.key) : randomUUID(),
    ...(options.key ? { key: options.key } : {}),
    workflow: graph.name,
    input,
    inputFingerprint: fingerprint(input),
    outputNodeId: graph.outputNodeId,
    status: "pending",
    nodes,
    createdAt: now,
    updatedAt: now,
  };
}

function keyedExecutionId(workflow: string, key: string): string {
  return createHash("sha256").update(workflow).update("\0").update(key).digest("hex");
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(serialize(value)).digest("hex");
}
