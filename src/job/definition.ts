import type { JobConstructor, JobOptions } from "../types.js";

const metadata = new WeakMap<JobConstructor, JobOptions>();

/** Register reconstructable code under a stable durable identity; never serializes a closure. */
export function Job(nameOrOptions: string | JobOptions) {
  const source = typeof nameOrOptions === "string" ? { name: nameOrOptions } : nameOrOptions;
  if (typeof source.name !== "string" || source.name.length === 0) {
    throw new TypeError("Job name must not be empty.");
  }
  const options: JobOptions = Object.freeze({
    name: source.name,
    ...(source.retry ? { retry: Object.freeze({ ...source.retry }) } : {}),
  });
  return <Value extends JobConstructor>(
    value: Value,
    _context: ClassDecoratorContext<Value>,
  ): void => {
    metadata.set(value, options);
  };
}

export function jobDefinition(type: JobConstructor): JobOptions {
  const options = metadata.get(type);
  if (!options) {
    throw new TypeError(`${type.name || "Job class"} is missing @Job metadata.`);
  }
  return options;
}
