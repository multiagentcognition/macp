#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';

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

type ServerConfig = {
  dbPath: string;
  agentId: string;
  agentName: string;
  sessionId: string;
  defaultChannel: string;
  role: string;
  interestTags: string[];
  maxPendingMessages: number;
  maxContextBytes: number;
};

function printHelp(): void {
  console.log(`MACP MCP server

Required:
  MACP_DB_PATH              Shared SQLite file path

Optional:
  MACP_AGENT_ID             Stable agent identifier (default: random UUID)
  MACP_AGENT_NAME           Human-readable name (default: MACP_AGENT_ID)
  MACP_SESSION_ID           Session identifier (default: random UUID)
  MACP_DEFAULT_CHANNEL      Default working channel for join/send tools
  MACP_AGENT_ROLE           Agent role label (default: participant)
  MACP_INTEREST_TAGS        JSON array or comma-separated interest tags
  MACP_MAX_PENDING_MESSAGES Queue limit advertised at registration (default: 200)
  MACP_MAX_CONTEXT_BYTES    Poll byte budget advertised at registration (default: 16384)
  MACP_SCHEMA_PATH          Optional override path to macp.schema.json
`);
}

function envNumber(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') {
    return defaultValue;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be numeric.`);
  }

  return parsed;
}

function envTags(name: string): string[] {
  const raw = process.env[name];
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

function parseConfig(): ServerConfig {
  const parsed = parseArgs({
    args: process.argv.slice(2),
    options: {
      help: {
        type: 'boolean',
        short: 'h',
      },
    },
    allowPositionals: false,
  });

  if (parsed.values.help) {
    printHelp();
    process.exit(0);
  }

  const dbPath = process.env.MACP_DB_PATH;
  if (!dbPath) {
    throw new Error('MACP_DB_PATH is required.');
  }

  const agentId = process.env.MACP_AGENT_ID ?? randomUUID();
  const sessionId = process.env.MACP_SESSION_ID ?? randomUUID();

  return {
    dbPath,
    agentId,
    agentName: process.env.MACP_AGENT_NAME ?? agentId,
    sessionId,
    defaultChannel: process.env.MACP_DEFAULT_CHANNEL ?? '',
    role: process.env.MACP_AGENT_ROLE ?? 'participant',
    interestTags: envTags('MACP_INTEREST_TAGS'),
    maxPendingMessages: envNumber('MACP_MAX_PENDING_MESSAGES', 200),
    maxContextBytes: envNumber('MACP_MAX_CONTEXT_BYTES', 16384),
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
  const defaultChannel = config.defaultChannel || '(set MACP_DEFAULT_CHANNEL or pass channelId explicitly)';
  const tags = config.interestTags.length > 0 ? config.interestTags.join(', ') : '(none)';

  return `You are operating through the MACP MCP tool surface.

Identity:
- agent_id: ${config.agentId}
- agent_name: ${config.agentName}
- session_id: ${config.sessionId}
- default_channel: ${defaultChannel}
- role: ${config.role}
- interest_tags: ${tags}

Rules:
1. Use the MACP MCP tools only.
2. Do not open the SQLite file directly.
3. Do not execute SQL or apply schema DDL yourself.
4. Handle deliveries idempotently because poll may return the same delivery more than once.

Tool workflow:
1. Call macp_register once on startup.
2. Call macp_join_channel for your working channel.
3. During your loop, call macp_poll.
4. After you act on a delivery, call macp_ack with its deliveryId.
5. Use macp_send_channel for shared channel updates.
6. Use macp_send_direct for one-to-one messages.
7. Call macp_deregister on shutdown.

Priority guide:
- info: background context
- advisory: useful findings worth considering
- steering: findings that should change what peers do next
- interrupt: urgent findings that should be handled on the next poll

The MCP server already applies the MACP schema and SQLite protocol rules for you.`;
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

export function createMacpServer(config: ServerConfig): McpServer {
  const core = new MacpCore({
    dbPath: config.dbPath,
  });
  const server = new McpServer({
    name: 'macp-mcp-server',
    version: '1.0.0-draft',
  });

  const prioritySchema = z.union([
    z.literal(0),
    z.literal(1),
    z.literal(2),
    z.literal(3),
    z.enum(['info', 'advisory', 'steering', 'interrupt']),
  ]);

  const ackLevelSchema = z.enum(['queued', 'received', 'processed']);

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
      description: 'Register this agent session on the MACP bus.',
      inputSchema: {
        interestTags: z.array(z.string()).optional(),
        maxPendingMessages: z.number().int().positive().optional(),
        maxContextBytes: z.number().int().positive().optional(),
      },
    },
    ({ interestTags, maxPendingMessages, maxContextBytes }) => {
      try {
        return toolSuccess(
          core.registerAgent({
            agentId: config.agentId,
            sessionId: config.sessionId,
            name: config.agentName,
            capabilities: {
              injection_tiers: ['tier1_polling'],
              ack_levels: ['received', 'queued', 'processed'],
              max_context_bytes: maxContextBytes ?? config.maxContextBytes,
            },
            interestTags: interestTags ?? config.interestTags,
            queuePreferences: {
              max_pending_messages: maxPendingMessages ?? config.maxPendingMessages,
            },
          }),
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'macp_join_channel',
    {
      description: 'Join the working MACP channel for this agent.',
      inputSchema: {
        channelId: z.string().min(1).optional(),
      },
    },
    ({ channelId }) => {
      try {
        const resolvedChannelId = channelId ?? config.defaultChannel;
        if (!resolvedChannelId) {
          throw new Error('channelId is required when MACP_DEFAULT_CHANNEL is not configured.');
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
          throw new Error('channelId is required when MACP_DEFAULT_CHANNEL is not configured.');
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

  return server;
}

async function main(): Promise<void> {
  const config = parseConfig();
  const server = createMacpServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
