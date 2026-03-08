import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue } from 'node:sqlite';

import {
  getAgentPromptTemplate,
  getConnectionPragmas,
  getDefaultBudgetBytes,
  getOperationSql,
  getSchemaDdl,
} from './schema.js';

export type Priority = 0 | 1 | 2 | 3;
export type PriorityAlias = 'info' | 'advisory' | 'steering' | 'interrupt';
export type AckLevel = 'queued' | 'received' | 'processed';
export type DestinationType = 'channel' | 'agent';

export interface SenderInfo {
  agentId: string;
  sessionId: string;
  name: string;
}

export interface MessageContext {
  relevanceTags: string[];
  confidence: number;
  sourceReferences: string[];
  payloadByteSize: number;
}

export interface AckRequest {
  requestLevel: AckLevel;
}

export interface Delivery {
  deliveryId: string;
  messageId: string;
  channelId: string | null;
  from: SenderInfo;
  destinationType: DestinationType;
  to: string;
  contentType: 'text/plain' | 'application/json';
  priority: Priority;
  type: string;
  content: string;
  sequenceNumber: number;
  context: MessageContext;
  ack: AckRequest;
  timestamp: string;
  ttlSeconds: number;
  state: string;
  destinationAgentId: string;
}

export interface RegisterAgentInput {
  agentId: string;
  sessionId: string;
  name: string;
  capabilities: Record<string, unknown>;
  interestTags: string[];
  queuePreferences: { max_pending_messages: number } | { maxPendingMessages: number };
  now?: string | undefined;
}

export interface JoinChannelInput {
  agentId: string;
  sessionId: string;
  channelId: string;
  now?: string | undefined;
}

interface BaseSendInput {
  from: SenderInfo;
  content: string;
  contentType?: 'text/plain' | 'application/json' | undefined;
  priority?: Priority | PriorityAlias | undefined;
  type?: string | undefined;
  context?: Partial<MessageContext> | undefined;
  ack?: Partial<AckRequest> | undefined;
  ttlSeconds?: number | undefined;
  now?: string | undefined;
  messageId?: string | undefined;
}

export interface SendChannelInput extends BaseSendInput {
  channelId: string;
}

export interface SendDirectInput extends BaseSendInput {
  destinationAgentId: string;
}

export interface SendResult {
  messageId: string;
  deliveryIds: string[];
  recipientAgentIds: string[];
}

export interface PollInput {
  agentId: string;
  minPriority?: Priority | undefined;
  maxMessages?: number | undefined;
  applyBudgetPruning?: boolean | undefined;
  budgetBytes?: number | undefined;
  now?: string | undefined;
}

export interface PollResult {
  deliveries: Delivery[];
  expiredDeliveryIds: string[];
  prunedDeliveryIds: string[];
}

export interface AckInput {
  deliveryId: string;
  now?: string | undefined;
}

export interface DeregisterInput {
  agentId: string;
  sessionId: string;
  now?: string | undefined;
}

export interface AgentInstructionContext {
  dbPath: string;
  agentId: string;
  agentName: string;
  channelId: string;
  role: string;
  interestTags: string[];
}

type SessionRow = {
  capabilities_json: string;
  interest_tags_json: string;
  queue_preferences_json: string;
};

type DeliveryRow = {
  delivery_id: string;
  message_id: string;
  channel_id: string | null;
  from_json: string;
  destination_type: DestinationType;
  to: string;
  content_type: 'text/plain' | 'application/json';
  priority: number;
  type: string;
  content: string;
  sequence_number: number;
  context_json: string;
  ack_json: string;
  timestamp: string;
  ttl_seconds: number;
  state: string;
  destination_agent_id: string;
};

type DeliveryStateRow = {
  state: string;
};

type ExpiredRow = {
  message_id: string;
  delivery_id: string;
  destination_agent_id: string;
  channel_id: string | null;
};

type DropCandidate = {
  delivery_id: string;
  priority: number;
};

type SqlBind = Record<string, SQLInputValue>;

type StatementResult = {
  changes: number;
  lastInsertRowid: number | bigint;
};

