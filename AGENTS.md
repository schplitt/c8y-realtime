# AGENTS.md

## Project Overview

**@schplitt/c8y-realtime** is a Web API compatible real-time client for Cumulocity IoT. It provides a simple, hook-based interface for subscribing to real-time updates from Cumulocity using the Bayeux protocol over WebSockets. The client is built on top of [hookable](https://github.com/unjs/hookable) and uses [better-result](https://github.com/dmmulroy/better-result) for robust error handling.

## Architecture

### Core Components

#### RealtimeClient

- Main public API using `HookableCore` from hookable library internally
- Manages lifecycle: lazy connection, hook registration, cleanup
- Hook format: `hook(id, name, callback)`
  - `id`: Device ID (string) or `'*'` for all devices
  - `name`: Hook name like `'inventory:create'`, `'inventory:update'`, `'inventory:delete'`, `'inventory:all'`
  - Internally uses key format: `${id}#${name}` for hook storage

#### Connection Management

- Handles **Web API WebSocket** connection to Cumulocity's `/notification/realtime` endpoint
- Uses standard `WebSocket` API (works in Node.js 18+, Deno, Bun, and browsers)
- Implements Bayeux protocol flow:
  1. **Handshake**: POST to `/meta/handshake` → receive `clientId`
  2. **Connect**: WebSocket connection for real-time messages
  3. **Disconnect**: POST to `/meta/disconnect` on cleanup
- Auto-reconnection logic with configurable delays
- Uses `better-result` for internal connection error handling
- Only connects when first hook is registered (lazy connection)

#### Subscription Management

- Manages Cumulocity channel subscriptions
- Maps hook patterns to Cumulocity channels:
  - `inventory:12345:*` → `/managedobjects/12345`
  - `inventory:*:create` → `/managedobjects/*` (filtered by action)
- Tracks active subscriptions and reference counts
- Automatically subscribes/unsubscribes as hooks are added/removed
- POST to `/meta/subscribe` or `/meta/unsubscribe`

#### Message Routing

- Receives messages from WebSocket connection
- Parses Cumulocity notification format:
  ```json
  {
    channel: "/managedobjects/145075",
    data: [{
      realtimeAction: "UPDATE",
      data: { id: "145075", name: "...", ... }
    }]
  }
  ```
- Routes to appropriate hooks based on:
  - Managed object ID from channel
  - `realtimeAction` (CREATE, UPDATE, DELETE)
- Handles wildcard subscriptions (`inventory:*:update`)

### Data Flow

1. User calls `client.hook('12345', 'inventory:update', callback)`
2. RealtimeClient creates internal key: `'12345#inventory:update'`
3. Stores callback in HookableCore with this key
4. Returns unhook function that removes the callback
5. When Cumulocity message arrives:
   - Parser extracts `managedObjectId` and `realtimeAction`
   - Creates matching key(s): `'${id}#inventory:${action}'` and `'${id}#inventory:all'`
   - Also checks wildcard: `'*#inventory:${action}'` and `'*#inventory:all'`
   - Triggers all matching hooks with parsed data
6. User calls `unhook()` or `removeHook()` when done
7. Callback is removed from internal storage

### Bayeux Protocol Implementation

The client implements the Bayeux protocol as specified by Cumulocity:

#### Handshake Request

```json
[{
  "channel": "/meta/handshake",
  "version": "1.0"
}]
```

#### Subscribe Request

```json
[{
  "channel": "/meta/subscribe",
  "clientId": "<received-from-handshake>",
  "subscription": "/managedobjects/<deviceId>"
}]
```

- **hookable**: Core pub/sub system for hook management
  - Provides type-safe hook system
  - Handles hook lifecycle (register, trigger, unregister)
  - Returns unhook function for cleanup
- **Hook naming**: Use format `<resource>:<id>:<action>`
  - Resource: `inventory`, `alarm`, `event`action>`
  - Resource: `inventory` (more resources to be added: `alarm`, `event`, `measurement`, `operation`)
  - Action: `create`, `update`, `delete`, `all`
  - Device ID is separate parameter: `hook(id, name, callback)`
  - Reuse single WebSocket connection for all subscriptions
  - Cumulocity limits parallel connections per user

- **Don't forget to handle DELETE events differently**
  - DELETE notifications only contain the managed object ID
  - Other fields may be missing or undefined

- **Don't ignore Bayeux protocol requirements**
  - Must send `clientId` in all requests after handshake
  - Must immediately repeat `/meta/connect` after receiving response
  - Empty responses keep connection alive, must re-poll

- **Don't over-poll or stream large volumes**
  - Long-polling is not designed for >100kB/sec or >50 events/sec
  - This is a limitation of Cumulocity's implementation

- **Don't forget session timeout (2 hours default)**
  - Implement keep-alive by polling `/meta/connect`
  - Handle re-authentication on session expiry
- **Lazy initialization**: Don't create connections until needed
  - First hook registration triggers connection
  - Connection cleanup when last hook is removed

- **Smart subscriptions**: Deduplicate Cumulocity subscriptions
  - Multiple hooks for same device → single Cumulocity subscription
  - Use reference counting to know when to unsubscribe

- **Error handling**: All fallible operations return `Result<T, E>`
  - Connection errors
  - Subscription failures
  - Authentication errors
  - Hook callback errors (optional, user-defined)

- **Type safety**: Leverage TypeScript for hook types
  - Define hook types with template literals: `inventory:${string}:${'create'|'update'|'delete'}`
  - Ensure callback sInternal error handling for async operations
  - Use `Result.ok(value)` and `Result.err(error)` internally for all connection operations
  - Connection errors, subscription failures, and auth issues should return Results internally
  - Makes error handling explicit and forces implementation to handle failures
  - **Not exposed in public API** - users work with standard callbacks and try/catch

- **Web API WebSocket**: Universal runtime compatibility
  - Use standard `WebSocket` API from Web APIs (no polyfills needed)
  - Works natively in:
    - **Node.js** 18+ (native WebSocket support)
    - **Deno** (built-in WebSocket)
    - **Bun** (built-in WebSocket)
    - **Browsers** (native WebSocket)
  - Use `fetch` for HTTP requests (handshake, subscribe, disconnect)
  - No conditional imports or runtime detection needed.)
  - Consider Node.js compatibility with conditional imports

```json
[{
  "channel": "/meta/connect",
  "clientId": "<clientId>",
  "connectionType": "long-polling",
  "advice": {
    "timeout": 5400000,
    "interval": 3000
  }
}]
```

### Authentication

- Basic Auth: Base64 encoded credentials in Authorization header
- OAuth: Access token in cookie, XSRF token in handshake `ext` object
- WebSocket: Auth passed in handshake `ext.authentication` field

### Source (src/)

- Main entry point for the package
- All public exports should be defined in `index.ts`
- Uses ESM module format
- Internal modules for connection, subscription, and utilities

### Tests (tests/)

- Uses Vitest for testing
- Test files follow the `*.test.ts` naming convention
- Import from `../src` to test the source code
- Mock WebSocket connections for unit tests
- Integration tests should use a test Cumulocity tenant (or mock server)

## Development

```sh
pnpm install    # Install dependencies
pnpm test       # Run tests with Vitest (watch mode)
pnpm test:run   # Run tests once (non-watch mode, for CI/automated workflows)
pnpm build      # Build with tsdown
pnpm lint       # Lint with ESLint
pnpm lint:fix   # Lint and auto-fix
pnpm typecheck  # TypeScript type checking
```

## Code Style

- ESM only (`"type": "module"`)
- TypeScript strict mode enabled
- Uses `tsdown` for building
- Uses `@schplitt/eslint-config` for linting
- Uses `vitest` for testing

## Testing

- Write tests in the `tests/` directory
- Use `*.test.ts` file naming convention
- Run `pnpm test:run` for test run (use this in automated workflows, never use `pnpm test` as you will get stuck in watch mode)
- Import modules from `../src`

Example test structure:

```ts
import { expect, test } from 'vitest'
import { myFunction } from '../src'

test('should do something', () => {
  expect(myFunction()).toBe(expectedValue)
})
```

## Maintaining Documentation

When making changes to the project:

- **`AGENTS.md`** — Update with technical details, architecture, and best practices for AI agents
  - Project architecture and file structure
  - Internal patterns and conventions
  - Development workflows
  - Testing strategies
  - Build/deployment processes
  - Code organization principles
  - Tool configurations and quirks

- **`README.md`** — Update with user-facing documentation for end users:
  - ✅ New exported utilities or functions from the package
  - ✅ New configuration options users can set
  - ✅ New CLI commands or features
  - ✅ Changes to existing API behavior
  - ✅ Environment variables users can set
  - ✅ Any feature users can configure, use, or interact with
  - ✅ Installation or setup instructions
  - ✅ Usage examples and code snippets

## Agent Guidelines

When working on this project:

1. **Run tests** after making changes: `pnpm test:run` (runs once, no watch mode)
2. **Run linting** to ensure code quality: `pnpm lint`
3. **Run type checking** before committing: `pnpm typecheck`
4. **Update this file** when adding new modules, APIs, or changing architecture
5. **Keep exports in `src/index.ts`** — all public API should be exported from the main entry point
6. **Add tests** for new functionality in the `tests/` directory
7. **Record learnings** — When the user corrects a mistake or provides context about how something should be done, add it to the "Project Context & Learnings" section below if it's a recurring pattern (not a one-time fix)
8. **Notify documentation changes** — When updating `README.md` or `AGENTS.md`, explicitly call out the changes to the user at the end of your response so they can review and don't overlook them

## Project Context & Learnings

This section captures project-specific knowledge, tool quirks, and lessons learned during development. When the user provides corrections or context about how things should be done in this project, add them here if they are recurring patterns (not a one-time fix).

> **Note:** Before adding something here, consider: Is this a one-time fix, or will it come up again? Only document patterns that are likely to recur or are notable enough to prevent future mistakes.

### Tools & Dependencies

<!-- Add tool-specific notes, required configurations, or gotchas here -->

### Patterns & Conventions

<!-- Add project-specific patterns, preferred approaches, or conventions here -->

### Common Mistakes to Avoid

<!-- Add things that have been done wrong before and should be avoided -->
