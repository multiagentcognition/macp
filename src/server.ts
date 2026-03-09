#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import {
  AckLevel,
  MacpCore,
  MacpProtocolError,
  Priority,
  PriorityAlias,
  SenderInfo,
} from './macp-core.js';
import { MacpWorkspaceExtensions } from './macp-extensions.js';
import { MacpWorkspaceExtensionsAdvanced } from './macp-extensions-advanced.js';
import { defaultProjectDbPath, loadProjectConfig, slugifyIdentifier } from './project.js';

export type ServerConfig = {
  dbPath: string;
  projectId: string;
  agentId: string;
  agentName: string;
  sessionId: string;
  defaultChannel: string;
  role: string;
  interestTags: string[];
  maxPendingMessages: number;
  maxContextBytes: number;
};

type ParsedCliInvocation =
  | { help: true }
  | { help: false; config: ServerConfig };

function normalizeOptionalString(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function printHelp(): void {
  console.log(`MACP MCP server

Usage:
  macp-mcp init [options]
  macp-mcp server [options]
  macp-server [options]

Options:
  --db <path>                  Shared SQLite file path
  --project-id <id>            Logical shared workspace id. If omitted, MACP
                               derives it from the current project folder.
  --channel <id>               Explicit MACP routing scope for broadcast tools
  --agent-id <id>              Stable agent identifier (default: random UUID)
  --agent-name <name>          Human-readable name (default: agent id)
  --session-id <id>            Session identifier (default: random UUID)
  --role <label>               Agent role label (default: participant)
  --interest-tags <list>       JSON array or comma-separated tags
  --max-pending-messages <n>   Advertised queue limit (default: 200)
  --max-context-bytes <n>      Advertised poll byte budget (default: 16384)
  --schema-path <path>         Override path to macp.schema.json
  -h, --help                   Show help

Environment aliases:
  MACP_PROJECT_ROOT
  MACP_DB_PATH
  MACP_PROJECT_ID
  MACP_DEFAULT_CHANNEL
  MACP_AGENT_ID
  MACP_AGENT_NAME
  MACP_SESSION_ID
  MACP_AGENT_ROLE
  MACP_INTEREST_TAGS
  MACP_MAX_PENDING_MESSAGES
  MACP_MAX_CONTEXT_BYTES
  MACP_SCHEMA_PATH

Project vs channel:
  - projectId: the logical shared workspace id
  - channel: the MACP routing scope used for broadcast messages
  - default setup: projectId derives from the current folder and uses a local DB
  - shared setup: explicit projectId defaults to a shared per-user DB path
  - advanced setup: one projectId, one DB, multiple channels via --channel

Behavior:
  - server startup auto-registers the current agent session
  - server startup auto-joins the default channel when one is configured
  - normal agent loops should use poll/send/ack rather than manual register/join
`);
}

function envNumber(name: string, defaultValue: number, env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') {
    return defaultValue;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be numeric.`);
  }

  return parsed;
}

function parseTagList(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === '') {
    return [];
  }

  if (raw.trim().startsWith('[')) {
    return JSON.parse(raw) as string[];
  }

  return raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function envTags(name: string, env: NodeJS.ProcessEnv = process.env): string[] {
  return parseTagList(env[name]);
}

function parseOptionalNumber(value: string | undefined, optionName: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${optionName} must be numeric.`);
  }

  return parsed;
}

