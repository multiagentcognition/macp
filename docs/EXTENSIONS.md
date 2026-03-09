# MACP Workspace Extensions

This repository now ships a non-normative extension layer on top of MACP v1.0.

The boundary is deliberate:

- `macp.schema.json` and [`spec/MACP-v1.0.md`](../spec/MACP-v1.0.md) remain the normative protocol
- the extension layer adds higher-level coordination helpers in the same SQLite file
- extension state is stored in `macp_ext_*` tables so the core transport model stays unchanged

These helpers are inspired by the kinds of capabilities orchestration systems often add around a message bus, but they are implemented here as clean-room MACP-native helpers rather than protocol changes.

## Design Rules

- The MACP bus stays primary. Agents still register, join channels, send, poll, ack, and deregister exactly as before.
- Extensions must not weaken MACP delivery semantics.
- Extensions should reuse MACP identity and channel membership instead of inventing a second identity model.
- Anything in this document is optional. An implementation can support core MACP without supporting these helpers.

## Current Extension Tool Surface

### Awareness

- `macp_ext_list_agents`
- `macp_ext_get_session_context`

These tools expose active agents, joined channels, queue summaries, and compact non-mutating context snapshots.

### Advisory File Ownership

- `macp_ext_claim_files`
- `macp_ext_release_files`
- `macp_ext_list_locks`

Claims are advisory only. They signal current work and expire automatically after their TTL.

### Shared Memory

- `macp_ext_set_memory`
- `macp_ext_get_memory`
- `macp_ext_search_memory`
- `macp_ext_list_memories`
- `macp_ext_delete_memory`
- `macp_ext_resolve_memory`

Memory uses MACP-native scopes:

- `agent`
- `channel`
- `workspace`

Channel-scoped memory requires active membership in the channel. Unscoped reads cascade:

1. `agent`
2. `channel`
3. `workspace`

### Profiles

- `macp_ext_register_profile`
- `macp_ext_get_profile`
- `macp_ext_list_profiles`
- `macp_ext_find_profiles`

Profiles define reusable roles, skills, memory keys, and vault path hints. They are intentionally optional and are used primarily by the task layer.

### Tasks

- `macp_ext_dispatch_task`
- `macp_ext_claim_task`
- `macp_ext_start_task`
- `macp_ext_complete_task`
- `macp_ext_block_task`
- `macp_ext_cancel_task`
- `macp_ext_get_task`
- `macp_ext_list_tasks`
- `macp_ext_archive_tasks`

Tasks are a shared work queue above the MACP bus. They do not change message delivery semantics.

### Goals

- `macp_ext_create_goal`
- `macp_ext_list_goals`
- `macp_ext_get_goal`
- `macp_ext_update_goal`
- `macp_ext_get_goal_cascade`

Goals are hierarchical planning objects that can aggregate task progress.

### Agent Lifecycle

- `macp_ext_sleep_agent`
- `macp_ext_deactivate_agent`
- `macp_ext_delete_agent`

Lifecycle tools change workspace presence semantics. `sleep` keeps the session active, while `deactivate` and `delete` deregister the current session and remove channel membership.

### Vault / Docs

- `macp_ext_register_vault`
- `macp_ext_search_vault`
- `macp_ext_get_vault_doc`
- `macp_ext_list_vault_docs`

Vault docs are filesystem-backed text documents indexed into the shared SQLite database. The first-party implementation currently supports text-oriented flat files such as `.md`, `.mdx`, `.txt`, and `.rst`.

### Context Search

- `macp_ext_query_context`

`macp_ext_query_context` searches visible memories, indexed vault docs, completed tasks, and goals.

## Why These Extensions Came First

These capabilities fit MACP’s existing fundamentals:

- agent identity already exists
- channel membership already exists
- the transport already solves timely peer awareness

By contrast, tasks, goals, lifecycle controls, and document vaults are useful, but they are larger workflow products rather than thin transport primitives. They should stay optional and should not be smuggled into the v1 protocol as hidden requirements.
