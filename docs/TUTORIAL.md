# MACP Quickstart

This repository now supports two integration styles:

1. `TypeScript + MCP`, recommended for LLM agents
2. direct SQL against the normative schema

For agent-in-the-loop use, prefer the MCP path. It gives the agent structured
tools instead of asking it to generate SQL.

## 1. Install and Build

From the repository root:

```bash
npm install
npm run build
```

Runtime requirement:

- Node.js 22.5+ for `node:sqlite`

## 2. Shared Database Path

All participating agents must point at the same SQLite file, for example:

```text
/tmp/macp_demo.db
```

The reference implementation applies the required PRAGMAs and DDL from
[`macp.schema.json`](../macp.schema.json) automatically.

## 3. Start the MCP Server for an Agent

Each agent gets its own MCP server process with agent-specific environment
variables and a shared `MACP_DB_PATH`.

Example:

```bash
MACP_DB_PATH=/tmp/macp_demo.db \
MACP_AGENT_ID=agent-alpha \
MACP_AGENT_NAME=Alpha \
MACP_DEFAULT_CHANNEL=case-001 \
MACP_AGENT_ROLE=investigator \
MACP_INTEREST_TAGS='["auth","credentials"]' \
node build/src/server.js
```

Important environment variables:

- `MACP_DB_PATH`: shared SQLite file
- `MACP_AGENT_ID`: stable agent identity
- `MACP_AGENT_NAME`: human-readable name
- `MACP_DEFAULT_CHANNEL`: default working channel
- `MACP_AGENT_ROLE`: optional role label for agent instructions
- `MACP_INTEREST_TAGS`: JSON array or comma-separated tags
- `MACP_MAX_PENDING_MESSAGES`: advertised queue limit
- `MACP_MAX_CONTEXT_BYTES`: advertised poll budget

## 4. MCP Tool Surface

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
MACP tools and explicitly avoid direct SQL/database access.

Recommended agent loop:

1. call `macp_get_instructions`
2. call `macp_register`
3. call `macp_join_channel`
4. do primary work
5. call `macp_poll` inside the loop
6. handle returned deliveries idempotently
7. call `macp_ack` after acting on each delivery
8. call `macp_deregister` on shutdown

## 5. Validate the Three-Agent Flow

The repository includes an end-to-end test that launches three independent MCP
server processes against one shared SQLite file and verifies:

- shared channel registration
- channel fanout
- direct messaging
- ACK recording
- poll redelivery behavior
- budget pruning audit behavior

Run it with:

```bash
npm test
```

Run the full release validation with:

```bash
npm run validate
```

## 6. Direct SQL Path

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

## 7. What the Test Proves

The current validation suite is not just schema parsing. It proves that a team
of three agents can use MACP through MCP and communicate inside a single shared
context backed by one SQLite file.

That is the current release bar for the 1.0 draft.
