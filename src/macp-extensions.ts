import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue } from 'node:sqlite';

import { MacpProtocolError, type Priority } from './macp-core.js';
import { getConnectionPragmas, getSchemaDdl } from './schema.js';

export type MemoryScope = 'agent' | 'channel' | 'workspace';
export type MemoryLayer = 'constraints' | 'behavior' | 'context';
export type MemoryConfidence = 'stated' | 'inferred' | 'observed';

export interface ListAgentsResult {
  agents: AgentPresence[];
}

export interface AgentPresence {
  agentId: string;
  name: string;
  sessionId: string;
  registeredAt: string;
  status: 'active' | 'sleeping' | 'inactive' | 'deleted';
  profileSlug: string | null;
  channels: string[];
  role?: string | undefined;
  interestTags: string[];
  maxPendingMessages: number;
  maxContextBytes?: number | undefined;
  pendingDeliveries: number;
  activeClaims: number;
}

export interface FileClaim {
  claimId: string;
  agentId: string;
  sessionId: string;
  filePath: string;
  claimedAt: string;
  expiresAt: string;
  reason?: string | undefined;
}

export interface ClaimFilesInput {
  agentId: string;
  sessionId: string;
  files: string[];
  ttlSeconds?: number | undefined;
  reason?: string | undefined;
  now?: string | undefined;
}

export interface ReleaseFilesInput {
  agentId: string;
  sessionId: string;
  files: string[];
  reason?: string | undefined;
  now?: string | undefined;
}

export interface ListFileClaimsInput {
  agentId?: string | undefined;
  files?: string[] | undefined;
  now?: string | undefined;
}

export interface MemoryEntry {
  memoryId: string;
  scope: MemoryScope;
  key: string;
  value: string;
  ownerAgentId: string | null;
  channelId: string | null;
  tags: string[];
  confidence: MemoryConfidence;
  layer: MemoryLayer;
  authorAgentId: string;
  createdAt: string;
  updatedAt: string;
}

export interface SetMemoryInput {
  agentId: string;
  sessionId: string;
  scope: MemoryScope;
  key: string;
  value: string;
  channelId?: string | undefined;
  tags?: string[] | undefined;
  confidence?: MemoryConfidence | undefined;
  layer?: MemoryLayer | undefined;
  now?: string | undefined;
}

export interface GetMemoryInput {
  agentId: string;
  sessionId: string;
  key: string;
  scope?: MemoryScope | undefined;
  channelId?: string | undefined;
}

export interface SearchMemoryInput {
  agentId: string;
  sessionId: string;
  query: string;
  scope?: MemoryScope | undefined;
  channelId?: string | undefined;
  tags?: string[] | undefined;
  limit?: number | undefined;
}

export interface ListMemoriesInput {
  agentId: string;
  sessionId: string;
  scope?: MemoryScope | undefined;
  channelId?: string | undefined;
  tags?: string[] | undefined;
  limit?: number | undefined;
}

export interface DeleteMemoryInput {
  agentId: string;
  sessionId: string;
  key: string;
  scope: MemoryScope;
  channelId?: string | undefined;
  now?: string | undefined;
}

export interface ResolveMemoryInput {
  agentId: string;
  sessionId: string;
  key: string;
  scope: MemoryScope;
  chosenValue: string;
  channelId?: string | undefined;
  tags?: string[] | undefined;
  confidence?: MemoryConfidence | undefined;
  layer?: MemoryLayer | undefined;
  now?: string | undefined;
}

export interface GetMemoryResult {
  resolvedScope: MemoryScope | null;
  entries: MemoryEntry[];
  conflicts: boolean;
}

export interface SearchMemoryResult {
  entries: MemoryEntry[];
}

export interface SessionContextInput {
  agentId: string;
  sessionId: string;
  channelId?: string | undefined;
  pendingLimit?: number | undefined;
  now?: string | undefined;
}

export interface SessionContextResult {
  agent: {
    agentId: string;
    sessionId: string;
    name: string;
    registeredAt: string;
    status: 'active' | 'sleeping' | 'inactive' | 'deleted';
    profileSlug: string | null;
    role?: string | undefined;
    interestTags: string[];
    channels: string[];
  };
  pending: {
    total: number;
    interrupt: number;
    steering: number;
    advisory: number;
    info: number;
    deliveries: PendingDeliverySummary[];
  };
  claims: {
    own: FileClaim[];
    peers: FileClaim[];
  };
  memories: {
    agent: number;
    channel: number;
    workspace: number;
  };
}

