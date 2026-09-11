import { getEventListeners } from "node:events";
import { LifecycleStateError, contextKey, execute, provide, signal, use } from "@tiberjs/runner";
import { expect, test } from "vitest";
import { EventBus, eventKey, type EventBusOptions } from "../src/index.js";

/**
 * Asynchronously reported failures surface as uncaught exceptions. Swap the
 * process handlers so the expectation observes them instead of the runner.
 */
async function captureReported(emit: () => void): Promise<unknown[]> {
  const captured: unknown[] = [];
  const installed = process.listeners("uncaughtException");
  process.removeAllListeners("uncaughtException");
  process.on("uncaughtException", (error) => {
    captured.push(error);
  });
  const drained = Promise.withResolvers<void>();
  try {
    emit();
    setImmediate(drained.resolve);
    await drained.promise;
  } finally {
    process.removeAllListeners("uncaughtException");
    for (const listener of installed) {
      process.on("uncaughtException", listener);
    }
  }

  return captured;
}

test("delivery follows registration order and preserves the emitted payload", () => {
  using bus = new EventBus();
  const changed = eventKey<{ id: number }>("changed");
  const sameDescription = eventKey<{ id: number }>("changed");
  const order: string[] = [];
  const payloads: unknown[] = [];
  const event = { id: 1 };

  bus.on(changed, (value) => {
    order.push("first");
    payloads.push(value);
  });
  bus.on(sameDescription, () => {
    order.push("same description");
  });
  bus.on(changed, (value) => {
    order.push("second");
    payloads.push(value);
  });

  using other = new EventBus();
  other.emit(changed, event);
  bus.emit(changed, event);

  expect(order).toStrictEqual(["first", "second"]);
  expect(payloads[0]).toBe(event);
  expect(payloads[1]).toBe(event);
});

test("a repeated listener has independent subscriptions and unsubscribe is idempotent", () => {
  using bus = new EventBus();
  const key = eventKey<number>("changed");
  const received: number[] = [];
  const listener = (value: number): undefined => {
    received.push(value);
  };

  const first = bus.on(key, listener);
  const second = bus.on(key, listener);

  bus.emit(key, 1);
  first();
  first();
  bus.emit(key, 2);
  second();
  bus.emit(key, 3);

  expect(received).toStrictEqual([1, 1, 2]);
  expect(bus.hasListeners(key)).toBe(false);
});

test("subscription changes and reentrant emissions only affect later emissions", () => {
  using bus = new EventBus();
  const key = eventKey<number>("changed");
  const order: string[] = [];
  let reentered = false;

  bus.on(key, (value) => {
    order.push(`a:${value}`);
    if (reentered) {
      return;
    }

    reentered = true;
    offB();
    bus.on(key, (next) => {
      order.push(`d:${next}`);
    });
    bus.emit(key, 2);
  });
  const offB = bus.on(key, (value) => {
    order.push(`b:${value}`);
  });
  bus.on(key, (value) => {
    order.push(`c:${value}`);
  });

  bus.emit(key, 1);
  bus.emit(key, 3);

  expect(order).toStrictEqual(["a:1", "a:2", "c:2", "d:2", "b:1", "c:1", "a:3", "c:3", "d:3"]);
});

test("a sole subscriber still sees only the membership present when delivery began", () => {
  using bus = new EventBus();
  const key = eventKey<number>("changed");
  const order: string[] = [];

  const off = bus.on(key, (value) => {
    order.push(`only:${value}`);
    // Both mutations happen while this single listener is mid-delivery.
    off();
    bus.on(key, (next) => {
      order.push(`late:${next}`);
    });
  });

  bus.emit(key, 1);
  bus.emit(key, 2);

  expect(order).toStrictEqual(["only:1", "late:2"]);
});

