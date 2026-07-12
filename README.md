# MACP 2.0 — Multi-Agent Collaboration Protocol

**Realtime communication and collaboration between running AI agents — as a profile over MCP.**

Agent fleets are now normal: orchestrators fan out hundreds of subagents, coding sessions run
unattended for hours, and users mix harnesses from different vendors in one workspace. Yet the
protocol map has a hole. MCP connects agents to tools. ACP connects agents to editors. A2A hands
tasks between agents *between* turns. **Nothing delivers a message into a running agent mid-turn** —
the quadrant where a reviewer stops a worker before the bug ships, where one sentence re-aims a
fleet without a relaunch, where two agents negotiate a file conflict the moment it appears.

MACP 2.0 fills that quadrant with the smallest possible ask: a coordinator that is **just an MCP
server**, and a delivery contract that harnesses wire to machinery they already have.

## A short history: v1 → 2.0

**[MACP v1](https://github.com/multiagentcognition/macp-v1) (2026)** named the missing quadrant — *"MCP is tools, A2A is delegation, MACP is
coordination during execution"* — and got the state model right: durable, prioritized,
addressed messages living outside every agent, plus file ownership, awareness, and shared
memory as first-class extensions.

But v1 carried three design decisions that capped adoption, and they are why 2.0 is a clean
break rather than an upgrade:

| | MACP v1 | MACP 2.0 |
|---|---|---|
| **Delivery** | poll — agents see messages when they choose to look; a worker deep in a 20-minute build sees nothing | **push at the inference boundary** — messages enter the agent's context before its next reasoning step; `interrupt` priority aborts the in-flight tool to create that boundary *now* |
| **Transport & storage** | its own bus: a shared database file every agent writes | **standard MCP** — agents hold one ordinary outbound MCP connection to a coordinator; storage is the coordinator's private business |
| **Harness integration** | unspecified — each integration invented its own | a **normative two-handler delivery contract** wired to code every harness already ships (mid-turn input queues, user-facing tool cancellation) |
| **Scope & authority** | flat | **logical projects**, default-deny grants, operator precedence, consent via MCP elicitation |

v1 is retired. There is no migration path and none is needed: 2.0 keeps v1's core
semantics (priorities, acknowledgements, presence/awareness via the roster) and replaces
everything about how messages move; v1's file-ownership and shared-memory extensions are
deferred to future extension specs. The v1 repository remains
[archived as prior art](https://github.com/multiagentcognition/macp-v1).

## How it works

```
agent A (harness X) ──MCP──►┐
agent B (harness Y) ──MCP──►│  MACP coordinator      registry: who's here, which project,
agent C (harness Y) ──MCP──►│  (one MCP server        liveness, grants
  human operator ──────────►┘   per fleet)            inboxes: durable envelopes per agent
```

Everything on the wire is standard MCP:

- **Register** — the MCP handshake itself: `initialize` (which harness), `roots` (which
  workspace → resolved to a logical project), the connection (liveness). No registration form.
- **Roster** — a subscribable resource: `macp://project/{id}/roster`. Who is running, right now.
- **Send** — a tool: `macp_send`. Fire-and-forget; the sender never blocks.
- **Receive** — the agent's inbox is a resource. New envelope → standard
  `notifications/resources/updated` → the harness reads the inbox and places the envelope into
  its **existing** mid-turn input queue → it is in the model's next request. If the envelope is
  `interrupt`-priority, the harness first cancels the in-flight tool (its existing user-facing cancel
  mechanism — e.g. the Esc key in CLI harnesses),
  keeping partial output — the boundary is created instead of awaited.
- **Consent** — cross-project contact triggers MCP elicitation: the human approves once,
  always, or never. Agents cannot grant themselves authority over other agents.

The physics are stated honestly: delivery-to-cognition is one (optional) tool abort plus one
inference step — seconds, inference-bound. Any protocol promising faster is misdescribing how
agents think; any protocol delivering slower is polling.

## Conformance ladder

| Level | What it takes | What you get |
|---|---|---|
| **L0 — tools-only** | add the coordinator to the MCP config. Zero harness changes | send, roster, poll — works on any MCP harness today |
| **L1 — realtime via binding** | a plugin/extension/bridge maps inbox updates to the harness's input queue and abort path | full mid-turn delivery, no vendor cooperation needed |
| **L2 — native** | the harness implements the two handlers itself — a small amount of glue against its existing queue + cancel machinery | first-class delivery, better boundary coverage |
| **L3 — symmetric** | the harness also *serves* MCP: create-session, prompt with a delivery-mode parameter, interrupt, and a subscribable live transcript resource | any agent can be driven and observed by any other, cross-vendor |

The `examples/` directory carries working L1 bindings for public harnesses — the standard is
useful before any vendor adopts it, which is how standards win.

## Security model

- **No listening agents.** Agents hold one outbound MCP connection; the coordinator is the only
  addressable thing, and in the default local deployment nothing is on the network at all.
- **The channel cannot be forged.** Envelopes enter context only through the harness's own
  delivery channel. Text arriving through tool output — files, web pages, command results — is
  never promoted to a message, so prompt-injection payloads can imitate the words but never the
  channel.
- **Default-deny authority.** Who may steer or interrupt whom is a grant recorded in the
  registry, enforced by the coordinator, auditable after the fact. The human outranks all grants.
- **Project isolation by default.** Messages stay inside a logical project unless a human
  opens a door — by name, on the record.

## Repository layout

```
spec/          MACP-2.0.md — the standard: envelope schema, delivery contract,
               scope resolution, grant model, conformance   +  spec/schemas/ (JSON Schema)
coordinator/   reference implementation: one MCP server (streamable HTTP)
examples/      L1 bindings for public harnesses + an end-to-end cross-vendor demo
conformance/   the conformance checklist and test suite
```

## Status

**Draft — spec review round open.** Milestones: coordinator MVP → first cross-vendor demo
(two different harnesses steering each other through one coordinator) → conformance suite
v0.1 → symmetric-channel (L3) spec draft.

Contributions, harness bindings, and spec review are welcome — open an issue or a discussion.

## License

Apache-2.0.
