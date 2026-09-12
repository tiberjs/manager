import type { DurableJobConstructor, DurableJobOptions } from "../types.js";

const metadata = new WeakMap<DurableJobConstructor, DurableJobOptions>();

/** Register reconstructable code under a stable durable identity; never serializes a closure. */
export function DurableJob(nameOrOptions: string | DurableJobOptions) {
  const source = typeof nameOrOptions === "string" ? { name: nameOrOptions } : nameOrOptions;
  if (typeof source.name !== "string" || source.name.length === 0) {
    throw new TypeError("Durable job name must not be empty.");
  }
  const options: DurableJobOptions = Object.freeze({
    name: source.name,
    ...(source.retry ? { retry: Object.freeze({ ...source.retry }) } : {}),
  });
  return <Value extends DurableJobConstructor>(
    value: Value,
    _context: ClassDecoratorContext<Value>,
  ): void => {
    metadata.set(value, options);
  };
}

export function durableJobDefinition(type: DurableJobConstructor): DurableJobOptions {
  const options = metadata.get(type);
  if (!options) {
    throw new TypeError(`${type.name || "Durable job class"} is missing @DurableJob metadata.`);
  }
  return options;
}
