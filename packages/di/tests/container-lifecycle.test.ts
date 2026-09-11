import { describe, expect, test } from "vitest";
import {
  Container,
  ContainerClosedError,
  type ContainerObject,
  DisposalConflictError,
  inject,
  onDispose,
  ProviderConflictError,
  ResolutionError,
  scoped,
  token,
} from "../src/index.js";

describe("Container resolution", () => {
  test("caches one instance per owning container and prefers a child override", async () => {
    const root = new Container();
    const child = root.child();
    const Config = token<{ tenant: string }>("config");
    let constructions = 0;

    class Service {
      readonly config = inject(Config);
    }

    root.provide(Config, () => {
      constructions++;
      return { tenant: "root" };
    });

    const rootService = root.resolve(Service);

    expect(root.resolve(Service)).toBe(rootService);
    expect(rootService.config).toBe(root.resolve(Config));
    // An ancestor-owned class token is a singleton for every descendant.
    expect(child.resolve(Service)).toBe(rootService);
    expect(child.resolve(Config)).toBe(rootService.config);
    expect(constructions).toBe(1);

    child.provide(Config, () => {
      constructions++;
      return { tenant: "child" };
    });

    expect(child.resolve(Config).tenant).toBe("child");
    expect(root.resolve(Config).tenant).toBe("root");
    expect(child.resolve(Service)).toBe(rootService);
    expect(constructions).toBe(2);
    expect(child.has(Config)).toBe(true);
    expect(root.has(Service)).toBe(true);
    expect(new Container().has(Config)).toBe(false);

    await child[Symbol.asyncDispose]();
    await root[Symbol.asyncDispose]();
  });

  test("a provider cannot silently lose to an instance this container already resolved", async () => {
    const root = new Container();
    const Config = token<{ tenant: string }>("config");
    let replacements = 0;

    class Service {
      readonly config = inject(Config);
    }

    root.provide(Config, () => ({ tenant: "first" }));
    // Replacing an unresolved provider is ordinary configuration.
    root.provide(Config, () => ({ tenant: "second" }));

    const service = root.resolve(Service);
    expect(service.config.tenant).toBe("second");

    const replace = () =>
      root.provide(Config, () => {
        replacements++;
        return { tenant: "ignored" };
      });

    expect(replace).toThrowError(ProviderConflictError);
    expect(() => root.provide(Service, () => new Service())).toThrowError(ProviderConflictError);
    // The rejection changes nothing: the resolved graph and later resolution stand.
    expect(root.resolve(Config)).toBe(service.config);
    expect(root.resolve(Service)).toBe(service);
    expect(replacements).toBe(0);

    // A child owns its own instance, so overriding there remains the supported path.
    const child = root.child();
    child.provide(Config, () => ({ tenant: "child" }));

    expect(child.resolve(Config).tenant).toBe("child");
    expect(root.resolve(Config).tenant).toBe("second");

    await child[Symbol.asyncDispose]();
    await root[Symbol.asyncDispose]();
  });

  test("a factory receives the container that owns its provider", async () => {
    const root = new Container();
    const child = root.child();
    // Wrapped: a bare Container is itself AsyncDisposable and would be adopted.
    const Owner = token<{ container: Container }>("owner");
    const Local = token<{ container: Container }>("local");

    root.provide(Owner, (container) => ({ container }));
    child.provide(Local, (container) => ({ container }));

    expect(child.resolve(Owner).container).toBe(root);
    expect(child.resolve(Local).container).toBe(child);

    await child[Symbol.asyncDispose]();
    await root[Symbol.asyncDispose]();
  });

  test("inline acquisition receives the acquiring container, like a provider factory", async () => {
    const root = new Container();
    const child = root.child();
    // Wrapped: a bare Container is itself AsyncDisposable and would be adopted.
    const Inline = token<{ container: Container }>("inline");
    const Ambient = token<{ container: Container }>("ambient");

    expect(child.use(Inline, (container) => ({ container })).container).toBe(child);
    // A cached value is returned without consulting the factory again.
    expect(child.use(Inline, () => ({ container: root })).container).toBe(child);

    class Service {
      readonly acquired = scoped(Ambient, (container) => ({ container }));
    }

    expect(root.resolve(Service).acquired.container).toBe(root);

    await child[Symbol.asyncDispose]();
    await root[Symbol.asyncDispose]();
  });

  test("a missing provider identifies the exact token and can be registered after failure", async () => {
    const container = new Container();
    const available = token<object>("store");
    const missing = token<object>("store");
    const value = {};
    container.provide(available, () => value);

    let resolutionFailure: unknown;
    try {
      container.resolve(missing);
    } catch (error) {
      resolutionFailure = error;
    }

    expect(resolutionFailure).toBeInstanceOf(ResolutionError);
    expect((resolutionFailure as ResolutionError).reason).toBe("missing-provider");
    expect((resolutionFailure as ResolutionError).token).toBe(missing);
    expect(container.has(missing)).toBe(false);

    container.provide(missing, () => value);

    expect(container.resolve(missing)).toBe(value);

    await container[Symbol.asyncDispose]();
  });

  test("inline acquisition detects cycles and failed attempts remain retryable", async () => {
    const container = new Container();
    const resource = token<object>("resource");

    let cycleFailure: unknown;
    try {
      container.use(resource, () => scoped(resource, () => ({})));
    } catch (error) {
      cycleFailure = error;
    }

    expect(cycleFailure).toBeInstanceOf(ResolutionError);
    expect((cycleFailure as ResolutionError).reason).toBe("circular-dependency");
    expect((cycleFailure as ResolutionError).token).toBe(resource);

    const events: string[] = [];
    const value = container.use(resource, () => ({
      [Symbol.dispose]() {
        events.push("disposed");
      },
    }));

    expect(container.resolve(resource)).toBe(value);

    await container[Symbol.asyncDispose]();

    expect(events).toStrictEqual(["disposed"]);
  });

  test("a cycle through providers is detected per container, not across the tree", async () => {
    const root = new Container();
    const child = root.child();
    const first = token<object>("first");
    const second = token<object>("second");

    root.provide(first, () => inject(second));
    root.provide(second, () => inject(first));
    child.provide(second, () => ({ borrowed: root.resolve(first) }));

    expect(() => root.resolve(first)).toThrow(ResolutionError);
    // The child's own provider is a distinct resolution frame.
    expect(() => child.resolve(second)).toThrow(ResolutionError);

    root.provide(second, () => ({}));

    expect(child.resolve(second)).toEqual({ borrowed: root.resolve(first) });

    await child[Symbol.asyncDispose]();
    await root[Symbol.asyncDispose]();
  });

  test("cycles are still reported after the root's diagnostics are gone", async () => {
    const root = new Container();
    const child = root.child();
    const cyclic = token<object>("cyclic");
    child.provide(cyclic, () => ({ borrowed: inject(cyclic) }));

    await root[Symbol.asyncDispose]();

    expect(root.resolutionGraph()).toStrictEqual({ nodes: [], edges: [] });

    let cycleFailure: unknown;
    try {
      child.resolve(cyclic);
    } catch (error) {
      cycleFailure = error;
    }

    expect(cycleFailure).toBeInstanceOf(ResolutionError);
    expect((cycleFailure as ResolutionError).reason).toBe("circular-dependency");
    expect((cycleFailure as ResolutionError).token).toBe(cyclic);
    expect(child.resolutionGraph()).toStrictEqual({ nodes: [], edges: [] });

    await child[Symbol.asyncDispose]();
  });

  test("undefined factory failures are not mistaken for a value or retained in the cache", async () => {
    const container = new Container();
    const resource = token<object>("resource");
    const value = {};
    let fail = true;

    container.provide(resource, () => {
      if (fail) {
        throw undefined;
      }

      return value;
    });

    let threw = false;
    let constructionFailure: unknown;
    try {
      container.resolve(resource);
    } catch (error) {
      threw = true;
      constructionFailure = error;
    }

    expect(threw).toBe(true);
    expect(constructionFailure).toBeUndefined();

    fail = false;

    expect(container.resolve(resource)).toBe(value);

    await container[Symbol.asyncDispose]();
  });

  test("failed construction keeps partial cleanup and can be retried", async () => {
    const container = new Container();
    const events: string[] = [];
    const failure = new Error("construction failed");
    const resource = token<object>("resource");
    let attempt = 0;

    class Dependency {
      constructor() {
        onDispose(() => {
          events.push("stop:dependency");
        });
      }
    }

    container.provide(resource, () => {
      const current = ++attempt;
      inject(Dependency);
      onDispose(() => {
        events.push(`stop:${current}`);
      });

      if (current === 1) {
        throw failure;
      }

      return {};
    });

    let constructionFailure: unknown;
    try {
      container.resolve(resource);
    } catch (error) {
      constructionFailure = error;
    }

    expect(constructionFailure).toBe(failure);

    const value = container.resolve(resource);
    expect(container.resolve(resource)).toBe(value);
    expect(attempt).toBe(2);

    await container[Symbol.asyncDispose]();

    expect(events).toStrictEqual(["stop:2", "stop:1", "stop:dependency"]);
  });
});

