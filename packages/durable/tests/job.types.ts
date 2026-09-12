import { inject } from "@tiberjs/di";
import {
  DurableExecution,
  Job,
  type Manager,
  type Execution,
  type WrappedJob,
} from "../src/index.js";

@Job("typed-job")
class TypedJob {
  readonly durable = inject(DurableExecution);
  async run(input: { value: number }): Promise<number> {
    return this.durable.checkpoint("read", input, () => input.value);
  }
}

@Job("no-input")
class NoInput {
  run(): string {
    return "done";
  }
}

function jobTypeContract(manager: Manager): Execution<number> {
  const wrapped: WrappedJob<{ value: number }, number> = manager.wrap(TypedJob);
  const result: Execution<number> = wrapped.run({ value: 42 });
  const resumed: Execution<number> = wrapped.get(result.id);
  const noInput: Execution<string> = manager.wrap(NoInput).run(undefined);
  // @ts-expect-error Inputs are inferred from the registered handler, not an untyped closure.
  wrapped.run({ value: "wrong" });
  // @ts-expect-error Direct Manager API preserves the same input contract.
  manager.run(TypedJob, { value: "wrong" });
  // @ts-expect-error A handler without run() cannot be registered.
  manager.wrap(class {});
  void resumed;
  void noInput;
  return result;
}
void jobTypeContract;
