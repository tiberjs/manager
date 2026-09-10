import { DuplicateJobError } from "../errors.js";
import { normalizePolicy } from "../execution/retry.js";
import type { JobConstructor, StoredRetryPolicy } from "../types.js";
import { jobDefinition } from "./definition.js";

export interface RegisteredJob {
  readonly type: JobConstructor;
  readonly name: string;
  readonly retry: StoredRetryPolicy;
}

/** Validates registration atomically, without constructing execution-scoped handlers. */
export class JobRegistry {
  private readonly byName = new Map<string, RegisteredJob>();
  private readonly byType = new Map<JobConstructor, RegisteredJob>();
  private readonly registeredNames: string[] = [];

  constructor(private readonly defaultRetry: StoredRetryPolicy) {}

  get names(): readonly string[] {
    return this.registeredNames;
  }

  register(types: readonly JobConstructor[]): boolean {
    const additions: RegisteredJob[] = [];
    const names = new Set(this.byName.keys());
    const batch = new Set<JobConstructor>();
    for (const type of types) {
      if (this.byType.has(type) || batch.has(type)) continue;
      const definition = jobDefinition(type);
      if (names.has(definition.name)) throw new DuplicateJobError(definition.name);
      additions.push({
        type,
        name: definition.name,
        retry: normalizePolicy(definition.retry, this.defaultRetry),
      });
      names.add(definition.name);
      batch.add(type);
    }
    for (const registered of additions) {
      this.byName.set(registered.name, registered);
      this.byType.set(registered.type, registered);
      this.registeredNames.push(registered.name);
    }
    return additions.length > 0;
  }

  get(type: JobConstructor): RegisteredJob {
    const registered = this.byType.get(type);
    if (!registered) throw new Error(`${type.name} is not registered with this Manager.`);
    return registered;
  }

  find(name: string): RegisteredJob | undefined {
    return this.byName.get(name);
  }
}