interface MacpCoreOptions {
  dbPath: string;
  now?: () => string;
}

export class MacpProtocolError extends Error {
  readonly reasonCode: string;
  readonly metadata: Record<string, unknown>;

  constructor(reasonCode: string, message: string, metadata: Record<string, unknown> = {}) {
    super(message);
    this.name = 'MacpProtocolError';
    this.reasonCode = reasonCode;
    this.metadata = metadata;
  }
}

export class MacpCore {
  readonly dbPath: string;
  private readonly db: DatabaseSync;
  private readonly nowProvider: () => string;

  constructor(options: MacpCoreOptions) {
    this.dbPath = options.dbPath;
    this.db = new DatabaseSync(options.dbPath);
    this.nowProvider = options.now ?? (() => new Date().toISOString());

    this.applyConnectionContract();
  }

  close(): void {
    this.db.close();
  }

  registerAgent(input: RegisterAgentInput): { agentId: string; sessionId: string } {
    const now = input.now ?? this.nowProvider();
    const queuePreferences = 'maxPendingMessages' in input.queuePreferences
      ? { max_pending_messages: input.queuePreferences.maxPendingMessages }
      : input.queuePreferences;

    this.run('register', 'step_1_upsert_agent', {
      agent_id: input.agentId,
      name: input.name,
      now,
    });
    this.run('register', 'step_2_cleanup_memberships', {
      agent_id: input.agentId,
    });
    this.run('register', 'step_3_upsert_session', {
      session_id: input.sessionId,
      agent_id: input.agentId,
      capabilities_json: JSON.stringify(input.capabilities),
      interest_tags_json: JSON.stringify(input.interestTags),
      queue_preferences_json: JSON.stringify(queuePreferences),
      now,
    });
    this.run('register', 'step_4_audit', {
      agent_id: input.agentId,
      now,
    });

    return {
      agentId: input.agentId,
      sessionId: input.sessionId,
    };
  }

  joinChannel(input: JoinChannelInput): { channelId: string; peerAgentIds: string[] } {
    const now = input.now ?? this.nowProvider();

    const sessionExists = this.get<{ '1': number }>('join', 'step_0_validate_session', {
      agent_id: input.agentId,
      session_id: input.sessionId,
    });

    if (sessionExists === undefined) {
      throw new MacpProtocolError(
        'MACP_ERR_SESSION_UNKNOWN',
        `Session ${input.sessionId} is not active for agent ${input.agentId}.`,
        {
          agentId: input.agentId,
          sessionId: input.sessionId,
        },
      );
    }

    this.run('join', 'step_1_create_channel', {
      channel_id: input.channelId,
      now,
    });
    this.run('join', 'step_2_add_member', {
      channel_id: input.channelId,
      agent_id: input.agentId,
      session_id: input.sessionId,
      now,
    });

    const peers = this.all<{ agent_id: string }>('join', 'step_3_discover_peers', {
      channel_id: input.channelId,
      agent_id: input.agentId,
    }).map((row) => row.agent_id);

    this.run('join', 'step_4_audit', {
      agent_id: input.agentId,
      channel_id: input.channelId,
      now,
    });

    return {
      channelId: input.channelId,
      peerAgentIds: peers,
    };
  }

