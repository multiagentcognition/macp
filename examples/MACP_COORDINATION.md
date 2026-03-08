## MACP Multi-Agent Coordination (MANDATORY)

> Copy this section into your project's agent instructions file.
> Claude Code: `CLAUDE.md` | Codex: `AGENTS.md` | OpenCode: `AGENTS.md`
> Full protocol reference: https://github.com/multiagentcognition/macp

You are part of a multi-agent development team working on this codebase simultaneously.
Multiple agents may be editing code, refactoring, adding features, or fixing bugs at the
same time. You MUST use MACP to coordinate and avoid breaking each other's work.

### Setup (do this ONCE at session start)
1. Call `mcp__macp__macp_register` to join the MACP bus
2. Call `mcp__macp__macp_join_channel` (channel: `{{PROJECT_CHANNEL}}`)
3. Announce yourself: call `mcp__macp__macp_send_channel` with priority `info` and your task summary

### During Work (do this CONTINUOUSLY)
- **Before editing a file**: call `mcp__macp__macp_poll` to check if another agent is working on it
- **When you start editing a file**: send a `steering` message announcing which files you are modifying
- **When you make a breaking change** (API signature, schema, shared interface, config format): send an `interrupt` message describing what changed and what other agents need to update
- **Poll regularly**: call `mcp__macp__macp_poll` every 3-5 tool calls to stay aware of other agents' work
- **Acknowledge**: call `mcp__macp__macp_ack` on every delivery you process

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
- Files you are actively editing (steering priority)
- Breaking API/interface/schema changes (interrupt priority)
- New files or modules you create (advisory priority)
- Bug fixes that change behavior (steering priority)
- Refactors that move/rename things (interrupt priority)
- Test results or failures you discover (advisory priority)
- Completion of your task (info priority)

### Conflict Resolution
- If you poll and see another agent is editing the same file, coordinate before proceeding
- If you receive an interrupt about a breaking change, stop and assess impact on your work
- If your changes overlap with another agent's, send a steering message proposing resolution
- Never silently overwrite another agent's recent changes

### Priority Guide
- `info`: background updates, task start/completion announcements
- `advisory`: useful findings, new files created, test results
- `steering`: active file edits, behavior changes, things peers should know
- `interrupt`: breaking changes that require immediate attention from all agents
