# TiberJS manager

A pnpm workspace of three independently published packages built on [Runner](https://github.com/tiberjs/runner). There is no root package: each one is installed and versioned on its own.

| Package             | Purpose                                                                                   | Docs                                             |
| ------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `@tiberjs/durable`  | Run Runner handlers as durable jobs with retries, cancellation, and optional checkpoints. | [packages/durable](packages/durable/README.md)   |
| `@tiberjs/di`       | Hierarchical dependency container that constructs, caches, and disposes what it owns.     | [packages/di](packages/di/README.md)             |
| `@tiberjs/eventbus` | Typed, synchronous, in-process notifications.                                             | [packages/eventbus](packages/eventbus/README.md) |

All three require **Node.js 24+** and TypeScript compiled with standard decorators, not legacy `experimentalDecorators`.

## Runner dependency

`@tiberjs/di` and `@tiberjs/eventbus` depend on `@tiberjs/runner` `^0.2.0`; `@tiberjs/durable` stays on `^0.1.1`. Runner 0.2.0 is not published yet, so inside this workspace `^0.2.0` resolves to the packed artifact committed under `vendor/`. That pin is temporary and disappears once 0.2.0 ships; packages on `^0.1.1` are unaffected by it.

## Development

Commands run from the workspace root:

```sh
pnpm install --frozen-lockfile
pnpm format
pnpm check
pnpm build
pnpm test
```

Run one package's suite with `pnpm test --project @tiberjs/di`. Contributor rules live in [AGENTS.md](AGENTS.md).