describe("Container disposal", () => {
  test("synchronous disposal closes untouched children without touching their parent", async () => {
    const parent = new Container();
    const container = parent.child();
    const Value = token<object>("unused provider");
    let acquired = false;
    container.provide(Value, () => {
      acquired = true;
      return {};
    });

    expect(container.disposeSync()).toBe(true);
    expect(container.disposeSync()).toBe(true);
    expect(container.has(Value)).toBe(false);
    expect(() => container.resolve(Value)).toThrow(ContainerClosedError);
    expect(() => container.use(Value, () => ({}))).toThrow(ContainerClosedError);
    expect(() => container.child()).toThrow(ContainerClosedError);
    expect(() => container.provide(Value, () => ({}))).toThrow(ContainerClosedError);
    expect(() => container.defer(() => {})).toThrow(ContainerClosedError);
    expect(acquired).toBe(false);

    const closing = container[Symbol.asyncDispose]();
    expect(container[Symbol.asyncDispose]()).toBe(closing);
    await closing;
    expect(container.disposeSync()).toBe(true);

    parent.provide(Value, () => ({}));
    expect(parent.disposeSync()).toBe(true);
  });

  test("a synchronous disposal attempt preserves cached instances and resource ownership", async () => {
    const container = new Container();
    const Value = token<object>("owned instance");
    const value = {};
    const order: string[] = [];
    container.use(
      Value,
      () => value,
      () => {
        order.push("resource");
      },
    );
    expect(container.disposeSync()).toBe(false);
    expect(container.resolve(Value)).toBe(value);
    container.defer(() => {
      order.push("deferred");
    });
    expect(order).toStrictEqual([]);

    await container[Symbol.asyncDispose]();
    expect(container.disposeSync()).toBe(false);
    await container[Symbol.asyncDispose]();
    expect(order).toStrictEqual(["deferred", "resource"]);
    expect(() => container.resolve(Value)).toThrow(ContainerClosedError);
  });

  test("plain cached values still require the asynchronous disposal path", async () => {
    const container = new Container();
    const Value = token<undefined>("cached undefined");
    container.use(Value, () => undefined);
    expect(container.disposeSync()).toBe(false);
    expect(container.has(Value)).toBe(true);
    expect(container.resolve(Value)).toBeUndefined();
    await container[Symbol.asyncDispose]();
    expect(container.has(Value)).toBe(false);
    expect(container.disposeSync()).toBe(false);
  });

  test("synchronous attempts do not hide a previous asynchronous cleanup failure", async () => {
    const container = new Container();
    const failure = new Error("cleanup", { cause: new Error("native cause") });
    let disposed = 0;
    container.defer(() => {
      disposed++;
      throw failure;
    });
    const disposal = container[Symbol.asyncDispose]();
    await expect(disposal).rejects.toBe(failure);
    expect(container.disposeSync()).toBe(false);
    await expect(container[Symbol.asyncDispose]()).rejects.toBe(failure);
    expect(disposed).toBe(1);
  });

  test("independent cleanup failures are aggregated for every disposal waiter", async () => {
    const container = new Container();
    const first = new Error("first cleanup failed");
    const second = new Error("second cleanup failed");
    const events: string[] = [];

    container.defer(() => {
      events.push("first");
      throw first;
    });
    container.defer(() => {
      events.push("second");
      throw second;
    });

    const disposing = container[Symbol.asyncDispose]();
    const joined = container[Symbol.asyncDispose]();
    const outcomes = await Promise.allSettled([disposing, joined]);

    expect(outcomes.map(({ status }) => status)).toStrictEqual(["rejected", "rejected"]);
    const failure = (outcomes[0] as PromiseRejectedResult).reason as AggregateError;
    expect(failure).toBeInstanceOf(AggregateError);
    expect((outcomes[1] as PromiseRejectedResult).reason).toBe(failure);
    // LIFO drain order with both identities retained.
    expect(failure.errors).toStrictEqual([second, first]);
    await expect(container[Symbol.asyncDispose]()).rejects.toBe(failure);
    expect(events).toStrictEqual(["second", "first"]);
  });

  test("concurrent disposal waits for one LIFO drain, including late cleanup", async () => {
    const container = new Container();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const events: string[] = [];

    container.defer(() => {
      events.push("first");
    });
    container.defer(async () => {
      events.push("second:begin");
      entered.resolve();

      await release.promise;

      onDispose(() => {
        events.push("late");
      });

      events.push("second:end");
    });

    expect(container.disposeSync()).toBe(false);

    let completed = 0;
    const first = container[Symbol.asyncDispose]().then(() => {
      completed++;
    });
    await entered.promise;
    expect(container.disposeSync()).toBe(false);

    const second = container[Symbol.asyncDispose]().then(() => {
      completed++;
    });

    try {
      await Promise.resolve();
      expect(completed).toBe(0);
      expect(events).toStrictEqual(["second:begin"]);
    } finally {
      release.resolve();
    }

    await Promise.all([first, second]);
    await container[Symbol.asyncDispose]();

    expect(completed).toBe(2);
    expect(events).toStrictEqual(["second:begin", "second:end", "late", "first"]);
    expect(() => container.defer(() => {})).toThrow(ContainerClosedError);
  });

  test("closing permits cached local resources but blocks all new acquisition", async () => {
    const container = new Container();
    const existing = token<object>("existing");
    const missing = token<object>("missing");
    const value = container.use(existing, () => ({}));
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();

    container.defer(async () => {
      entered.resolve();
      await release.promise;
    });

    let acquired = 0;
    const factory = () => {
      acquired++;
      return {};
    };
    container.provide(missing, factory);

    const closing = container[Symbol.asyncDispose]();
    await entered.promise;

    try {
      expect(container.resolve(existing)).toBe(value);
      expect(container.use(existing, factory)).toBe(value);
      expect(() => container.resolve(missing)).toThrow(ContainerClosedError);
      expect(() => container.use(missing, factory)).toThrow(ContainerClosedError);
      expect(() => container.provide(missing, factory)).toThrow(ContainerClosedError);
      expect(() => container.child()).toThrow(ContainerClosedError);
      expect(() => container.resolve(missing)).toThrow(
        expect.objectContaining({ state: "closing" }),
      );
      expect(acquired).toBe(0);
    } finally {
      release.resolve();
      await closing;
    }

    expect(() => container.resolve(existing)).toThrow(ContainerClosedError);
    expect(() => container.use(existing, factory)).toThrow(
      expect.objectContaining({ state: "disposed" }),
    );
    expect(acquired).toBe(0);
  });

  test("a closing child container can still resolve open ancestor singletons", async () => {
    const root = new Container();
    const child = root.child();
    const events: string[] = [];
    class Logger {
      log(message: string) {
        events.push(message);
      }
    }
    root.resolve(Logger);
    child.defer(() => {
      inject(Logger).log("closing");
    });
    await child[Symbol.asyncDispose]();
    expect(() => child.resolve(Logger)).toThrow(ContainerClosedError);
    await root[Symbol.asyncDispose]();
    expect(events).toStrictEqual(["closing"]);
  });

  test("a factory initiating shutdown still transfers its resource into teardown", async () => {
    const container = new Container();
    const resource = token<object>("resource");
    const events: string[] = [];
    let closing: Promise<void> | undefined;

    container.provide(resource, () => {
      onDispose(() => {
        events.push("partial");
      });

      closing = container[Symbol.asyncDispose]();
      return {
        [Symbol.dispose]() {
          events.push("resource");
        },
      };
    });

    container.resolve(resource);

    expect(closing).toBeInstanceOf(Promise);
    await closing;

    expect(events).toStrictEqual(["resource", "partial"]);
  });
});

