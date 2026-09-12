import { DuplicateJobError } from "../errors.js";
import { normalizePolicy } from "../execution/retry.js";
import type { DurableJobConstructor, StoredRetryPolicy } from "../types.js";
import { durableJobDefinition } from "./definition.js";

export interface RegisteredDurableJob {
  readonly type: DurableJobConstructor;
  readonly name: string;
  readonly retry: StoredRetryPolicy;
}

/** Validates registration atomically, without constructing execution-scoped handlers. */
export class DurableJobRegistry {
  private readonly byName = new Map<string, RegisteredDurableJob>();
  private readonly byType = new Map<DurableJobConstructor, RegisteredDurableJob>();
  private readonly registeredNames: string[] = [];

  constructor(private readonly defaultRetry: StoredRetryPolicy) {}

  get names(): readonly string[] {
    return this.registeredNames;
  }

  register(types: readonly DurableJobConstructor[]): boolean {
    const additions: RegisteredDurableJob[] = [];
    const names = new Set(this.byName.keys());
    const batch = new Set<DurableJobConstructor>();
    for (const type of types) {
      if (this.byType.has(type) || batch.has(type)) continue;
      const definition = durableJobDefinition(type);
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

  get(type: DurableJobConstructor): RegisteredDurableJob {
    const registered = this.byType.get(type);
    if (!registered) throw new Error(`${type.name} is not registered with this Manager.`);
    return registered;
  }

  find(name: string): RegisteredDurableJob | undefined {
    return this.byName.get(name);
  }
}
