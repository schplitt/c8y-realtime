# AGENTS.md

## Project Overview

**@schplitt/c8y-realtime** is a Cumulocity-specific realtime client that implements the required Bayeux message flow directly, without depending on `@c8y/client` realtime or CometD.

The goal of this package is **not** to avoid the Cumulocity realtime protocol. The goal is to own the implementation stack and expose a cleaner, more controllable, strongly typed API for browser and server runtimes.

**Project intent:**

- Implement the Cumulocity realtime protocol directly
- Be **WebSocket-first**
- Work in both **browser** and **Node.js** environments
- Keep the core **framework-agnnostic**
- Expose plain TypeScript primitives, not framework hooks as the foundation
- Provide **Cumulocity-specific helpers** instead of generic CometD abstractions
- Stay intentionally narrow: this is **not** a general-purpose Bayeux client

> **Current state:** The repository is still early and currently contains a minimal hook-based prototype. Treat that as an implementation starting point, **not** as the final architectural direction. Future work should move the package toward the framework-agnostic core described in this file.

## Key Design Constraints

### What this package is

- A **minimal Bayeux-over-WebSocket client specialized for Cumulocity**
- A library for **shared realtime infrastructure** in browser apps, servers, Nitro apps, and microservices
- A package that owns its own:
  - public API
  - types
  - auth abstraction
  - reconnect behavior
  - resubscription behavior
  - Cumulocity channel helpers

### What this package is not

- Not a wrapper around CometD
- Not a wrapper around `@c8y/client` realtime
- Not a generic Bayeux client for arbitrary servers
- Not a framework-specific hooks/composables package at the core layer

### Core API direction

Prefer building toward these primitives:

- connection lifecycle control
- subscription handles
- typed events
- typed channel builders
- callback-based subscriptions and/or async iterables
- explicit connection state events

If framework hooks/composables are added later, they should be **thin wrappers on top of the core**, not the core itself.

## Architecture

### Current Repository Layout

```text
src/
├── index.ts         # Main public entry point
├── types.ts         # Current public hook and managed object types
└── websocket.ts     # Reserved for websocket/runtime transport work
```

### Expected Near-Term Architecture

As the library grows, prefer a structure close to this:

```text
src/
├── index.ts                 # Public exports only
├── client/                  # High-level realtime client
├── connection/              # Handshake/connect/disconnect/reconnect logic
├── protocol/                # Bayeux message types and protocol helpers
├── channels/                # Cumulocity-specific channel builders
├── auth/                    # Auth strategy/types for browser and server use
├── transport/               # WebSocket abstraction / injected implementation support
├── routing/                 # Incoming message parsing and event routing
├── subscriptions/           # Subscription registry, dedupe, ref counting
├── types/                   # Public API and protocol types
└── internal/                # Internal-only helpers and implementation details

tests/
├── unit/                    # Protocol, routing, channel, and state-machine tests
└── integration/             # Mock-server or tenant-backed integration tests
```

You do **not** need to create all of these immediately, but new code should move in this direction instead of deepening the current prototype shape.

### Package Exports

Current package export:

- `c8y-realtime` — main public entry point

Guidelines:

- Keep all public exports in `src/index.ts`
- Do not expose internal implementation files directly
- Add new exports intentionally; avoid leaking unstable internals

## Realtime Protocol Scope

This package should implement the Cumulocity realtime Bayeux flow directly.

### Required Bayeux messages

- `/meta/handshake`
- `/meta/connect`
- `/meta/subscribe`
- `/meta/unsubscribe`
- `/meta/disconnect`

### Required behavior

- Perform handshake and store `clientId`
- Include `clientId` in all subsequent meta requests
- Maintain the connect loop as required by Bayeux/Cumulocity
- Reconnect when the socket is lost
- Re-handshake when required
- Restore active subscriptions after reconnect
- Surface connection state transitions clearly

### Important Cumulocity-specific notes

- Realtime messages are Cumulocity-specific and should be modeled as such
- Provide typed helpers for resources like:
  - inventory
  - alarms
  - events
  - measurements
  - operations
- Consumers should not need to manually build raw channel strings everywhere
- DELETE payloads may only contain an identifier; do not assume full object payloads

### Message routing expectations

Incoming messages should eventually be routed using Cumulocity semantics:

- derive resource/channel information from the incoming message
- determine the affected entity id when present
- map Cumulocity realtime actions like `CREATE`, `UPDATE`, `DELETE`
- route to exact and wildcard listeners where supported by the public API

## Runtime Compatibility

### Browser

