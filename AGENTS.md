# AGENTS.md

## Project Overview

**c8y-realtime** is a standalone, dependency-light TypeScript SDK for the Cumulocity IoT **Notification 2.0** API. It implements the Notification 2.0 protocol directly (subscriptions REST, token minting, the `wss` consumer protocol, and the ack format) with **zero dependency on `@c8y/client`**.

> **Source of truth:** `Notification2.md` (the 2.0 protocol) is the spec this is built against. `apis.md` is the _older_ Bayeux real-time API and is used ONLY as a reference for resource payload shapes and the CREATE/UPDATE/DELETE taxonomy — NOT the protocol. Ignore the Bayeux/CometD framing in older parts of this doc; this SDK is Notification 2.0.

**Project intent:**

- Implement Notification 2.0 directly (native `fetch` for REST, `ws` for the consumer)
- Framework-agnostic core; the ergonomic high-level client is a thin layer on top
- Work in Node.js (browser-friendly; the WebSocket impl is injectable)
- Two layers: `createNotificationClient` (low-level core) and `createRealtimeClient` (typed hooks)

### Architecture (actual)

```text
src/
├── index.ts          # public exports
├── types.ts          # protocol types (Subscription, TokenResponse, Notification, …)
├── domain.ts         # domain payload types (Alarm, Measurement, ManagedObject, …)
├── errors.ts         # C8yError / C8yHttpError / C8yConnectionError
├── http.ts           # authenticated fetch (Basic auth, URL joining)
├── subscriptions.ts  # notification2/subscriptions + /token + /unsubscribe
├── frame.ts          # consumer wire-protocol frame parsing + ack id
├── consumer.ts       # resilient WebSocketConsumer (async-iterable)
├── client.ts         # createNotificationClient / createMultiTenantClient
└── realtime.ts       # createRealtimeClient (typed hooks, one topic + one consumer)
```

Key model note (see Learnings): a Notification 2.0 **subscription** ≠ **topic** ≠ **consumer**. The high-level client uses ONE topic + ONE consumer, with per-scope subscriptions (apis narrowed to registered types) funneling in.

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

## Protocol Scope (Notification 2.0)

This package implements the Notification 2.0 flow directly — NOT the Bayeux/CometD real-time API.

### REST (`notification2/*`)

- `subscriptions` — create / list / get / delete forwarding rules. `ensure()` treats 409 as success.
- `token` — mint a consumer JWT for a `(subscription, subscriber)`.
- `unsubscribe?token=<jwt>` — remove a consumer (needs the topic live).

### Consumer protocol (`wss://…/notification2/consumer/?token=<jwt>`)

- Frames are UTF-8 text: header lines separated by `\n`, a blank line, then the payload.
- First header = the **ack id** (send it back verbatim on the same socket to acknowledge).
- Second header = `/{tenantId}/{type}/{sourceId}`; third = action (`CREATE`/`UPDATE`/`DELETE`).
- Resilience: ping/pong keepalive, reconnect with backoff, token refresh per connect, teardown flag, fatal-4xx stops instead of looping.

### Subscription / topic / consumer model (critical)

A **subscription** ≠ a **topic** ≠ a **consumer** (see Learnings and `Notification2.md`). Deleting a subscription does not delete its topic or consumers. The high-level client uses ONE topic + ONE consumer, with per-scope subscriptions (`tenant` or `mo`+device, apis narrowed to registered types) funneling in; routing is client-side by `(type, sourceId, action)`.

- Names (subscription + subscriber) must be **alphanumeric**.
- DELETE payloads may only contain an identifier; do not assume full object payloads.

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

There are two test tiers under `tests/`:

- **`tests/unit/`** — pure/mocked unit tests (auth, URL joining, ensure-409, frame/ack parsing, consumer resilience via a `MockSocket`, realtime routing + apis narrowing + dedupe). Run in CI. `pnpm test:unit`.
- **`tests/e2e/`** — **live** integration tests against a real Cumulocity tenant. **Local only** — NOT run in CI. `pnpm test:e2e`.

### Live e2e requires a local `.env` (needed!)

The e2e suite reads throwaway credentials from a **gitignored `.env`** at the repo root:

```
C8Y_REALTIME_URL=...
C8Y_REALTIME_TENANT=...
C8Y_REALTIME_USER=...
C8Y_REALTIME_PASSWORD=...
```

When `.env` (or those env vars) are absent the whole e2e suite **auto-skips**, so `pnpm test:run` stays green without credentials. The e2e tests mutate a real tenant (create/delete managed objects, measurements, events, alarms, operations) and clean up in `afterAll` — including purging Messaging **consumers** via the admin API (see Learnings). Never commit `.env` or log its values.

### CI vs local

- **CI** (`.github/workflows/ci.yml`) runs `install → build → test:unit → lint → typecheck`. It does NOT run e2e (no secrets; e2e creates undeletable Messaging topics and mutates a real tenant).
- Do **not** add the tenant credentials as CI secrets to run e2e in CI on the shared throwaway user — concurrent local+CI runs collide on the same fixed subscription/consumer names.

### Automation rule

- Use `pnpm test:unit` (CI/automation) or `pnpm test:run` (all, e2e auto-skips without `.env`).
- Do **not** use `pnpm test` in automated runs — it starts watch mode.

## Commit, PR, and Release Workflow

### Local workflow

Before finishing a change, run:

```sh
pnpm lint
pnpm typecheck
pnpm build
pnpm test:run
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

- The package should stay lightweight and avoid unnecessary runtime dependencies in the core realtime implementation. Runtime deps: `ws` (consumer) and `hookable` (high-level dispatch) only.
- CI runs build, unit tests, lint, and typecheck on pull requests; keep local verification aligned with that.
- Release publishing is tag-driven through GitHub Actions and npm.

### Notification 2.0 resource model & cleanup (learned the hard way)

- Three distinct server-side resources: **subscription** (`notification2/subscriptions`, has an `id`, deletable), **topic** (Messaging Service, named by the `subscription` field; many subscriptions with the same name funnel into ONE topic), and **consumer/subscriber** (created on first websocket connect; persists after disconnect).
- Deleting a subscription does NOT delete the topic or its consumers. Disconnecting a websocket does NOT remove the consumer.
- `subscriptionFilter.apis` is a **filter** (which data categories forward), alongside `typeFilter` (content) and `fragmentsToCopy` (payload trimming) — not a "channel". Scope is `context` + `source`, separately.
- The old design created one topic+consumer per `(type, scope)` → a new topic every run (device ids change) → resource leak. Fixed: ONE topic + ONE consumer per client, per-scope subscriptions funneling in.
- **Cleanup** (tests): delete subscription resources by id AND purge consumers via the admin API: `GET /service/messaging-management/tenants/{tenant}/namespaces/relnotif/topics` → `DELETE …/topics/{topic}/types/persistent/subscribers/{name}`. Topics themselves can NOT be deleted (405); they auto-GC once empty.

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
- Do not forget to update `README.md` and `AGENTS.md` when public behavior or architecture changes.
