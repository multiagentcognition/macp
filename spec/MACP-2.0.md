# MACP 2.0 — Multi-Agent Collaboration Protocol

**Version:** 2.0.0-draft.1
**Status:** Draft — open for review
**License:** Apache-2.0

MACP 2.0 is a **profile over the Model Context Protocol (MCP)**: it defines how running
AI agents communicate and collaborate in realtime — mid-turn — using only standard MCP
wire machinery, one small server (the *coordinator*), and a normative behavioral contract
for harnesses (the *delivery contract*).

The key words MUST, MUST NOT, REQUIRED, SHOULD, SHOULD NOT, MAY are to be interpreted as
described in RFC 2119.

---

## 1. Scope

This specification defines:

1. The **coordinator** — an MCP server that maintains the agent registry, message
   inboxes, and authority grants for a fleet of agents.
2. The **envelope** — the schema of a message exchanged between agents
   ([schemas/envelope.schema.json](schemas/envelope.schema.json)).
3. The **delivery contract** — the required behavior of a *participating harness*:
   draining inbox deliveries at inference boundaries, and creating a boundary early for
   `interrupt`-priority deliveries.
4. **Scope resolution** — how agents are grouped into logical projects.
5. The **grant model** — who may send what to whom, and how consent is obtained.
6. **Conformance levels** L0–L3.

Out of scope: coordinator storage (implementation-private), model behavior beyond the
agent obligations in §10, and transport details already specified by MCP.

### 1.1 Design constraints (informative)

Agents are sequential inference machines: information enters an agent's cognition only as
context evaluated at its next inference step. Therefore "realtime" delivery *means*
delivery at the next inference boundary; anything faster has no observable effect on the agent, and
anything slower is polling. Because in-flight operations (a build, a long fetch) can defer
that boundary indefinitely, bounded delivery latency requires the ability to **create** a
boundary by aborting the in-flight operation. Prompt-cache economics require delivery to
be **append-only**. Trust requires messages to arrive on a channel that tool output cannot
write. These four constraints produce the delivery contract in §8; they are stated here so
reviewers can check the normative text against its rationale.

## 2. Terminology

- **Harness** — a runtime that executes an agent loop (a coding CLI, an IDE agent, an
  orchestrator runtime, an SDK loop).
- **Agent** — one sequential inference loop with its own context: a session, a subagent,
  a spawned worker.
- **Coordinator** — the MCP server defined by this spec. One coordinator serves a fleet.
- **Fleet** — the set of agents connected to one coordinator.
- **Project (scope)** — a logical grouping of agents (§5). Messages are project-scoped by
  default.
- **Inference boundary** — the moment immediately before a harness submits context for an
  agent's next inference step.
- **Delivery** — one (envelope × recipient) pair, with its own lifecycle and identity.
- **Binding** — the component that implements the delivery contract for a given harness:
  native code, a plugin/extension, or an external bridge process.
- **Participating harness** — a harness (or harness + binding) that implements at least
  conformance level L1.

## 3. Architecture

```
agent A (harness X) ──MCP──►┐
agent B (harness Y) ──MCP──►│   coordinator        registry · inboxes · grants · audit log
agent C (harness Y) ──MCP──►│   (one MCP server)
  human operator ──────────►┘
```

- Every agent holds **one ordinary outbound MCP client connection** to the coordinator.
  Agents MUST NOT be required to listen on any network endpoint.
- The coordinator SHOULD be served over MCP's streamable HTTP transport so that multiple
  independent processes reach the *same* coordinator instance. A stdio-launched
  coordinator is conformant only if its instances present one consistent registry and
  message store to the whole fleet.
- Coordinator storage is implementation-private. The reference implementation uses an
  embedded database; any backend satisfying the durability and ordering requirements in
  §7.4 is valid.

## 4. Identity and addressing

Every agent is addressable as:

```
agent://<harness-id>/<agent-id>[/<subagent-path>]
```

- `harness-id` — a lowercase token identifying the harness product (e.g. `opencode`,
  `pi`, `codex`, `claude-code`).
- `agent-id` — the harness's own stable identifier for the agent (session ID or
  equivalent).
- `subagent-path` — optional slash-separated path for nested spawns.

