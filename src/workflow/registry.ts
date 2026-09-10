import { DuplicateWorkflowError } from "../errors.js";
import { normalizePolicy } from "../execution/retry.js";
import type { StoredRetryPolicy, WorkflowConstructor } from "../types.js";
import type { CompiledWorkflow } from "./definition.js";
import { compileWorkflow } from "./definition.js";

export interface RegisteredWorkflow {
  readonly type: WorkflowConstructor;
  readonly graph: CompiledWorkflow;
}

/** Compiles and indexes workflow definitions without owning execution state. */
export class WorkflowRegistry {
  private readonly defaultRetry: StoredRetryPolicy;
  private readonly byName = new Map<string, RegisteredWorkflow>();
  private readonly byType = new Map<WorkflowConstructor, RegisteredWorkflow>();
  private readonly registeredNames: string[] = [];

  constructor(defaultRetry: StoredRetryPolicy) {
    this.defaultRetry = defaultRetry;
  }

  get names(): readonly string[] {
    return this.registeredNames;
  }

  register(types: readonly WorkflowConstructor[]): boolean {
    const additions = this.prepare(types);
    for (const registered of additions) {
      this.byName.set(registered.graph.name, registered);
      this.byType.set(registered.type, registered);
      this.registeredNames.push(registered.graph.name);
    }
    return additions.length > 0;
  }

  get(type: WorkflowConstructor): RegisteredWorkflow {
    const registered = this.byType.get(type);
    if (!registered) {
      throw new Error(`${type.name} is not registered with this Manager.`);
    }
    return registered;
  }

  find(name: string): RegisteredWorkflow | undefined {
    return this.byName.get(name);
  }

  private prepare(types: readonly WorkflowConstructor[]): RegisteredWorkflow[] {
    const additions: RegisteredWorkflow[] = [];
    const batchTypes = new Set<WorkflowConstructor>();
    const names = new Set(this.byName.keys());

    for (const type of types) {
      if (this.byType.has(type) || batchTypes.has(type)) {
        continue;
      }

      const graph = compileWorkflow(type);
      if (names.has(graph.name)) {
        throw new DuplicateWorkflowError(graph.name);
      }
      validateRetryPolicies(graph, this.defaultRetry);

      additions.push({ type, graph });
      batchTypes.add(type);
      names.add(graph.name);
    }
    return additions;
  }
}

function validateRetryPolicies(graph: CompiledWorkflow, defaultRetry: StoredRetryPolicy): void {
  const workflowRetry = normalizePolicy(graph.retry, defaultRetry);
  for (const node of graph.nodes.values()) {
    normalizePolicy(node.retry, workflowRetry);
  }
}
