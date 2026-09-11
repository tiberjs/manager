import { execute, fork, peekState, provide, use } from "@tiberjs/runner";
import { describe, expect, test } from "vitest";
import {
  Container,
  ContainerClosedError,
  ContainerKey,
  currentContainer,
  inject,
  onDispose,
  scoped,
  token,
  withContainer,
} from "../src/index.js";

describe("ambient container", () => {
  test("every ambient API fails without construction, a binding, or withContainer", () => {
    expect(peekState()).toBeUndefined();
    expect(() => currentContainer()).toThrow(/No active container/);
    expect(() => inject(token<object>("value"))).toThrow(/No active container/);
    expect(() => scoped(token<object>("value"), () => ({}))).toThrow(/No active container/);
    expect(() => onDispose(() => {})).toThrow(/No active container/);
  });

  test("construction restores the outer container after a nested ancestor factory", async () => {
    const root = new Container();
    const child = root.child();
    // Wrapped: a bare Container is itself AsyncDisposable and would be adopted.
    const inner = token<{ container: Container }>("inner");
    const outer = token<{ inner: Container; before: Container; after: Container }>("outer");

    root.provide(inner, () => ({ container: currentContainer() }));
    child.provide(outer, () => {
      const before = currentContainer();
      const nested = inject(inner).container;

      return { inner: nested, before, after: currentContainer() };
    });

    const resolved = child.resolve(outer);

    expect(resolved.inner).toBe(root);
    expect(resolved.before).toBe(child);
    expect(resolved.after).toBe(child);

    await child[Symbol.asyncDispose]();
    await root[Symbol.asyncDispose]();
  });

  test("onDispose registers cleanup on the owning container, LIFO within each owner", async () => {
    const root = new Container();
    const child = root.child();
    const events: string[] = [];
    const local = token<object>("local");

    class Shared {
      constructor() {
        onDispose(() => {
          events.push("shared");
        });
      }
    }

    child.provide(local, () => {
      onDispose(() => {
        events.push("local:first");
      });
      const shared = inject(Shared);
      onDispose(() => {
        events.push("local:second");
      });

      return { shared };
    });

    child.resolve(local);

    await child[Symbol.asyncDispose]();

    expect(events).toStrictEqual(["local:second", "local:first"]);

    await root[Symbol.asyncDispose]();

    expect(events).toStrictEqual(["local:second", "local:first", "shared"]);
  });

  test("an execution bound to ContainerKey resolves and defers into that container", async () => {
    const root = new Container();
    const request = root.child();
    const Config = token<string>("config");
    const forked = token<AsyncDisposable>("forked");
    const events: string[] = [];
    let executionContainer: unknown;

    root.provide(Config, () => "app");

    await execute({ values: [provide(ContainerKey, request)] }, async () => {
      executionContainer = currentContainer();
      events.push(`resolved:${inject(Config)}`);
      onDispose(() => {
        events.push("execution:cleanup");
      });

      await fork(async () => {
        events.push(`fork:${currentContainer() === request}`);
        scoped(forked, () => ({
          [Symbol.asyncDispose]() {
            events.push("fork:resource");
            return Promise.resolve();
          },
        }));
      });
    });

    expect(executionContainer).toBe(request);
    // DI owns no execution lifetime: finishing the execution disposes nothing.
    expect(events).toStrictEqual(["resolved:app", "fork:true"]);

    await request[Symbol.asyncDispose]();

    expect(events).toStrictEqual([
      "resolved:app",
      "fork:true",
      "fork:resource",
      "execution:cleanup",
    ]);
    expect(() => request.resolve(Config)).toThrow(ContainerClosedError);
    expect(root.resolve(Config)).toBe("app");

    await root[Symbol.asyncDispose]();
  });

  test("a child created inside an execution stays usable after that execution ends", async () => {
    const root = new Container();
    const Value = token<object>("returned child");
    const value = {};
    let disposed = false;

    const child = await execute({ values: [provide(ContainerKey, root)] }, () =>
      currentContainer().child(),
    );

    expect(
      child.use(
        Value,
        () => value,
        () => {
          disposed = true;
        },
      ),
    ).toBe(value);
    expect(disposed).toBe(false);

    await child[Symbol.asyncDispose]();

    expect(disposed).toBe(true);
    expect(() => child.resolve(Value)).toThrow(ContainerClosedError);

    await root[Symbol.asyncDispose]();
  });

  test("withContainer binds a container without any active execution", async () => {
    const container = new Container();
    const Value = token<string>("value");
    const events: string[] = [];
    container.provide(Value, () => "bound");

    const resolved = withContainer(container, () => {
      expect(currentContainer()).toBe(container);
      onDispose(() => {
        events.push("cleanup");
      });

      return inject(Value);
    });

    expect(resolved).toBe("bound");
    expect(() => currentContainer()).toThrow(/No active container/);

    await container[Symbol.asyncDispose]();

    expect(events).toStrictEqual(["cleanup"]);
  });

  test("withContainer overrides an outer construction container and publishes its binding", async () => {
    const constructing = new Container();
    const other = new Container();
    const Nested = token<{ inner: Container; after: Container }>("nested");

    constructing.provide(Nested, () => ({
      inner: withContainer(other, () => currentContainer()),
      after: currentContainer(),
    }));

    const resolved = constructing.resolve(Nested);

    expect(resolved.inner).toBe(other);
    expect(resolved.after).toBe(constructing);

    await execute({ values: [provide(ContainerKey, constructing)] }, () => {
      withContainer(other, () => {
        expect(currentContainer()).toBe(other);
        // Derived executions observe the same container through the context.
        expect(use(ContainerKey)).toBe(other);
      });
      expect(use(ContainerKey)).toBe(constructing);
      expect(currentContainer()).toBe(constructing);
    });

    await other[Symbol.asyncDispose]();
    await constructing[Symbol.asyncDispose]();
  });
});