  sendChannel(input: SendChannelInput): SendResult {
    const normalized = this.normalizeSendInput(input);
    this.beginSend();

    try {
      this.assertSenderActive(input.from);

      const channelExists = this.get<{ '1': number }>('send', 'step_1_validate_channel', {
        channel_id: input.channelId,
      });

      if (channelExists === undefined) {
        throw new MacpProtocolError(
          'MACP_ERR_CHANNEL_NOT_FOUND',
          `Channel ${input.channelId} is not active.`,
          { channelId: input.channelId },
        );
      }

      const senderMembership = this.get<{ '1': number }>('send', 'step_1b_validate_sender_membership', {
        channel_id: input.channelId,
        sender_agent_id: input.from.agentId,
        sender_session_id: input.from.sessionId,
      });

      if (senderMembership === undefined) {
        throw new MacpProtocolError(
          'MACP_ERR_SENDER_NOT_MEMBER',
          `Sender ${input.from.agentId} is not an active member of channel ${input.channelId}.`,
          {
            agentId: input.from.agentId,
            sessionId: input.from.sessionId,
            channelId: input.channelId,
          },
        );
      }

      const recipientRows = this.all<{ agent_id: string }>('send', 'step_3_get_broadcast_recipients', {
        channel_id: input.channelId,
        sender_agent_id: input.from.agentId,
      });
      const recipientAgentIds = recipientRows.map((row) => row.agent_id);
      const deliveryIds: string[] = [];

      for (const recipientAgentId of recipientAgentIds) {
        deliveryIds.push(this.queueDelivery({
          ...normalized,
          destinationType: 'channel',
          channelId: input.channelId,
          destinationAgentId: recipientAgentId,
          to: input.channelId,
        }));
      }

      this.commitSend();

      return {
        messageId: normalized.messageId,
        deliveryIds,
        recipientAgentIds,
      };
    } catch (error) {
      this.rollbackSend();
      throw error;
    }
  }

  sendDirect(input: SendDirectInput): SendResult {
    const normalized = this.normalizeSendInput(input);
    this.beginSend();

    try {
      this.assertSenderActive(input.from);

      const recipientExists = this.get<{ '1': number }>('send', 'step_2_validate_direct_recipient', {
        dest_agent_id: input.destinationAgentId,
      });

      if (recipientExists === undefined) {
        throw new MacpProtocolError(
          'MACP_ERR_DESTINATION_UNKNOWN',
          `Destination ${input.destinationAgentId} is not active.`,
          { destinationAgentId: input.destinationAgentId },
        );
      }

      const deliveryId = this.queueDelivery({
        ...normalized,
        destinationType: 'agent',
        channelId: null,
        destinationAgentId: input.destinationAgentId,
        to: input.destinationAgentId,
      });

      this.commitSend();

      return {
        messageId: normalized.messageId,
        deliveryIds: [deliveryId],
        recipientAgentIds: [input.destinationAgentId],
      };
    } catch (error) {
      this.rollbackSend();
      throw error;
    }
  }

  poll(input: PollInput): PollResult {
    const now = input.now ?? this.nowProvider();
    const minPriority = input.minPriority ?? 0;
    const maxMessages = input.maxMessages ?? 10;

    const expiredRows = this.all<ExpiredRow>('poll', 'step_0_expire_pending', {
      my_agent_id: input.agentId,
      now,
    });

    for (const row of expiredRows) {
      this.run('poll', 'step_0b_audit_expired_row', {
        message_id: row.message_id,
        delivery_id: row.delivery_id,
        agent_id: row.destination_agent_id,
        channel_id: row.channel_id,
        now,
      });
    }

    const pendingRows = this.all<DeliveryRow>('poll', 'step_1_select', {
      my_agent_id: input.agentId,
      min_priority: minPriority,
      max_messages: maxMessages,
      now,
    });

    const pruning = this.applyBudgetPruning(
      input.agentId,
      pendingRows,
      input.applyBudgetPruning ?? true,
      input.budgetBytes,
      now,
    );

    for (const delivery of pruning.deliveries) {
      this.run('poll', 'step_3_mark_surfaced', {
        delivery_id: delivery.deliveryId,
      });
      this.run('poll', 'step_4_record_received_ack', {
        delivery_id: delivery.deliveryId,
        now,
      });
    }

    return {
      deliveries: pruning.deliveries,
      expiredDeliveryIds: expiredRows.map((row) => row.delivery_id),
      prunedDeliveryIds: pruning.prunedDeliveryIds,
    };
  }

