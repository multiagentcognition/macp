## MACP Multi-Agent Coordination (MANDATORY)

> Copy this section into your project's agent instructions file.
> Claude Code: `CLAUDE.md` | Codex: `AGENTS.md` | OpenCode: `AGENTS.md`
> Full protocol reference: https://github.com/multiagentcognition/macp
> `projectId` is the shared workspace id. `channel` is the MACP broadcast lane. In simple setups, use the folder slug for both.

You are part of a multi-agent development team working on this codebase simultaneously.
Multiple agents may be editing code, refactoring, adding features, or fixing bugs at the
same time. You MUST use MACP to coordinate and avoid breaking each other's work.

### Setup (do this ONCE at session start)
1. MACP is already attached for this project. The MCP server auto-registers this session and auto-joins the default channel on startup.
2. If available, call `mcp__macp__macp_ext_get_session_context` to inspect pending deliveries, active claims, and shared memory
3. If the workspace uses tasks, call `mcp__macp__macp_ext_list_tasks` or `mcp__macp__macp_ext_claim_task` for your assigned work
4. Announce yourself: call `mcp__macp__macp_send_channel` with priority `info` and your task summary

### During Work (do this CONTINUOUSLY)
- **Before editing a file**: call `mcp__macp__macp_poll` to check recent activity and, if available, `mcp__macp__macp_ext_claim_files` for the files you are about to change
- **When you finish or abandon a file**: call `mcp__macp__macp_ext_release_files`
- **When you start editing a file**: send a `steering` message announcing which files you are modifying
- **When you make a breaking change** (API signature, schema, shared interface, config format): send an `interrupt` message describing what changed and what other agents need to update
- **When you discover durable facts, decisions, or constraints**: store them with `mcp__macp__macp_ext_set_memory`
- **Before changing shared behavior or touching unfamiliar code**: use `mcp__macp__macp_ext_query_context`; if docs are indexed, also use `mcp__macp__macp_ext_search_vault` / `mcp__macp__macp_ext_get_vault_doc`
- **If tasks/goals are in use**: update status with `mcp__macp__macp_ext_start_task`, `mcp__macp__macp_ext_complete_task`, `mcp__macp__macp_ext_block_task`, `mcp__macp__macp_ext_cancel_task`, and inspect `mcp__macp__macp_ext_get_goal` / `mcp__macp__macp_ext_get_goal_cascade`
- **Poll regularly**: call `mcp__macp__macp_poll` every 3-5 tool calls to stay aware of other agents' work
- **Acknowledge**: call `mcp__macp__macp_ack` on every delivery you process
- **If you pause for a while**: call `mcp__macp__macp_ext_sleep_agent`; on planned shutdown use `mcp__macp__macp_ext_deactivate_agent` if lifecycle tracking is enabled, otherwise `mcp__macp__macp_deregister`
- **Repair only when needed**: `mcp__macp__macp_register` and `mcp__macp__macp_join_channel` are repair/override tools, not normal startup steps

### Workspace Extensions (use when available)
- `mcp__macp__macp_ext_list_agents` and `mcp__macp__macp_ext_get_session_context` improve situational awareness
- `mcp__macp__macp_ext_claim_files` complements steering messages; use both, not just one
- `mcp__macp__macp_ext_search_memory` and `mcp__macp__macp_ext_query_context` help you avoid rediscovering existing decisions
- `mcp__macp__macp_ext_register_profile`, `mcp__macp__macp_ext_register_vault`, `mcp__macp__macp_ext_archive_tasks`, and `mcp__macp__macp_ext_delete_agent` are administrative tools; use them only if your role includes workspace maintenance

### Message Format
Use structured content in your messages:
```
[ACTION] editing | refactoring | adding | removing | fixing
[FILES] comma-separated file paths
[BREAKING] yes/no
[SUMMARY] one-line description of the change
[DETAILS] optional longer explanation if breaking=yes
```

### What to Communicate
- Files you are actively editing or claiming (steering priority)
- Breaking API/interface/schema changes (interrupt priority)
- Durable design decisions or discovered constraints (advisory priority plus shared memory when appropriate)
- New files or modules you create (advisory priority)
- Bug fixes that change behavior (steering priority)
- Refactors that move/rename things (interrupt priority)
- Test results or failures you discover (advisory priority)
- Task status changes when the task layer is in use (info or advisory priority)
- Completion of your task (info priority)

### Conflict Resolution
- If you poll or see a file claim from another agent on the same file, coordinate before proceeding
- If you receive an interrupt about a breaking change, stop and assess impact on your work
- If your changes overlap with another agent's, send a steering message proposing resolution
- Never silently overwrite another agent's recent changes

### Priority Guide
- `info`: background updates, task start/completion announcements
- `advisory`: useful findings, new files created, test results
- `steering`: active file edits, behavior changes, things peers should know
- `interrupt`: breaking changes that require immediate attention from all agents
