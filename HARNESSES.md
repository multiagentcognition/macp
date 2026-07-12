# Implementing MACP per harness — the push map

MACP v1 failed at exactly one point: delivery was **pull**. An agent saw a message only
when it chose to poll — and an agent deep in a 20-minute build polls nothing. MACP 2.0's
delivery contract ([spec §8](spec/MACP-2.0.md)) is **push**: envelopes land at the
agent's next inference boundary, and `interrupt`-priority creates that boundary by
cancelling the in-flight tool.

The reason this is implementable *everywhere* is an observable fact about the 2026
harness landscape: **every major harness has already built the two required organs,
privately** — a mid-turn input queue (because users type while the agent works) and
tool cancellation (because users press Esc/Ctrl-C). An L1 binding is nothing more than
wiring the center's inbox to those two organs:

```
inbox resource updated ──► harness's existing mid-turn input queue   (drain at boundary, §8.1)
interrupt-priority     ──► harness's existing tool-cancel + redeliver (create boundary, §8.3)
```

This document maps each harness's organs and its shortest path to L1 (realtime), so no
implementation ever has to fall back to v1's pull.

## Status legend

- **verified** — mechanisms confirmed by reading the harness source at the pinned commit
- **documented** — mechanisms confirmed from the harness's public docs/feature surface
- **unsurveyed** — expected to fit the same pattern; survey contributions welcome

---

## opencode (`sst/opencode`, surveyed @ `34e5809`) — **verified**

The friendliest target: opencode's server API *already speaks the delivery contract*.

| Organ | Where |
|---|---|
| Mid-turn input | `POST /session/:id/prompt` accepts `delivery: "steer"` — durable input admitted during an active turn and promoted into history at the start of the next provider turn (`packages/core/src/session/input.ts`, `packages/core/src/session/runner/llm.ts`) |
| Tool cancel | `POST /session/:id/interrupt`; interrupted tools return **partial output to the model** (`packages/opencode/src/session/processor.ts` cleanup + `message-v2.ts` conversion) |
| Registry evidence | `GET /session` + `GET /session/status` (busy/idle map), SSE `GET /event` |

**L1 binding = a pure external bridge, no in-process code:** an MCP client process that
registers each opencode session with the center, subscribes to its inbox, and maps
envelope → `prompt {delivery:"steer"}`, interrupt → `/interrupt` then redeliver.
Alternative in-process route: a plugin using the `experimental.chat.messages.transform`
hook (fires once per LLM step) + the bundled SDK client. See `examples/opencode-bridge/`.

## Pi (`badlogic/pi-mono`, surveyed @ `8479bd8`) — **verified**

The cleanest in-process story: pi's steering queue **is** drain-at-boundary, natively.

| Organ | Where |
|---|---|
| Mid-turn input | steering queue polled after each turn's tool calls, immediately before the next LLM request (`packages/agent/src/agent-loop.ts`); extensions inject via `pi.sendMessage(msg, {deliverAs: "steer", triggerTurn})` |
| Tool cancel | `ctx.abort()` → AbortSignal to every tool; bash kills the process tree and the **partial output enters the transcript** as the tool result |
| Idle wake | `triggerTurn: true` starts a turn when idle |

**L1 binding = one extension file** in `~/.pi/agent/extensions/` (pi hot-reloads
extensions — an agent can even install its own binding): register on `session_start`,
subscribe to the inbox, deliver via `sendMessage({deliverAs:"steer"})`, abort + redeliver
on interrupt, `macp_send`/`macp_roster` via `pi.registerTool`. See `examples/pi-extension/`.

## Codex CLI (`openai/codex`) — **documented**

| Organ | Where |
|---|---|
| Mid-turn input | user input submitted during an active turn is queued (`input_queue`) and drained at turn boundaries inside the task loop (`codex-rs/core`) |
| Tool cancel | `Op::Interrupt` + killable exec sessions |
| Registry evidence | persisted thread topology (`codex-rs/agent-graph-store`); internal thread-to-thread messaging (`InterAgentCommunication`) shows the delivery pattern exists in-process |

**L1 path:** a small core module (Rust) that connects to the center, feeds deliveries
into the existing pending-input queue, and maps interrupt to exec-session kill — or an
external wrapper for `codex exec`-style spawned sessions. Survey against a pinned
upstream commit + a working binding: contribution welcome.

## Claude Code (Anthropic) — **documented**

| Organ | Where |
|---|---|
| Mid-turn input | user messages typed during a turn are queued and delivered at the next boundary (product behavior); **hooks** (PreToolUse/Stop and others) run inside every agent's own context — including subagents — and their output enters the model's context on the harness channel |
| Tool cancel | Esc interrupts the running tool |

**L1 path (no vendor changes):** a hook-based binding — a PreToolUse hook drains the
center inbox and emits envelopes as hook output (harness-authenticated by construction,
spec §8.1 D4), plus a `macp send` CLI. Interrupt-tier requires harness cooperation or
process-level signaling; boundary delivery works today.

## Gemini CLI, goose, aider, OpenHands — **unsurveyed**

Expected to fit the same two-organ pattern (all are interactive tool-loop harnesses with
user-facing cancel). Surveys welcome: the useful contribution is (1) where mid-turn input
queues, (2) how tools are cancelled, (3) the least-invasive extension surface — plus a
runnable binding under `examples/`.

---

## The rule of thumb for any new harness

1. Find where the harness assembles the next model request — that's the boundary.
2. Find how a user message typed mid-turn reaches that boundary — that queue is your
   delivery slot (D1–D6).
3. Find what Esc/Ctrl-C does to a running tool — that's your interrupt (I1–I5).
4. Wire both to the center's inbox resource; register via the MCP handshake.
5. Run the conformance checklist (spec §12) and claim **L1**.

If step 2 or 3 truly has no extension surface: an external wrapper around the harness's
headless/server mode (opencode-style) or a PTY wrapper is a legitimate L1 vehicle — the
conformance suite runs identically against native, plugin, and wrapper bindings.
