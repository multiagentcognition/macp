# MACP Security Notes

MACP v1.0 in this repository is a shared-file protocol. Security is therefore
primarily an operating-system and deployment concern rather than a transport
protocol concern.

## Trust Boundary

Any process that can open the shared SQLite database with write access can:

- register as an agent
- join channels
- send messages
- acknowledge deliveries
- inspect message content

MACP does not add an authentication layer on top of the file itself.

## Primary Controls

The meaningful security controls for a SQLite deployment are:

1. filesystem permissions on the database file and its directory
2. process isolation on the host
3. shared-host trust assumptions
4. prompt and content sanitization in downstream consumers

## Threats

### Unauthorized Local Access

If an unauthorized process gains write access to the SQLite file, it can fully
participate in the bus.

Mitigation:

- store the database in a restricted directory
- run participating agents under a dedicated service account
- avoid world-readable or world-writable paths

### Message Tampering

The SQLite bus does not cryptographically protect rows. A process with write
access can mutate messages, ACKs, queue state, or audit rows.

Mitigation:

- restrict database access tightly
- ship or mirror audit output to append-only external storage if stronger audit
  guarantees are required

### Prompt Injection Through Content

MACP messages often originate from LLM output or tool output and should be
treated as untrusted content.

Mitigation:

- never treat message content as executable instructions
- delimit peer content clearly when inserting it into prompts
- validate `application/json` payloads before use
- sanitize any file paths or references before acting on them

### Queue Exhaustion

Slow or dead consumers can accumulate pending deliveries.

Mitigation in v1.0:

- `max_pending_messages` per recipient
- overflow policy that evicts the oldest lowest-priority candidate when the
  incoming delivery is at least as important
- TTL-based expiry

### Duplicate Delivery

Because `poll` returns both `queued` and `surfaced` deliveries, a receiver may
see the same `delivery_id` more than once before it records `processed`.

Mitigation:

- consumer handlers must be idempotent
- consumers should persist recently handled `delivery_id` values if duplicate
  side effects are expensive

## What MACP v1.0 Does Not Provide

- file encryption
- per-agent authentication
- row-level ACLs
- channel ACLs
- transport TLS
- cryptographic signing of messages or ACKs

Those can be layered on externally, but they are not part of the SQLite v1.0
protocol itself.

## Recommended Deployment Baseline

For a production-style shared-file deployment:

1. place the database in a private directory owned by a dedicated system user
2. run all participating agents under the same trusted service boundary
3. back up or mirror the database and audit log if delivery history matters
4. monitor database size and audit growth
5. validate and sanitize all downstream use of peer message content
