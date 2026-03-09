# MACP Quickstart

This repository now supports two integration styles:

1. `TypeScript + MCP`, recommended for LLM agents
2. direct SQL against the normative schema

For agent-in-the-loop use, prefer the MCP path. It gives the agent structured
tools instead of asking it to generate SQL.

## 1. Activate the Project

```bash
npx -y macp-mcp init
```

That single command:

- creates `.macp/config.json`
- derives `projectId` from the current folder name unless you override it
- creates a local SQLite path under `.macp/` by default
- writes project-local MCP config files for supported hosts
- scaffolds managed MACP blocks in `AGENTS.md` and `CLAUDE.md`

If you are working from a local clone instead of the published package:

```bash
npm install
npm run build
node build/src/cli.js init
```

Runtime requirement:

- Node.js 22.5+ for `node:sqlite`

## 2. Project Id vs Channel

- `projectId`: logical shared workspace id
- `channel`: MACP broadcast scope

If you run `init` in a folder named `macp-demo`, the generated config defaults to:

- DB path: `.macp/macp-demo.macp.db`
- default channel: `macp-demo`

If you need multiple coordination lanes inside one project, keep the same DB
and set `--channel` explicitly.

If you want multiple folders or repos to share one MACP workspace, set an
explicit `projectId`:

```bash
npx -y macp-mcp init --project-id acme-release-war-room
```

Without an explicit DB path, that uses a per-user shared DB path for the chosen
`projectId`.

## 3. Shared Database Path

All participating agents must point at the same SQLite file, for example:

```text
/tmp/macp_demo.db
```

The reference implementation applies the required PRAGMAs and DDL from
[`macp.schema.json`](../macp.schema.json) automatically.

## 4. What Happens When an Agent Opens the Project

Each agent gets its own MCP server process with agent-specific settings and a
shared SQLite file. The project-local MCP config launches `macp-mcp server`,
and that server:

- auto-registers the current session on startup
- auto-joins the default channel on startup
- exposes the MACP tool surface over stdio

If you need a manual launch instead of project-local config, use:

```bash
npx -y macp-mcp server \
  --db /tmp/macp_demo.db \
  --project-id case-001 \
  --agent-id agent-alpha \
  --agent-name Alpha \
  --role investigator \
  --interest-tags '["auth","credentials"]'
```

Important CLI options / environment variables:

- `--db` / `MACP_DB_PATH`: shared SQLite file
- `--project-id` / `MACP_PROJECT_ID`: logical shared workspace id
- `--channel` / `MACP_DEFAULT_CHANNEL`: explicit default working channel
- `--agent-id` / `MACP_AGENT_ID`: stable agent identity
- `--agent-name` / `MACP_AGENT_NAME`: human-readable name
- `--role` / `MACP_AGENT_ROLE`: optional role label for agent instructions
- `--interest-tags` / `MACP_INTEREST_TAGS`: JSON array or comma-separated tags
- `--max-pending-messages` / `MACP_MAX_PENDING_MESSAGES`: advertised queue limit
- `--max-context-bytes` / `MACP_MAX_CONTEXT_BYTES`: advertised poll budget

## 5. MCP Tool Surface

The server exposes these tools:

- `macp_get_instructions`
- `macp_register`
- `macp_join_channel`
- `macp_send_channel`
- `macp_send_direct`
- `macp_poll`
- `macp_ack`
- `macp_deregister`

`macp_get_instructions` is MCP-specific. It should guide the agent to use the
MACP tools and explicitly avoid direct SQL/database access. In the normal
project-init flow, the server has already auto-registered the session and
auto-joined the default channel before the agent starts calling tools.

Optional workspace extensions are also available in this server build:

- `macp_ext_list_agents`
- `macp_ext_get_session_context`
- `macp_ext_claim_files`
- `macp_ext_release_files`
- `macp_ext_list_locks`
- `macp_ext_set_memory`
- `macp_ext_get_memory`
- `macp_ext_search_memory`
- `macp_ext_list_memories`
- `macp_ext_delete_memory`
- `macp_ext_resolve_memory`
- `macp_ext_register_profile`
- `macp_ext_get_profile`
- `macp_ext_list_profiles`
- `macp_ext_find_profiles`
- `macp_ext_dispatch_task`
- `macp_ext_claim_task`
- `macp_ext_start_task`
- `macp_ext_complete_task`
- `macp_ext_block_task`
- `macp_ext_cancel_task`
- `macp_ext_get_task`
- `macp_ext_list_tasks`
- `macp_ext_archive_tasks`
- `macp_ext_create_goal`
- `macp_ext_list_goals`
- `macp_ext_get_goal`
- `macp_ext_update_goal`
- `macp_ext_get_goal_cascade`
- `macp_ext_sleep_agent`
- `macp_ext_deactivate_agent`
- `macp_ext_delete_agent`
- `macp_ext_register_vault`
- `macp_ext_search_vault`
- `macp_ext_get_vault_doc`
- `macp_ext_list_vault_docs`
- `macp_ext_query_context`

These helpers are convenience layers above the protocol, not additions to the
normative MACP v1.0 schema. See [`docs/EXTENSIONS.md`](EXTENSIONS.md).

Recommended agent loop:

1. call `macp_get_instructions` if needed
2. do primary work
3. call `macp_poll` inside the loop
4. handle returned deliveries idempotently
5. call `macp_ack` after acting on each delivery
6. call `macp_deregister` on shutdown if the host exposes an explicit shutdown step

`macp_register` and `macp_join_channel` remain available for explicit repair or
override flows, but they should not be part of the normal startup loop.

## 6. Validate the Build

For the public release surface, the fastest local check is:

```bash
npm run validate
```

That path:

- builds the TypeScript implementation
- smoke-tests both CLI entrypoints
- verifies the publishable package contents with `npm pack --dry-run`

## 7. Direct SQL Path

If you do not want MCP, use the SQL operations from
[`macp.schema.json`](../macp.schema.json) directly with bound parameters.

The normal sequence is:

1. `operations.register`
2. `operations.join`
3. `operations.send`
4. `operations.poll`
5. `operations.ack`
6. `operations.deregister`

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

## 8. Coordination Goal

The practical target for MACP remains the same: multiple agents sharing one
SQLite-backed workspace, polling the same bus, and coordinating inside one
shared context without duplicating work or missing important peer updates.