export interface PendingDeliverySummary {
  deliveryId: string;
  messageId: string;
  channelId: string | null;
  fromAgentId: string;
  fromName: string;
  priority: Priority;
  priorityLabel: 'info' | 'advisory' | 'steering' | 'interrupt';
  type: string;
  contentPreview: string;
  timestamp: string;
  state: string;
}

type SqlBind = Record<string, SQLInputValue>;

type StatementResult = {
  changes: number;
  lastInsertRowid: number | bigint;
};

type SessionPresenceRow = {
  agent_id: string;
  name: string;
  session_id: string;
  registered_at: string;
  capabilities_json: string;
  interest_tags_json: string;
  queue_preferences_json: string;
};

type FileClaimRow = {
  claim_id: string;
  agent_id: string;
  session_id: string;
  file_path: string;
  claimed_at: string;
  expires_at: string;
  reason: string | null;
};

type MemoryRow = {
  memory_id: string;
  scope: MemoryScope;
  memory_key: string;
  value_text: string;
  owner_agent_id: string | null;
  channel_id: string | null;
  tags_json: string;
  confidence: MemoryConfidence;
  layer: MemoryLayer;
  author_agent_id: string;
  created_at: string;
  updated_at: string;
};

type PendingDeliveryRow = {
  delivery_id: string;
  message_id: string;
  channel_id: string | null;
  from_json: string;
  priority: number;
  type: string;
  content: string;
  timestamp: string;
  state: string;
};

type AgentStateRow = {
  status: 'active' | 'sleeping' | 'inactive' | 'deleted';
  profile_slug: string | null;
};

type CountRow = {
  count: number;
};

type ActiveSessionRow = {
  registered_at: string;
  capabilities_json: string;
  interest_tags_json: string;
  queue_preferences_json: string;
  name: string;
};

interface MacpWorkspaceExtensionsOptions {
  dbPath: string;
  now?: () => string;
}

