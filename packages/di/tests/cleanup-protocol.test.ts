import { describe, expect, test } from "vitest";
import { type ContainerObject, planCleanup } from "../src/cleanup-protocol.js";
import { DisposalConflictError } from "../src/errors.js";

describe("cleanup protocol", () => {
  test("an explicit disposer overrides every shape and receives the value", () => {
    const events: string[] = [];
    const value = {
      onClose() {
        events.push("onClose");
      },
      [Symbol.dispose]() {
        events.push("dispose");
      },
    };

    const plan = planCleanup(value, (released) => {
      events.push(`explicit:${released === value}`);
    });

    expect(plan.conflict).toBeUndefined();
    plan.cleanup?.();
    expect(events).toStrictEqual(["explicit:true"]);
  });

  test("asyncDispose outranks dispose, and both outrank onClose", () => {
    const events: string[] = [];
    const both = {
      [Symbol.asyncDispose]() {
        events.push(`asyncDispose:${this === both}`);
        return Promise.resolve();
      },
      [Symbol.dispose]() {
        events.push("dispose");
      },
    };
    const closable: ContainerObject = {
      onClose() {
        events.push(`onClose:${this === closable}`);
      },
    };

    planCleanup(both).cleanup?.();
    planCleanup(closable).cleanup?.();

    expect(events).toStrictEqual(["asyncDispose:true", "onClose:true"]);
  });

  test("onClose beside a symbol disposer is refused, yet still yields rollback cleanup", () => {
    const events: string[] = [];
    const value = {
      onClose() {
        events.push("onClose");
      },
      [Symbol.dispose]() {
        events.push("dispose");
      },
    };

    const plan = planCleanup(value);

    expect(plan.conflict).toBeInstanceOf(DisposalConflictError);
    expect(plan.conflict?.reason).toBe("multiple-hooks");
    // The caller releases an object it will never hand out.
    plan.cleanup?.();
    expect(events).toStrictEqual(["dispose"]);
  });

  test("a value with no protocol and no disposer is left unowned", () => {
    const plan = planCleanup({ close() {} });

    expect(plan.cleanup).toBeUndefined();
    expect(plan.conflict).toBeUndefined();
  });
});