- Use native `WebSocket`
- Use standard `fetch`
- Avoid Node-only APIs in the core implementation

### Node.js

- Do **not** force a WebSocket dependency for all consumers
- Support an **injected WebSocket implementation/polyfill** when needed
- Keep the transport abstraction small and explicit
- Avoid hidden runtime magic when a dependency must be provided

### General runtime rules

- Prefer Web APIs and portable TypeScript where possible
- Keep the library compatible with server-side and browser-side usage
- Avoid framework/runtime lock-in in core modules

## Authentication

The library should own a small auth abstraction instead of inheriting one from another client.

Possible supported modes include:

- Basic auth
- Cookie/session-based auth for browser environments
- Token-based auth if needed by Cumulocity flows
- Handshake `ext` payload support where required

Guidelines:

- Keep auth types explicit
- Keep auth transport concerns separate from channel/subscription concerns
- Avoid baking app-specific auth assumptions into the core

## Current Prototype Notes

The current codebase exposes a hook-based `RealtimeClient` built on `hookable`.

That is acceptable as a temporary scaffold, but future work should prefer:

- framework-agnostic connection and subscription primitives
- explicit subscription handles over implicit hook-only APIs
- clear state management for disconnected / connecting / connected / reconnecting
- typed channel/resource helpers instead of raw string usage

If modifying the current prototype:

- avoid making the hook-first API harder to replace later
- keep new logic modular so it can be moved into connection/protocol/subscription layers
- prefer extracting reusable internals over adding more logic directly into `src/index.ts`

## Development

```sh
pnpm install    # Install dependencies
pnpm build      # Build package with tsdown
pnpm lint       # Run ESLint
pnpm lint:fix   # Auto-fix lint issues
pnpm typecheck  # TypeScript checks
pnpm test       # Vitest watch mode
pnpm test:run   # Vitest single run
pnpm release    # Version/tag workflow helper via bumpp
```

## Build and Tooling

- ESM only (`"type": "module"`)
- TypeScript strict mode enabled
- Built with `tsdown`
- Linted with `@schplitt/eslint-config`
- Tested with `vitest`
- Package manager: `pnpm`
- Node engine in `package.json`: `>=20.0.0`
- CI currently runs on Node 22

### Build output

- Package output goes to `dist/`
- Public package entry points resolve to built files in `dist/`
- Declaration files are generated during build

## Testing

### Current status

The repository currently keeps a single optional real-tenant integration test under `tests/integration/`.

### Test expectations

- Put tests under `tests/`
- Use `*.test.ts` naming
- Import from `../src` or `../../src` depending on location
- Put tests under `tests/`
- Use `*.test.ts` naming
- Import from `../src` or `../../src` depending on location
- Real-tenant integration tests may use environment variables and should:
  - live under `tests/integration/`
  - exercise the actual `C8YBayeuxConnection` flow rather than raw WebSocket smoke tests
  - load tenant credentials from shell env or a local `.env` file when configured to do so
  - skip with Vitest's built-in conditional skip when required tenant credentials are not present
  - fail normally when the external tenant check itself fails

### Automation rule

- Use `pnpm test:run` in automation and agent workflows
- Do **not** use `pnpm test` in automated runs because it starts watch mode

## Commit, PR, and Release Workflow

### Local workflow

Before finishing a change, run:

```sh
pnpm lint
pnpm typecheck
pnpm build
pnpm test:run
```

If you specifically touch real-tenant coverage, also run:

```sh
pnpm test:integration
```

If there are still no tests in the repo, note that `pnpm test:run` will fail with “No test files found”. In that case:

- still run it when relevant
- report the result clearly
- do not pretend tests passed

### Commit guidelines

- Keep commits focused and scoped to one concern when possible
- Include documentation updates in the same change when behavior or architecture changes
- Avoid mixing large refactors with unrelated formatting or cleanup
- Keep public API changes explicit in commit messages and final summaries

### Pull request / CI workflow

On pull requests, GitHub Actions currently runs:

- `pnpm install --frozen-lockfile`
- `pnpm build`
- `pnpm lint`
- `pnpm typecheck`

Implications:

- A change is not ready if it only typechecks locally but fails the build
- Keep the lockfile in sync with dependency changes
- Do not rely on unbuilt source-only behavior; build must pass too

### Main branch autofix workflow

On pushes to `main`, there is an autofix workflow that runs:

- `pnpm lint:fix`

Guidelines:

- Do not rely on autofix to clean up sloppy work
- Still run lint locally before finishing
- Expect formatting/lint-only follow-up commits from automation if needed