The scheme `human://<operator-id>` is reserved for the human operator's address (§9 G3);
it takes no path segments.

The coordinator MUST assign each connection to exactly one agent address. An agent MUST
be able to learn its own address (returned by `macp_register`, and present in every
envelope it receives).

## 5. Registration and scope resolution

### 5.1 Registration

Registration rides the MCP handshake plus one optional tool call:

| Fact | Source |
|---|---|
| Harness product + version | MCP `initialize` → `clientInfo` |
| Connection identity | the MCP session (e.g. `Mcp-Session-Id` on streamable HTTP) |
| Workspace evidence | MCP `roots/list` (+ `notifications/roots/list_changed`) |
| Liveness | the connection itself; MCP `ping` |
| Agent ID, role, capabilities, explicit project | `macp_register` tool call (§6.1) |

A coordinator MUST register a connecting client into the registry upon `initialize`,
using declared roots for provisional scope. A client SHOULD call `macp_register` to
supply its agent ID and role; until it does, the coordinator MAY address it by a
connection-derived placeholder ID.

The registry entry schema is
[schemas/registry-entry.schema.json](schemas/registry-entry.schema.json).

### 5.2 Liveness

A registry entry is **live** while its MCP connection is open and responsive. The
coordinator MUST mark an entry stale when the connection closes or fails ping for an
implementation-defined interval (RECOMMENDED: 60 s), and MUST exclude stale entries from
default roster results. Stale entries retain their inboxes: deliveries to a stale agent
queue durably and drain when it reconnects and re-registers with the same address.

### 5.3 Scope resolution — the project

The **project is a logical identifier, not a filesystem path**. Folders, repositories,
and roots are *evidence* used to resolve it. Resolution order (strongest wins):

1. **Explicit declaration** — `project` field in `macp_register`, or an environment /
   marker-file convention the binding forwards (e.g. `MACP_PROJECT`).
2. **Repository identity** — a normalized VCS remote identity, so that clones, worktrees,
   and CI checkouts of the same repository resolve to the same project.
3. **Canonical workspace path** — the canonicalized root folder; meaningful only for
   same-machine, no-VCS, undeclared cases.

When evidence is ambiguous, the coordinator MUST resolve to the **more isolated** option.
Agents with no workspace at all (service agents) MUST declare their project explicitly.

### 5.4 Isolation rule

The coordinator MUST NOT deliver an envelope across project boundaries unless a link or
grant (§9) permits it, or the sender is the human operator.

## 6. Coordinator surface (all standard MCP)

The coordinator exposes **tools** and **resources** only — no custom protocol methods,
no custom notification types.

### 6.1 Tools

| Tool | Purpose |
|---|---|
| `macp_register` | supply agent ID, role, capabilities, explicit project; returns the assigned address |
| `macp_send` | send an envelope to an address, a role within the project, or the project (broadcast); returns delivery IDs |
| `macp_ack` | acknowledge a delivery as `processed` (see §8.5) |
| `macp_roster` | query live agents (default: own project) |
| `macp_grant` | create/revoke a grant the caller has authority to give (§9) |

Tool input/output schemas are defined in [schemas/](schemas/) alongside the envelope.

### 6.2 Resources

| Resource URI | Content |
|---|---|
| `macp://self` | the caller's own registry entry (address, project, grants held) |
| `macp://project/{project}/roster` | live registry entries for the project — **subscribable** |
| `macp://agent/{address}/inbox` | the caller's pending deliveries, priority-ordered — **subscribable** |

The coordinator MUST support `resources/read` for all three, and SHOULD support
`resources/subscribe` + `notifications/resources/updated` for roster and inbox. An agent
MUST only be able to read **its own** inbox; the coordinator MUST enforce this by
connection identity.

### 6.3 Fallback ladder

Because MCP client support for subscriptions is uneven, a binding uses the strongest
mechanism available, in order:

1. `resources/subscribe` on the inbox → `notifications/resources/updated` → read (push).
2. Coordinator-side **long-poll read**: a `resources/read` on the inbox MAY be held open
   by the coordinator until a delivery arrives or a timeout elapses.
3. Plain periodic `resources/read` (polling; L0 behavior).

## 7. The envelope

Schema: [schemas/envelope.schema.json](schemas/envelope.schema.json). Example:

