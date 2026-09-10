import {
  DurableGraph,
  Manager,
  Workflow,
  type Execution,
  type NodeRef,
  type WorkflowInput,
} from "../src/index.js";

class ReadValue {
  run(input: { source: { value: number } }): number {
    return input.source.value;
  }
}

@Workflow("typed-workflow")
class TypedWorkflow extends DurableGraph<{ value: number }, number> {
  build(input: WorkflowInput<{ value: number }>): NodeRef<number> {
    return this.step("read", ReadValue, { source: input });
  }
}

function workflowTypeContract(manager: Manager): Execution<number> {
  const execution = manager.run(TypedWorkflow, { value: 42 });

  // @ts-expect-error Workflow input is inferred from DurableGraph's input type.
  manager.run(TypedWorkflow, { value: "wrong" });

  return execution;
}

void workflowTypeContract;