  ack(input: AckInput): { deliveryId: string; state: 'acknowledged' } {
    const now = input.now ?? this.nowProvider();

    const existing = this.get<DeliveryStateRow>('ack', 'step_0_get_delivery_state', {
      delivery_id: input.deliveryId,
    });

    if (existing === undefined) {
      throw new MacpProtocolError(
        'MACP_ERR_DELIVERY_NOT_FOUND',
        `Delivery ${input.deliveryId} does not exist.`,
        {
          deliveryId: input.deliveryId,
        },
      );
    }

    if (existing.state === 'acknowledged') {
      return {
        deliveryId: input.deliveryId,
        state: 'acknowledged',
      };
    }

    if (existing.state === 'expired' || existing.state === 'dropped') {
      throw new MacpProtocolError(
        'MACP_ERR_DELIVERY_NOT_ACKABLE',
        `Delivery ${input.deliveryId} is in terminal state ${existing.state}.`,
        {
          deliveryId: input.deliveryId,
          state: existing.state,
        },
      );
    }

    this.run('ack', 'step_1_record_processed_ack', {
      delivery_id: input.deliveryId,
      now,
    });
    const updateState = this.run('ack', 'step_2_update_state', {
      delivery_id: input.deliveryId,
    });

    if (updateState.changes === 0) {
      const current = this.get<DeliveryStateRow>('ack', 'step_0_get_delivery_state', {
        delivery_id: input.deliveryId,
      });

      if (current?.state === 'acknowledged') {
        return {
          deliveryId: input.deliveryId,
          state: 'acknowledged',
        };
      }

      throw new MacpProtocolError(
        'MACP_ERR_DELIVERY_NOT_ACKABLE',
        `Delivery ${input.deliveryId} could not transition to acknowledged.`,
        {
          deliveryId: input.deliveryId,
          state: current?.state ?? 'unknown',
        },
      );
    }

    this.run('ack', 'step_3_audit', {
      delivery_id: input.deliveryId,
      now,
    });

    return {
      deliveryId: input.deliveryId,
      state: 'acknowledged',
    };
  }

  deregister(input: DeregisterInput): { agentId: string; sessionId: string } {
    const now = input.now ?? this.nowProvider();

    this.run('deregister', 'step_1_remove_memberships', {
      agent_id: input.agentId,
    });
    this.run('deregister', 'step_2_mark_session', {
      session_id: input.sessionId,
    });
    this.run('deregister', 'step_3_audit', {
      agent_id: input.agentId,
      now,
    });

    return {
      agentId: input.agentId,
      sessionId: input.sessionId,
    };
  }

  renderAgentInstructions(context: AgentInstructionContext): string {
    return getAgentPromptTemplate()
      .replaceAll('{DB_PATH}', this.dbPath)
      .replaceAll('{AGENT_ID}', context.agentId)
      .replaceAll('{AGENT_NAME}', context.agentName)
      .replaceAll('{CHANNEL_ID}', context.channelId)
      .replaceAll('{ROLE}', context.role)
      .replaceAll('{TAGS}', JSON.stringify(context.interestTags));
  }

  private applyConnectionContract(): void {
    const pragmas = getConnectionPragmas();
    this.db.exec(`PRAGMA journal_mode=${pragmas.journalMode}`);
    this.db.exec(`PRAGMA busy_timeout=${pragmas.busyTimeout}`);
    this.db.exec(`PRAGMA foreign_keys=${pragmas.foreignKeys ? 'ON' : 'OFF'}`);
    this.db.exec(getSchemaDdl());
  }

  private assertSenderActive(sender: SenderInfo): void {
    const senderExists = this.get<{ '1': number }>('send', 'step_1a_validate_sender_active', {
      sender_agent_id: sender.agentId,
      sender_session_id: sender.sessionId,
    });

    if (senderExists === undefined) {
      throw new MacpProtocolError(
        'MACP_ERR_SENDER_NOT_ACTIVE',
        `Sender ${sender.agentId} is not active for session ${sender.sessionId}.`,
        {
          agentId: sender.agentId,
          sessionId: sender.sessionId,
        },
      );
    }
  }