```json
{
  "macp": "2.0",
  "id": "d_01J9Y6…",
  "from": "agent://opencode/9f2c",
  "to": "agent://pi/a1b7",
  "project": "prj_x3k…",
  "priority": "steering",
  "sent_at": "2026-07-12T09:14:02Z",
  "ack": "auto",
  "in_reply_to": null,
  "body": "Schema changed upstream: IDs are strings now — re-read types before migrating more files.",
  "interrupted": null
}
```

### 7.1 Priorities

`interrupt` > `steering` > `advisory` > `info`.

- `interrupt` — deliver now; create the boundary (§8.3). Requires a grant (§9).
- `steering` — deliver at the next natural inference boundary. Requires a grant.
- `advisory` / `info` — deliver at the next boundary or batched; never abort anything;
  no grant required within a project.

### 7.2 Reply correlation

`in_reply_to` carries the delivery `id` of the envelope being answered. Request/reply
patterns (ask, then continue working or wait, then incorporate the answer) are built from
ordinary sends plus this field; waiting is always the *agent's* choice, never a protocol
block.

### 7.3 Provenance fields

Everything except `body` is provenance and is authored by the coordinator/binding, not by
the sending model. A binding MUST NOT allow tool output or file content to populate
provenance fields.

### 7.4 Store requirements

The coordinator MUST persist envelopes durably until acknowledged (at-least-once), MUST
preserve per-recipient order within a priority, and MUST record every send, delivery,
abort, and ack in an audit log attributable to a registered address.

## 8. The delivery contract (normative core)

This section is what a harness (or its binding) implements. It is deliberately small.

### 8.1 Drain at the boundary

**D1.** At every inference boundary, a participating harness MUST check for pending
deliveries (via subscription state or a read) and append any of priority `steering` or
higher to the agent's context before submitting the inference request. `advisory`/`info`
MAY be included or batched.

**D2.** Delivery is **append-only**. The harness MUST NOT rewrite or delete prior context
to deliver an envelope.

**D3.** Deliveries MUST be presented in priority order, then send order. Multiple
deliveries MAY be coalesced into one context block.

**D4.** The context block MUST be visibly attributed as a coordinator delivery (with
sender address and priority) and MUST enter through the harness's own trusted channel —
the same class of channel as user input or system instructions — **never** as tool
output.

**D5.** A harness MUST NOT inject mid-inference (during token generation). The boundary
is the only injection point.

**D6.** When a delivery coincides with a completed tool call, the harness SHOULD append
the tool result first, then the envelope block.

### 8.2 Idle agents

If the agent is idle (no turn in flight) when a `steering`+ delivery arrives, the binding
SHOULD start a turn to deliver it (a "wake"), subject to harness policy. `advisory`/`info`
deliveries MUST NOT wake an idle agent.

### 8.3 Interrupt — creating the boundary

**I1.** On an `interrupt`-priority delivery for an agent currently inside an abortable
operation (a running tool), the harness MUST abort that operation promptly, using the
same mechanism as its user-facing cancel (RECOMMENDED target: signal within 2 s).

**I2.** The aborted tool call MUST resolve with an explicit interrupted marker plus any
safely available partial output, followed by the envelope per D6. The turn then reaches
its inference boundary — the interrupt *creates* the boundary.

**I3.** Non-abortable operations are not aborted; the delivery lands at the next natural
boundary. Harnesses SHOULD keep tool executions cancellable as a design goal.

**I4.** `steering` and lower MUST NOT abort operations.

**I5.** Duplicate deliveries (at-least-once store) MUST NOT trigger a second abort for
the same delivery `id`, and SHOULD be suppressed from context.

### 8.4 Latency contract

Delivery-to-cognition is **one (optional) tool abort plus one inference step** —
inference-bound; protocol overhead is negligible by comparison. Documentation claiming
MACP support MUST state realtime behavior in these terms.

### 8.5 Acknowledgement

- `received` — recorded by the coordinator when the binding confirms the envelope was
  appended to context (the read/notification cycle completing is sufficient signal).
- `processed` — sent by the *agent* via `macp_ack`. For `ack: "required"` envelopes the
  agent MUST ack before its turn ends; bindings SHOULD surface unacked required
  deliveries back into context once.