describe("Container resource ownership", () => {
  test.each(["sync", "async"] as const)(
    "children retain local acquisition and cleanup after %s parent disposal",
    async (mode) => {
      const parent = new Container();
      const child = parent.child();
      const untouched = parent.child();
      const Value = token<object>("child-local");
      const value = {};
      const order: string[] = [];
      child.provide(Value, () => {
        onDispose(() => {
          order.push("resource");
        });
        return value;
      });
      if (mode === "sync") {
        parent.disposeSync();
      } else {
        await parent[Symbol.asyncDispose]();
      }

      expect(child.resolve(Value)).toBe(value);
      child.defer(() => {
        order.push("deferred");
      });
      expect(() => parent.resolve(Value)).toThrow(ContainerClosedError);
      expect(() => parent.defer(() => {})).toThrow(ContainerClosedError);
      expect(() => parent.child()).toThrow(ContainerClosedError);
      expect(() => parent.provide(Value, () => value)).toThrow(ContainerClosedError);
      expect(parent.resolutionGraph()).toStrictEqual({ nodes: [], edges: [] });

      await untouched[Symbol.asyncDispose]();
      expect(() => untouched.child()).toThrow(ContainerClosedError);
      await child[Symbol.asyncDispose]();
      expect(order).toStrictEqual(["deferred", "resource"]);
      expect(() => child.resolve(Value)).toThrow(ContainerClosedError);
      await parent[Symbol.asyncDispose]();
    },
  );

  test("closed ancestors do not split disposal ownership between surviving siblings", async () => {
    const root = new Container();
    const branch = root.child();
    const first = branch.child();
    const second = root.child();
    const Shared = token<object>("shared");
    const Explicit = token<object>("explicit duplicate");
    let disposed = 0;
    const shared = {
      [Symbol.dispose]() {
        disposed++;
      },
    };
    expect(branch.disposeSync()).toBe(true);
    expect(root.disposeSync()).toBe(true);

    expect(first.use(Shared, () => shared)).toBe(shared);
    expect(second.use(Shared, () => shared)).toBe(shared);
    expect(() =>
      second.use(
        Explicit,
        () => shared,
        () => {},
      ),
    ).toThrow(DisposalConflictError);
    expect(root.disposeSync()).toBe(true);
    expect(branch.disposeSync()).toBe(true);

    await second[Symbol.asyncDispose]();
    expect(disposed).toBe(0);
    await first[Symbol.asyncDispose]();
    expect(disposed).toBe(1);
    await Promise.all([root[Symbol.asyncDispose](), branch[Symbol.asyncDispose]()]);
    expect(disposed).toBe(1);
  });

  test("disposal ownership is direction independent and an explicit disposer overrides shape conflicts", async () => {
    const root = new Container();
    const child = root.child();
    let disposed = 0;
    const shared = {
      [Symbol.dispose]() {
        disposed++;
      },
    };
    child.use(token("child first"), () => shared);
    expect(root.use(token("root alias"), () => shared)).toBe(shared);
    await child[Symbol.asyncDispose]();
    await root[Symbol.asyncDispose]();
    expect(disposed).toBe(1);

    const explicit = new Container();
    const events: string[] = [];
    const thirdParty = {
      onClose() {
        events.push("onClose");
      },
      [Symbol.dispose]() {
        events.push("dispose");
      },
    };
    explicit.use(
      token("wrapped"),
      () => thirdParty,
      () => {
        events.push("explicit");
      },
    );
    await explicit[Symbol.asyncDispose]();
    expect(events).toStrictEqual(["explicit"]);
  });

  test("conflicting close protocols fail acquisition and roll back exactly one disposer", async () => {
    const container = new Container();
    const events: string[] = [];
    const value = {
      onClose() {
        events.push("onClose");
      },
      [Symbol.asyncDispose]() {
        events.push("asyncDispose");
        return Promise.resolve();
      },
      [Symbol.dispose]() {
        events.push("dispose");
      },
    };
    const resource = token<typeof value>("conflict");
    container.provide(resource, () => {
      onDispose(() => {
        events.push("partial");
      });
      return value;
    });
    expect(() => container.resolve(resource)).toThrow(DisposalConflictError);
    // The cached rejection keeps every later alias of the same shape identical.
    expect(() => container.use(token<typeof value>("alias"), () => value)).toThrow(
      DisposalConflictError,
    );
    await container[Symbol.asyncDispose]();
    expect(events).toStrictEqual(["asyncDispose", "partial"]);
  });

  test("explicit disposal owns an object once, and aliases never add a second owner", async () => {
    const container = new Container();
    const child = container.child();
    const events: string[] = [];
    const value: ContainerObject = {
      onClose() {
        events.push("automatic");
      },
    };
    container.use(
      token<ContainerObject>("resource"),
      () => value,
      () => {
        events.push("explicit");
      },
    );
    child.use(token<ContainerObject>("borrowed"), () => value);
    expect(() =>
      child.use(
        token<ContainerObject>("second owner"),
        () => value,
        () => {
          events.push("duplicate");
        },
      ),
    ).toThrow(DisposalConflictError);
    await child[Symbol.asyncDispose]();
    await container[Symbol.asyncDispose]();
    expect(events).toStrictEqual(["explicit"]);
  });

  test("inline factories acquire nested resources in their own container", async () => {
    const root = new Container();
    const child = root.child();
    const outer = token<object>("outer");
    const inner = token<object>("inner");
    const events: string[] = [];

    root.provide(outer, () =>
      child.use(outer, () => {
        const nested = scoped(inner, () => ({
          [Symbol.dispose]() {
            events.push("inner");
          },
        }));

        onDispose(() => {
          events.push("outer");
        });

        return { nested };
      }),
    );

    root.resolve(outer);
    await root[Symbol.asyncDispose]();

    expect(events).toStrictEqual([]);

    await child[Symbol.asyncDispose]();

    expect(events).toStrictEqual(["outer", "inner"]);
  });

  test("provider aliases borrow automatically tracked ancestor resources", async () => {
    const root = new Container();
    const child = root.child();
    const resource = token<object>("resource");
    const alias = token<object>("alias");
    const childAlias = token<object>("child alias");
    const events: string[] = [];

    root.provide(resource, () => {
      scoped(token<object>("nested"), () => ({
        [Symbol.dispose]() {
          events.push("nested");
        },
      }));

      return {
        [Symbol.dispose]() {
          events.push("resource");
        },
      };
    });
    root.provide(alias, () => inject(resource));
    child.provide(childAlias, () => inject(alias));

    expect(child.resolve(childAlias)).toBe(root.resolve(resource));

    await child[Symbol.asyncDispose]();

    expect(events).toStrictEqual([]);

    await root[Symbol.asyncDispose]();

    expect(events).toStrictEqual(["resource", "nested"]);
  });
});