  private normalizeSendInput(input: BaseSendInput): {
    messageId: string;
    fromJson: string;
    contentType: 'text/plain' | 'application/json';
    priority: Priority;
    type: string;
    content: string;
    contextJson: string;
    ackJson: string;
    ttlSeconds: number;
    now: string;
  } {
    const now = input.now ?? this.nowProvider();
    const contentType = input.contentType ?? 'text/plain';
    const priority = this.normalizePriority(input.priority ?? 'advisory');
    const type = input.type ?? 'discovery';
    const ttlSeconds = input.ttlSeconds ?? 3600;

    const context: MessageContext = {
      relevanceTags: input.context?.relevanceTags ?? [],
      confidence: input.context?.confidence ?? 1.0,
      sourceReferences: input.context?.sourceReferences ?? [],
      payloadByteSize: input.context?.payloadByteSize ?? Buffer.byteLength(input.content, 'utf8'),
    };

    const ack: AckRequest = {
      requestLevel: input.ack?.requestLevel ?? 'received',
    };

    return {
      messageId: input.messageId ?? randomUUID(),
      fromJson: JSON.stringify({
        agent_id: input.from.agentId,
        session_id: input.from.sessionId,
        name: input.from.name,
      }),
      contentType,
      priority,
      type,
      content: input.content,
      contextJson: JSON.stringify({
        relevance_tags: context.relevanceTags,
        confidence: context.confidence,
        source_references: context.sourceReferences,
        payload_byte_size: context.payloadByteSize,
      }),
      ackJson: JSON.stringify({
        request_level: ack.requestLevel,
      }),
      ttlSeconds,
      now,
    };
  }

  private queueDelivery(input: {
    messageId: string;
    fromJson: string;
    destinationType: DestinationType;
    channelId: string | null;
    to: string;
    contentType: 'text/plain' | 'application/json';
    priority: Priority;
    type: string;
    content: string;
    contextJson: string;
    ackJson: string;
    ttlSeconds: number;
    now: string;
    destinationAgentId: string;
  }): string {
    const queueLimit = this.get<{ max_pending_messages: number }>('send', 'step_4_read_queue_limit', {
      dest_agent_id: input.destinationAgentId,
    });

    if (queueLimit === undefined) {
      throw new MacpProtocolError(
        'MACP_ERR_DESTINATION_UNKNOWN',
        `Destination ${input.destinationAgentId} is not active.`,
        { destinationAgentId: input.destinationAgentId },
      );
    }

    const pendingCountRow = this.get<{ pending_count: number }>('send', 'step_5_count_pending', {
      dest_agent_id: input.destinationAgentId,
      now: input.now,
    });
    const pendingCount = pendingCountRow?.pending_count ?? 0;

    if (pendingCount >= queueLimit.max_pending_messages) {
      const candidate = this.get<DropCandidate>('send', 'step_6_select_drop_candidate', {
        dest_agent_id: input.destinationAgentId,
        now: input.now,
      });

      if (candidate === undefined || candidate.priority > input.priority) {
        this.run('send', 'step_9_reject_incoming', {
          message_id: input.messageId,
          dest_agent_id: input.destinationAgentId,
          channel_id: input.channelId,
          now: input.now,
          metadata_json: JSON.stringify({
            incoming_priority: input.priority,
            destination_agent_id: input.destinationAgentId,
          }),
        });

        throw new MacpProtocolError(
          'MACP_ERR_QUEUE_FULL_REJECT_INCOMING',
          `Queue for ${input.destinationAgentId} is full of higher-priority work.`,
          { destinationAgentId: input.destinationAgentId },
        );
      }

      const dropResult = this.run('send', 'step_7_mark_dropped', {
        drop_delivery_id: candidate.delivery_id,
      });

      if (dropResult.changes === 0) {
        this.run('send', 'step_9_reject_incoming', {
          message_id: input.messageId,
          dest_agent_id: input.destinationAgentId,
          channel_id: input.channelId,
          now: input.now,
          metadata_json: JSON.stringify({
            incoming_priority: input.priority,
            destination_agent_id: input.destinationAgentId,
          }),
        });

        throw new MacpProtocolError(
          'MACP_ERR_QUEUE_FULL_REJECT_INCOMING',
          `Queue for ${input.destinationAgentId} changed before overflow handling completed.`,
          { destinationAgentId: input.destinationAgentId },
        );
      }

      this.run('send', 'step_8_audit_drop', {
        drop_delivery_id: candidate.delivery_id,
        now: input.now,
        metadata_json: JSON.stringify({
          replaced_by_message_id: input.messageId,
        }),
      });
    }

    const sequenceRow = this.get<{ allocated_sequence: number }>('send', 'step_10_allocate_sequence', {
      dest_agent_id: input.destinationAgentId,
    });

    if (sequenceRow === undefined) {
      throw new Error(`Failed to allocate sequence number for ${input.destinationAgentId}`);
    }

    const deliveryId = randomUUID();

    this.run('send', 'step_11_insert_delivery', {
      delivery_id: deliveryId,
      message_id: input.messageId,
      channel_id: input.channelId,
      from_json: input.fromJson,
      destination_type: input.destinationType,
      to: input.to,
      content_type: input.contentType,
      priority: input.priority,
      type: input.type,
      content: input.content,
      sequence_number: sequenceRow.allocated_sequence,
      context_json: input.contextJson,
      ack_json: input.ackJson,
      now: input.now,
      ttl: input.ttlSeconds,
      dest_agent_id: input.destinationAgentId,
    });
    this.run('send', 'step_12_record_queued_ack', {
      delivery_id: deliveryId,
      now: input.now,
    });
    this.run('send', 'step_13_audit_send', {
      message_id: input.messageId,
      delivery_id: deliveryId,
      dest_agent_id: input.destinationAgentId,
      channel_id: input.channelId,
      now: input.now,
    });

    return deliveryId;
  }

