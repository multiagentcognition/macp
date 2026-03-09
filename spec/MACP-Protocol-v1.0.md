# MACP v1.0 Specification

## Multi-Agent Cognition Protocol

**Version:** 1.0
**Status:** Released
**Date:** 2026-03-08
**License:** Apache 2.0

---

## 1. Scope

This document describes the SQLite-only form of **MACP** v1.0.

MACP v1.0 is:

- a shared SQLite database file
- a durable data model for agents, sessions, channels, deliveries, ACKs, and audit events
- a set of SQL operations for registration, membership, sending, polling, acknowledgment, and deregistration

MACP v1.0 is not:

- a broker protocol
- an HTTP API
- a WebSocket API
- a push-delivery system

The normative artifact is [`macp.schema.json`](../macp.schema.json). This file is
companion prose.

## 2. Architecture

All agents participating in a MACP deployment open the same SQLite database file.
Every agent can read and write protocol state directly.

```text
+----------+    +----------+    +----------+
| Agent A  |    | Agent B  |    | Agent C  |
+-----+----+    +-----+----+    +-----+----+
      |               |               |
      +---------------+---------------+
                      |
             Shared SQLite File
```

The required SQLite mode is:

- `PRAGMA journal_mode = WAL`
- `PRAGMA busy_timeout = 5000`
- `PRAGMA foreign_keys = ON`

## 3. Core Entities

### 3.1 Agents

An **agent** is the stable identity used across reconnects. Agents are stored in
the `agents` table.

### 3.2 Sessions

A **session** is the current active connection state for an agent. An agent has at
most one active session in v1.0. Sessions are stored in the `sessions` table.

Session states:

- `active`
- `deregistered`

### 3.3 Channels

A **channel** is a named multicast scope. In the SQLite deployment, channel
identifiers are stable strings such as `ops` or `fraud-ops`.

### 3.4 Logical Messages and Deliveries

MACP separates logical send identity from delivery identity.

- `message_id`: the logical send identifier shared across all recipients
- `delivery_id`: the unique per-recipient row identifier

One send may therefore produce:

- one `message_id`
- many `delivery_id` rows

Deliveries are stored in the `messages` table.

`channel_id` semantics:

- broadcast deliveries store the channel identifier
- direct deliveries store `NULL`

### 3.5 ACK State

ACK state is tracked per delivery, not per logical message. This is required
because each recipient progresses independently.

ACK levels:

- `queued`
- `received`
- `processed`

## 4. Delivery Lifecycle

Delivery states:

- `queued`
- `surfaced`
- `acknowledged`
- `expired`
- `dropped`

Lifecycle rules:

1. A new delivery row is inserted as `queued`.
2. `poll` returns deliveries in either `queued` or `surfaced` state.
3. When a previously `queued` delivery is returned by `poll`, it transitions to
   `surfaced`.
4. A `surfaced` delivery remains eligible for later polls until it is
   acknowledged or expires.
5. If overflow evicts a still-queued delivery, that delivery transitions to
   `dropped` and remains in the table for audit/history.
6. After the receiving agent acts on the delivery, it writes a `processed` ACK
   and the delivery transitions to `acknowledged`.

This produces simple at-least-once semantics. Duplicate processing is possible
after retries. Consumers MUST therefore handle deliveries idempotently.

## 5. Routing Model

Before any send, the sender MUST validate that its own `agent_id` and
`session_id` identify an active session.

If sender validation fails, the send MUST be rejected with
`MACP_ERR_SENDER_NOT_ACTIVE`.

### 5.1 Channel Broadcast

For `destination_type = channel`, the sender MUST first validate that the
channel exists and is active. It then enumerates active channel members other
than itself and inserts one delivery row per recipient.

The sender MUST also be an active member of that channel.

If the channel lookup fails, the send MUST be rejected with
`MACP_ERR_CHANNEL_NOT_FOUND`.

If sender membership validation fails, the send MUST be rejected with
`MACP_ERR_SENDER_NOT_MEMBER`.

### 5.2 Direct Messaging

For `destination_type = agent`, the sender MUST first validate the destination
agent:

```sql
SELECT 1 FROM sessions WHERE agent_id = :dest_agent_id AND state = 'active'
```

If no row is returned, the send MUST be rejected with
`MACP_ERR_DESTINATION_UNKNOWN`.

Direct deliveries are not channel-scoped in v1.0. They MUST therefore bind
`channel_id = NULL`.

## 6. Sequence Numbers

Sequence numbers are allocated per destination agent queue. They are used for
FIFO ordering within a priority class.

MACP v1.0 requires atomic allocation. The schema uses SQLite `RETURNING` support
to avoid the broken increment-then-read pattern.

The full logical send MUST execute inside one SQLite `BEGIN IMMEDIATE`
transaction so queue accounting, overflow decisions, and sequence allocation are
serialized under contention.

Priority ordering always wins first:

1. higher priority before lower priority
2. lower sequence number before higher sequence number within the same priority

## 7. Queue Limits and Overflow

Each agent advertises:

```json
{"max_pending_messages": 200}
```

Pending deliveries are those in state `queued` or `surfaced`.

