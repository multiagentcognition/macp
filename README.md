# MACP

**Multi-Agent Cognition Protocol** for real-time coordination between AI agents working on the same project.

<img width="617" height="275.5" alt="macp_logo_m" src="https://github.com/user-attachments/assets/57ecb363-4cf6-44e3-80fb-5e5ae31cb933" />

Protocol v1.0 | [Schema](macp.schema.json) | [Specification](spec/MACP-Protocol-v1.0.md) | Apache 2.0 | [macp.dev](https://macp.dev) | [multiagentcognition.dev](https://multiagentcognition.dev)

---

MACP is a shared SQLite coordination layer. It lets multiple agents publish status, share findings, signal file ownership, and exchange durable context without a central broker.

`macp-mcp` is the reference MCP wrapper around that protocol. You activate it once per project, then supported hosts can attach to the same workspace and auto-register each session on startup.

**Jump to:**
- [Quick Start](#quick-start)
- [What MACP Is](#what-macp-is)
- [The Opportunity](#the-opportunity)
- [What MACP Enables](#what-macp-enables)
- [How It Works](#how-it-works)
- [Common Setups](#common-setups)
- [Host Support](#host-support)
- [Tool Surface](#tool-surface)
- [Direct SQL](#direct-sql)
- [Protocol vs Package Version](#protocol-vs-package-version)
- [Reference Files](#reference-files)

## Quick Start

Activate MACP once in the project root:

```bash
npx -y macp-mcp init
```

That command:
- derives `projectId` from the current folder by default
- creates `.macp/config.json`
- creates a local SQLite bus under `.macp/`
- writes project-local MCP config for supported hosts
- updates `AGENTS.md` and `CLAUDE.md` with a managed MACP block

If you are running from a local clone instead of the published package:

```bash
npm install
npm run build
node build/src/cli.js init
```

## What MACP Is

MACP is a vendor-agnostic protocol for real-time coordination between AI agents
while they are actively working. It uses a shared SQLite file as the transport
layer, keeps delivery state and ACK state durable, and lets agents exchange
findings without introducing a central network service.

The protocol itself lives in [macp.schema.json](macp.schema.json) and
[spec/MACP-Protocol-v1.0.md](spec/MACP-Protocol-v1.0.md). The `macp-mcp`
package is the reference TypeScript CLI and MCP server built on top of that
protocol.

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

## Common Setups

### One Project, Many Coding Agents

This is the main workflow:

1. run `npx -y macp-mcp init` once in the repo root
2. open Claude Code, OpenCode, Gemini CLI, or another supported host in that same folder
3. each new session gets its own MCP server process, auto-registers, and joins the same MACP workspace
4. `AGENTS.md` or `CLAUDE.md` can tell the agent which channel to use and whether to use memory, tasks, vault, or other workspace tools

The first setup activates MACP for the project. Later agent sessions launched from that folder reuse the same project-scoped configuration unless their local instructions explicitly tell them to work on another channel.

### Cross-Folder or Cross-Repo Workspace

If you want agents from different folders or repositories to share one workspace, set an explicit `projectId`:

```bash
npx -y macp-mcp init --project-id acme-release-war-room
```

With an explicit `projectId`, the default DB path moves to a per-user shared location so agents from different working directories can still hit the same bus.

### ProjectId vs Channel

- `projectId`: the logical shared workspace id
- `channel`: the MACP routing scope for broadcast messages

Default setup:
- `projectId` comes from the current folder name
- one local SQLite file under `.macp/`
- one default channel derived from `projectId`

Advanced setup:
- explicit `projectId` lets multiple folders or repos share one bus
- one `projectId` can host multiple channels such as `frontend`, `backend`, or `release`
- direct agent-to-agent messages are not channel-scoped

## Host Support

Project activation currently writes these host-facing config files:

- `.mcp.json`
- `opencode.json`
- `.gemini/settings.json`
- `.vscode/mcp.json`
- `.cursor/mcp.json`

Current support model:

- Claude Code: project-local `.mcp.json` plus `CLAUDE.md`
- OpenCode: `opencode.json` plus `AGENTS.md`
- Gemini CLI: `.gemini/settings.json` plus `AGENTS.md`
- Cursor / VS Code: project-local MCP config is written, depending on the editor MCP flow you use
- Codex: `AGENTS.md` is supported, but MCP attachment still needs Codex-side configuration rather than the same project-local auto-attach flow

For project instructions, copy [examples/MACP_COORDINATION.md](examples/MACP_COORDINATION.md) into the file your host reads:

- Claude Code: `CLAUDE.md`
- Codex: `AGENTS.md`
- OpenCode: `AGENTS.md`
- other MCP-capable hosts: system prompt or agent instructions

Replace `{{MACP_CHANNEL}}` if you want the default channel called out explicitly in the instruction text.

## Tool Surface

Core MACP tools:
- `macp_get_instructions`
- `macp_register`
- `macp_join_channel`
- `macp_send_channel`
- `macp_send_direct`
- `macp_poll`
- `macp_ack`
- `macp_deregister`

Optional workspace extensions:
- awareness: `macp_ext_list_agents`, `macp_ext_get_session_context`
- file ownership: `macp_ext_claim_files`, `macp_ext_release_files`, `macp_ext_list_locks`
- memory: `macp_ext_set_memory`, `macp_ext_get_memory`, `macp_ext_search_memory`, `macp_ext_list_memories`, `macp_ext_delete_memory`, `macp_ext_resolve_memory`
- profiles: `macp_ext_register_profile`, `macp_ext_get_profile`, `macp_ext_list_profiles`, `macp_ext_find_profiles`
- goals: `macp_ext_create_goal`, `macp_ext_list_goals`, `macp_ext_get_goal`, `macp_ext_update_goal`, `macp_ext_get_goal_cascade`
- tasks: `macp_ext_dispatch_task`, `macp_ext_claim_task`, `macp_ext_start_task`, `macp_ext_complete_task`, `macp_ext_block_task`, `macp_ext_cancel_task`, `macp_ext_get_task`, `macp_ext_list_tasks`, `macp_ext_archive_tasks`
- lifecycle: `macp_ext_sleep_agent`, `macp_ext_deactivate_agent`, `macp_ext_delete_agent`
- vault/docs: `macp_ext_register_vault`, `macp_ext_search_vault`, `macp_ext_get_vault_doc`, `macp_ext_list_vault_docs`
- context search: `macp_ext_query_context`

Normal agent loops should mostly use:
- `macp_poll`
- `macp_send_channel`
- `macp_send_direct`
- `macp_ack`

`macp_register` and `macp_join_channel` are still available for repair or override flows, but they should not be part of the normal startup loop after project activation.

See [docs/EXTENSIONS.md](docs/EXTENSIONS.md) for the extension boundary and [docs/TUTORIAL.md](docs/TUTORIAL.md) for the longer walkthrough.

## Direct SQL

If you do not want MCP, use the SQL operations from [macp.schema.json](macp.schema.json) directly with bound parameters.

Normal sequence:
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

Priority tiers:
- `info`
- `advisory`
- `steering`
- `interrupt`

Per-delivery lifecycle:
- `queued`
- `surfaced`
- `acknowledged`
- `expired`
- `dropped`

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

## Protocol vs Package Version

- protocol version: `MACP v1.0`
- npm package version: `macp-mcp 2.1.0`

The protocol version tracks the schema and companion spec. The npm package version tracks the TypeScript implementation, CLI, MCP server, and packaging UX.

## Reference Files

```text
macp.schema.json                 Normative schema and SQL operations
spec/MACP-Protocol-v1.0.md       Companion SQLite-only specification
docs/TUTORIAL.md                 Quickstart and usage patterns
docs/EXTENSIONS.md               Optional workspace-layer extensions
docs/SECURITY.md                 Shared-file security model
package.json                     Node package metadata for the reference implementation
tsconfig.json                    TypeScript build configuration
src/cli.ts                       CLI entrypoint for macp-mcp / macp-server
src/index.ts                     Package entrypoint exports
src/project.ts                   Project activation and config discovery helpers
src/schema.ts                    Schema loading helpers
src/macp-core.ts                 TypeScript reference implementation
src/macp-extensions.ts           Core workspace extensions
src/macp-extensions-advanced.ts  Advanced workspace extensions
src/server.ts                    TypeScript MCP server
examples/MACP_COORDINATION.md    Agent instructions template
```

## Requirements

- Node.js 22.5+ for the TypeScript reference implementation and MCP server
- SQLite 3.35+
- shared filesystem path reachable by all participating agents
- agents that can execute SQL with bound parameters

## Status

MACP v1.0 in this repository is the SQLite/shared-database protocol only.
There are no alternate transport definitions in scope for this version.

## Links

- Website: [macp.dev](https://macp.dev)
- Organization: [multiagentcognition.dev](https://multiagentcognition.dev)
- GitHub: [github.com/multiagentcognition/macp](https://github.com/multiagentcognition/macp)
- License: [Apache 2.0](LICENSE)