test("closing during delivery seals the bus without corrupting the in-flight emission", () => {
  const bus = new EventBus();
  const key = eventKey<void>("changed");
  const order: string[] = [];
  let reentrantFailure: unknown;

  bus.on(key, () => {
    order.push("first");
    bus.close();
    try {
      bus.emit(key, undefined);
    } catch (error) {
      reentrantFailure = error;
    }
  });
  bus.on(key, () => {
    order.push("second");
  });

  bus.emit(key, undefined);

  expect(order).toStrictEqual(["first", "second"]);
  expect(reentrantFailure).toBeInstanceOf(LifecycleStateError);
  expect(reentrantFailure).toMatchObject({ operation: "emit", state: "closed" });
  expect(bus.hasListeners(key)).toBe(false);
});

test("signal-bound subscriptions abort, pre-abort to nothing, and leak in neither direction", () => {
  using bus = new EventBus();
  const key = eventKey<number>("changed");
  const received: number[] = [];
  const listener = (value: number): undefined => {
    received.push(value);
  };

  const preAborted = new AbortController();
  preAborted.abort();
  const noop = bus.on(key, listener, { signal: preAborted.signal });
  expect(bus.hasListeners(key)).toBe(false);
  noop();

  const manual = new AbortController();
  const off = bus.on(key, listener, { signal: manual.signal });
  expect(getEventListeners(manual.signal, "abort")).toHaveLength(1);
  off();
  expect(getEventListeners(manual.signal, "abort")).toHaveLength(0);
  manual.abort();

  const automatic = new AbortController();
  bus.on(key, listener, { signal: automatic.signal });
  bus.on(key, (value) => {
    received.push(value * 10);
  });
  automatic.abort();
  expect(getEventListeners(automatic.signal, "abort")).toHaveLength(0);

  bus.emit(key, 1);

  expect(received).toStrictEqual([10]);
});

test("hasListeners tracks membership per key", () => {
  using bus = new EventBus();
  const changed = eventKey<void>("changed");
  const other = eventKey<void>("other");

  expect(bus.hasListeners(changed)).toBe(false);
  const first = bus.on(changed, () => {});
  const second = bus.on(changed, () => {});
  bus.on(other, () => {});

  expect(bus.hasListeners(changed)).toBe(true);
  first();
  expect(bus.hasListeners(changed)).toBe(true);
  second();
  expect(bus.hasListeners(changed)).toBe(false);
  expect(bus.hasListeners(other)).toBe(true);
});

test("a throwing listener starves neither its siblings nor the publisher", async () => {
  const reports: unknown[] = [];
  using bus = new EventBus({
    onError(error) {
      reports.push(error);
    },
  });
  const key = eventKey<number>("changed");
  const failure = new Error("listener failed");
  const received: number[] = [];

  bus.on(key, () => {
    throw failure;
  });
  bus.on(key, (value) => {
    received.push(value);
  });

  const published = await execute(() => {
    bus.emit(key, 7);
    return "published";
  });

  expect(published).toBe("published");
  expect(received).toStrictEqual([7]);
  expect(reports).toStrictEqual([failure]);
});

test("independent failures aggregate once while a sole failure keeps its identity", () => {
  const reports: { error: unknown; event: string }[] = [];
  using bus = new EventBus({
    onError(error, context) {
      reports.push({ error, event: context.event });
    },
  });
  const key = eventKey<void>("changed");
  const firstCause = new Error("first cause");
  const secondCause = new Error("second cause");
  const first = new Error("first", { cause: firstCause });
  const second = new Error("second", { cause: secondCause });
  let delivered = 0;

  const offFirst = bus.on(key, () => {
    throw first;
  });
  bus.on(key, () => {
    delivered++;
  });
  bus.on(key, () => {
    throw second;
  });

  bus.emit(key, undefined);

  expect(delivered).toBe(1);
  expect(reports).toHaveLength(1);
  expect(reports[0]?.event).toBe("changed");
  const aggregate = reports[0]?.error as AggregateError;
  expect(aggregate).toBeInstanceOf(AggregateError);
  expect(aggregate.errors).toStrictEqual([first, second]);
  expect(aggregate.errors[0].cause).toBe(firstCause);
  expect(aggregate.errors[1].cause).toBe(secondCause);

  offFirst();
  bus.emit(key, undefined);

  expect(reports).toHaveLength(2);
  expect(reports[1]?.error).toBe(second);
});