export function parseServerCliArgs(
  args: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): ParsedCliInvocation {
  const parsed = parseArgs({
    args,
    options: {
      help: {
        type: 'boolean',
        short: 'h',
      },
      db: {
        type: 'string',
      },
      'project-id': {
        type: 'string',
      },
      channel: {
        type: 'string',
      },
      'agent-id': {
        type: 'string',
      },
      'agent-name': {
        type: 'string',
      },
      'session-id': {
        type: 'string',
      },
      role: {
        type: 'string',
      },
      'interest-tags': {
        type: 'string',
      },
      'max-pending-messages': {
        type: 'string',
      },
      'max-context-bytes': {
        type: 'string',
      },
      'schema-path': {
        type: 'string',
      },
    },
    allowPositionals: true,
    strict: true,
  });

  const command = parsed.positionals[0];
  if (parsed.values.help || command === 'help') {
    return { help: true };
  }

  if (command !== undefined && command !== 'server') {
    throw new Error(`Unknown MACP command: ${command}`);
  }

  if (parsed.positionals.length > (command === undefined ? 0 : 1)) {
    throw new Error(`Unexpected positional arguments: ${parsed.positionals.slice(1).join(' ')}`);
  }

  const discoveryRoot = normalizeOptionalString(env.MACP_PROJECT_ROOT) ?? process.cwd();
  const discovered = loadProjectConfig(discoveryRoot)?.config;

  const derivedProjectId = slugifyIdentifier(basename(discovered?.projectRoot ?? process.cwd())) || 'macp';
  const cliProjectId = normalizeOptionalString(parsed.values['project-id']);
  const envProjectId = normalizeOptionalString(env.MACP_PROJECT_ID);
  const projectId = slugifyIdentifier(cliProjectId ?? envProjectId ?? discovered?.projectId ?? derivedProjectId) || 'macp';

  const hasExplicitProjectId = cliProjectId !== undefined || envProjectId !== undefined;
  const cliChannel = normalizeOptionalString(parsed.values.channel);
  const envChannel = normalizeOptionalString(env.MACP_DEFAULT_CHANNEL);
  const defaultChannel = cliChannel ?? envChannel ?? discovered?.defaultChannel ?? projectId;

  const cliDb = normalizeOptionalString(parsed.values.db);
  const dbPath = cliDb
    ?? normalizeOptionalString(env.MACP_DB_PATH)
    ?? (hasExplicitProjectId ? undefined : discovered?.dbPath)
    ?? defaultProjectDbPath(
      discovered?.projectRoot ?? process.cwd(),
      projectId,
      hasExplicitProjectId,
    );

  const schemaPath = normalizeOptionalString(parsed.values['schema-path']) ?? normalizeOptionalString(env.MACP_SCHEMA_PATH);
  if (schemaPath !== undefined) {
    process.env.MACP_SCHEMA_PATH = schemaPath;
  }

  const cliInterestTags = normalizeOptionalString(parsed.values['interest-tags']);
  const cliMaxPendingMessages = parseOptionalNumber(
    normalizeOptionalString(parsed.values['max-pending-messages']),
    '--max-pending-messages',
  );
  const cliMaxContextBytes = parseOptionalNumber(
    normalizeOptionalString(parsed.values['max-context-bytes']),
    '--max-context-bytes',
  );

  const agentId = normalizeOptionalString(parsed.values['agent-id']) ?? normalizeOptionalString(env.MACP_AGENT_ID) ?? randomUUID();
  const sessionId = normalizeOptionalString(parsed.values['session-id']) ?? normalizeOptionalString(env.MACP_SESSION_ID) ?? randomUUID();

  return {
    help: false,
    config: {
      dbPath,
      projectId,
      agentId,
      agentName: normalizeOptionalString(parsed.values['agent-name']) ?? normalizeOptionalString(env.MACP_AGENT_NAME) ?? agentId,
      sessionId,
      defaultChannel,
      role: normalizeOptionalString(parsed.values.role) ?? normalizeOptionalString(env.MACP_AGENT_ROLE) ?? 'participant',
      interestTags: cliInterestTags !== undefined ? parseTagList(cliInterestTags) : envTags('MACP_INTEREST_TAGS', env),
      maxPendingMessages: cliMaxPendingMessages ?? envNumber('MACP_MAX_PENDING_MESSAGES', 200, env),
      maxContextBytes: cliMaxContextBytes ?? envNumber('MACP_MAX_CONTEXT_BYTES', 16384, env),
    },
  };
}

function normalizePriority(value: Priority | PriorityAlias): Priority {
  switch (value) {
    case 0:
    case 1:
    case 2:
    case 3:
      return value;
    case 'info':
      return 0;
    case 'advisory':
      return 1;
    case 'steering':
      return 2;
    case 'interrupt':
      return 3;
    default:
      throw new Error(`Unsupported priority: ${String(value)}`);
  }
}

function buildSenderInfo(config: ServerConfig): SenderInfo {
  return {
    agentId: config.agentId,
    sessionId: config.sessionId,
    name: config.agentName,
  };
}

function buildMcpInstructions(config: ServerConfig): string {
  const defaultChannel = config.defaultChannel || '(set --channel / MACP_DEFAULT_CHANNEL or use --project-id)';
  const projectId = config.projectId || '(not set)';
  const tags = config.interestTags.length > 0 ? config.interestTags.join(', ') : '(none)';

  return `You are operating through the MACP MCP tool surface.

Identity:
- project_id: ${projectId}
- agent_id: ${config.agentId}
- agent_name: ${config.agentName}
- session_id: ${config.sessionId}
- default_channel: ${defaultChannel}
- role: ${config.role}
- interest_tags: ${tags}

Scope:
- project_id is the logical shared workspace id.
- channel is the MACP routing scope used for broadcast messages.
- direct messages are not channel-scoped.

Rules:
1. Use the MACP MCP tools only.
2. Do not open the SQLite file directly.
3. Do not execute SQL or apply schema DDL yourself.
4. Handle deliveries idempotently because poll may return the same delivery more than once.

Tool workflow:
1. This MCP server auto-registers your session on startup.
2. This MCP server auto-joins the default channel on startup when one is configured.
3. During your loop, call macp_poll.
4. After you act on a delivery, call macp_ack with its deliveryId.
5. Use macp_send_channel for shared channel updates.
6. Use macp_send_direct for one-to-one messages.
7. Use macp_register or macp_join_channel only for explicit repair or override flows.
8. Call macp_deregister on shutdown when your host supports a planned shutdown step.

Priority guide:
- info: background context
- advisory: useful findings worth considering
- steering: findings that should change what peers do next
- interrupt: urgent findings that should be handled on the next poll

The MCP server already applies the MACP schema and SQLite protocol rules for you.

Optional workspace extensions in this server build:
- macp_ext_list_agents
- macp_ext_get_session_context
- macp_ext_claim_files / macp_ext_release_files / macp_ext_list_locks
- macp_ext_set_memory / macp_ext_get_memory / macp_ext_search_memory / macp_ext_list_memories
- macp_ext_delete_memory / macp_ext_resolve_memory
- macp_ext_register_profile / macp_ext_get_profile / macp_ext_list_profiles / macp_ext_find_profiles
- macp_ext_dispatch_task / macp_ext_claim_task / macp_ext_start_task / macp_ext_complete_task / macp_ext_block_task / macp_ext_cancel_task / macp_ext_get_task / macp_ext_list_tasks / macp_ext_archive_tasks
- macp_ext_create_goal / macp_ext_list_goals / macp_ext_get_goal / macp_ext_update_goal / macp_ext_get_goal_cascade
- macp_ext_sleep_agent / macp_ext_deactivate_agent / macp_ext_delete_agent
- macp_ext_register_vault / macp_ext_search_vault / macp_ext_get_vault_doc / macp_ext_list_vault_docs
- macp_ext_query_context

Recommended extension workflow when these tools are available:
- Use macp_ext_get_session_context after register/join to inspect pending work, claims, and shared memory.
- Before editing files, use macp_ext_claim_files. Release claims with macp_ext_release_files when done.
- Persist durable facts and decisions with macp_ext_set_memory. Search existing state with macp_ext_search_memory or macp_ext_query_context before changing shared behavior.
- If docs are indexed, use macp_ext_search_vault and macp_ext_get_vault_doc.
- If tasks/goals are in use, use macp_ext_claim_task / macp_ext_start_task / macp_ext_complete_task and inspect goals with macp_ext_get_goal or macp_ext_get_goal_cascade.
- Administrative tools such as macp_ext_register_profile, macp_ext_register_vault, macp_ext_archive_tasks, and macp_ext_delete_agent are for workspace maintenance rather than every agent loop.
- Use macp_ext_sleep_agent for pauses and macp_ext_deactivate_agent on planned shutdown when lifecycle tracking is enabled.

These extension tools are non-normative helpers layered on top of the MACP bus.`;
}

