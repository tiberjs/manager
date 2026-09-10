import type {
  InputBinding,
  NodeRef,
  RetryPolicy,
  StepConstructor,
  StepOptions,
  WorkflowConstructor,
  WorkflowInput,
  WorkflowOptions,
  WorkflowShape,
} from "../types.js";

const workflowMetadata = new WeakMap<Function, WorkflowOptions>();
const REFERENCE = Symbol("tiberjs.manager.reference");

type ReferenceMetadata =
  | { readonly graph: symbol; readonly source: "input" }
  | { readonly graph: symbol; readonly source: "node"; readonly nodeId: string };

interface GraphReference<T> extends NodeRef<T> {
  readonly [REFERENCE]: ReferenceMetadata;
}

export interface CompiledNode {
  readonly id: string;
  readonly handler: StepConstructor<unknown, unknown>;
  readonly input: unknown;
  readonly dependencies: readonly string[];
  readonly retry?: RetryPolicy;
}

export interface CompiledWorkflow {
  readonly name: string;
  readonly retry?: RetryPolicy;
  readonly nodes: ReadonlyMap<string, CompiledNode>;
  readonly outputNodeId: string;
}

/** Declare the stable identity and defaults of a durable DAG. */
export function Workflow(
  name: string,
): <Value extends WorkflowConstructor>(value: Value, context: ClassDecoratorContext<Value>) => void;
export function Workflow(
  options: WorkflowOptions,
): <Value extends WorkflowConstructor>(value: Value, context: ClassDecoratorContext<Value>) => void;
export function Workflow(nameOrOptions: string | WorkflowOptions) {
  const options = copyWorkflowOptions(nameOrOptions);
  if (options.name.length === 0) {
    throw new TypeError("Workflow name must not be empty.");
  }

  return <Value extends WorkflowConstructor>(
    value: Value,
    _context: ClassDecoratorContext<Value>,
  ): void => {
    workflowMetadata.set(value, options);
  };
}

/** A pure, typed declaration of a durable directed acyclic graph. */
export abstract class DurableGraph<Input, Output> implements WorkflowShape<Input, Output> {
  readonly #graph = Symbol("workflow.graph");
  readonly #nodes = new Map<string, CompiledNode>();

  abstract build(input: WorkflowInput<Input>): NodeRef<Output>;

  protected step<StepInput, StepOutput>(
    id: string,
    handler: StepConstructor<StepInput, StepOutput>,
    input: InputBinding<StepInput>,
    options: StepOptions = {},
  ): NodeRef<StepOutput> {
    if (id.length === 0) {
      throw new TypeError("Step id must not be empty.");
    }
    if (this.#nodes.has(id)) {
      throw new Error(`Workflow contains duplicate step id ${JSON.stringify(id)}.`);
    }

    const binding = compileBinding(input, this.#graph);
    this.#nodes.set(id, {
      id,
      handler: handler as StepConstructor<unknown, unknown>,
      input: binding.value,
      dependencies: binding.dependencies,
      retry: options.retry ? { ...options.retry } : undefined,
    });
    return nodeReference(this.#graph, id);
  }