## 9. Authority: grants, links, and the human

**G1 — default deny.** No agent may send `steering` or `interrupt` to another agent
without a grant. `advisory`/`info` within a project require none.

**G2 — grant sources.** A grant is created by: (a) a spawner over its spawned agents, at
registration; (b) project or coordinator configuration; (c) the human operator, including
interactively via consent (G4). Grants are recorded in the registry, are revocable
(`macp_grant`), and appear in the audit log. **No agent can grant itself authority over
another agent.**

**G3 — operator precedence.** The human operator's address outranks all grants: it may send
any priority to any agent in any project, and its revocations are immediate. Coordinator
implementations MUST provide a human-identity mechanism (e.g. a local CLI authenticated
as the operator).

**G4 — consent via elicitation.** When a send requires a grant that does not exist (e.g.
cross-project contact), the coordinator MUST NOT deliver silently. It SHOULD park the
envelope and request human consent — using MCP **elicitation** where a connected client
supports it, or a queued approval surfaced through the operator's interface (G3). Approval MAY create
a standing grant; denial MUST be remembered for the pair.

**G5 — links.** A human may link projects (merging rosters and send rights) or create
one-directional grants between them. Links and grants are always human-authored, named,
and logged.

## 10. Agent obligations

**A1.** An agent receiving a `steering`+ envelope MUST address it at its next decision:
comply, or state why not. Silence is non-conformant; disagreement is not.

**A2.** An agent MUST treat envelope instructions as carrying the *sender's* authority
only — not as harness/system commands, and not as license to bypass its own policies.

**A3.** An agent MUST NOT re-emit content from tool output as if it were a coordinator
delivery.

Bindings SHOULD provision these obligations once per session (system-prompt fragment or
first-delivery preamble). The envelope format is designed to be self-describing so that
models can satisfy A1–A3 without fine-tuning; the conformance suite is expected to
validate this per harness.

## 11. Security considerations

1. **No listening agents.** Agents make one outbound connection. The coordinator is the
   only addressable component; in the default local deployment it binds to localhost.
2. **Channel authenticity.** D4 is the injection defense: text arriving through tool
   output (files, web pages, command results) can imitate an envelope's *words* but can
   never enter through the delivery *channel*. Bindings MUST NOT promote tool-visible
   content to deliveries.
3. **Networked deployments** MUST authenticate connections to the coordinator (bearer
   token or mTLS) and SHOULD bind registration identity to the authenticated principal.
4. **Interrupt abuse.** Grants gate `interrupt`; coordinators SHOULD additionally rate-
   limit interrupts per sender and SHOULD downgrade (to `advisory`) rather than drop
   ungranted sends, so misconfiguration is visible instead of silent.
5. **Auditability.** §7.4's audit log makes all steering attributable and replayable.

## 12. Conformance

### L0 — tools-only (any MCP client, zero changes)

- [ ] Connects to a coordinator; `macp_register`, `macp_send`, `macp_roster`, `macp_ack`
      callable as ordinary MCP tools.
- Delivery is poll-shaped (the agent reads its inbox when it chooses). No realtime claim
  may be made at L0.

### L1 — realtime via binding

- [ ] All of L0.
- [ ] A binding implements D1–D6 against the harness's existing mid-turn input mechanism.
- [ ] I1–I5 implemented via the harness's existing cancel mechanism.
- [ ] Idle wake per §8.2; received-acks per §8.5.

### L2 — native

- [ ] All of L1, implemented inside the harness itself (no external binding process),
      covering every agent type the harness runs (sessions, subagents, spawned workers).

### L3 — symmetric

- [ ] All of L2, and the harness also *serves* MCP: create-session, prompt with a
      delivery-mode parameter (deliver at a created boundary per §8.3, or at the next
      natural boundary per §8.1), interrupt, and a subscribable live transcript
      resource — so any granted agent can drive and observe agents on this harness
      directly.

A conformance claim MUST name its level and, for L1, the binding used.

## 13. Versioning

The `macp` envelope field carries the major.minor protocol version. Coordinators MUST
reject envelopes with an unknown major version. This specification has no compatibility
relationship with MACP v1 (retired; archived as prior art).
