# MACP

**Multi-Agent Cognition Protocol** for real-time cognitive collaboration between AI agents during active execution.

<img width="617" height="275.5" alt="macp_logo_m" src="https://github.com/user-attachments/assets/57ecb363-4cf6-44e3-80fb-5e5ae31cb933" />

Protocol v1.0 | [Schema](macp.schema.json) | [Specification](spec/MACP-Protocol-v1.0.md) | Apache 2.0 | [macp.dev](https://macp.dev) | [multiagentcognition.dev](https://multiagentcognition.dev)

---

MACP is a shared SQLite coordination layer for multiple AI agents working on the
same project at the same time. It gives each agent a live bus for status
updates, file ownership signals, memory, tasks, and high-priority findings
without introducing a central network service.

The `macp-mcp` package is the reference MCP wrapper around that protocol. You
activate it once per project, then supported agent hosts can attach to the same
workspace automatically and register each session on startup.

## Quick Start

Activate MACP once in the project root:

```bash
npx -y macp-mcp init
```

That is the primary deployment flow.

What it does:

- derives `projectId` from the current folder by default
- creates `.macp/config.json`
- creates a local SQLite bus under `.macp/`
- writes project-local MCP config for supported hosts
- updates `AGENTS.md` and `CLAUDE.md` with a managed MACP block

### Most Common Setup: One Project, Many Coding Agents

This is the agentic coding workflow:

1. run `npx -y macp-mcp init` once in the repo root
2. open Claude Code, OpenCode, Gemini CLI, or another supported agent in that same folder
3. each new session gets its own MCP server process, auto-registers, and joins the same MACP workspace
4. the shared `projectId` and DB come from the project config written by the first setup step
5. `AGENTS.md` or `CLAUDE.md` can tell the agent to use a different channel or extra tools such as memory, vault, tasks, or goals

In other words: the first setup activates MACP for the project; later agent
sessions launched from that folder should reuse that same project-scoped MACP
config unless their local instructions explicitly tell them to work on a
different channel.

### Cross-Folder or Cross-Repo Workspace

If you want agents from different folders or repositories to share one MACP
workspace, set an explicit `projectId`:

```bash
npx -y macp-mcp init --project-id acme-release-war-room
```

With an explicit `projectId`, the default DB path moves to a per-user shared
location so agents from different working directories can still hit the same
bus.

### Host Notes

- Claude Code: project-local `.mcp.json` plus `CLAUDE.md`
- OpenCode: project-local `opencode.json` plus `AGENTS.md`
- Gemini CLI: project-local `.gemini/settings.json` plus `AGENTS.md`
- Codex: `AGENTS.md` is supported, but MCP attachment still needs Codex-side
  configuration instead of the same project-local auto-attach flow

## 20 Agents, One Codebase, Zero Conflicts

Run Claude Code, OpenCode, Codex -- any combination of AI coding agents -- on
the same project at the same time. Without coordination, they destroy each
other's work. Agent A refactors a module while Agent B adds a feature to it.
Agent C rewrites a file that Agent D just finished editing. Merge hell,
duplicated effort, reverted progress.

MACP fixes this. Point every agent at the same SQLite file. Each agent
announces what it is working on, what files it owns, and what it has changed.
Every other agent sees this in real time, before it touches a single file.

```
                         project.macp.db
              ┌─────────────────────────────────┐
              │  priority-ranked message bus     │
              │                                 │
              │  [!] interrupt  "auth is broken" │
              │  [>] steering   "use JWT not    │
              │                  sessions"      │
              │  [i] advisory   "tests green    │
              │                  on user module"│
              │  [ ] info       "starting CSS   │
              │                  refactor"      │
              └──┬──────┬──────┬──────┬─────────┘
                 │      │      │      │
        poll ◀───┘      │      │      └───▶ poll
    ┌────────────┐  ┌───┴────────┐  ┌────────────┐
    │ Claude Code│  │  OpenCode  │  │   Codex    │
    │            │  │            │  │            │
    │ "working   │  │ "working   │  │ "working   │
    │  on auth/" │  │  on api/"  │  │  on ui/"   │
    │            │  │            │  │            │
    │ sees:      │  │ sees:      │  │ sees:      │
    │ - api/ is  │  │ - auth/ is │  │ - auth is  │
    │   claimed  │  │   claimed  │  │   broken,  │
    │ - ui/ is   │  │ - ui/ is   │  │   wait for │
    │   claimed  │  │   claimed  │  │   fix      │
    │ - tests    │  │ - auth bug │  │ - api/ is  │
    │   green    │  │   found    │  │   claimed  │
    └────────────┘  └────────────┘  └────────────┘
```

- **No conflicts.** Before editing a file, an agent checks the bus. If another
  agent owns it, it works on something else.
- **No duplication.** Agents broadcast what they have completed. No two agents
  implement the same function.
- **Live progress.** Every agent knows which tests pass, which modules are
  done, what problems were found -- without reading every file.
- **Findings flow up.** An agent discovers a broken API contract and broadcasts
  a steering-priority message. Every other agent adjusts immediately.
- **Zero central infrastructure.** One SQLite file. No broker, no network. In
  MCP mode, each agent uses its own local stdio server process as a wrapper.

The quick-start flow above is the intended deployment model. MACP is activated
once per project, then later agent sessions reuse the same project-scoped bus
configuration automatically when their host supports project-local MCP config.

`init` writes:

- `.macp/config.json`
- `.mcp.json`
- `opencode.json`
- `.gemini/settings.json`
- `.vscode/mcp.json`
- `.cursor/mcp.json`
- a managed MACP block in `AGENTS.md` and `CLAUDE.md`

Then drop the coordination instructions into your project's agent config file so
every agent knows the protocol. Copy
[`examples/MACP_COORDINATION.md`](examples/MACP_COORDINATION.md) into:

| Tool | File |
|------|------|
| Claude Code | `CLAUDE.md` in project root |
| Codex | `AGENTS.md` in project root |
| OpenCode | `AGENTS.md` in project root |
| Any MCP-capable agent | system prompt or agent instructions |

Replace `{{MACP_CHANNEL}}` with your default coordination channel if you want an
explicit reminder in the instructions. In simple setups, use the same slug as
your folder-derived `projectId`. Every agent that reads the file will know how to poll, claim
files, persist shared memory, use shared task/vault context when enabled,
announce work, and communicate breaking changes. The repository root also ships
[AGENTS.md](AGENTS.md) with the same first-party workflow for contributors
working inside this repo.

This turns a chaotic swarm of independent agents into a coordinated team.

The protocol version is MACP v1.0. The npm package version tracks the
reference implementation and MCP tooling, so it can advance independently.

---

## What MACP Is

MACP is a vendor-agnostic protocol for real-time cognitive collaboration between
AI agents during active execution. It splits cognition across agents -- each
agent owns a clean, purpose-built context. The protocol is the boundary between
raw data and distilled intelligence.

Intelligence flows inside the execution loop, not after it. The agent that needs
to know, knows now.

The protocol is a single JSON Schema file containing every data structure, every
SQL operation, and a ready-to-inject agent prompt template. The schema is
designed to be implementable from any language with SQLite support. No SDK
required. No vendor lock-in. Agents share a SQLite file -- no servers, no
brokers, no infrastructure.

The schema is the normative source of truth. The prose spec and docs explain the
design, but the durable data model and SQL operations live in
[`macp.schema.json`](macp.schema.json).

## The Opportunity

Two protocols have emerged that define how AI agents interact with the world:

**MCP** connects agents to tools. One agent calls external APIs, reads files,
queries databases. Agent-to-tool.

**A2A** connects agents to each other across organizations. Discovery, task
delegation, capability advertisement. Agent-to-agent transport.

Neither delivers intelligence to an agent while it is actively executing. MCP
gives an agent hands. A2A gives agents addresses. But the moment an agent is
working, it is deaf -- no protocol feeds it new information mid-action.

MACP fills this gap. It connects agents to each other's cognition in real time,
during execution. Not between tasks. Not between turns. Inside the loop.

---

## What MACP Enables

### Clean Context, Better Decisions

A solo agent doing everything fills its context window with raw data -- API
responses, intermediate calculations, retry logic, parsing errors. By the time
it needs to make a decision, the signal is buried in noise. Context
contamination is the default failure mode of every ambitious single-agent system.

MACP eliminates context contamination. Each agent owns a clean, purpose-built
context. Raw data stays with the agent that processes it. Only distilled
intelligence crosses the protocol boundary. The agent making decisions receives
conclusions, not data.

### Real-Time Situational Awareness

Without MACP, an agent learns what happened after it finishes working. With MACP,
an agent knows what is happening while it works. Weather changes, system failures,
reliability shifts, demand spikes -- every signal arrives inside the execution
loop, ranked by urgency. Decisions reflect the world as it is, not as it was.

### Parallel Cognition

One agent cannot monitor 50 streams and reason about them simultaneously. MACP
splits cognition across agents -- each maintaining continuous behavioral context
over its domain. A fraud analyst maintaining rolling pattern memory across
thousands of transactions. A log analyst tracking cascade signatures across
microservices. A weather monitor correlating regional conditions with route
performance. All running in parallel, all feeding intelligence to the agents
that need it.

### Where It Applies

Fraud detection, distributed systems monitoring, trading, supply chain
optimization, energy grid management, research synthesis -- any domain where
data arrives fast, requires comprehension to filter, and decisions must happen
in real time.

---

## How It Works

```
  Many observers (cheap)                     One executor (capable)
+----------------------+                  +-------------------------+
|  Stream analyst 1    |                  |                         |
|  Stream analyst 2    |   Shared DB      |  while running:         |
|  Stream analyst 3    |  +-----------+   |    do_work()            |
|  ...                 |->| priority  |-->|    check_bus() <------  |
|  Stream analyst N    |  | routing   |   |    adjust_strategy()    |
|                      |  | pruning   |   |    continue_work()      |
+----------------------+  +-----------+   +-------------------------+
```

Intelligence is ranked by four priority tiers:

- `info`: background context
- `advisory`: actionable findings worth considering
- `steering`: findings that should change what peers do next
- `interrupt`: urgent findings that must be handled on the next poll cycle

Byte-budget pruning ensures only the highest-value intelligence fits the
receiver's context window. Interrupt-priority deliveries bypass the budget
entirely. The rest are ranked by a utility function weighing priority, tag
relevance, and freshness.

## Core Model

Each send has one logical `message_id`. Each recipient gets its own
`delivery_id`. Delivery state, ACK state, pruning, and queue limits are all
persisted in the same shared SQLite file.

Routing detail:

- broadcast deliveries store a real `channel_id`
- direct agent deliveries store `channel_id = NULL`

Per-delivery lifecycle:

- `queued`
- `surfaced`
- `acknowledged`
- `expired`
- `dropped`

ACK lifecycle:

- `queued`: written automatically when a delivery row is inserted
- `received`: written automatically when a delivery is returned by `poll`
- `processed`: written explicitly by the receiving agent after it acts

`poll` returns both `queued` and `surfaced` deliveries. That gives the SQLite
bus simple at-least-once delivery semantics and makes consumer idempotency a
protocol requirement.

If byte-budget pruning omits deliveries from one poll result, those deliveries
stay pending and should be audited as budget-pruned rather than deleted.

Each logical send executes inside one SQLite `BEGIN IMMEDIATE` transaction so
queue enforcement and sequence allocation stay atomic under contention.

## Project Id vs Channel

`projectId` is the logical shared workspace id. `channel` is the routing scope.

- `projectId`: the shared workspace identity used to choose the bus location
- `channel`: the actual MACP routing scope for broadcast messages

Simple setup:

- `projectId` derives from the current folder name
- one local SQLite file under `.macp/`
- one default channel derived from the `projectId`

Advanced setup:

- explicit `projectId` lets multiple folders or repos share one workspace bus
- explicit `projectId` defaults to a per-user shared DB path
- one `projectId` can host multiple channels such as `frontend`, `backend`, or `release`

Direct agent-to-agent messages are not channel-scoped.

## Why SQLite

The transport is a shared database file rather than a server:

- cheap to embed
- easy to inspect
- durable with WAL mode
- usable from any language with SQLite support

This repository ships:

- the normative schema
- a TypeScript reference implementation in `src/macp-core.ts`
- a TypeScript MCP server in `src/server.ts`
- first-party workspace extensions implemented in `src/macp-extensions.ts` and `src/macp-extensions-advanced.ts`

## Using MACP

There are two supported paths:

1. Recommended for LLM agents: use the TypeScript MCP server and let the agent
   call MACP tools over MCP.
2. Lower-level integration: execute the SQL operations in `macp.schema.json`
   directly with bound parameters.

### MCP Path

Single-line project activation:

```bash
npx -y macp-mcp init
```

If you are running from a cloned repo instead of the published package:

```bash
git clone https://github.com/multiagentcognition/macp.git
cd macp
npm install
npm run build
node build/src/cli.js init
```

What `init` does:

- creates `.macp/config.json`
- derives `projectId` from the current folder unless you override it
- uses a local DB under `.macp/` by default
- uses a per-user shared DB path when you explicitly set `projectId`
- writes project-local MCP config files for supported hosts
- appends a managed MACP block to `AGENTS.md` and `CLAUDE.md`

Advanced/manual server launch is still available if you need explicit paths or a
non-default channel:

```bash
npx -y macp-mcp server \
  --db /tmp/project-x.macp.db \
  --channel project-x \
  --project-id project-x \
  --agent-id agent-alpha \
  --agent-name Alpha
```

To deliberately share one MACP bus across different folders or repos:

```bash
npx -y macp-mcp init --project-id acme-release-war-room
```

The MCP tool surface is:

- `macp_get_instructions`
- `macp_register`
- `macp_join_channel`
- `macp_send_channel`
- `macp_send_direct`
- `macp_poll`
- `macp_ack`
- `macp_deregister`

`macp_get_instructions` returns MCP-tool guidance only. It should tell an agent
to use the MACP tools, not to execute SQL or open the SQLite file directly. In
the normal `init` flow, the server has already auto-registered the session and
auto-joined the default channel before the agent starts calling tools.

This server build also ships optional workspace extensions layered on top of
the core bus:

- awareness: `macp_ext_list_agents`, `macp_ext_get_session_context`
- advisory file ownership: `macp_ext_claim_files`, `macp_ext_release_files`, `macp_ext_list_locks`
- shared memory: `macp_ext_set_memory`, `macp_ext_get_memory`, `macp_ext_search_memory`, `macp_ext_list_memories`, `macp_ext_delete_memory`, `macp_ext_resolve_memory`
- profiles: `macp_ext_register_profile`, `macp_ext_get_profile`, `macp_ext_list_profiles`, `macp_ext_find_profiles`
- tasks: `macp_ext_dispatch_task`, `macp_ext_claim_task`, `macp_ext_start_task`, `macp_ext_complete_task`, `macp_ext_block_task`, `macp_ext_cancel_task`, `macp_ext_get_task`, `macp_ext_list_tasks`, `macp_ext_archive_tasks`
- goals: `macp_ext_create_goal`, `macp_ext_list_goals`, `macp_ext_get_goal`, `macp_ext_update_goal`, `macp_ext_get_goal_cascade`
- agent lifecycle: `macp_ext_sleep_agent`, `macp_ext_deactivate_agent`, `macp_ext_delete_agent`
- vault/docs: `macp_ext_register_vault`, `macp_ext_search_vault`, `macp_ext_get_vault_doc`, `macp_ext_list_vault_docs`
- context search: `macp_ext_query_context`

These tools are intentionally non-normative. The protocol remains defined by
[`macp.schema.json`](macp.schema.json) and [the v1.0 spec](spec/MACP-Protocol-v1.0.md).
See [Workspace Extensions](docs/EXTENSIONS.md) for the design boundary.
The shipped [agent instructions template](examples/MACP_COORDINATION.md) covers
the recommended extension workflow.

Normal agent loops should use `macp_poll`, `macp_send_channel`, `macp_send_direct`,
and `macp_ack`. `macp_register` and `macp_join_channel` remain available for
explicit repair or override flows.

If your MCP host does not honor the generated project config files, use the
manual `server` command above or copy the generated server entry into the host's
equivalent MCP config. Use `--project-id` when you want cross-folder sharing
without relying on the current folder name.

### Raw SQL Path

If you do not want MCP, the shortest path is:

1. Choose a shared database path such as `/tmp/macp_team.db`.
2. Apply the DDL from `connection.schema_ddl` in `macp.schema.json`.
3. Register each agent with `operations.register`.
4. Join a channel with `operations.join`.
5. Send with `operations.send`.
6. Poll inside the agent's work loop with `operations.poll`.
7. Record `processed` with `operations.ack` after acting on a delivery.
8. Close with `operations.deregister`.

For raw SQL integrations, the schema also contains `agent_prompt_template`,
which is designed to be copied into an agent prompt after filling in the
placeholders.

## Design Boundaries

MACP v1.0 is deliberately narrow.

- Transport: shared SQLite file only
- Routing: channel broadcast and direct agent addressing
- Delivery semantics: durable, poll-based, at-least-once
- Budgeting: byte-based pruning using `context.payload_byte_size`

Out of scope for v1.0:

- brokered transports
- push delivery
- cross-machine discovery
- federated routing
- packaged auth and network security controls

This repository may also ship optional helper layers above the protocol. Those
helpers can improve coordination, but they are not part of the MACP v1.0
contract unless they are added to the normative schema and spec.

## Files

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
examples/MACP_COORDINATION.md    Agent instructions template (copy into your project)
```

## Requirements

- Node.js 22.5+ for the TypeScript reference implementation and MCP server
- SQLite 3.35+
- Shared filesystem path reachable by all participating agents
- Agents that can execute SQL with bound parameters

## Status

MACP v1.0 in this repository is the SQLite/shared-database protocol only.
There are no alternate transport definitions in scope for this version.

## Links

- Website: [macp.dev](https://macp.dev)
- Organization: [multiagentcognition.dev](https://multiagentcognition.dev)
- GitHub: [github.com/multiagentcognition/macp](https://github.com/multiagentcognition/macp)
- License: [Apache 2.0](LICENSE)