  /** @internal Compile this declaration without executing any step handler. */
  compile(options: WorkflowOptions): CompiledWorkflow {
    const output = this.build(inputReference(this.#graph));
    const metadata = referenceMetadata(output);
    if (!metadata || metadata.graph !== this.#graph || metadata.source !== "node") {
      throw new TypeError("Workflow build() must return a step created by this graph.");
    }

    const reachable = new Set<string>();
    const visit = (id: string): void => {
      if (reachable.has(id)) {
        return;
      }
      reachable.add(id);
      const node = this.#nodes.get(id);
      if (!node) {
        throw new Error(`Workflow references unknown step ${JSON.stringify(id)}.`);
      }
      for (const dependency of node.dependencies) {
        visit(dependency);
      }
    };
    visit(metadata.nodeId);

    if (reachable.size !== this.#nodes.size) {
      const disconnected = [...this.#nodes.keys()].filter((id) => !reachable.has(id));
      throw new Error(
        `Workflow contains steps disconnected from its output: ${disconnected.join(", ")}.`,
      );
    }

    return {
      name: options.name,
      retry: options.retry,
      nodes: new Map(this.#nodes),
      outputNodeId: metadata.nodeId,
    };
  }
}

export function compileWorkflow<Workflow extends WorkflowConstructor>(
  type: Workflow,
): CompiledWorkflow {
  const metadata = workflowMetadata.get(type);
  if (!metadata) {
    throw new TypeError(`${type.name || "Workflow class"} is missing @Workflow metadata.`);
  }

  const instance = new type();
  if (!(instance instanceof DurableGraph)) {
    throw new TypeError(`${type.name} must extend DurableGraph.`);
  }
  return instance.compile(metadata);
}

export function resolveBinding(
  binding: unknown,
  graph: CompiledWorkflow,
  executionInput: unknown,
  results: Readonly<Record<string, unknown>>,
): unknown {
  const metadata = referenceMetadata(binding);
  if (metadata) {
    if (metadata.source === "input") {
      return executionInput;
    }
    const { nodeId } = metadata;
    if (!graph.nodes.has(nodeId) || !Object.hasOwn(results, nodeId)) {
      throw new Error(`Step ${JSON.stringify(nodeId)} has no completed result.`);
    }
    return results[nodeId];
  }

  if (Array.isArray(binding)) {
    return binding.map((value) => resolveBinding(value, graph, executionInput, results));
  }
  if (isPlainObject(binding)) {
    return Object.fromEntries(
      Object.entries(binding).map(([key, value]) => [
        key,
        resolveBinding(value, graph, executionInput, results),
      ]),
    );
  }
  return binding;
}

function inputReference<T>(graph: symbol): GraphReference<T> {
  return Object.freeze({ [REFERENCE]: { graph, source: "input" } }) as GraphReference<T>;
}

function nodeReference<T>(graph: symbol, nodeId: string): GraphReference<T> {
  return Object.freeze({
    [REFERENCE]: { graph, source: "node", nodeId },
  }) as GraphReference<T>;
}

function referenceMetadata(value: unknown): ReferenceMetadata | undefined {
  return typeof value === "object" && value !== null && REFERENCE in value
    ? (value as GraphReference<unknown>)[REFERENCE]
    : undefined;
}

function compileBinding(
  binding: unknown,
  graph: symbol,
): { readonly value: unknown; readonly dependencies: readonly string[] } {
  const dependencies = new Set<string>();
  const copies = new WeakMap<object, unknown>();
  const visiting = new WeakSet<object>();

  const visit = (value: unknown): unknown => {
    const metadata = referenceMetadata(value);
    if (metadata) {
      if (metadata.graph !== graph) {
        throw new Error("A workflow cannot reference a value from another graph.");
      }
      if (metadata.source === "node") {
        dependencies.add(metadata.nodeId);
      }
      return value;
    }
    if (!Array.isArray(value) && !isPlainObject(value)) {
      return value;
    }
    if (visiting.has(value)) {
      throw new TypeError("Step input bindings must not contain cycles.");
    }
    if (copies.has(value)) {
      return copies.get(value);
    }

    visiting.add(value);
    if (Array.isArray(value)) {
      const copy: unknown[] = [];
      copies.set(value, copy);
      for (const item of value) {
        copy.push(visit(item));
      }
      visiting.delete(value);
      return Object.freeze(copy);
    }

    const copy = Object.create(Object.getPrototypeOf(value)) as Record<string, unknown>;
    copies.set(value, copy);
    for (const [key, item] of Object.entries(value)) {
      Object.defineProperty(copy, key, {
        value: visit(item),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    visiting.delete(value);
    return Object.freeze(copy);
  };

  return { value: visit(binding), dependencies: [...dependencies] };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function copyWorkflowOptions(value: string | WorkflowOptions): WorkflowOptions {
  const options = typeof value === "string" ? { name: value } : value;
  return {
    name: options.name,
    ...(options.retry ? { retry: { ...options.retry } } : {}),
  };
}