Overflow policy:

1. Read the recipient's `max_pending_messages`.
2. Count current pending deliveries.
3. If the queue is below the limit, insert the new delivery.
4. If the queue is full, find the oldest lowest-priority queued delivery.
5. If the candidate priority is less than or equal to the incoming priority,
   drop the candidate and insert the incoming delivery.
6. Otherwise reject the incoming delivery.

If the bus drops an existing queued delivery to make room, it MUST record
`MACP_ERR_QUEUE_FULL_DROP_OLDEST`.

If the bus rejects the incoming delivery instead, it MUST record
`MACP_ERR_QUEUE_FULL_REJECT_INCOMING`.

## 8. ACK Semantics

ACKs are persisted in `ack_states`.

### 8.1 queued

Written automatically when the delivery row is inserted.

### 8.2 received

Written automatically when `poll` returns the delivery.

### 8.3 processed

Written explicitly by the receiving agent after it has acted on the delivery.

`ack.request_level` is stored with the delivery and indicates the highest ACK
stage the sender intends to inspect. It does not change the underlying delivery
lifecycle.

ACK validity rules:

- `queued` and `surfaced` deliveries are ackable
- `acknowledged` deliveries treat repeated `ack` calls as idempotent no-ops
- `expired` and `dropped` deliveries are terminal and MUST be rejected with
  `MACP_ERR_DELIVERY_NOT_ACKABLE`
- unknown `delivery_id` values MUST be rejected with
  `MACP_ERR_DELIVERY_NOT_FOUND`

## 9. Polling Model

The key operational rule in MACP is:

**Poll inside the execution loop.**

Typical pattern:

```text
while running:
    do_work()
    deliveries = poll()
    for delivery in deliveries:
        adjust_behavior(delivery)
        ack_processed(delivery)
```

Each poll begins by marking expired `queued` or `surfaced` deliveries for that
recipient and writing one `message.expire` audit row for each returned expired
delivery.

`poll` then returns only non-expired deliveries for the current agent, ordered
by:

1. `priority DESC`
2. `sequence_number ASC`

Because `surfaced` deliveries remain eligible for polling, agents may see the
same delivery more than once if earlier processing did not reach `processed`.

## 10. Context Budget

MACP v1.0 uses byte-based pruning, not token-based pruning.

The canonical cost field is:

```text
context.payload_byte_size
```

Utility function:

```text
U(d) = 0.7 * priority_score + 0.2 * tag_relevance + 0.1 * freshness
```

Where:

- `priority_score = delivery.priority / 3.0`
- `tag_relevance` is Jaccard similarity between `delivery.context.relevance_tags`
  and the receiver's `interest_tags`
- `freshness` decays linearly over the delivery TTL

Default byte budget:

- `16384` bytes

Interrupt deliveries are considered first and should only be pruned when they
are expired or malformed.

If a delivery is excluded from the current poll result because the byte budget
is exhausted:

- the delivery row remains in `queued` or `surfaced` state
- it stays eligible for a later poll
- the polling agent MUST write a `message.prune` audit event with
  `MACP_ERR_BUDGET_PRUNED`

## 11. Expiry

Every delivery includes:

- `timestamp`
- `ttl_seconds`

Expired deliveries:

- MUST NOT be returned by `poll`
- MUST be marked `expired` during poll cleanup
- MUST produce `MACP_ERR_TTL_EXPIRED` audit events

## 12. Deregistration

Closing a session is a two-step lifecycle action:

1. remove the agent from all channel memberships
2. mark the session `deregistered`

This prevents broadcast routing from continuing to target a closed agent.

Closed agents MUST NOT continue to send. A send attempted after deregistration
MUST fail sender validation with `MACP_ERR_SENDER_NOT_ACTIVE`.

## 13. Security Baseline

MACP v1.0 assumes a shared-file trust boundary.

Security controls come from:

- filesystem permissions
- process isolation
- deployment discipline

The protocol itself does not define:

- network authentication
- transport encryption
- TLS termination

If an agent can open the database file with write access, it can participate in
the bus.

## 14. Conformance

A conformant SQLite MACP v1.0 implementation MUST:

1. apply the schema DDL
2. use bound parameters for all data values
3. preserve the `message_id` / `delivery_id` split
4. wrap each logical send in one IMMEDIATE transaction
5. allocate sequence numbers atomically
6. enforce per-recipient queue limits
7. validate the sender session before any send and sender membership for channel sends
8. validate direct recipients and broadcast channels before send
9. bind `channel_id = NULL` for direct deliveries
10. record ACK state per delivery
11. reject invalid ACKs for unknown, expired, or dropped deliveries while treating repeated ACKs as idempotent
12. expire and audit stale pending deliveries during poll
13. audit byte-budget-pruned deliveries when pruning is applied
14. return both `queued` and `surfaced` deliveries from `poll`
15. remove memberships on deregistration

## 15. Out of Scope

The following are out of scope for this repository's v1.0:

- broker transports
- OpenAPI or AsyncAPI bindings
- push-delivery hooks
- packaged SDKs
- benchmark code

Those may exist in future work, but they are not part of the v1.0 protocol
defined here.