test("without a reporter, listener failures surface asynchronously", async () => {
  using bus = new EventBus();
  const key = eventKey<void>("changed");
  const failure = new Error("listener failed");
  let delivered = 0;
  bus.on(key, () => {
    throw failure;
  });
  bus.on(key, () => {
    delivered++;
  });

  const reported = await captureReported(() => {
    bus.emit(key, undefined);
  });

  expect(reported).toStrictEqual([failure]);
  expect(delivered).toBe(1);
});

test("a throwing reporter is isolated from the publisher and loses no failure", async () => {
  const failure = new Error("listener failed");
  const reporterFailure = new Error("reporter failed");
  const seen: unknown[] = [];
  using bus = new EventBus({
    onError(error) {
      seen.push(error);
      throw reporterFailure;
    },
  });
  const key = eventKey<void>("changed");
  let delivered = 0;
  bus.on(key, () => {
    throw failure;
  });
  bus.on(key, () => {
    delivered++;
  });

  const reported = await captureReported(() => {
    bus.emit(key, undefined);
  });

  expect(seen).toStrictEqual([failure]);
  expect(reported).toStrictEqual([failure, reporterFailure]);
  expect(delivered).toBe(1);
});

test("a non-function reporter is rejected at construction", () => {
  expect(() => new EventBus({ onError: 42 } as unknown as EventBusOptions)).toThrow(TypeError);
});

test("close is idempotent, releases abort registrations, and seals the bus", () => {
  const bus = new EventBus();
  const key = eventKey<void>("changed");
  const controller = new AbortController();
  let delivered = 0;
  bus.on(
    key,
    () => {
      delivered++;
    },
    { signal: controller.signal },
  );

  bus.close();
  bus.close();
  bus[Symbol.dispose]();
  controller.abort();

  expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  expect(bus.hasListeners(key)).toBe(false);
  expect(delivered).toBe(0);

  let subscribeFailure: unknown;
  try {
    bus.on(key, () => {});
  } catch (error) {
    subscribeFailure = error;
  }
  let emitFailure: unknown;
  try {
    bus.emit(key, undefined);
  } catch (error) {
    emitFailure = error;
  }

  expect(subscribeFailure).toBeInstanceOf(LifecycleStateError);
  expect(subscribeFailure).toMatchObject({
    owner: "EventBus",
    operation: "on",
    state: "closed",
  });
  expect(emitFailure).toBeInstanceOf(LifecycleStateError);
  expect(emitFailure).toMatchObject({ owner: "EventBus", operation: "emit", state: "closed" });
});

test("a listener observes the publisher's context bindings and live signal", async () => {
  using bus = new EventBus();
  const Tenant = contextKey<string>("tenant");
  const key = eventKey<void>("changed");
  const controller = new AbortController();
  let tenant: string | undefined;
  let listenerSignal: AbortSignal | undefined;
  let abortedAtDelivery: boolean | undefined;
  let publisherSignal: AbortSignal | undefined;
  let abortedAfterCancellation: boolean | undefined;

  bus.on(key, () => {
    tenant = use(Tenant);
    listenerSignal = signal();
    abortedAtDelivery = listenerSignal.aborted;
  });

  await execute({ signal: controller.signal, values: [provide(Tenant, "acme")] }, () => {
    publisherSignal = signal();
    bus.emit(key, undefined);
    controller.abort();
    abortedAfterCancellation = listenerSignal?.aborted;
  }).catch(() => undefined);

  expect(tenant).toBe("acme");
  expect(listenerSignal).toBe(publisherSignal);
  expect(abortedAtDelivery).toBe(false);
  expect(abortedAfterCancellation).toBe(true);
});
