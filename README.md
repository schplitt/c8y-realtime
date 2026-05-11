# c8y-realtime

A Web API compatible real-time client for Cumulocity IoT that provides a simple, hook-based interface for subscribing to real-time updates.

## Features

- 🪝 **Hook-based API** - Simple event subscription using [hookable](https://github.com/unjs/hookable)
- 🎯 **Type-safe** - Full TypeScript support with typed hooks
- 🌐 **Web API Compatible** - Built for browsers, Node.js 18+, Deno, and Bun
- 🧱 **Minimal library internals** - Uses standard JavaScript/TypeScript error handling without app-level result wrapper dependencies

> **Status**: Early development.

## Installation

```sh
pnpm add c8y-realtime
# or
npm install c8y-realtime
# or
yarn add c8y-realtime
```

## Quick Start

```ts
import { RealtimeClient } from 'c8y-realtime'

// Create a client instance
const client = new RealtimeClient()

// Register hooks for inventory events
const unhook = client.hook('12345', 'inventory:update', async (object) => {
  console.log('Device updated:', object.name)
  console.log('Last updated:', object.lastUpdated)
})

// Hook into all CREATE events
client.hook('*', 'inventory:create', async (object) => {
  console.log('New device created:', object.id)
})

// Hook into DELETE events (only contains id)
client.hook('12345', 'inventory:delete', async (object) => {
  console.log('Device deleted:', object.id)
})

// Unsubscribe when done
unhook()
```

## API

### `RealtimeClient`

#### Methods

- **`hook(id, name, callback)`** - Subscribe to real-time events
  - `id`: Device ID (string) or `'*'` to match all devices
  - `name`: Hook name (e.g., `'inventory:create'`, `'inventory:update'`, `'inventory:delete'`, `'inventory:all'`)
  - `callback`: Function to call when event occurs
  - Returns an `unhook` function to unsubscribe

- **`removeHook(id, name, callback)`** - Remove a specific hook

- **`removeHooks(name)`** - Remove all hooks for a given name across all device IDs

### Hook Names

#### Inventory Hooks

- `'inventory:create'` - When a managed object is created
- `'inventory:update'` - When a managed object is updated
- `'inventory:delete'` - When a managed object is deleted (only `id` field available)
- `'inventory:all'` - All inventory events (create, update, delete)

### Development

```sh
# Install dependencies
pnpm install

# Run all tests once
pnpm test:run

# Run only the optional real-tenant integration tests
pnpm test:integration

# Build
pnpm build

# Lint
pnpm lint

# Type check
pnpm typecheck
```

## Real-tenant integration tests

The repository includes an optional Vitest integration test that exercises `C8YBayeuxConnection` directly against a real Cumulocity tenant.

Set these environment variables in your shell or in a local `.env` file before running `pnpm test:run` or `pnpm test:integration`:

```sh
export C8Y_REALTIME_URL='wss://your-tenant.example.com/notification/realtime'
export C8Y_REALTIME_TENANT='t12345'
export C8Y_REALTIME_USER='your-user'
export C8Y_REALTIME_PASSWORD='your-password'
```

Behavior:

- If any required environment variable is missing, the real-tenant test is skipped with Vitest's built-in `it.skipIf(...)`.
- If the test runs and fails, it fails normally.

## License

MIT