  private applyBudgetPruning(
    agentId: string,
    rows: DeliveryRow[],
    applyBudgetPruning: boolean,
    budgetBytesOverride: number | undefined,
    now: string,
  ): { deliveries: Delivery[]; prunedDeliveryIds: string[] } {
    const deliveries = rows.map((row) => this.parseDeliveryRow(row));

    if (!applyBudgetPruning || deliveries.length === 0) {
      return {
        deliveries,
        prunedDeliveryIds: [],
      };
    }

    const sessionRow = this.getSessionRow(agentId);
    const interestTags = sessionRow === undefined
      ? []
      : (JSON.parse(sessionRow.interest_tags_json) as string[]);
    const capabilities = sessionRow === undefined
      ? {}
      : (JSON.parse(sessionRow.capabilities_json) as { max_context_bytes?: number });
    const budgetBytes = budgetBytesOverride ?? capabilities.max_context_bytes ?? getDefaultBudgetBytes();

    const scored = deliveries.map((delivery) => ({
      delivery,
      utility: this.computeUtility(delivery, interestTags, now),
      cost: delivery.context.payloadByteSize,
    }));

    const interrupts = scored.filter((entry) => entry.delivery.priority === 3);
    const rest = scored
      .filter((entry) => entry.delivery.priority !== 3)
      .sort((left, right) => {
        if (right.utility !== left.utility) {
          return right.utility - left.utility;
        }
        if (right.delivery.priority !== left.delivery.priority) {
          return right.delivery.priority - left.delivery.priority;
        }
        return left.delivery.sequenceNumber - right.delivery.sequenceNumber;
      });

    const included: Delivery[] = [];
    const pruned: Delivery[] = [];
    let remainingBudget = budgetBytes;

    for (const entry of interrupts) {
      included.push(entry.delivery);
      remainingBudget -= entry.cost;
    }

    for (const entry of rest) {
      if (entry.cost <= remainingBudget) {
        included.push(entry.delivery);
        remainingBudget -= entry.cost;
      } else {
        pruned.push(entry.delivery);
      }
    }

    for (const delivery of pruned) {
      this.run('poll', 'step_2b_audit_budget_pruned', {
        delivery_id: delivery.deliveryId,
        now,
        metadata_json: JSON.stringify({
          budget_bytes: budgetBytes,
          payload_byte_size: delivery.context.payloadByteSize,
        }),
      });
    }

    return {
      deliveries: included,
      prunedDeliveryIds: pruned.map((delivery) => delivery.deliveryId),
    };
  }