### Release workflow

Releases are currently triggered by pushing a tag matching:

```text
v*
```

The release workflow currently performs:

- install
- test
- build
- lint
- typecheck
- changelog generation
- npm publish

Guidelines:

- Do not change release-sensitive package metadata casually
- Keep `package.json`, exports, and build output aligned
- When versioning/publishing changes are made, verify tag-driven release assumptions still hold
- If adjusting test commands in CI/release, keep watch mode out of automation paths

## Code Style and Implementation Rules

### Public API

- Design for ergonomics, but keep internals explicit
- Prefer named types and small interfaces over opaque stringly APIs
- Make Cumulocity-specific helpers easy to discover
- Keep the core API framework-agnostic

### Error handling

- Use standard exceptions and explicit error types where helpful
- Surface connection and protocol failures clearly
- Do not silently swallow reconnect/auth/subscription errors
- Distinguish between recoverable transport failures and terminal configuration/auth failures

### Type design

- Prefer strong public typing over generic `any`-based event payloads
- Model DELETE payloads separately where necessary
- Use literal unions and helper types for resource/action/state values
- Keep internal protocol types separate from user-facing ergonomic types when useful

### File organization

- Keep `src/index.ts` as the public export surface
- Move reusable logic out of entry points into focused modules
- Separate transport, protocol, routing, and subscription concerns
- Avoid large god-files as the implementation grows

## Maintaining Documentation

When making changes to the project:

- **`AGENTS.md`** — Update technical details, architecture, workflows, and agent guidance
- **`README.md`** — Update all user-facing package documentation

### Update `README.md` when changing

- public API shape
- exported types or classes
- installation/runtime requirements
- auth options
- channel builders
- reconnect behavior
- subscription behavior
- browser/Node usage requirements
- WebSocket injection requirements for Node users
- examples and usage snippets

### Update `AGENTS.md` when changing

- file structure
- architecture direction
- protocol implementation strategy
- development workflow
- testing strategy
- CI/release behavior
- recurring project conventions or learnings

### Documentation checklist

- [ ] Did I add or change a public export?
- [ ] Did I change runtime requirements or environment assumptions?
- [ ] Did I change connection/reconnect/subscription behavior?
- [ ] Did I add or move source files?
- [ ] Did I change tests or verification workflow?
- [ ] Did I update the relevant docs in the same change?
- [ ] Did I explicitly tell the user that docs changed?

## Agent Guidelines

When working on this project:

1. Read `AGENTS.md` before making architectural assumptions
2. Keep all public exports in `src/index.ts`
3. Favor the target architecture in this file over deepening the temporary hook-first prototype
4. Add tests for new functionality under `tests/`
5. Run `pnpm lint`, `pnpm typecheck`, and `pnpm build` after meaningful changes
6. Run `pnpm test:run` for automated verification and report clearly if the repo still has no tests
7. Update `AGENTS.md` when architecture, workflows, or conventions change
8. Update `README.md` when user-facing behavior changes
9. Record recurring learnings in the section below when the user corrects a pattern or direction
10. Explicitly notify the user when documentation files were changed

## Project Context & Learnings

This section captures project-specific knowledge, tool quirks, and lessons learned during development. Only add items that are likely to matter again.

### Tools & Dependencies

- The package should stay lightweight and avoid unnecessary runtime dependencies in the core realtime implementation.
- CI runs build, lint, and typecheck on pull requests; keep local verification aligned with that.
- Release publishing is tag-driven through GitHub Actions and npm.

### Patterns & Conventions

- Build toward a **framework-agnostic, WebSocket-first core**. Framework hooks/composables belong on top, not at the center of the library.
- This library is **Cumulocity-specific on purpose**. Prefer explicit Cumulocity concepts and typed helpers over generic abstraction layers that add little value.
- In Node environments, prefer **injected WebSocket implementations** over forcing a transport dependency on all users.
- Use standard JavaScript/TypeScript error handling and explicit error types where useful.
- Keep browser and server runtime concerns separated behind small abstractions.

### Common Mistakes to Avoid

- Do not turn this into a generic CometD/Bayeux client.
- Do not hard-wire the core API to framework hooks/composables.
- Do not force raw channel strings everywhere when typed Cumulocity channel builders can be provided.
- Do not assume DELETE events contain full resource payloads.
- Do not use `pnpm test` in automation.
- Do not add extra test layers when the current direction is to keep only the single real-tenant `C8YBayeuxConnection` integration test.
- Do not forget to update `README.md` and `AGENTS.md` when public behavior or architecture changes.
