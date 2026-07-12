# macp-coordinator

The MACP 2.0 **reference coordinator** — one MCP server (streamable HTTP) per fleet.
Implements the coordinator surface of [the spec](../spec/MACP-2.0.md) §6: registration via
the MCP handshake, the five `macp_*` tools, the three `macp://` resources with
subscription push, default-deny grants, and a durable per-agent inbox.

Storage is an embedded SQLite database (`node:sqlite` — no native build step). Storage is
implementation-private per spec §3; swap `src/store.ts` for any backend satisfying §7.4.

## Run

```bash
npm install && npm run build
npm start                       # http://localhost:7737/mcp, db ./macp.db
# or: node dist/index.js --port 7737 --db /path/to/fleet.db
```

Optional: `MACP_OPERATOR_TOKEN=<secret>` — when set, operator registration
(`harness: "operator"`) requires the matching `operator_token`. When unset, the
coordinator trusts local operator registration (single-machine default).

## Connect an agent (any MCP client)

Add to the harness's MCP config:

```json
{ "mcpServers": { "macp": { "type": "http", "url": "http://localhost:7737/mcp" } } }
```

Then, from the agent (L0 — tools-only, works on any MCP harness today):

1. `macp_register {agent_id, harness, role?, project?}` → your `agent://` address.
   Project resolves per spec §5.3 (explicit > repository identity > workspace path,
   using MCP roots as evidence).
2. `macp_roster {}` → live peers in your project.
3. `macp_send {to, body, priority}` → deliver to a peer, a `role:<label>`, or `project`
   (broadcast). `steering`/`interrupt` require a grant; ungranted sends are downgraded
   to `advisory` and audited.
4. Read `macp://agent/<address>/inbox` → your pending envelopes (reading marks them
   received). `macp_ack {delivery_id}` marks processed.
5. Subscribe to your inbox resource for push (`notifications/resources/updated`) —
   this is what an L1 binding maps to the harness's mid-turn input queue.

## Test

```bash
npm test    # end-to-end smoke: boots a coordinator, drives 4 MCP clients through
            # register/roster/send/inbox/ack, subscription push, grant + downgrade,
            # self-grant refusal, inbox isolation, offline durability, project isolation
```

## Status

Reference implementation for the draft spec — reviewed alongside it. Known gaps vs the
spec, tracked for the next revision: consent-via-elicitation for parked cross-project
sends (§9 G4 — currently: blocked + audited), long-poll inbox reads (§6.3 rung 2),
interrupt rate-limiting (§11.4).