  private computeUtility(delivery: Delivery, interestTags: string[], now: string): number {
    const priorityScore = delivery.priority / 3.0;
    const tagRelevance = this.jaccard(delivery.context.relevanceTags, interestTags);
    const elapsedSeconds = Math.max(
      0,
      (Date.parse(now) - Date.parse(delivery.timestamp)) / 1000,
    );
    const freshness = Math.max(0, 1 - elapsedSeconds / delivery.ttlSeconds);

    return 0.7 * priorityScore + 0.2 * tagRelevance + 0.1 * freshness;
  }

  private jaccard(left: string[], right: string[]): number {
    const leftSet = new Set(left);
    const rightSet = new Set(right);

    const union = new Set([...leftSet, ...rightSet]);
    if (union.size === 0) {
      return 1;
    }

    let intersectionSize = 0;
    for (const value of leftSet) {
      if (rightSet.has(value)) {
        intersectionSize += 1;
      }
    }

    return intersectionSize / union.size;
  }

  private parseDeliveryRow(row: DeliveryRow): Delivery {
    const sender = JSON.parse(row.from_json) as {
      agent_id: string;
      session_id: string;
      name: string;
    };
    const context = JSON.parse(row.context_json) as {
      relevance_tags: string[];
      confidence: number;
      source_references: string[];
      payload_byte_size: number;
    };
    const ack = JSON.parse(row.ack_json) as {
      request_level: AckLevel;
    };

    return {
      deliveryId: row.delivery_id,
      messageId: row.message_id,
      channelId: row.channel_id,
      from: {
        agentId: sender.agent_id,
        sessionId: sender.session_id,
        name: sender.name,
      },
      destinationType: row.destination_type,
      to: row.to,
      contentType: row.content_type,
      priority: this.normalizePriority(row.priority),
      type: row.type,
      content: row.content,
      sequenceNumber: row.sequence_number,
      context: {
        relevanceTags: context.relevance_tags,
        confidence: context.confidence,
        sourceReferences: context.source_references,
        payloadByteSize: context.payload_byte_size,
      },
      ack: {
        requestLevel: ack.request_level,
      },
      timestamp: row.timestamp,
      ttlSeconds: row.ttl_seconds,
      state: row.state,
      destinationAgentId: row.destination_agent_id,
    };
  }

  private normalizePriority(priority: Priority | PriorityAlias | number): Priority {
    if (priority === 0 || priority === 1 || priority === 2 || priority === 3) {
      return priority;
    }

    switch (priority) {
      case 'info':
        return 0;
      case 'advisory':
        return 1;
      case 'steering':
        return 2;
      case 'interrupt':
        return 3;
      default:
        throw new Error(`Unsupported priority value: ${String(priority)}`);
    }
  }

  private getSessionRow(agentId: string): SessionRow | undefined {
    return this.db
      .prepare(
        'SELECT capabilities_json, interest_tags_json, queue_preferences_json FROM sessions WHERE agent_id = :agent_id AND state = \'active\'',
      )
      .get({ agent_id: agentId }) as SessionRow | undefined;
  }

  private beginSend(): void {
    this.db.exec(getOperationSql('send', 'step_0_begin_immediate'));
  }

  private commitSend(): void {
    this.db.exec(getOperationSql('send', 'step_14_commit'));
  }

  private rollbackSend(): void {
    try {
      this.db.exec(getOperationSql('send', 'step_15_rollback'));
    } catch {
      // Ignore rollback errors if the transaction never began or already closed.
    }
  }

  private get<T>(operation: string, step: string, params: SqlBind): T | undefined {
    return this.db.prepare(getOperationSql(operation, step)).get(params) as T | undefined;
  }

  private all<T>(operation: string, step: string, params: SqlBind): T[] {
    return this.db.prepare(getOperationSql(operation, step)).all(params) as T[];
  }

  private run(operation: string, step: string, params: SqlBind): StatementResult {
    return this.db.prepare(getOperationSql(operation, step)).run(params) as StatementResult;
  }
}
