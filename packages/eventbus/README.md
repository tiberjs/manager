# @tiberjs/eventbus

Typed notifications between components in one process. Publishers announce what happened without knowing who listens, and every call site is type-checked because an event is a key, not a string.

A bus is an object you construct and own. No global instance, no queue, no cross-process fanout. Requires **Node.js 24+**.

```sh
pnpm add @tiberjs/eventbus @tiberjs/runner
```

## Quick start

```ts
import { EventBus, eventKey } from "@tiberjs/eventbus";

const UserCreated = eventKey<{ id: string }>("user.created");

using bus = new EventBus({ onError: (error, { event }) => void console.error(event, error) });

const unsubscribe = bus.on(UserCreated, (user) => void console.log("welcome", user.id));

bus.emit(UserCreated, { id: "u1" }); // logs: welcome u1

unsubscribe();
```

## Delivery is synchronous

`emit` calls each listener inline and returns when the last one returns. There is no queue and no async listener: a listener runs in the publisher's Runner context, so `inject()`, `use()`, and `signal()` inside it see the emitting execution.

Work that must await, retry, or outlive the publisher forks its own job:

```ts
import { fork } from "@tiberjs/runner";

bus.on(UserCreated, (user) => void fork(() => sendWelcomeEmail(user.id)));
```

The bus never starts, joins, or awaits anything, and `close()` does not wait for work a listener started.

## Sharing one bus

Importing `EventBus` gives you the class, not an instance, so two rules follow.

**Export each key once.** `eventKey()` mints a new identity per call, so two files calling `eventKey("user.created")` are talking about different events and will never see each other's emissions.

```ts
// events.ts
export const UserCreated = eventKey<{ id: string }>("user.created");
```

**Share the instance like any other dependency** — pass it in, or register it:

```ts
const Bus = token<EventBus>("event-bus");
root.provide(Bus, () => new EventBus({ onError: report }));
```

`EventBus` is `Disposable`, so the container that built it also closes it.

## Failures

A listener that throws never stops the others and never changes the publisher's result. One report per emission reaches `onError` after every listener ran: a single failure as-is, several as an `AggregateError`.

**Pass `onError` in any long-lived process.** Without it a listener failure is rethrown from a microtask, which reaches Node as an `uncaughtException` and can end the process. That is deliberate — swallowing an observer's failure is worse — but it means the owner of an application's bus should always supply a reporter.

## API

|                                      |                                                                                                                                                |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `eventKey<T>(description)`           | The event identity and its payload type. Description is for diagnostics only.                                                                  |
| `new EventBus({ onError? })`         | A bus. A non-function `onError` throws `TypeError`.                                                                                            |
| `bus.on(key, listener, { signal? })` | Subscribe in delivery order; returns an idempotent unsubscribe. `signal` unsubscribes on abort, and an already-aborted one subscribes nothing. |
| `bus.emit(key, event)`               | Deliver to the subscribers present when the emission starts.                                                                                   |
| `bus.hasListeners(key)`              | Whether anyone is subscribed.                                                                                                                  |
| `bus.close()`                        | Drop every subscription and seal the bus. Idempotent, also invoked by `using`.                                                                 |

Subscribing the same function twice gives two subscriptions. After `close()`, `on` and `emit` throw Runner's `LifecycleStateError`.
