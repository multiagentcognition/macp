## MACP Contributor Coordination

This repository uses MACP core tools plus the first-party extension workflow.
Use the MCP tools for coordination; do not rely on local assumptions about what
other agents are doing.

### Setup
1. If MACP tools are attached for this project, the MCP server auto-registers this session and auto-joins the default channel on startup.
2. If available, call `mcp__macp__macp_ext_get_session_context`.
3. If tasks are active, call `mcp__macp__macp_ext_list_tasks` or `mcp__macp__macp_ext_claim_task`.
4. Announce your task with `mcp__macp__macp_send_channel`.

### During Work
- Before editing files, call `mcp__macp__macp_poll` and then `mcp__macp__macp_ext_claim_files` for the files you intend to change.
- When you finish or abandon a file, call `mcp__macp__macp_ext_release_files`.
- Send a `steering` message when you start editing shared files.
- Send an `interrupt` message for breaking interface, schema, or config changes.
- Write durable facts and decisions with `mcp__macp__macp_ext_set_memory`.
- Use `mcp__macp__macp_ext_query_context` and `mcp__macp__macp_ext_search_memory` before changing shared behavior or revisiting prior decisions.
- If docs are indexed, use `mcp__macp__macp_ext_search_vault` and `mcp__macp__macp_ext_get_vault_doc`.
- If tasks/goals are in use, update them with `mcp__macp__macp_ext_start_task`, `mcp__macp__macp_ext_complete_task`, `mcp__macp__macp_ext_block_task`, `mcp__macp__macp_ext_cancel_task`, `mcp__macp__macp_ext_get_goal`, and `mcp__macp__macp_ext_get_goal_cascade`.
- Call `mcp__macp__macp_ack` for every delivery you act on.
- If you pause for a while, call `mcp__macp__macp_ext_sleep_agent`. On planned shutdown, prefer `mcp__macp__macp_ext_deactivate_agent` when lifecycle tracking is enabled; otherwise call `mcp__macp__macp_deregister`.
- `mcp__macp__macp_register` and `mcp__macp__macp_join_channel` are repair/override tools. Do not treat them as required startup steps in normal project use.

### Extension Notes
- `mcp__macp__macp_ext_list_agents` and `mcp__macp__macp_ext_get_session_context` are your quick awareness tools.
- File claims complement steering messages; use both.
- `mcp__macp__macp_ext_register_profile`, `mcp__macp__macp_ext_register_vault`, `mcp__macp__macp_ext_archive_tasks`, and `mcp__macp__macp_ext_delete_agent` are administrative tools.

### Message Format
Use structured message content:

```text
[ACTION] editing | refactoring | adding | removing | fixing
[FILES] comma-separated file paths
[BREAKING] yes/no
[SUMMARY] one-line description of the change
[DETAILS] optional longer explanation if breaking=yes
```

### Priority Guide
- `info`: background updates, task start/completion announcements
- `advisory`: useful findings, shared decisions, new files created, test results
- `steering`: active file edits, behavior changes, things peers should know
- `interrupt`: breaking changes that require immediate attention
