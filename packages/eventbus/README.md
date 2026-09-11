# @tiberjs/eventbus

Typed notifications between components inside one process. Publishers announce that something happened without knowing who listens, and payload types are checked at every call site because an event is a typed key rather than a bare string.

A bus is an ordinary object you construct, own, and close — there is no global instance, no queue, and no cross-process fanout.

Requires **Node.js 24+**.

## Installation

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
console.log(bus.hasListeners(UserCreated)); // true

unsubscribe();
```

`emit` returns once the last listener has returned; `using` closes the bus at the end of the scope.

## Sharing one bus across files

Importing `EventBus` gives you the class, not an instance. There is no global bus, so publishers and subscribers in different files have to reach the same object, and two rules follow from that.

**Define each key once and export it.** `eventKey()` mints a fresh identity per call, so two files that each call `eventKey("user.created")` are talking about two different events and will never see each other's emissions. Keep them in a module both sides import:

```ts
// events.ts
export const UserCreated = eventKey<{ id: string }>("user.created");
```

**Share the instance the way you share any other dependency.** Pass it in, or register it with a container:

```ts
import { Container, inject, token } from "@tiberjs/di";

const Bus = token<EventBus>("event-bus");

await using root = new Container();
root.provide(Bus, () => new EventBus({ onError: report }));

class Publisher {
  #bus = inject(Bus);
  announce(id: string) {
    this.#bus.emit(UserCreated, { id });
  }
}
```

Every consumer resolving `Bus` gets the same bus, and because `EventBus` is `Disposable` the container that built it also closes it: leaving the container's scope drops every subscription, and a later `emit` raises Runner's `LifecycleStateError`. Whoever constructs the bus decides its lifetime — the bus never registers itself anywhere.

## API

### `eventKey<T>(description): EventKey<T>`

Create an event identity and fix its payload type. The description is for diagnostics only — two keys built from the same description are still different events. Keys are frozen and carry no behavior.

### `new EventBus(options?)`

`options.onError(error, context)` receives listener failures; `context.event` is the description of the key being delivered. See [Failures](#failures).

### `bus.on(key, listener, options?): () => void`

Subscribe. Listeners run in registration order and must be synchronous: `EventListener<T>` returns `undefined`, and the bus never awaits a return value.

Returns an idempotent unsubscribe function. Passing `options.signal` also unsubscribes on abort; an already-aborted signal subscribes nothing and returns a no-op.

Each call is its own subscription, so registering the same function twice delivers twice and needs two unsubscribes.

### `bus.emit(key, event): void`

Deliver `event` to every current subscriber of `key`, inline. Returns `void`.

### `bus.hasListeners(key): boolean`

Whether anyone is currently subscribed to `key`. Always `false` after close.

### `bus.close(): void`

Drop every subscription and seal the bus. Synchronous, idempotent, and also invoked by `using` through `Symbol.dispose`. Afterwards `on` and `emit` throw Runner's `LifecycleStateError`.

## What you need to know to use it correctly

**Delivery is synchronous.** `emit` calls each listener on the publisher's own stack and returns when the last one returns. There is no mailbox, no flush, no backpressure, and no async listener contract. Because nothing is deferred, a listener runs in the publisher's Runner execution context, so `inject()`, `use()`, and `signal()` inside it observe the emitting execution.

**Subscriptions are revocable and stable during delivery.** Unsubscribe with the returned function or by aborting the signal you passed. An `emit` delivers to the subscribers that were registered when it started, so subscribing, unsubscribing, or closing from inside a listener affects later emissions only.

**Background work is yours, not the bus's.** A listener that must await, retry, or outlive the publisher forks a caller-owned Runner job instead of becoming async:

```ts
import { fork } from "@tiberjs/runner";

bus.on(UserCreated, (user) => void fork(() => sendWelcomeEmail(user.id)));
```

`fork` needs an active Runner job, which the listener has whenever the publisher emits from inside one. The bus itself never starts, joins, or awaits anything, and `close()` does not wait for work a listener started.

## Failures

A listener that throws never stops delivery to the others and never changes the publisher's result. Failures from a single `emit` are collected and reported once, after every listener has run, through Runner's `combinedError`: one failure is reported as-is, several as an `AggregateError`.

**Supply `onError` in any long-lived process.** Without a reporter, a listener failure is rethrown from a microtask, which reaches Node as an `uncaughtException` and, with no handler installed, terminates the process. That is deliberate — silently swallowing an observer's failure is worse — but it means a bus that carries application-wide notifications should always be constructed with a reporter:

```ts
const bus = new EventBus({
  onError: (error, { event }) => void logger.error({ err: error, event }, "listener failed"),
});
```

`onError` is itself synchronous; do any reporting I/O in your own job. A reporter that throws never reaches the publisher — its error and the listener failure both surface as unhandled errors instead.
