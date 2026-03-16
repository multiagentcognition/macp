# MACP

**Multi-Agent Cognition Protocol** for real-time coordination between AI agents working on the same project.

Protocol v1.0 | [Schema](macp.schema.json) | [Specification](spec/MACP-Protocol-v1.0.md) | Apache 2.0 | [macp.dev](https://macp.dev) | [multiagentcognition.dev](https://multiagentcognition.dev)

---

MACP is a protocol for coordination between AI agents: messaging, handoffs, delivery semantics, findings, memory, goals, tasks, and durable context between independent agents while work is happening.

It bridges the gap between A2A and MCP: MCP handles tool access, A2A handles communication, and MACP handles coordination during execution.

The idea is broader than coding tools. It’s meant for software that embeds multiple agents and needs them to coordinate reliably rather than behave like isolated workers.

This repo contains the protocol — spec, schema, and a TypeScript reference implementation with zero runtime dependencies.

```bash
npm i macp
```

```ts
import { MacpCore, MacpWorkspaceExtensions } from 'macp';
```

## MCP Implementations

There are two MCP server implementations for MACP, both part of the [multiagentcognition](https://github.com/multiagentcognition) org:

- **[macp-agent-mcp](https://github.com/multiagentcognition/macp-agent-mcp)** — the reference MCP server for AI coding agents. Activate it once per project and supported hosts auto-register each session on startup.
- **[macp-openclaw-plugin](https://github.com/multiagentcognition/macp-openclaw-plugin)** — the OpenClaw plugin that exposes MACP coordination through the OpenClaw agent framework.

## Quick Start

The fastest way to use MACP is through the agent MCP server:

```bash
npx -y macp-agent-mcp init
```

That command activates MACP for the current project, creates a local SQLite bus, and writes MCP config for supported hosts.

To use the protocol directly without MCP, install this package and use the classes:

```ts
import { MacpCore, MacpWorkspaceExtensions, MacpWorkspaceExtensionsAdvanced } from 'macp';

const core = new MacpCore({ dbPath: '/path/to/shared.db' });
core.registerAgent({ agentId: 'my-agent', sessionId: 'session-1', name: 'My Agent', capabilities: {}, interestTags: [], queuePreferences: { maxPendingMessages: 200 } });
```

Or use the SQL operations from [macp.schema.json](macp.schema.json) directly with bound parameters from any language.

## What MACP Is

MACP is a vendor-agnostic protocol for real-time coordination between AI agents
while they are actively working. It uses a shared SQLite file as the transport
layer, keeps delivery state and ACK state durable, and lets agents exchange
findings without introducing a central network service.

The protocol itself lives in [macp.schema.json](macp.schema.json) and
[spec/MACP-Protocol-v1.0.md](spec/MACP-Protocol-v1.0.md).

## The Opportunity

Current agent tooling usually covers one of two things:

- agent-to-tool access through MCP
- agent-to-agent transport or workflow orchestration

What is usually missing is a durable shared coordination layer inside the work
loop itself. MACP fills that gap by giving agents one shared bus for status,
findings, file claims, memory, and task context while each agent keeps its own
separate working context.

## What MACP Enables

- live coordination across multiple agents in one project
- file ownership signaling before edits collide
- durable shared memory and task context above the message bus
- prioritized delivery of urgent findings through `info`, `advisory`,
  `steering`, and `interrupt`
- simple project-scoped activation with no broker or external service

## How It Works

Each logical send has one `message_id`. Each recipient gets its own
`delivery_id`. Delivery state, ACK state, queue limits, and pruning all live in
the same shared SQLite file.

Key mechanics:

- agents poll the bus instead of receiving push delivery
- `poll` returns both `queued` and `surfaced` deliveries
- sends execute inside `BEGIN IMMEDIATE` so queue enforcement and sequence
  allocation stay atomic
- direct deliveries store `channel_id = NULL`
- lower-value deliveries can be budget-pruned without being deleted
- consumers must be idempotent because delivery is at-least-once

Priority tiers:

- `info`
- `advisory`
- `steering`
- `interrupt`

## Protocol Operations

Core operations:
- `register` / `deregister`
- `join` (channel)
- `send` (channel or direct)
- `poll`
- `ack`

Extension operations:
- awareness: list agents, get session context
- file ownership: claim files, release files, list locks
- memory: set, get, search, list, delete, resolve
- profiles: register, get, list, find
- goals: create, list, get, update, get cascade
- tasks: dispatch, claim, start, complete, block, cancel, get, list, archive
- lifecycle: sleep agent, deactivate agent, delete agent
- vault/docs: register vault, search vault, get vault doc, list vault docs
- context search: query context

See [docs/EXTENSIONS.md](docs/EXTENSIONS.md) for the extension boundary and [docs/TUTORIAL.md](docs/TUTORIAL.md) for the longer walkthrough.

## Direct SQL

Use the SQL operations from [macp.schema.json](macp.schema.json) directly with bound parameters:

1. apply the DDL from `connection.schema_ddl`
2. `operations.register`
3. `operations.join`
4. `operations.send`
5. `operations.poll`
6. `operations.ack`
7. `operations.deregister`

Important operational rules:
- validate the joining session with `operations.join.step_0_validate_session`
- run logical sends inside `BEGIN IMMEDIATE`
- validate the sender session before any send
- validate sender membership for channel sends
- use bound parameters, never string-spliced SQL
- direct deliveries bind `channel_id = NULL`
- `poll` returns both `queued` and `surfaced`
- receivers must therefore be idempotent
- only `queued` and `surfaced` deliveries are ackable

## How MACP Works in Detail

MACP gives each recipient its own `delivery_id` while preserving one logical `message_id` per send. Delivery state, ACK state, pruning, and queue limits all live in the same SQLite file.

Per-delivery lifecycle:
- `queued` → `surfaced` → `acknowledged`
- `expired` / `dropped` (terminal)

ACK lifecycle:
- `queued`: written automatically when a delivery row is inserted
- `received`: written automatically when `poll` surfaces the delivery
- `processed`: written explicitly by the receiving agent after it acts

Delivery model:
- `poll` returns both `queued` and `surfaced`
- this gives the SQLite bus simple at-least-once semantics
- byte-budget pruning keeps lower-value deliveries pending instead of deleting them
- each logical send executes inside one SQLite `BEGIN IMMEDIATE` transaction so queue enforcement and sequence allocation stay atomic under contention

Why SQLite:
- cheap to embed
- easy to inspect
- durable with WAL mode
- usable from any language with SQLite support

## Reference Files

```text
macp.schema.json                 Normative schema and SQL operations
spec/MACP-Protocol-v1.0.md      Companion SQLite-only specification
src/index.ts                     Package entrypoint exports
src/schema.ts                    Schema loading helpers
src/macp-core.ts                 TypeScript reference implementation
src/macp-extensions.ts           Core workspace extensions
src/macp-extensions-advanced.ts  Advanced workspace extensions
docs/TUTORIAL.md                 Quickstart and usage patterns
docs/EXTENSIONS.md               Optional workspace-layer extensions
docs/SECURITY.md                 Shared-file security model
examples/MACP_COORDINATION.md    Agent instructions template
```

## Requirements

The protocol requires SQLite 3.35+ with WAL mode and a shared filesystem path reachable by all participating agents. Any language with SQLite support can implement it using the SQL operations in [macp.schema.json](macp.schema.json).

The `macp` npm package (TypeScript reference implementation) requires Node.js 22.5+.

## Links

- Website: [macp.dev](https://macp.dev)
- Organization: [multiagentcognition.dev](https://multiagentcognition.dev)
- GitHub: [github.com/multiagentcognition/macp](https://github.com/multiagentcognition/macp)
- License: [Apache 2.0](LICENSE)