const EXTENSION_SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS macp_ext_agent_state (
    agent_id TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'active',
    profile_slug TEXT,
    reason TEXT,
    changed_at TEXT NOT NULL,
    FOREIGN KEY (agent_id) REFERENCES agents(agent_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS macp_ext_file_claims (
    claim_id TEXT NOT NULL,
    file_path TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    claimed_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    reason TEXT,
    released_at TEXT,
    release_reason TEXT,
    PRIMARY KEY (claim_id, file_path),
    FOREIGN KEY (agent_id) REFERENCES agents(agent_id) ON DELETE CASCADE,
    FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_macp_ext_file_claims_active
ON macp_ext_file_claims(file_path, released_at, expires_at);

CREATE INDEX IF NOT EXISTS idx_macp_ext_file_claims_agent
ON macp_ext_file_claims(agent_id, released_at, expires_at);

CREATE TABLE IF NOT EXISTS macp_ext_memories (
    memory_id TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    memory_key TEXT NOT NULL,
    value_text TEXT NOT NULL,
    owner_agent_id TEXT,
    channel_id TEXT,
    tags_json TEXT NOT NULL DEFAULT '[]',
    confidence TEXT NOT NULL DEFAULT 'stated',
    layer TEXT NOT NULL DEFAULT 'context',
    author_agent_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    archived_at TEXT,
    archived_reason TEXT,
    FOREIGN KEY (owner_agent_id) REFERENCES agents(agent_id) ON DELETE CASCADE,
    FOREIGN KEY (channel_id) REFERENCES channels(channel_id) ON DELETE CASCADE,
    FOREIGN KEY (author_agent_id) REFERENCES agents(agent_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_macp_ext_memories_lookup
ON macp_ext_memories(scope, memory_key, owner_agent_id, channel_id, archived_at, updated_at);

CREATE INDEX IF NOT EXISTS idx_macp_ext_memories_author
ON macp_ext_memories(author_agent_id, archived_at, updated_at);
`;

export class MacpWorkspaceExtensions {
  readonly dbPath: string;
  private readonly db: DatabaseSync;
  private readonly nowProvider: () => string;

  constructor(options: MacpWorkspaceExtensionsOptions) {
    this.dbPath = options.dbPath;
    mkdirSync(dirname(options.dbPath), { recursive: true });
    this.db = new DatabaseSync(options.dbPath);
    this.nowProvider = options.now ?? (() => new Date().toISOString());

    this.applyConnectionContract();
  }

  close(): void {
    this.db.close();
  }

  listAgents(now: string = this.nowProvider()): ListAgentsResult {
    const rows = this.all<SessionPresenceRow>(
      `SELECT
          a.agent_id,
          a.name,
          s.session_id,
          s.registered_at,
          s.capabilities_json,
          s.interest_tags_json,
          s.queue_preferences_json
       FROM agents a
       INNER JOIN sessions s ON s.agent_id = a.agent_id
       WHERE s.state = 'active'
       ORDER BY a.agent_id`,
      {},
    );

    return {
      agents: rows.map((row) => this.buildAgentPresence(row, now)),
    };
  }

  claimFiles(input: ClaimFilesInput): { claimId: string; claims: FileClaim[] } {
    const now = input.now ?? this.nowProvider();
    const ttlSeconds = input.ttlSeconds ?? 1800;
    const files = this.normalizeFiles(input.files);

    if (files.length === 0) {
      throw new Error('files must contain at least one path.');
    }

    this.assertActiveSession(input.agentId, input.sessionId);
    const expiresAt = new Date(Date.parse(now) + ttlSeconds * 1000).toISOString();
    const claimId = randomUUID();

    for (const filePath of files) {
      this.run(
        `UPDATE macp_ext_file_claims
         SET released_at = COALESCE(released_at, :now),
             release_reason = COALESCE(release_reason, 'superseded')
         WHERE agent_id = :agent_id
           AND file_path = :file_path
           AND released_at IS NULL
           AND datetime(expires_at) > datetime(:now)`,
        {
          agent_id: input.agentId,
          file_path: filePath,
          now,
        },
      );

      this.run(
        `INSERT INTO macp_ext_file_claims (
            claim_id, file_path, agent_id, session_id, claimed_at, expires_at, reason
         ) VALUES (
            :claim_id, :file_path, :agent_id, :session_id, :claimed_at, :expires_at, :reason
         )`,
        {
          claim_id: claimId,
          file_path: filePath,
          agent_id: input.agentId,
          session_id: input.sessionId,
          claimed_at: now,
          expires_at: expiresAt,
          reason: input.reason ?? null,
        },
      );
    }

    return {
      claimId,
      claims: this.listFileClaims({
        agentId: input.agentId,
        files,
        now,
      }).claims,
    };
  }

  releaseFiles(input: ReleaseFilesInput): { releasedFiles: string[] } {
    const now = input.now ?? this.nowProvider();
    const files = this.normalizeFiles(input.files);

    if (files.length === 0) {
      throw new Error('files must contain at least one path.');
    }

    this.assertActiveSession(input.agentId, input.sessionId);

    const releasedFiles: string[] = [];

    for (const filePath of files) {
      const result = this.run(
        `UPDATE macp_ext_file_claims
         SET released_at = :now,
             release_reason = :release_reason
         WHERE agent_id = :agent_id
           AND session_id = :session_id
           AND file_path = :file_path
           AND released_at IS NULL
           AND datetime(expires_at) > datetime(:now)`,
        {
          now,
          release_reason: input.reason ?? 'released',
          agent_id: input.agentId,
          session_id: input.sessionId,
          file_path: filePath,
        },
      );

      if (result.changes > 0) {
        releasedFiles.push(filePath);
      }
    }

    return { releasedFiles };
  }

  listFileClaims(input: ListFileClaimsInput = {}): { claims: FileClaim[] } {
    const now = input.now ?? this.nowProvider();
    const rows = this.all<FileClaimRow>(
      `SELECT claim_id, agent_id, session_id, file_path, claimed_at, expires_at, reason
       FROM macp_ext_file_claims
       WHERE released_at IS NULL
         AND datetime(expires_at) > datetime(:now)
       ORDER BY file_path, claimed_at ASC`,
      { now },
    );

    const filtered = rows.filter((row) => {
      if (input.agentId !== undefined && row.agent_id !== input.agentId) {
        return false;
      }

      if (input.files !== undefined && !input.files.includes(row.file_path)) {
        return false;
      }

      return true;
    });

    return {
      claims: filtered.map((row) => this.mapFileClaim(row)),
    };
  }

  setMemory(input: SetMemoryInput): { entry: MemoryEntry; conflicts: number } {
    const now = input.now ?? this.nowProvider();
    const trimmedKey = input.key.trim();
    const trimmedValue = input.value.trim();

    if (trimmedKey.length === 0) {
      throw new Error('key must not be empty.');
    }

    if (trimmedValue.length === 0) {
      throw new Error('value must not be empty.');
    }

    this.assertActiveSession(input.agentId, input.sessionId);
    const scopeContext = this.resolveScopeContext(input.agentId, input.sessionId, input.scope, input.channelId);

    const existing = this.get<{ memory_id: string }>(
      `SELECT memory_id
       FROM macp_ext_memories
       WHERE archived_at IS NULL
         AND scope = :scope
         AND memory_key = :memory_key
         AND owner_agent_id IS :owner_agent_id
         AND channel_id IS :channel_id
         AND value_text = :value_text
       LIMIT 1`,
      {
        scope: scopeContext.scope,
        memory_key: trimmedKey,
        owner_agent_id: scopeContext.ownerAgentId,
        channel_id: scopeContext.channelId,
        value_text: trimmedValue,
      },
    );

    const tagsJson = JSON.stringify(this.normalizeTags(input.tags));
    const confidence = input.confidence ?? 'stated';
    const layer = input.layer ?? 'context';
    let memoryId = existing?.memory_id;

    if (memoryId === undefined) {
      memoryId = randomUUID();
      this.run(
        `INSERT INTO macp_ext_memories (
            memory_id, scope, memory_key, value_text, owner_agent_id, channel_id, tags_json,
            confidence, layer, author_agent_id, created_at, updated_at
         ) VALUES (
            :memory_id, :scope, :memory_key, :value_text, :owner_agent_id, :channel_id, :tags_json,
            :confidence, :layer, :author_agent_id, :created_at, :updated_at
         )`,
        {
          memory_id: memoryId,
          scope: scopeContext.scope,
          memory_key: trimmedKey,
          value_text: trimmedValue,
          owner_agent_id: scopeContext.ownerAgentId,
          channel_id: scopeContext.channelId,
          tags_json: tagsJson,
          confidence,
          layer,
          author_agent_id: input.agentId,
          created_at: now,
          updated_at: now,
        },
      );
    } else {
      this.run(
        `UPDATE macp_ext_memories
         SET tags_json = :tags_json,
             confidence = :confidence,
             layer = :layer,
             updated_at = :updated_at
         WHERE memory_id = :memory_id`,
        {
          tags_json: tagsJson,
          confidence,
          layer,
          updated_at: now,
          memory_id: memoryId,
        },
      );
    }

    const rows = this.getActiveMemoryRows({
      agentId: input.agentId,
      sessionId: input.sessionId,
      scope: scopeContext.scope,
      channelId: scopeContext.channelId,
      key: trimmedKey,
    });
    const entry = rows.find((row) => row.memory_id === memoryId);

    if (entry === undefined) {
      throw new Error(`Failed to read memory ${memoryId} after write.`);
    }

    return {
      entry: this.mapMemoryEntry(entry),
      conflicts: rows.length,
    };
  }

  getMemory(input: GetMemoryInput): GetMemoryResult {
    this.assertActiveSession(input.agentId, input.sessionId);

    if (input.scope !== undefined) {
      const scopeContext = this.resolveScopeContext(input.agentId, input.sessionId, input.scope, input.channelId);
      const rows = this.getActiveMemoryRows({
        agentId: input.agentId,
        sessionId: input.sessionId,
        scope: scopeContext.scope,
        channelId: scopeContext.channelId,
        key: input.key,
      });

      return {
        resolvedScope: scopeContext.scope,
        entries: rows.map((row) => this.mapMemoryEntry(row)),
        conflicts: rows.length > 1,
      };
    }

    const cascadeScopes: Array<{ scope: MemoryScope; channelId: string | null }> = [
      { scope: 'agent', channelId: null },
      { scope: 'channel', channelId: input.channelId ?? null },
      { scope: 'workspace', channelId: null },
    ];

    for (const candidate of cascadeScopes) {
      if (candidate.scope === 'channel' && candidate.channelId === null) {
        continue;
      }

      const rows = this.getActiveMemoryRows({
        agentId: input.agentId,
        sessionId: input.sessionId,
        scope: candidate.scope,
        channelId: candidate.channelId,
        key: input.key,
      });

      if (rows.length > 0) {
        return {
          resolvedScope: candidate.scope,
          entries: rows.map((row) => this.mapMemoryEntry(row)),
          conflicts: rows.length > 1,
        };
      }
    }

    return {
      resolvedScope: null,
      entries: [],
      conflicts: false,
    };
  }

  searchMemory(input: SearchMemoryInput): SearchMemoryResult {
    const rows = this.listVisibleMemoryRows(input.agentId, input.sessionId, input.channelId);
    const query = input.query.trim().toLowerCase();

    if (query.length === 0) {
      return { entries: [] };
    }

    const filtered = rows.filter((row) => {
      if (input.scope !== undefined && row.scope !== input.scope) {
        return false;
      }

      if (input.scope === 'channel' && input.channelId !== undefined && row.channel_id !== input.channelId) {
        return false;
      }

      if (!this.matchesTags(row.tags_json, input.tags)) {
        return false;
      }

      const haystack = `${row.memory_key}\n${row.value_text}`.toLowerCase();
      return haystack.includes(query);
    });

    return {
      entries: filtered
        .slice(0, input.limit ?? 20)
        .map((row) => this.mapMemoryEntry(row)),
    };
  }

  listMemories(input: ListMemoriesInput): SearchMemoryResult {
    const rows = this.listVisibleMemoryRows(input.agentId, input.sessionId, input.channelId)
      .filter((row) => {
        if (input.scope !== undefined && row.scope !== input.scope) {
          return false;
        }

        if (input.scope === 'channel' && input.channelId !== undefined && row.channel_id !== input.channelId) {
          return false;
        }

        return this.matchesTags(row.tags_json, input.tags);
      })
      .slice(0, input.limit ?? 50);

    return {
      entries: rows.map((row) => this.mapMemoryEntry(row)),
    };
  }

  deleteMemory(input: DeleteMemoryInput): { archivedCount: number } {
    const now = input.now ?? this.nowProvider();
    this.assertActiveSession(input.agentId, input.sessionId);
    const scopeContext = this.resolveScopeContext(input.agentId, input.sessionId, input.scope, input.channelId);

    const result = this.run(
      `UPDATE macp_ext_memories
       SET archived_at = :archived_at,
           archived_reason = 'deleted'
       WHERE archived_at IS NULL
         AND scope = :scope
         AND memory_key = :memory_key
         AND owner_agent_id IS :owner_agent_id
         AND channel_id IS :channel_id`,
      {
        archived_at: now,
        scope: scopeContext.scope,
        memory_key: input.key,
        owner_agent_id: scopeContext.ownerAgentId,
        channel_id: scopeContext.channelId,
      },
    );

    return {
      archivedCount: result.changes,
    };
  }

  resolveMemory(input: ResolveMemoryInput): { entry: MemoryEntry; archivedCount: number } {
    const now = input.now ?? this.nowProvider();
    this.assertActiveSession(input.agentId, input.sessionId);
    const scopeContext = this.resolveScopeContext(input.agentId, input.sessionId, input.scope, input.channelId);

    const archiveResult = this.run(
      `UPDATE macp_ext_memories
       SET archived_at = :archived_at,
           archived_reason = 'resolved'
       WHERE archived_at IS NULL
         AND scope = :scope
         AND memory_key = :memory_key
         AND owner_agent_id IS :owner_agent_id
         AND channel_id IS :channel_id`,
      {
        archived_at: now,
        scope: scopeContext.scope,
        memory_key: input.key,
        owner_agent_id: scopeContext.ownerAgentId,
        channel_id: scopeContext.channelId,
      },
    );

    const write = this.setMemory({
      agentId: input.agentId,
      sessionId: input.sessionId,
      scope: input.scope,
      key: input.key,
      value: input.chosenValue,
      channelId: input.channelId,
      tags: input.tags,
      confidence: input.confidence,
      layer: input.layer,
      now,
    });

    return {
      entry: write.entry,
      archivedCount: archiveResult.changes,
    };
  }

  getSessionContext(input: SessionContextInput): SessionContextResult {
    const now = input.now ?? this.nowProvider();
    const session = this.getActiveSession(input.agentId, input.sessionId);

    if (session === undefined) {
      throw new MacpProtocolError(
        'MACP_ERR_SESSION_UNKNOWN',
        `Session ${input.sessionId} is not active for agent ${input.agentId}.`,
        {
          agentId: input.agentId,
          sessionId: input.sessionId,
        },
      );
    }

    const channels = this.getAgentChannels(input.agentId);
    const pendingRows = this.all<PendingDeliveryRow>(
      `SELECT delivery_id, message_id, channel_id, from_json, priority, type, content, timestamp, state
       FROM messages
       WHERE destination_agent_id = :agent_id
         AND state IN ('queued', 'surfaced')
         AND datetime(timestamp, '+' || ttl_seconds || ' seconds') > datetime(:now)
       ORDER BY priority DESC, sequence_number ASC
       LIMIT :limit`,
      {
        agent_id: input.agentId,
        now,
        limit: input.pendingLimit ?? 10,
      },
    );

    const pendingCountRows = this.all<{ priority: number; count: number }>(
      `SELECT priority, COUNT(*) AS count
       FROM messages
       WHERE destination_agent_id = :agent_id
         AND state IN ('queued', 'surfaced')
         AND datetime(timestamp, '+' || ttl_seconds || ' seconds') > datetime(:now)
       GROUP BY priority`,
      {
        agent_id: input.agentId,
        now,
      },
    );

    const activeClaims = this.listFileClaims({ now }).claims;
    const ownClaims = activeClaims.filter((claim) => claim.agentId === input.agentId);
    const peerClaims = activeClaims.filter((claim) => claim.agentId !== input.agentId);
    const memoryCounts = this.countVisibleMemories(input.agentId, input.sessionId, input.channelId);

    return {
      agent: {
        agentId: input.agentId,
        sessionId: input.sessionId,
        name: session.name,
        registeredAt: session.registered_at,
        status: this.getAgentState(input.agentId)?.status ?? 'active',
        profileSlug: this.getAgentState(input.agentId)?.profile_slug ?? null,
        role: this.extractRole(session.capabilities_json),
        interestTags: this.parseJson<string[]>(session.interest_tags_json, []),
        channels,
      },
      pending: {
        total: pendingCountRows.reduce((sum, row) => sum + row.count, 0),
        interrupt: this.priorityCount(pendingCountRows, 3),
        steering: this.priorityCount(pendingCountRows, 2),
        advisory: this.priorityCount(pendingCountRows, 1),
        info: this.priorityCount(pendingCountRows, 0),
        deliveries: pendingRows.map((row) => this.mapPendingDelivery(row)),
      },
      claims: {
        own: ownClaims,
        peers: peerClaims,
      },
      memories: memoryCounts,
    };
  }

  private applyConnectionContract(): void {
    const pragmas = getConnectionPragmas();
    this.db.exec(`PRAGMA journal_mode=${pragmas.journalMode}`);
    this.db.exec(`PRAGMA busy_timeout=${pragmas.busyTimeout}`);
    this.db.exec(`PRAGMA foreign_keys=${pragmas.foreignKeys ? 'ON' : 'OFF'}`);
    this.db.exec(getSchemaDdl());
    this.db.exec(EXTENSION_SCHEMA_DDL);
  }

  private buildAgentPresence(row: SessionPresenceRow, now: string): AgentPresence {
    const queuePreferences = this.parseJson<{ max_pending_messages?: number }>(row.queue_preferences_json, {});
    const capabilities = this.parseJson<{ max_context_bytes?: number } & Record<string, unknown>>(row.capabilities_json, {});
    const state = this.getAgentState(row.agent_id);

    return {
      agentId: row.agent_id,
      name: row.name,
      sessionId: row.session_id,
      registeredAt: row.registered_at,
      status: state?.status ?? 'active',
      profileSlug: state?.profile_slug ?? null,
      channels: this.getAgentChannels(row.agent_id),
      role: this.extractRole(row.capabilities_json),
      interestTags: this.parseJson<string[]>(row.interest_tags_json, []),
      maxPendingMessages: queuePreferences.max_pending_messages ?? 200,
      maxContextBytes: typeof capabilities.max_context_bytes === 'number' ? capabilities.max_context_bytes : undefined,
      pendingDeliveries: this.countPendingDeliveries(row.agent_id, now),
      activeClaims: this.countActiveClaims(row.agent_id, now),
    };
  }

  private getAgentChannels(agentId: string): string[] {
    return this.all<{ channel_id: string }>(
      `SELECT channel_id
       FROM channel_members
       WHERE agent_id = :agent_id
       ORDER BY channel_id`,
      { agent_id: agentId },
    ).map((row) => row.channel_id);
  }

  private countPendingDeliveries(agentId: string, now: string): number {
    return this.get<CountRow>(
      `SELECT COUNT(*) AS count
       FROM messages
       WHERE destination_agent_id = :agent_id
         AND state IN ('queued', 'surfaced')
         AND datetime(timestamp, '+' || ttl_seconds || ' seconds') > datetime(:now)`,
      {
        agent_id: agentId,
        now,
      },
    )?.count ?? 0;
  }

  private countActiveClaims(agentId: string, now: string): number {
    return this.get<CountRow>(
      `SELECT COUNT(*) AS count
       FROM macp_ext_file_claims
       WHERE agent_id = :agent_id
         AND released_at IS NULL
         AND datetime(expires_at) > datetime(:now)`,
      {
        agent_id: agentId,
        now,
      },
    )?.count ?? 0;
  }

  private getActiveSession(agentId: string, sessionId: string): ActiveSessionRow | undefined {
    return this.get<ActiveSessionRow>(
      `SELECT s.registered_at, s.capabilities_json, s.interest_tags_json, s.queue_preferences_json, a.name
       FROM sessions s
       INNER JOIN agents a ON a.agent_id = s.agent_id
       WHERE s.agent_id = :agent_id
         AND s.session_id = :session_id
         AND s.state = 'active'`,
      {
        agent_id: agentId,
        session_id: sessionId,
      },
    );
  }

  private getAgentState(agentId: string): AgentStateRow | undefined {
    return this.get<AgentStateRow>(
      `SELECT status, profile_slug
       FROM macp_ext_agent_state
       WHERE agent_id = :agent_id`,
      {
        agent_id: agentId,
      },
    );
  }

  private assertActiveSession(agentId: string, sessionId: string): void {
    const session = this.getActiveSession(agentId, sessionId);
    if (session === undefined) {
      throw new MacpProtocolError(
        'MACP_ERR_SESSION_UNKNOWN',
        `Session ${sessionId} is not active for agent ${agentId}.`,
        {
          agentId,
          sessionId,
        },
      );
    }
  }

  private resolveScopeContext(
    agentId: string,
    sessionId: string,
    scope: MemoryScope,
    channelId: string | undefined,
  ): { scope: MemoryScope; ownerAgentId: string | null; channelId: string | null } {
    switch (scope) {
      case 'agent':
        return {
          scope,
          ownerAgentId: agentId,
          channelId: null,
        };
      case 'channel': {
        const resolvedChannelId = channelId?.trim();
        if (!resolvedChannelId) {
          throw new Error('channelId is required for channel-scoped memories.');
        }

        const membership = this.get<{ '1': number }>(
          `SELECT 1
           FROM channel_members
           WHERE channel_id = :channel_id
             AND agent_id = :agent_id
             AND session_id = :session_id`,
          {
            channel_id: resolvedChannelId,
            agent_id: agentId,
            session_id: sessionId,
          },
        );

        if (membership === undefined) {
          throw new MacpProtocolError(
            'MACP_ERR_SENDER_NOT_MEMBER',
            `Agent ${agentId} is not an active member of channel ${resolvedChannelId}.`,
            {
              agentId,
              sessionId,
              channelId: resolvedChannelId,
            },
          );
        }

        return {
          scope,
          ownerAgentId: null,
          channelId: resolvedChannelId,
        };
      }
      case 'workspace':
        return {
          scope,
          ownerAgentId: null,
          channelId: null,
        };
      default:
        throw new Error(`Unsupported memory scope: ${String(scope)}`);
    }
  }

  private getActiveMemoryRows(input: {
    agentId: string;
    sessionId: string;
    scope: MemoryScope;
    channelId: string | null;
    key: string;
  }): MemoryRow[] {
    this.assertActiveSession(input.agentId, input.sessionId);

    const scopeContext = this.resolveScopeContext(
      input.agentId,
      input.sessionId,
      input.scope,
      input.channelId ?? undefined,
    );

    return this.all<MemoryRow>(
      `SELECT
          memory_id,
          scope,
          memory_key,
          value_text,
          owner_agent_id,
          channel_id,
          tags_json,
          confidence,
          layer,
          author_agent_id,
          created_at,
          updated_at
       FROM macp_ext_memories
       WHERE archived_at IS NULL
         AND scope = :scope
         AND memory_key = :memory_key
         AND owner_agent_id IS :owner_agent_id
         AND channel_id IS :channel_id
       ORDER BY updated_at DESC, created_at DESC`,
      {
        scope: scopeContext.scope,
        memory_key: input.key.trim(),
        owner_agent_id: scopeContext.ownerAgentId,
        channel_id: scopeContext.channelId,
      },
    );
  }

  private listVisibleMemoryRows(agentId: string, sessionId: string, channelId: string | undefined): MemoryRow[] {
    this.assertActiveSession(agentId, sessionId);

    if (channelId !== undefined && channelId.trim().length > 0) {
      this.resolveScopeContext(agentId, sessionId, 'channel', channelId);
    }

    return this.all<MemoryRow>(
      `SELECT
          memory_id,
          scope,
          memory_key,
          value_text,
          owner_agent_id,
          channel_id,
          tags_json,
          confidence,
          layer,
          author_agent_id,
          created_at,
          updated_at
       FROM macp_ext_memories
       WHERE archived_at IS NULL
       ORDER BY updated_at DESC, created_at DESC`,
      {},
    ).filter((row) => this.isMemoryVisible(row, agentId, channelId));
  }

  private isMemoryVisible(row: MemoryRow, agentId: string, channelId: string | undefined): boolean {
    switch (row.scope) {
      case 'agent':
        return row.owner_agent_id === agentId;
      case 'channel':
        return channelId !== undefined && channelId.trim().length > 0 && row.channel_id === channelId;
      case 'workspace':
        return true;
      default:
        return false;
    }
  }

  private countVisibleMemories(
    agentId: string,
    sessionId: string,
    channelId: string | undefined,
  ): { agent: number; channel: number; workspace: number } {
    const rows = this.listVisibleMemoryRows(agentId, sessionId, channelId);
    return {
      agent: rows.filter((row) => row.scope === 'agent').length,
      channel: rows.filter((row) => row.scope === 'channel').length,
      workspace: rows.filter((row) => row.scope === 'workspace').length,
    };
  }

  private mapFileClaim(row: FileClaimRow): FileClaim {
    return {
      claimId: row.claim_id,
      agentId: row.agent_id,
      sessionId: row.session_id,
      filePath: row.file_path,
      claimedAt: row.claimed_at,
      expiresAt: row.expires_at,
      reason: row.reason ?? undefined,
    };
  }

  private mapMemoryEntry(row: MemoryRow): MemoryEntry {
    return {
      memoryId: row.memory_id,
      scope: row.scope,
      key: row.memory_key,
      value: row.value_text,
      ownerAgentId: row.owner_agent_id,
      channelId: row.channel_id,
      tags: this.parseJson<string[]>(row.tags_json, []),
      confidence: row.confidence,
      layer: row.layer,
      authorAgentId: row.author_agent_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapPendingDelivery(row: PendingDeliveryRow): PendingDeliverySummary {
    const sender = this.parseJson<{ agent_id?: string; name?: string }>(row.from_json, {});
    const priority = this.normalizePriority(row.priority);

    return {
      deliveryId: row.delivery_id,
      messageId: row.message_id,
      channelId: row.channel_id,
      fromAgentId: sender.agent_id ?? 'unknown',
      fromName: sender.name ?? 'unknown',
      priority,
      priorityLabel: this.priorityLabel(priority),
      type: row.type,
      contentPreview: row.content.length > 200 ? `${row.content.slice(0, 197)}...` : row.content,
      timestamp: row.timestamp,
      state: row.state,
    };
  }

  private priorityCount(rows: Array<{ priority: number; count: number }>, priority: number): number {
    return rows.find((row) => row.priority === priority)?.count ?? 0;
  }

  private priorityLabel(priority: Priority): 'info' | 'advisory' | 'steering' | 'interrupt' {
    switch (priority) {
      case 0:
        return 'info';
      case 1:
        return 'advisory';
      case 2:
        return 'steering';
      case 3:
        return 'interrupt';
      default:
        return 'info';
    }
  }

  private normalizePriority(priority: number): Priority {
    if (priority === 0 || priority === 1 || priority === 2 || priority === 3) {
      return priority;
    }

    throw new Error(`Unsupported priority value: ${priority}`);
  }

  private extractRole(capabilitiesJson: string): string | undefined {
    const capabilities = this.parseJson<Record<string, unknown>>(capabilitiesJson, {});
    return typeof capabilities.role === 'string' ? capabilities.role : undefined;
  }

  private normalizeFiles(files: string[]): string[] {
    return [...new Set(files.map((file) => file.trim()).filter((file) => file.length > 0))];
  }

  private normalizeTags(tags: string[] | undefined): string[] {
    if (tags === undefined) {
      return [];
    }

    return [...new Set(tags.map((tag) => tag.trim()).filter((tag) => tag.length > 0))];
  }

  private matchesTags(tagsJson: string, requiredTags: string[] | undefined): boolean {
    if (requiredTags === undefined || requiredTags.length === 0) {
      return true;
    }

    const rowTags = new Set(this.parseJson<string[]>(tagsJson, []));
    return this.normalizeTags(requiredTags).every((tag) => rowTags.has(tag));
  }

  private parseJson<T>(value: string, fallback: T): T {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }

  private get<T>(sql: string, params: SqlBind): T | undefined {
    return this.db.prepare(sql).get(params) as T | undefined;
  }

  private all<T>(sql: string, params: SqlBind): T[] {
    return this.db.prepare(sql).all(params) as T[];
  }

  private run(sql: string, params: SqlBind): StatementResult {
    return this.db.prepare(sql).run(params) as StatementResult;
  }
}