function toolSuccess<T extends object>(data: T): CallToolResult {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(data, null, 2),
      },
    ],
    structuredContent: data as Record<string, unknown>,
  };
}

function toolError(error: unknown): CallToolResult {
  if (error instanceof MacpProtocolError) {
    return {
      isError: true,
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              reasonCode: error.reasonCode,
              message: error.message,
              metadata: error.metadata,
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [
      {
        type: 'text' as const,
        text: message,
      },
    ],
  };
}

type ServerRuntime = {
  core: MacpCore;
  workspace: MacpWorkspaceExtensions;
  advanced: MacpWorkspaceExtensionsAdvanced;
};

function createServerRuntime(config: ServerConfig): ServerRuntime {
  return {
    core: new MacpCore({
      dbPath: config.dbPath,
    }),
    workspace: new MacpWorkspaceExtensions({
      dbPath: config.dbPath,
    }),
    advanced: new MacpWorkspaceExtensionsAdvanced({
      dbPath: config.dbPath,
    }),
  };
}

function bootstrapServerRuntime(runtime: ServerRuntime, config: ServerConfig): void {
  runtime.core.registerAgent({
    agentId: config.agentId,
    sessionId: config.sessionId,
    name: config.agentName,
    capabilities: {
      role: config.role,
      injection_tiers: ['tier1_polling'],
      ack_levels: ['received', 'queued', 'processed'],
      max_context_bytes: config.maxContextBytes,
    },
    interestTags: config.interestTags,
    queuePreferences: {
      max_pending_messages: config.maxPendingMessages,
    },
  });

  runtime.advanced.activateAgent({
    agentId: config.agentId,
  });

  if (config.defaultChannel) {
    runtime.core.joinChannel({
      agentId: config.agentId,
      sessionId: config.sessionId,
      channelId: config.defaultChannel,
    });
  }
}

function closeServerRuntime(runtime: ServerRuntime): void {
  runtime.advanced.close();
  runtime.workspace.close();
  runtime.core.close();
}

function cleanupServerRuntime(runtime: ServerRuntime, config: ServerConfig, reason: string): void {
  try {
    runtime.advanced.deactivateAgent({
      agentId: config.agentId,
      sessionId: config.sessionId,
      reason,
    });
    return;
  } catch {
    // Fall through to best-effort core deregistration.
  }

  try {
    runtime.core.deregister({
      agentId: config.agentId,
      sessionId: config.sessionId,
    });
  } catch {
    // Nothing else to do on shutdown.
  }
}

function registerProcessCleanup(runtime: ServerRuntime, config: ServerConfig): void {
  let cleanedUp = false;

  const finalize = (reason: string): void => {
    if (cleanedUp) {
      return;
    }

    cleanedUp = true;
    cleanupServerRuntime(runtime, config, reason);
    closeServerRuntime(runtime);
  };

  const attachSignal = (signal: NodeJS.Signals, exitCode: number): void => {
    process.once(signal, () => {
      finalize(signal);
      process.exit(exitCode);
    });
  };

  attachSignal('SIGINT', 130);
  attachSignal('SIGTERM', 143);
  attachSignal('SIGHUP', 129);
  process.once('beforeExit', () => {
    finalize('beforeExit');
  });
  process.once('exit', () => {
    finalize('exit');
  });
}

export function createMacpServer(config: ServerConfig, runtime: ServerRuntime = createServerRuntime(config)): McpServer {
  const { core, workspace, advanced } = runtime;
  const server = new McpServer({
    name: 'macp-mcp-server',
    version: '1.0.0',
  });

  const prioritySchema = z.union([
    z.literal(0),
    z.literal(1),
    z.literal(2),
    z.literal(3),
    z.enum(['info', 'advisory', 'steering', 'interrupt']),
  ]);

  const ackLevelSchema = z.enum(['queued', 'received', 'processed']);
  const memoryScopeSchema = z.enum(['agent', 'channel', 'workspace']);
  const memoryLayerSchema = z.enum(['constraints', 'behavior', 'context']);
  const memoryConfidenceSchema = z.enum(['stated', 'inferred', 'observed']);
  const taskPrioritySchema = z.enum(['P0', 'P1', 'P2', 'P3']);
  const goalTypeSchema = z.enum(['mission', 'project_goal', 'agent_goal']);
  const goalStatusSchema = z.enum(['active', 'completed', 'paused']);

  server.registerTool(
    'macp_get_instructions',
    {
      description: 'Return the MACP team protocol instructions for this configured agent.',
      inputSchema: {},
    },
    () => {
      try {
        return toolSuccess({
          instructions: buildMcpInstructions(config),
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'macp_register',
    {
      description: 'Refresh or repair registration for this configured agent session on the MACP bus.',
      inputSchema: {
        interestTags: z.array(z.string()).optional(),
        maxPendingMessages: z.number().int().positive().optional(),
        maxContextBytes: z.number().int().positive().optional(),
        profileSlug: z.string().min(1).optional(),
      },
    },
    ({ interestTags, maxPendingMessages, maxContextBytes, profileSlug }) => {
      try {
        const registered = core.registerAgent({
            agentId: config.agentId,
            sessionId: config.sessionId,
            name: config.agentName,
            capabilities: {
              role: config.role,
              injection_tiers: ['tier1_polling'],
              ack_levels: ['received', 'queued', 'processed'],
              max_context_bytes: maxContextBytes ?? config.maxContextBytes,
            },
            interestTags: interestTags ?? config.interestTags,
            queuePreferences: {
              max_pending_messages: maxPendingMessages ?? config.maxPendingMessages,
            },
          });

        if (config.defaultChannel) {
          core.joinChannel({
            agentId: config.agentId,
            sessionId: config.sessionId,
            channelId: config.defaultChannel,
          });
        }

        const agentState = advanced.activateAgent({
          agentId: config.agentId,
          profileSlug,
        });

        return toolSuccess({
          ...registered,
          status: agentState.status,
          profileSlug: agentState.profileSlug,
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'macp_join_channel',
    {
      description: 'Join an additional channel or repair channel membership for this agent.',
      inputSchema: {
        channelId: z.string().min(1).optional(),
      },
    },
    ({ channelId }) => {
      try {
        const resolvedChannelId = channelId ?? config.defaultChannel;
        if (!resolvedChannelId) {
          throw new Error('channelId is required when neither --channel nor --project-id is configured.');
        }

        return toolSuccess(
          core.joinChannel({
            agentId: config.agentId,
            sessionId: config.sessionId,
            channelId: resolvedChannelId,
          }),
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'macp_send_channel',
    {
      description: 'Send a channel-scoped MACP message from this agent.',
      inputSchema: {
        channelId: z.string().min(1).optional(),
        content: z.string().min(1),
        priority: prioritySchema.optional(),
        type: z.string().min(1).optional(),
        relevanceTags: z.array(z.string()).optional(),
        confidence: z.number().min(0).max(1).optional(),
        sourceReferences: z.array(z.string()).optional(),
        ttlSeconds: z.number().int().positive().optional(),
        contentType: z.enum(['text/plain', 'application/json']).optional(),
        ackLevel: ackLevelSchema.optional(),
      },
    },
    ({ channelId, content, priority, type, relevanceTags, confidence, sourceReferences, ttlSeconds, contentType, ackLevel }) => {
      try {
        const resolvedChannelId = channelId ?? config.defaultChannel;
        if (!resolvedChannelId) {
          throw new Error('channelId is required when neither --channel nor --project-id is configured.');
        }

        return toolSuccess(
          core.sendChannel({
            channelId: resolvedChannelId,
            from: buildSenderInfo(config),
            content,
            priority: normalizePriority(priority ?? 'advisory'),
            type,
            contentType,
            ttlSeconds,
            context: {
              relevanceTags: relevanceTags ?? [],
              confidence: confidence ?? 1,
              sourceReferences: sourceReferences ?? [],
            },
            ack: {
              requestLevel: ackLevel ?? 'received',
            },
          }),
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'macp_send_direct',
    {
      description: 'Send a direct MACP message from this agent to another agent.',
      inputSchema: {
        destinationAgentId: z.string().min(1),
        content: z.string().min(1),
        priority: prioritySchema.optional(),
        type: z.string().min(1).optional(),
        relevanceTags: z.array(z.string()).optional(),
        confidence: z.number().min(0).max(1).optional(),
        sourceReferences: z.array(z.string()).optional(),
        ttlSeconds: z.number().int().positive().optional(),
        contentType: z.enum(['text/plain', 'application/json']).optional(),
        ackLevel: ackLevelSchema.optional(),
      },
    },
    ({ destinationAgentId, content, priority, type, relevanceTags, confidence, sourceReferences, ttlSeconds, contentType, ackLevel }) => {
      try {
        return toolSuccess(
          core.sendDirect({
            destinationAgentId,
            from: buildSenderInfo(config),
            content,
            priority: normalizePriority(priority ?? 'advisory'),
            type,
            contentType,
            ttlSeconds,
            context: {
              relevanceTags: relevanceTags ?? [],
              confidence: confidence ?? 1,
              sourceReferences: sourceReferences ?? [],
            },
            ack: {
              requestLevel: ackLevel ?? 'received',
            },
          }),
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'macp_poll',
    {
      description: 'Poll for pending MACP deliveries for this agent.',
      inputSchema: {
        minPriority: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]).optional(),
        maxMessages: z.number().int().positive().optional(),
        applyBudgetPruning: z.boolean().optional(),
        budgetBytes: z.number().int().positive().optional(),
      },
    },
    ({ minPriority, maxMessages, applyBudgetPruning, budgetBytes }) => {
      try {
        return toolSuccess(
          core.poll({
            agentId: config.agentId,
            minPriority,
            maxMessages,
            applyBudgetPruning,
            budgetBytes,
          }),
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'macp_ack',
    {
      description: 'Record processed and acknowledge a MACP delivery by delivery_id.',
      inputSchema: {
        deliveryId: z.string().uuid(),
      },
    },
    ({ deliveryId }) => {
      try {
        return toolSuccess(core.ack({ deliveryId }));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'macp_deregister',
    {
      description: 'Remove this agent from channel membership and mark the session deregistered.',
      inputSchema: {},
    },
    () => {
      try {
        return toolSuccess(
          core.deregister({
            agentId: config.agentId,
            sessionId: config.sessionId,
          }),
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'macp_ext_list_agents',
    {
      description: 'List active MACP agents with joined channels, queue hints, and advisory claim counts.',
      inputSchema: {},
    },
    () => {
      try {
        return toolSuccess(workspace.listAgents());
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'macp_ext_get_session_context',
    {
      description: 'Return a non-mutating workspace snapshot for this agent: pending deliveries, active claims, and memory counts.',
      inputSchema: {
        channelId: z.string().min(1).optional(),
        pendingLimit: z.number().int().positive().optional(),
      },
    },
    ({ channelId, pendingLimit }) => {
      try {
        return toolSuccess(
          workspace.getSessionContext({
            agentId: config.agentId,
            sessionId: config.sessionId,
            channelId: channelId ?? config.defaultChannel ?? undefined,
            pendingLimit,
          }),
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'macp_ext_claim_files',
    {
      description: 'Create advisory file claims for the current agent. Claims are TTL-based and do not block writes.',
      inputSchema: {
        files: z.array(z.string().min(1)).min(1),
        ttlSeconds: z.number().int().positive().optional(),
        reason: z.string().min(1).optional(),
      },
    },
    ({ files, ttlSeconds, reason }) => {
      try {
        return toolSuccess(
          workspace.claimFiles({
            agentId: config.agentId,
            sessionId: config.sessionId,
            files,
            ttlSeconds,
            reason,
          }),
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'macp_ext_release_files',
    {
      description: 'Release advisory file claims previously created by the current agent session.',
      inputSchema: {
        files: z.array(z.string().min(1)).min(1),
        reason: z.string().min(1).optional(),
      },
    },
    ({ files, reason }) => {
      try {
        return toolSuccess(
          workspace.releaseFiles({
            agentId: config.agentId,
            sessionId: config.sessionId,
            files,
            reason,
          }),
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'macp_ext_list_locks',
    {
      description: 'List active advisory file claims across the workspace.',
      inputSchema: {
        agentId: z.string().min(1).optional(),
        files: z.array(z.string().min(1)).optional(),
      },
    },
    ({ agentId, files }) => {
      try {
        return toolSuccess(
          workspace.listFileClaims({
            agentId,
            files,
          }),
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'macp_ext_set_memory',
    {
      description: 'Store workspace memory scoped to the current agent, the current channel, or the whole workspace.',
      inputSchema: {
        key: z.string().min(1),
        value: z.string().min(1),
        scope: memoryScopeSchema,
        channelId: z.string().min(1).optional(),
        tags: z.array(z.string()).optional(),
        confidence: memoryConfidenceSchema.optional(),
        layer: memoryLayerSchema.optional(),
      },
    },
    ({ key, value, scope, channelId, tags, confidence, layer }) => {
      try {
        return toolSuccess(
          workspace.setMemory({
            agentId: config.agentId,
            sessionId: config.sessionId,
            key,
            value,
            scope,
            channelId: channelId ?? config.defaultChannel ?? undefined,
            tags,
            confidence,
            layer,
          }),
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'macp_ext_get_memory',
    {
      description: 'Read workspace memory with optional scope selection. Without scope, memory cascades agent -> channel -> workspace.',
      inputSchema: {
        key: z.string().min(1),
        scope: memoryScopeSchema.optional(),
        channelId: z.string().min(1).optional(),
      },
    },
    ({ key, scope, channelId }) => {
      try {
        return toolSuccess(
          workspace.getMemory({
            agentId: config.agentId,
            sessionId: config.sessionId,
            key,
            scope,
            channelId: channelId ?? config.defaultChannel ?? undefined,
          }),
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'macp_ext_search_memory',
    {
      description: 'Search visible workspace memories by key or value substring.',
      inputSchema: {
        query: z.string().min(1),
        scope: memoryScopeSchema.optional(),
        channelId: z.string().min(1).optional(),
        tags: z.array(z.string()).optional(),
        limit: z.number().int().positive().optional(),
      },
    },
    ({ query, scope, channelId, tags, limit }) => {
      try {
        return toolSuccess(
          workspace.searchMemory({
            agentId: config.agentId,
            sessionId: config.sessionId,
            query,
            scope,
            channelId: channelId ?? config.defaultChannel ?? undefined,
            tags,
            limit,
          }),
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'macp_ext_list_memories',
    {
      description: 'List visible workspace memories, optionally filtered by scope or tags.',
      inputSchema: {
        scope: memoryScopeSchema.optional(),
        channelId: z.string().min(1).optional(),
        tags: z.array(z.string()).optional(),
        limit: z.number().int().positive().optional(),
      },
    },
    ({ scope, channelId, tags, limit }) => {
      try {
        return toolSuccess(
          workspace.listMemories({
            agentId: config.agentId,
            sessionId: config.sessionId,
            scope,
            channelId: channelId ?? config.defaultChannel ?? undefined,
            tags,
            limit,
          }),
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'macp_ext_delete_memory',
    {
      description: 'Archive active memories for a key within one explicit scope.',
      inputSchema: {
        key: z.string().min(1),
        scope: memoryScopeSchema,
        channelId: z.string().min(1).optional(),
      },
    },
    ({ key, scope, channelId }) => {
      try {
        return toolSuccess(
          workspace.deleteMemory({
            agentId: config.agentId,
            sessionId: config.sessionId,
            key,
            scope,
            channelId: channelId ?? config.defaultChannel ?? undefined,
          }),
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'macp_ext_resolve_memory',
    {
      description: 'Resolve conflicting memories for a key by archiving existing values and writing a chosen replacement.',
      inputSchema: {
        key: z.string().min(1),
        scope: memoryScopeSchema,
        chosenValue: z.string().min(1),
        channelId: z.string().min(1).optional(),
        tags: z.array(z.string()).optional(),
        confidence: memoryConfidenceSchema.optional(),
        layer: memoryLayerSchema.optional(),
      },
    },
    ({ key, scope, chosenValue, channelId, tags, confidence, layer }) => {
      try {
        return toolSuccess(
          workspace.resolveMemory({
            agentId: config.agentId,
            sessionId: config.sessionId,
            key,
            scope,
            chosenValue,
            channelId: channelId ?? config.defaultChannel ?? undefined,
            tags,
            confidence,
            layer,
          }),
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'macp_ext_register_profile',
    {
      description: 'Create or update a reusable profile for task routing and context presets.',
      inputSchema: {
        slug: z.string().min(1),
        name: z.string().min(1),
        role: z.string().min(1),
        contextPack: z.string().optional(),
        skills: z.array(
          z.object({
            id: z.string().min(1),
            name: z.string().min(1),
            tags: z.array(z.string()).optional(),
          }),
        ).optional(),
        memoryKeys: z.array(z.string()).optional(),
        vaultPaths: z.array(z.string()).optional(),
      },
    },
    ({ slug, name, role, contextPack, skills, memoryKeys, vaultPaths }) => {
      try {
        return toolSuccess(
          advanced.registerProfile({
            agentId: config.agentId,
            sessionId: config.sessionId,
            slug,
            name,
            role,
            contextPack,
            skills,
            memoryKeys,
            vaultPaths,
          }),
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'macp_ext_get_profile',
    {
      description: 'Read one profile by slug.',
      inputSchema: {
        slug: z.string().min(1),
      },
    },
    ({ slug }) => {
      try {
        return toolSuccess(
          advanced.getProfile({
            agentId: config.agentId,
            sessionId: config.sessionId,
            slug,
          }),
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'macp_ext_list_profiles',
    {
      description: 'List all registered profiles.',
      inputSchema: {},
    },
    () => {
      try {
        return toolSuccess(
          advanced.listProfiles({
            agentId: config.agentId,
            sessionId: config.sessionId,
          }),
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'macp_ext_find_profiles',
    {
      description: 'Find profiles by skill tag.',
      inputSchema: {
        skillTag: z.string().min(1),
      },
    },
    ({ skillTag }) => {
      try {
        return toolSuccess(
          advanced.findProfiles({
            agentId: config.agentId,
            sessionId: config.sessionId,
            skillTag,
          }),
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'macp_ext_create_goal',
    {
      description: 'Create a goal in the extension goal hierarchy.',
      inputSchema: {
        type: goalTypeSchema,
        title: z.string().min(1),
        description: z.string().optional(),
        parentGoalId: z.string().uuid().optional(),
        ownerAgentId: z.string().min(1).optional(),
      },
    },
    ({ type, title, description, parentGoalId, ownerAgentId }) => {
      try {
        return toolSuccess(
          advanced.createGoal({
            agentId: config.agentId,
            sessionId: config.sessionId,
            type,
            title,
            description,
            parentGoalId,
            ownerAgentId,
          }),
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'macp_ext_list_goals',
    {
      description: 'List goals with optional filtering.',
      inputSchema: {
        type: goalTypeSchema.optional(),
        status: goalStatusSchema.optional(),
        ownerAgentId: z.string().min(1).optional(),
      },
    },
    ({ type, status, ownerAgentId }) => {
      try {
        return toolSuccess(
          advanced.listGoals({
            agentId: config.agentId,
            sessionId: config.sessionId,
            type,
            status,
            ownerAgentId,
          }),
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'macp_ext_get_goal',
    {
      description: 'Get one goal with ancestry and direct children.',
      inputSchema: {
        goalId: z.string().uuid(),
      },
    },
    ({ goalId }) => {
      try {
        return toolSuccess(
          advanced.getGoal({
            agentId: config.agentId,
            sessionId: config.sessionId,
            goalId,
          }),
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'macp_ext_update_goal',
    {
      description: 'Update a goal title, description, or status.',
      inputSchema: {
        goalId: z.string().uuid(),
        title: z.string().min(1).optional(),
        description: z.string().optional(),
        status: goalStatusSchema.optional(),
      },
    },
    ({ goalId, title, description, status }) => {
      try {
        return toolSuccess(
          advanced.updateGoal({
            agentId: config.agentId,
            sessionId: config.sessionId,
            goalId,
            title,
            description,
            status,
          }),
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'macp_ext_get_goal_cascade',
    {
      description: 'Return either the whole goal forest or a single goal subtree.',
      inputSchema: {
        goalId: z.string().uuid().optional(),
      },
    },
    ({ goalId }) => {
      try {
        return toolSuccess(
          advanced.getGoalCascade({
            agentId: config.agentId,
            sessionId: config.sessionId,
            goalId,
          }),
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'macp_ext_dispatch_task',
    {
      description: 'Create a task for an optional profile and goal.',
      inputSchema: {
        title: z.string().min(1),
        description: z.string().optional(),
        profileSlug: z.string().min(1).optional(),
        priority: taskPrioritySchema.optional(),
        goalId: z.string().uuid().optional(),
        parentTaskId: z.string().uuid().optional(),
      },
    },
    ({ title, description, profileSlug, priority, goalId, parentTaskId }) => {
      try {
        return toolSuccess(
          advanced.dispatchTask({
            agentId: config.agentId,
            sessionId: config.sessionId,
            title,
            description,
            profileSlug,
            priority,
            goalId,
            parentTaskId,
          }),
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'macp_ext_claim_task',
    {
      description: 'Claim a pending task.',
      inputSchema: {
        taskId: z.string().uuid(),
      },
    },
    ({ taskId }) => {
      try {
        return toolSuccess(
          advanced.claimTask({
            agentId: config.agentId,
            sessionId: config.sessionId,
            taskId,
          }),
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'macp_ext_start_task',
    {
      description: 'Transition a task to in-progress.',
      inputSchema: {
        taskId: z.string().uuid(),
      },
    },
    ({ taskId }) => {
      try {
        return toolSuccess(
          advanced.startTask({
            agentId: config.agentId,
            sessionId: config.sessionId,
            taskId,
          }),
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'macp_ext_complete_task',
    {
      description: 'Complete a task with an optional result summary.',
      inputSchema: {
        taskId: z.string().uuid(),
        result: z.string().optional(),
      },
    },
    ({ taskId, result }) => {
      try {
        return toolSuccess(
          advanced.completeTask({
            agentId: config.agentId,
            sessionId: config.sessionId,
            taskId,
            result,
          }),
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'macp_ext_block_task',
    {
      description: 'Block a task with a reason.',
      inputSchema: {
        taskId: z.string().uuid(),
        reason: z.string().optional(),
      },
    },
    ({ taskId, reason }) => {
      try {
        return toolSuccess(
          advanced.blockTask({
            agentId: config.agentId,
            sessionId: config.sessionId,
            taskId,
            reason,
          }),
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'macp_ext_cancel_task',
    {
      description: 'Cancel a task with a reason.',
      inputSchema: {
        taskId: z.string().uuid(),
        reason: z.string().optional(),
      },
    },
    ({ taskId, reason }) => {
      try {
        return toolSuccess(
          advanced.cancelTask({
            agentId: config.agentId,
            sessionId: config.sessionId,
            taskId,
            reason,
          }),
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'macp_ext_get_task',
    {
      description: 'Get one task with optional subtasks and linked goal ancestry.',
      inputSchema: {
        taskId: z.string().uuid(),
        includeSubtasks: z.boolean().optional(),
      },
    },
    ({ taskId, includeSubtasks }) => {
      try {
        return toolSuccess(
          advanced.getTask({
            agentId: config.agentId,
            sessionId: config.sessionId,
            taskId,
            includeSubtasks,
          }),
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'macp_ext_list_tasks',
    {
      description: 'List tasks with optional filters.',
      inputSchema: {
        status: z.enum(['pending', 'accepted', 'in-progress', 'done', 'blocked', 'cancelled']).optional(),
        profileSlug: z.string().min(1).optional(),
        priority: taskPrioritySchema.optional(),
        goalId: z.string().uuid().optional(),
        assignedAgentId: z.string().min(1).optional(),
        limit: z.number().int().positive().optional(),
      },
    },
    ({ status, profileSlug, priority, goalId, assignedAgentId, limit }) => {
      try {
        return toolSuccess(
          advanced.listTasks({
            agentId: config.agentId,
            sessionId: config.sessionId,
            status,
            profileSlug,
            priority,
            goalId,
            assignedAgentId,
            limit,
          }),
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'macp_ext_archive_tasks',
    {
      description: 'Archive completed or cancelled tasks.',
      inputSchema: {
        status: z.enum(['done', 'cancelled']).optional(),
        goalId: z.string().uuid().optional(),
      },
    },
    ({ status, goalId }) => {
      try {
        return toolSuccess(
          advanced.archiveTasks({
            agentId: config.agentId,
            sessionId: config.sessionId,
            status,
            goalId,
          }),
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'macp_ext_sleep_agent',
    {
      description: 'Mark the current agent as sleeping while leaving the session active.',
      inputSchema: {
        reason: z.string().optional(),
      },
    },
    ({ reason }) => {
      try {
        return toolSuccess(
          advanced.sleepAgent({
            agentId: config.agentId,
            sessionId: config.sessionId,
            reason,
          }),
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'macp_ext_deactivate_agent',
    {
      description: 'Deactivate the current agent: release claims, remove channel membership, and deregister the current session.',
      inputSchema: {
        reason: z.string().optional(),
      },
    },
    ({ reason }) => {
      try {
        return toolSuccess(
          advanced.deactivateAgent({
            agentId: config.agentId,
            sessionId: config.sessionId,
            reason,
          }),
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'macp_ext_delete_agent',
    {
      description: 'Soft-delete the current agent from the active workspace state.',
      inputSchema: {
        reason: z.string().optional(),
      },
    },
    ({ reason }) => {
      try {
        return toolSuccess(
          advanced.deleteAgent({
            agentId: config.agentId,
            sessionId: config.sessionId,
            reason,
          }),
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'macp_ext_register_vault',
    {
      description: 'Index a filesystem folder of text documents into the shared SQLite vault.',
      inputSchema: {
        path: z.string().min(1),
      },
    },
    ({ path }) => {
      try {
        return toolSuccess(
          advanced.registerVault({
            agentId: config.agentId,
            sessionId: config.sessionId,
            path,
          }),
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'macp_ext_search_vault',
    {
      description: 'Search indexed vault docs by substring match.',
      inputSchema: {
        query: z.string().min(1),
        tags: z.array(z.string()).optional(),
        limit: z.number().int().positive().optional(),
      },
    },
    ({ query, tags, limit }) => {
      try {
        return toolSuccess(
          advanced.searchVault({
            agentId: config.agentId,
            sessionId: config.sessionId,
            query,
            tags,
            limit,
          }),
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'macp_ext_get_vault_doc',
    {
      description: 'Read one indexed vault doc by its relative path.',
      inputSchema: {
        path: z.string().min(1),
      },
    },
    ({ path }) => {
      try {
        return toolSuccess(
          advanced.getVaultDoc({
            agentId: config.agentId,
            sessionId: config.sessionId,
            path,
          }),
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'macp_ext_list_vault_docs',
    {
      description: 'List indexed vault docs.',
      inputSchema: {
        tags: z.array(z.string()).optional(),
        limit: z.number().int().positive().optional(),
      },
    },
    ({ tags, limit }) => {
      try {
        return toolSuccess(
          advanced.listVaultDocs({
            agentId: config.agentId,
            sessionId: config.sessionId,
            tags,
            limit,
          }),
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'macp_ext_query_context',
    {
      description: 'Search shared memory, indexed vault docs, completed tasks, and goals for relevant context.',
      inputSchema: {
        query: z.string().min(1),
        channelId: z.string().min(1).optional(),
        limit: z.number().int().positive().optional(),
      },
    },
    ({ query, channelId, limit }) => {
      try {
        return toolSuccess(
          advanced.queryContext({
            agentId: config.agentId,
            sessionId: config.sessionId,
            query,
            channelId: channelId ?? config.defaultChannel ?? undefined,
            limit,
          }),
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );

  return server;
}

export async function startMacpServer(config: ServerConfig): Promise<void> {
  mkdirSync(dirname(config.dbPath), { recursive: true });
  const runtime = createServerRuntime(config);
  bootstrapServerRuntime(runtime, config);
  registerProcessCleanup(runtime, config);
  const server = createMacpServer(config, runtime);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

export async function runServerCli(
  args: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const invocation = parseServerCliArgs(args, env);
  if (invocation.help) {
    printHelp();
    return;
  }

  await startMacpServer(invocation.config);
}

function isDirectExecution(): boolean {
  const argv1 = process.argv[1];
  if (argv1 === undefined) {
    return false;
  }

  return resolve(argv1) === fileURLToPath(import.meta.url);
}

if (isDirectExecution()) {
  runServerCli().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
