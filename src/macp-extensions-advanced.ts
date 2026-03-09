import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, extname, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue } from 'node:sqlite';

import { MacpProtocolError } from './macp-core.js';
import { getConnectionPragmas, getSchemaDdl } from './schema.js';

export type AgentStatus = 'active' | 'sleeping' | 'inactive' | 'deleted';
export type TaskStatus = 'pending' | 'accepted' | 'in-progress' | 'done' | 'blocked' | 'cancelled';
export type TaskPriority = 'P0' | 'P1' | 'P2' | 'P3';
export type GoalType = 'mission' | 'project_goal' | 'agent_goal';
export type GoalStatus = 'active' | 'completed' | 'paused';

export interface ActivateAgentInput {
  agentId: string;
  profileSlug?: string | undefined;
  now?: string | undefined;
}

export interface AgentLifecycleInput {
  agentId: string;
  sessionId: string;
  reason?: string | undefined;
  now?: string | undefined;
}

export interface ProfileRecord {
  slug: string;
  name: string;
  role: string;
  contextPack: string;
  skills: Array<{ id: string; name: string; tags: string[] }>;
  memoryKeys: string[];
  vaultPaths: string[];
  updatedAt: string;
}

export interface RegisterProfileInput {
  agentId: string;
  sessionId: string;
  slug: string;
  name: string;
  role: string;
  contextPack?: string | undefined;
  skills?: Array<{ id: string; name: string; tags?: string[] | undefined }> | undefined;
  memoryKeys?: string[] | undefined;
  vaultPaths?: string[] | undefined;
  now?: string | undefined;
}

export interface FindProfilesInput {
  agentId: string;
  sessionId: string;
  skillTag: string;
}

export interface CreateGoalInput {
  agentId: string;
  sessionId: string;
  type: GoalType;
  title: string;
  description?: string | undefined;
  parentGoalId?: string | undefined;
  ownerAgentId?: string | undefined;
  now?: string | undefined;
}

export interface UpdateGoalInput {
  agentId: string;
  sessionId: string;
  goalId: string;
  title?: string | undefined;
  description?: string | undefined;
  status?: GoalStatus | undefined;
  now?: string | undefined;
}

export interface ListGoalsInput {
  agentId: string;
  sessionId: string;
  type?: GoalType | undefined;
  status?: GoalStatus | undefined;
  ownerAgentId?: string | undefined;
}

export interface GetGoalInput {
  agentId: string;
  sessionId: string;
  goalId: string;
}

export interface GoalProgress {
  totalTasks: number;
  completedTasks: number;
  completionRatio: number;
}

export interface GoalRecord {
  goalId: string;
  type: GoalType;
  title: string;
  description: string;
  status: GoalStatus;
  parentGoalId: string | null;
  ownerAgentId: string | null;
  createdByAgentId: string;
  createdAt: string;
  updatedAt: string;
  progress: GoalProgress;
}

export interface DispatchTaskInput {
  agentId: string;
  sessionId: string;
  title: string;
  description?: string | undefined;
  profileSlug?: string | undefined;
  priority?: TaskPriority | undefined;
  goalId?: string | undefined;
  parentTaskId?: string | undefined;
  now?: string | undefined;
}

export interface TaskMutationInput {
  agentId: string;
  sessionId: string;
  taskId: string;
  reason?: string | undefined;
  result?: string | undefined;
  now?: string | undefined;
}

export interface ListTasksInput {
  agentId: string;
  sessionId: string;
  status?: TaskStatus | undefined;
  profileSlug?: string | undefined;
  priority?: TaskPriority | undefined;
  goalId?: string | undefined;
  assignedAgentId?: string | undefined;
  limit?: number | undefined;
}

export interface ArchiveTasksInput {
  agentId: string;
  sessionId: string;
  status?: Extract<TaskStatus, 'done' | 'cancelled'> | undefined;
  goalId?: string | undefined;
  now?: string | undefined;
}

export interface GetTaskInput {
  agentId: string;
  sessionId: string;
  taskId: string;
  includeSubtasks?: boolean | undefined;
}

export interface TaskRecord {
  taskId: string;
  title: string;
  description: string;
  profileSlug: string | null;
  priority: TaskPriority;
  status: TaskStatus;
  goalId: string | null;
  parentTaskId: string | null;
  dispatcherAgentId: string;
  assignedAgentId: string | null;
  result: string | null;
  reason: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface GetTaskResult {
  task: TaskRecord;
  subtasks: TaskRecord[];
  goalChain: GoalRecord[];
}

export interface VaultDocRecord {
  docId: string;
  path: string;
  title: string;
  tags: string[];
  updatedAt: string;
  sourcePath: string;
  content?: string | undefined;
}

export interface RegisterVaultInput {
  agentId: string;
  sessionId: string;
  path: string;
  now?: string | undefined;
}

export interface SearchVaultInput {
  agentId: string;
  sessionId: string;
  query: string;
  tags?: string[] | undefined;
  limit?: number | undefined;
}

export interface GetVaultDocInput {
  agentId: string;
  sessionId: string;
  path: string;
}

export interface ListVaultDocsInput {
  agentId: string;
  sessionId: string;
  tags?: string[] | undefined;
  limit?: number | undefined;
}

export interface QueryContextInput {
  agentId: string;
  sessionId: string;
  query: string;
  channelId?: string | undefined;
  limit?: number | undefined;
}

export interface QueryContextResult {
  results: QueryContextEntry[];
}

export interface QueryContextEntry {
  kind: 'memory' | 'vault_doc' | 'task' | 'goal';
  id: string;
  title: string;
  snippet: string;
  score: number;
  metadata: Record<string, unknown>;
}

type SqlBind = Record<string, SQLInputValue>;

type StatementResult = {
  changes: number;
  lastInsertRowid: number | bigint;
};

type TaskRow = {
  task_id: string;
  title: string;
  description: string;
  profile_slug: string | null;
  priority: string;
  status: string;
  goal_id: string | null;
  parent_task_id: string | null;
  dispatcher_agent_id: string;
  assigned_agent_id: string | null;
  result_text: string | null;
  reason_text: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
};

type GoalRow = {
  goal_id: string;
  goal_type: GoalType;
  title: string;
  description: string;
  status: GoalStatus;
  parent_goal_id: string | null;
  owner_agent_id: string | null;
  created_by_agent_id: string;
  created_at: string;
  updated_at: string;
};

type ProfileRow = {
  slug: string;
  name: string;
  role: string;
  context_pack: string;
  skills_json: string;
  memory_keys_json: string;
  vault_paths_json: string;
  updated_at: string;
};

type VaultDocRow = {
  doc_id: string;
  doc_path: string;
  title: string;
  content: string;
  tags_json: string;
  updated_at: string;
  source_path: string;
};

type AgentStateRow = {
  status: AgentStatus;
  profile_slug: string | null;
};

type ActiveSessionRow = {
  session_id: string;
};

interface AdvancedOptions {
  dbPath: string;
  now?: () => string;
}

const ADVANCED_SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS macp_ext_agent_state (
    agent_id TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'active',
    profile_slug TEXT,
    reason TEXT,
    changed_at TEXT NOT NULL,
    FOREIGN KEY (agent_id) REFERENCES agents(agent_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS macp_ext_profiles (
    slug TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    role TEXT NOT NULL,
    context_pack TEXT NOT NULL DEFAULT '',
    skills_json TEXT NOT NULL DEFAULT '[]',
    memory_keys_json TEXT NOT NULL DEFAULT '[]',
    vault_paths_json TEXT NOT NULL DEFAULT '[]',
    author_agent_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (author_agent_id) REFERENCES agents(agent_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS macp_ext_goals (
    goal_id TEXT PRIMARY KEY,
    goal_type TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active',
    parent_goal_id TEXT,
    owner_agent_id TEXT,
    created_by_agent_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (parent_goal_id) REFERENCES macp_ext_goals(goal_id) ON DELETE SET NULL,
    FOREIGN KEY (owner_agent_id) REFERENCES agents(agent_id) ON DELETE SET NULL,
    FOREIGN KEY (created_by_agent_id) REFERENCES agents(agent_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_macp_ext_goals_parent
ON macp_ext_goals(parent_goal_id, status, updated_at);

CREATE TABLE IF NOT EXISTS macp_ext_tasks (
    task_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    profile_slug TEXT,
    priority TEXT NOT NULL DEFAULT 'P2',
    status TEXT NOT NULL DEFAULT 'pending',
    goal_id TEXT,
    parent_task_id TEXT,
    dispatcher_agent_id TEXT NOT NULL,
    assigned_agent_id TEXT,
    assigned_session_id TEXT,
    result_text TEXT,
    reason_text TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    archived_at TEXT,
    FOREIGN KEY (profile_slug) REFERENCES macp_ext_profiles(slug) ON DELETE SET NULL,
    FOREIGN KEY (goal_id) REFERENCES macp_ext_goals(goal_id) ON DELETE SET NULL,
    FOREIGN KEY (parent_task_id) REFERENCES macp_ext_tasks(task_id) ON DELETE SET NULL,
    FOREIGN KEY (dispatcher_agent_id) REFERENCES agents(agent_id) ON DELETE CASCADE,
    FOREIGN KEY (assigned_agent_id) REFERENCES agents(agent_id) ON DELETE SET NULL,
    FOREIGN KEY (assigned_session_id) REFERENCES sessions(session_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_macp_ext_tasks_list
ON macp_ext_tasks(status, priority, profile_slug, goal_id, updated_at);

CREATE TABLE IF NOT EXISTS macp_ext_vault_registry (
    registry_id TEXT PRIMARY KEY,
    root_path TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by_agent_id TEXT NOT NULL,
    FOREIGN KEY (updated_by_agent_id) REFERENCES agents(agent_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS macp_ext_vault_docs (
    doc_id TEXT PRIMARY KEY,
    doc_path TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    tags_json TEXT NOT NULL DEFAULT '[]',
    source_path TEXT NOT NULL UNIQUE,
    source_mtime TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_macp_ext_vault_docs_path
ON macp_ext_vault_docs(doc_path, updated_at);
`;

const SUPPORTED_VAULT_EXTENSIONS = new Set(['.md', '.mdx', '.txt', '.rst']);

export class MacpWorkspaceExtensionsAdvanced {
  readonly dbPath: string;
  private readonly db: DatabaseSync;
  private readonly nowProvider: () => string;

  constructor(options: AdvancedOptions) {
    this.dbPath = options.dbPath;
    mkdirSync(dirname(options.dbPath), { recursive: true });
    this.db = new DatabaseSync(options.dbPath);
    this.nowProvider = options.now ?? (() => new Date().toISOString());

    this.applyConnectionContract();
  }

  close(): void {
    this.db.close();
  }

  activateAgent(input: ActivateAgentInput): { agentId: string; status: AgentStatus; profileSlug: string | null } {
    const now = input.now ?? this.nowProvider();
    const existing = this.get<{ profile_slug: string | null }>(
      'SELECT profile_slug FROM macp_ext_agent_state WHERE agent_id = :agent_id',
      { agent_id: input.agentId },
    );
    const profileSlug = input.profileSlug ?? existing?.profile_slug ?? null;

    if (profileSlug !== null) {
      this.assertProfileExists(profileSlug);
    }

    this.run(
      `INSERT INTO macp_ext_agent_state (agent_id, status, profile_slug, reason, changed_at)
       VALUES (:agent_id, 'active', :profile_slug, NULL, :changed_at)
       ON CONFLICT(agent_id) DO UPDATE SET
         status = 'active',
         profile_slug = excluded.profile_slug,
         reason = NULL,
         changed_at = excluded.changed_at`,
      {
        agent_id: input.agentId,
        profile_slug: profileSlug,
        changed_at: now,
      },
    );

    return {
      agentId: input.agentId,
      status: 'active',
      profileSlug,
    };
  }

  sleepAgent(input: AgentLifecycleInput): { agentId: string; status: AgentStatus } {
    this.assertActiveSession(input.agentId, input.sessionId);
    const now = input.now ?? this.nowProvider();

    this.run(
      `INSERT INTO macp_ext_agent_state (agent_id, status, profile_slug, reason, changed_at)
       VALUES (:agent_id, 'sleeping', (SELECT profile_slug FROM macp_ext_agent_state WHERE agent_id = :agent_id), :reason, :changed_at)
       ON CONFLICT(agent_id) DO UPDATE SET
         status = 'sleeping',
         reason = excluded.reason,
         changed_at = excluded.changed_at`,
      {
        agent_id: input.agentId,
        reason: input.reason ?? null,
        changed_at: now,
      },
    );

    return {
      agentId: input.agentId,
      status: 'sleeping',
    };
  }

  deactivateAgent(input: AgentLifecycleInput): { agentId: string; status: AgentStatus } {
    this.assertActiveSession(input.agentId, input.sessionId);
    const now = input.now ?? this.nowProvider();
    this.releaseAgentClaims(input.agentId, input.sessionId, now, 'deactivated');
    this.run('DELETE FROM channel_members WHERE agent_id = :agent_id', { agent_id: input.agentId });
    this.run(
      `UPDATE sessions
       SET state = 'deregistered'
       WHERE agent_id = :agent_id AND session_id = :session_id`,
      {
        agent_id: input.agentId,
        session_id: input.sessionId,
      },
    );
    this.run(
      `INSERT INTO macp_ext_agent_state (agent_id, status, profile_slug, reason, changed_at)
       VALUES (:agent_id, 'inactive', (SELECT profile_slug FROM macp_ext_agent_state WHERE agent_id = :agent_id), :reason, :changed_at)
       ON CONFLICT(agent_id) DO UPDATE SET
         status = 'inactive',
         reason = excluded.reason,
         changed_at = excluded.changed_at`,
      {
        agent_id: input.agentId,
        reason: input.reason ?? null,
        changed_at: now,
      },
    );

    return {
      agentId: input.agentId,
      status: 'inactive',
    };
  }

  deleteAgent(input: AgentLifecycleInput): { agentId: string; status: AgentStatus } {
    this.assertActiveSession(input.agentId, input.sessionId);
    const now = input.now ?? this.nowProvider();
    this.releaseAgentClaims(input.agentId, input.sessionId, now, 'deleted');
    this.run('DELETE FROM channel_members WHERE agent_id = :agent_id', { agent_id: input.agentId });
    this.run(
      `UPDATE sessions
       SET state = 'deregistered'
       WHERE agent_id = :agent_id AND session_id = :session_id`,
      {
        agent_id: input.agentId,
        session_id: input.sessionId,
      },
    );
    this.run(
      `INSERT INTO macp_ext_agent_state (agent_id, status, profile_slug, reason, changed_at)
       VALUES (:agent_id, 'deleted', (SELECT profile_slug FROM macp_ext_agent_state WHERE agent_id = :agent_id), :reason, :changed_at)
       ON CONFLICT(agent_id) DO UPDATE SET
         status = 'deleted',
         reason = excluded.reason,
         changed_at = excluded.changed_at`,
      {
        agent_id: input.agentId,
        reason: input.reason ?? null,
        changed_at: now,
      },
    );

    return {
      agentId: input.agentId,
      status: 'deleted',
    };
  }

  registerProfile(input: RegisterProfileInput): { profile: ProfileRecord } {
    this.assertActiveSession(input.agentId, input.sessionId);
    const now = input.now ?? this.nowProvider();
    const slug = input.slug.trim().toLowerCase();

    if (slug.length === 0) {
      throw new Error('slug must not be empty.');
    }

    this.run(
      `INSERT INTO macp_ext_profiles (
          slug, name, role, context_pack, skills_json, memory_keys_json, vault_paths_json,
          author_agent_id, created_at, updated_at
       ) VALUES (
          :slug, :name, :role, :context_pack, :skills_json, :memory_keys_json, :vault_paths_json,
          :author_agent_id, :created_at, :updated_at
       )
       ON CONFLICT(slug) DO UPDATE SET
         name = excluded.name,
         role = excluded.role,
         context_pack = excluded.context_pack,
         skills_json = excluded.skills_json,
         memory_keys_json = excluded.memory_keys_json,
         vault_paths_json = excluded.vault_paths_json,
         updated_at = excluded.updated_at`,
      {
        slug,
        name: input.name.trim(),
        role: input.role.trim(),
        context_pack: input.contextPack ?? '',
        skills_json: JSON.stringify(this.normalizeSkills(input.skills)),
        memory_keys_json: JSON.stringify(this.normalizeStrings(input.memoryKeys)),
        vault_paths_json: JSON.stringify(this.normalizeStrings(input.vaultPaths)),
        author_agent_id: input.agentId,
        created_at: now,
        updated_at: now,
      },
    );

    return {
      profile: this.readProfile(slug),
    };
  }

  getProfile(input: { agentId: string; sessionId: string; slug: string }): { profile: ProfileRecord } {
    this.assertActiveSession(input.agentId, input.sessionId);
    return {
      profile: this.readProfile(input.slug.trim().toLowerCase()),
    };
  }

  listProfiles(input: { agentId: string; sessionId: string }): { profiles: ProfileRecord[] } {
    this.assertActiveSession(input.agentId, input.sessionId);
    return {
      profiles: this.all<ProfileRow>(
        `SELECT slug, name, role, context_pack, skills_json, memory_keys_json, vault_paths_json, updated_at
         FROM macp_ext_profiles
         ORDER BY slug`,
        {},
      ).map((row) => this.mapProfile(row)),
    };
  }

  findProfiles(input: FindProfilesInput): { profiles: ProfileRecord[] } {
    this.assertActiveSession(input.agentId, input.sessionId);
    const skillTag = input.skillTag.trim().toLowerCase();
    return {
      profiles: this.all<ProfileRow>(
        `SELECT slug, name, role, context_pack, skills_json, memory_keys_json, vault_paths_json, updated_at
         FROM macp_ext_profiles
         ORDER BY slug`,
        {},
      )
        .map((row) => this.mapProfile(row))
        .filter((profile) => profile.skills.some((skill) => skill.tags.some((tag) => tag === skillTag))),
    };
  }

  createGoal(input: CreateGoalInput): { goal: GoalRecord } {
    this.assertActiveSession(input.agentId, input.sessionId);
    const now = input.now ?? this.nowProvider();

    if (input.parentGoalId !== undefined) {
      this.assertGoalExists(input.parentGoalId);
    }

    if (input.ownerAgentId !== undefined) {
      this.assertAgentExists(input.ownerAgentId);
    }

    const goalId = randomUUID();
    this.run(
      `INSERT INTO macp_ext_goals (
          goal_id, goal_type, title, description, status, parent_goal_id, owner_agent_id,
          created_by_agent_id, created_at, updated_at
       ) VALUES (
          :goal_id, :goal_type, :title, :description, 'active', :parent_goal_id, :owner_agent_id,
          :created_by_agent_id, :created_at, :updated_at
       )`,
      {
        goal_id: goalId,
        goal_type: input.type,
        title: input.title.trim(),
        description: input.description ?? '',
        parent_goal_id: input.parentGoalId ?? null,
        owner_agent_id: input.ownerAgentId ?? null,
        created_by_agent_id: input.agentId,
        created_at: now,
        updated_at: now,
      },
    );

    return {
      goal: this.readGoal(goalId),
    };
  }

  updateGoal(input: UpdateGoalInput): { goal: GoalRecord } {
    this.assertActiveSession(input.agentId, input.sessionId);
    const now = input.now ?? this.nowProvider();
    const existing = this.readGoalRow(input.goalId);

    this.run(
      `UPDATE macp_ext_goals
       SET title = :title,
           description = :description,
           status = :status,
           updated_at = :updated_at
       WHERE goal_id = :goal_id`,
      {
        goal_id: input.goalId,
        title: input.title ?? existing.title,
        description: input.description ?? existing.description,
        status: input.status ?? existing.status,
        updated_at: now,
      },
    );

    return {
      goal: this.readGoal(input.goalId),
    };
  }

  listGoals(input: ListGoalsInput): { goals: GoalRecord[] } {
    this.assertActiveSession(input.agentId, input.sessionId);
    return {
      goals: this.all<GoalRow>(
        `SELECT goal_id, goal_type, title, description, status, parent_goal_id, owner_agent_id, created_by_agent_id, created_at, updated_at
         FROM macp_ext_goals
         ORDER BY created_at ASC`,
        {},
      )
        .filter((row) => (input.type === undefined || row.goal_type === input.type))
        .filter((row) => (input.status === undefined || row.status === input.status))
        .filter((row) => (input.ownerAgentId === undefined || row.owner_agent_id === input.ownerAgentId))
        .map((row) => this.mapGoal(row)),
    };
  }

  getGoal(input: GetGoalInput): { goal: GoalRecord; ancestry: GoalRecord[]; children: GoalRecord[] } {
    this.assertActiveSession(input.agentId, input.sessionId);
    const goal = this.readGoal(input.goalId);
    const ancestry: GoalRecord[] = [];
    let cursor = goal.parentGoalId;

    while (cursor !== null) {
      const parent = this.readGoal(cursor);
      ancestry.unshift(parent);
      cursor = parent.parentGoalId;
    }

    const children = this.all<GoalRow>(
      `SELECT goal_id, goal_type, title, description, status, parent_goal_id, owner_agent_id, created_by_agent_id, created_at, updated_at
       FROM macp_ext_goals
       WHERE parent_goal_id = :parent_goal_id
       ORDER BY created_at ASC`,
      {
        parent_goal_id: input.goalId,
      },
    ).map((row) => this.mapGoal(row));

    return {
      goal,
      ancestry,
      children,
    };
  }

  getGoalCascade(input: { agentId: string; sessionId: string; goalId?: string | undefined }): { goals: Array<GoalRecord & { children: GoalRecord[] }> } {
    this.assertActiveSession(input.agentId, input.sessionId);
    const allGoals = this.all<GoalRow>(
      `SELECT goal_id, goal_type, title, description, status, parent_goal_id, owner_agent_id, created_by_agent_id, created_at, updated_at
       FROM macp_ext_goals
       ORDER BY created_at ASC`,
      {},
    ).map((row) => this.mapGoal(row));

    const rootIds = input.goalId !== undefined
      ? [input.goalId]
      : allGoals.filter((goal) => goal.parentGoalId === null).map((goal) => goal.goalId);

    return {
      goals: rootIds.map((goalId) => ({
        ...this.readGoal(goalId),
        children: allGoals.filter((goal) => goal.parentGoalId === goalId),
      })),
    };
  }

  dispatchTask(input: DispatchTaskInput): { task: TaskRecord } {
    this.assertActiveSession(input.agentId, input.sessionId);
    const now = input.now ?? this.nowProvider();

    if (input.profileSlug !== undefined) {
      this.assertProfileExists(input.profileSlug);
    }

    if (input.goalId !== undefined) {
      this.assertGoalExists(input.goalId);
    }

    if (input.parentTaskId !== undefined) {
      this.assertTaskExists(input.parentTaskId);
    }

    const taskId = randomUUID();
    this.run(
      `INSERT INTO macp_ext_tasks (
          task_id, title, description, profile_slug, priority, status, goal_id, parent_task_id,
          dispatcher_agent_id, created_at, updated_at
       ) VALUES (
          :task_id, :title, :description, :profile_slug, :priority, 'pending', :goal_id, :parent_task_id,
          :dispatcher_agent_id, :created_at, :updated_at
       )`,
      {
        task_id: taskId,
        title: input.title.trim(),
        description: input.description ?? '',
        profile_slug: input.profileSlug ?? null,
        priority: input.priority ?? 'P2',
        goal_id: input.goalId ?? null,
        parent_task_id: input.parentTaskId ?? null,
        dispatcher_agent_id: input.agentId,
        created_at: now,
        updated_at: now,
      },
    );

    return {
      task: this.readTask(taskId),
    };
  }

  claimTask(input: TaskMutationInput): { task: TaskRecord } {
    this.assertActiveSession(input.agentId, input.sessionId);
    const now = input.now ?? this.nowProvider();
    const task = this.readTaskRow(input.taskId);
    this.assertTaskAssignable(task, input.agentId);
    this.assertAgentMatchesProfile(input.agentId, task.profile_slug);

    if (task.status !== 'pending') {
      throw new Error(`Task ${task.task_id} is not pending.`);
    }

    this.run(
      `UPDATE macp_ext_tasks
       SET status = 'accepted',
           assigned_agent_id = :assigned_agent_id,
           assigned_session_id = :assigned_session_id,
           updated_at = :updated_at
       WHERE task_id = :task_id`,
      {
        task_id: input.taskId,
        assigned_agent_id: input.agentId,
        assigned_session_id: input.sessionId,
        updated_at: now,
      },
    );

    return {
      task: this.readTask(input.taskId),
    };
  }

  startTask(input: TaskMutationInput): { task: TaskRecord } {
    this.assertActiveSession(input.agentId, input.sessionId);
    const now = input.now ?? this.nowProvider();
    const task = this.readTaskRow(input.taskId);
    this.assertTaskAssignable(task, input.agentId);
    this.assertAgentMatchesProfile(input.agentId, task.profile_slug);

    if (!['pending', 'accepted', 'blocked'].includes(task.status)) {
      throw new Error(`Task ${task.task_id} cannot transition to in-progress from ${task.status}.`);
    }

    this.run(
      `UPDATE macp_ext_tasks
       SET status = 'in-progress',
           assigned_agent_id = :assigned_agent_id,
           assigned_session_id = :assigned_session_id,
           updated_at = :updated_at,
           reason_text = NULL
       WHERE task_id = :task_id`,
      {
        task_id: input.taskId,
        assigned_agent_id: input.agentId,
        assigned_session_id: input.sessionId,
        updated_at: now,
      },
    );

    return {
      task: this.readTask(input.taskId),
    };
  }

  completeTask(input: TaskMutationInput): { task: TaskRecord } {
    this.assertActiveSession(input.agentId, input.sessionId);
    const now = input.now ?? this.nowProvider();
    const task = this.readTaskRow(input.taskId);
    this.assertTaskOwnedBy(task, input.agentId);

    if (!['accepted', 'in-progress', 'blocked'].includes(task.status)) {
      throw new Error(`Task ${task.task_id} cannot be completed from ${task.status}.`);
    }

    this.run(
      `UPDATE macp_ext_tasks
       SET status = 'done',
           result_text = :result_text,
           reason_text = NULL,
           updated_at = :updated_at
       WHERE task_id = :task_id`,
      {
        task_id: input.taskId,
        result_text: input.result ?? '',
        updated_at: now,
      },
    );

    return {
      task: this.readTask(input.taskId),
    };
  }

  blockTask(input: TaskMutationInput): { task: TaskRecord } {
    this.assertActiveSession(input.agentId, input.sessionId);
    const now = input.now ?? this.nowProvider();
    const task = this.readTaskRow(input.taskId);
    this.assertTaskOwnedBy(task, input.agentId);

    if (!['accepted', 'in-progress'].includes(task.status)) {
      throw new Error(`Task ${task.task_id} cannot be blocked from ${task.status}.`);
    }

    this.run(
      `UPDATE macp_ext_tasks
       SET status = 'blocked',
           reason_text = :reason_text,
           updated_at = :updated_at
       WHERE task_id = :task_id`,
      {
        task_id: input.taskId,
        reason_text: input.reason ?? '',
        updated_at: now,
      },
    );

    return {
      task: this.readTask(input.taskId),
    };
  }

  cancelTask(input: TaskMutationInput): { task: TaskRecord } {
    this.assertActiveSession(input.agentId, input.sessionId);
    const now = input.now ?? this.nowProvider();
    const task = this.readTaskRow(input.taskId);

    if (task.status === 'done' || task.status === 'cancelled') {
      throw new Error(`Task ${task.task_id} cannot be cancelled from ${task.status}.`);
    }

    if (task.assigned_agent_id !== null && task.assigned_agent_id !== input.agentId && task.dispatcher_agent_id !== input.agentId) {
      throw new Error(`Task ${task.task_id} is assigned to another agent.`);
    }

    this.run(
      `UPDATE macp_ext_tasks
       SET status = 'cancelled',
           reason_text = :reason_text,
           updated_at = :updated_at
       WHERE task_id = :task_id`,
      {
        task_id: input.taskId,
        reason_text: input.reason ?? '',
        updated_at: now,
      },
    );

    return {
      task: this.readTask(input.taskId),
    };
  }

  getTask(input: GetTaskInput): GetTaskResult {
    this.assertActiveSession(input.agentId, input.sessionId);
    const task = this.readTask(input.taskId);
    const subtasks = input.includeSubtasks
      ? this.all<TaskRow>(
        `SELECT task_id, title, description, profile_slug, priority, status, goal_id, parent_task_id, dispatcher_agent_id,
                assigned_agent_id, result_text, reason_text, created_at, updated_at, archived_at
         FROM macp_ext_tasks
         WHERE parent_task_id = :parent_task_id
         ORDER BY created_at ASC`,
        { parent_task_id: input.taskId },
      ).map((row) => this.mapTask(row))
      : [];

    const goalChain: GoalRecord[] = [];
    let goalCursor = task.goalId;
    while (goalCursor !== null) {
      const goal = this.readGoal(goalCursor);
      goalChain.unshift(goal);
      goalCursor = goal.parentGoalId;
    }

    return {
      task,
      subtasks,
      goalChain,
    };
  }

  listTasks(input: ListTasksInput): { tasks: TaskRecord[] } {
    this.assertActiveSession(input.agentId, input.sessionId);
    const rows = this.all<TaskRow>(
      `SELECT task_id, title, description, profile_slug, priority, status, goal_id, parent_task_id, dispatcher_agent_id,
              assigned_agent_id, result_text, reason_text, created_at, updated_at, archived_at
       FROM macp_ext_tasks
       WHERE archived_at IS NULL
       ORDER BY CASE priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 ELSE 3 END, created_at DESC`,
      {},
    );

    return {
      tasks: rows
        .filter((row) => (input.status === undefined || row.status === input.status))
        .filter((row) => (input.profileSlug === undefined || row.profile_slug === input.profileSlug))
        .filter((row) => (input.priority === undefined || row.priority === input.priority))
        .filter((row) => (input.goalId === undefined || row.goal_id === input.goalId))
        .filter((row) => (input.assignedAgentId === undefined || row.assigned_agent_id === input.assignedAgentId))
        .slice(0, input.limit ?? 50)
        .map((row) => this.mapTask(row)),
    };
  }

  archiveTasks(input: ArchiveTasksInput): { archivedCount: number } {
    this.assertActiveSession(input.agentId, input.sessionId);
    const now = input.now ?? this.nowProvider();
    const targetStatus = input.status ?? 'done';
    const result = this.run(
      `UPDATE macp_ext_tasks
       SET archived_at = :archived_at,
           updated_at = :updated_at
       WHERE archived_at IS NULL
         AND status = :status
         AND (:goal_id IS NULL OR goal_id = :goal_id)`,
      {
        archived_at: now,
        updated_at: now,
        status: targetStatus,
        goal_id: input.goalId ?? null,
      },
    );

    return {
      archivedCount: result.changes,
    };
  }

  registerVault(input: RegisterVaultInput): { rootPath: string; indexedDocs: number; supportedExtensions: string[] } {
    this.assertActiveSession(input.agentId, input.sessionId);
    const now = input.now ?? this.nowProvider();
    const rootPath = resolve(input.path);
    const stats = statSync(rootPath);

    if (!stats.isDirectory()) {
      throw new Error(`Vault path ${rootPath} is not a directory.`);
    }

    const docs = this.collectVaultDocs(rootPath, rootPath);

    this.run('DELETE FROM macp_ext_vault_docs', {});
    for (const doc of docs) {
      this.run(
        `INSERT INTO macp_ext_vault_docs (
            doc_id, doc_path, title, content, tags_json, source_path, source_mtime, content_hash, updated_at
         ) VALUES (
            :doc_id, :doc_path, :title, :content, :tags_json, :source_path, :source_mtime, :content_hash, :updated_at
         )`,
        {
          doc_id: doc.docId,
          doc_path: doc.path,
          title: doc.title,
          content: doc.content ?? '',
          tags_json: JSON.stringify(doc.tags),
          source_path: doc.sourcePath,
          source_mtime: doc.updatedAt,
          content_hash: this.hashContent(doc.content ?? ''),
          updated_at: doc.updatedAt,
        },
      );
    }

    this.run(
      `INSERT INTO macp_ext_vault_registry (registry_id, root_path, updated_at, updated_by_agent_id)
       VALUES ('default', :root_path, :updated_at, :updated_by_agent_id)
       ON CONFLICT(registry_id) DO UPDATE SET
         root_path = excluded.root_path,
         updated_at = excluded.updated_at,
         updated_by_agent_id = excluded.updated_by_agent_id`,
      {
        root_path: rootPath,
        updated_at: now,
        updated_by_agent_id: input.agentId,
      },
    );

    return {
      rootPath,
      indexedDocs: docs.length,
      supportedExtensions: [...SUPPORTED_VAULT_EXTENSIONS].sort(),
    };
  }

  searchVault(input: SearchVaultInput): { docs: VaultDocRecord[] } {
    this.assertActiveSession(input.agentId, input.sessionId);
    const query = input.query.trim().toLowerCase();
    if (query.length === 0) {
      return { docs: [] };
    }

    const docs = this.all<VaultDocRow>(
      `SELECT doc_id, doc_path, title, content, tags_json, updated_at, source_path
       FROM macp_ext_vault_docs
       ORDER BY updated_at DESC`,
      {},
    )
      .filter((row) => this.matchesTags(row.tags_json, input.tags))
      .map((row) => ({
        row,
        score: this.textScore(`${row.doc_path}\n${row.title}\n${row.content}`, query),
      }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score || right.row.updated_at.localeCompare(left.row.updated_at))
      .slice(0, input.limit ?? 20)
      .map((entry) => this.mapVaultDoc(entry.row, false));

    return { docs };
  }

  getVaultDoc(input: GetVaultDocInput): { doc: VaultDocRecord } {
    this.assertActiveSession(input.agentId, input.sessionId);
    const row = this.get<VaultDocRow>(
      `SELECT doc_id, doc_path, title, content, tags_json, updated_at, source_path
       FROM macp_ext_vault_docs
       WHERE doc_path = :doc_path`,
      {
        doc_path: input.path.trim(),
      },
    );

    if (row === undefined) {
      throw new Error(`Vault doc ${input.path} was not found.`);
    }

    return {
      doc: this.mapVaultDoc(row, true),
    };
  }

  listVaultDocs(input: ListVaultDocsInput): { docs: VaultDocRecord[] } {
    this.assertActiveSession(input.agentId, input.sessionId);
    return {
      docs: this.all<VaultDocRow>(
        `SELECT doc_id, doc_path, title, content, tags_json, updated_at, source_path
         FROM macp_ext_vault_docs
         ORDER BY doc_path ASC`,
        {},
      )
        .filter((row) => this.matchesTags(row.tags_json, input.tags))
        .slice(0, input.limit ?? 100)
        .map((row) => this.mapVaultDoc(row, false)),
    };
  }

  queryContext(input: QueryContextInput): QueryContextResult {
    this.assertActiveSession(input.agentId, input.sessionId);
    const query = input.query.trim().toLowerCase();
    if (query.length === 0) {
      return { results: [] };
    }

    const memoryRows = this.all<{
      memory_id: string;
      scope: string;
      memory_key: string;
      value_text: string;
      owner_agent_id: string | null;
      channel_id: string | null;
      tags_json: string;
      updated_at: string;
    }>(
      `SELECT memory_id, scope, memory_key, value_text, owner_agent_id, channel_id, tags_json, updated_at
       FROM macp_ext_memories
       WHERE archived_at IS NULL
       ORDER BY updated_at DESC`,
      {},
    ).filter((row) => this.isVisibleMemory(row, input.agentId, input.channelId));

    const taskRows = this.all<TaskRow>(
      `SELECT task_id, title, description, profile_slug, priority, status, goal_id, parent_task_id, dispatcher_agent_id,
              assigned_agent_id, result_text, reason_text, created_at, updated_at, archived_at
       FROM macp_ext_tasks
       WHERE status = 'done'
       ORDER BY updated_at DESC`,
      {},
    );

    const goalRows = this.all<GoalRow>(
      `SELECT goal_id, goal_type, title, description, status, parent_goal_id, owner_agent_id, created_by_agent_id, created_at, updated_at
       FROM macp_ext_goals
       ORDER BY updated_at DESC`,
      {},
    );

    const vaultRows = this.all<VaultDocRow>(
      `SELECT doc_id, doc_path, title, content, tags_json, updated_at, source_path
       FROM macp_ext_vault_docs
       ORDER BY updated_at DESC`,
      {},
    );

    const results: QueryContextEntry[] = [];

    for (const row of memoryRows) {
      const score = this.textScore(`${row.memory_key}\n${row.value_text}`, query);
      if (score > 0) {
        results.push({
          kind: 'memory',
          id: row.memory_id,
          title: row.memory_key,
          snippet: this.makeSnippet(row.value_text, query),
          score,
          metadata: {
            scope: row.scope,
            channelId: row.channel_id,
            tags: this.parseJson<string[]>(row.tags_json, []),
          },
        });
      }
    }

    for (const row of vaultRows) {
      const score = this.textScore(`${row.doc_path}\n${row.title}\n${row.content}`, query);
      if (score > 0) {
        results.push({
          kind: 'vault_doc',
          id: row.doc_id,
          title: row.title,
          snippet: this.makeSnippet(row.content, query),
          score,
          metadata: {
            path: row.doc_path,
            tags: this.parseJson<string[]>(row.tags_json, []),
          },
        });
      }
    }

    for (const row of taskRows) {
      const score = this.textScore(`${row.title}\n${row.description}\n${row.result_text ?? ''}`, query);
      if (score > 0) {
        results.push({
          kind: 'task',
          id: row.task_id,
          title: row.title,
          snippet: this.makeSnippet(`${row.description}\n${row.result_text ?? ''}`, query),
          score,
          metadata: {
            status: row.status,
            goalId: row.goal_id,
            profileSlug: row.profile_slug,
          },
        });
      }
    }

    for (const row of goalRows) {
      const score = this.textScore(`${row.title}\n${row.description}`, query);
      if (score > 0) {
        results.push({
          kind: 'goal',
          id: row.goal_id,
          title: row.title,
          snippet: this.makeSnippet(row.description, query),
          score,
          metadata: {
            type: row.goal_type,
            status: row.status,
            parentGoalId: row.parent_goal_id,
          },
        });
      }
    }

    return {
      results: results
        .sort((left, right) => right.score - left.score || left.kind.localeCompare(right.kind))
        .slice(0, input.limit ?? 10),
    };
  }

  private applyConnectionContract(): void {
    const pragmas = getConnectionPragmas();
    this.db.exec(`PRAGMA journal_mode=${pragmas.journalMode}`);
    this.db.exec(`PRAGMA busy_timeout=${pragmas.busyTimeout}`);
    this.db.exec(`PRAGMA foreign_keys=${pragmas.foreignKeys ? 'ON' : 'OFF'}`);
    this.db.exec(getSchemaDdl());
    this.db.exec(ADVANCED_SCHEMA_DDL);
  }

  private assertActiveSession(agentId: string, sessionId: string): void {
    const row = this.get<ActiveSessionRow>(
      `SELECT session_id
       FROM sessions
       WHERE agent_id = :agent_id
         AND session_id = :session_id
         AND state = 'active'`,
      {
        agent_id: agentId,
        session_id: sessionId,
      },
    );

    if (row === undefined) {
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

  private assertAgentExists(agentId: string): void {
    const row = this.get<{ agent_id: string }>(
      'SELECT agent_id FROM agents WHERE agent_id = :agent_id',
      { agent_id: agentId },
    );
    if (row === undefined) {
      throw new Error(`Agent ${agentId} does not exist.`);
    }
  }

  private assertProfileExists(profileSlug: string): void {
    const row = this.get<{ slug: string }>(
      'SELECT slug FROM macp_ext_profiles WHERE slug = :slug',
      { slug: profileSlug.trim().toLowerCase() },
    );
    if (row === undefined) {
      throw new Error(`Profile ${profileSlug} does not exist.`);
    }
  }

  private assertGoalExists(goalId: string): void {
    const row = this.get<{ goal_id: string }>(
      'SELECT goal_id FROM macp_ext_goals WHERE goal_id = :goal_id',
      { goal_id: goalId },
    );
    if (row === undefined) {
      throw new Error(`Goal ${goalId} does not exist.`);
    }
  }

  private assertTaskExists(taskId: string): void {
    const row = this.get<{ task_id: string }>(
      'SELECT task_id FROM macp_ext_tasks WHERE task_id = :task_id',
      { task_id: taskId },
    );
    if (row === undefined) {
      throw new Error(`Task ${taskId} does not exist.`);
    }
  }

  private assertAgentMatchesProfile(agentId: string, profileSlug: string | null): void {
    if (profileSlug === null) {
      return;
    }

    const state = this.get<AgentStateRow>(
      'SELECT status, profile_slug FROM macp_ext_agent_state WHERE agent_id = :agent_id',
      { agent_id: agentId },
    );
    if (state?.profile_slug !== profileSlug) {
      throw new Error(`Agent ${agentId} is not currently registered with profile ${profileSlug}.`);
    }
  }

  private assertTaskAssignable(task: TaskRow, agentId: string): void {
    if (task.assigned_agent_id !== null && task.assigned_agent_id !== agentId) {
      throw new Error(`Task ${task.task_id} is already assigned to ${task.assigned_agent_id}.`);
    }
  }

  private assertTaskOwnedBy(task: TaskRow, agentId: string): void {
    if (task.assigned_agent_id !== agentId) {
      throw new Error(`Task ${task.task_id} is not assigned to ${agentId}.`);
    }
  }

  private readProfile(slug: string): ProfileRecord {
    const row = this.get<ProfileRow>(
      `SELECT slug, name, role, context_pack, skills_json, memory_keys_json, vault_paths_json, updated_at
       FROM macp_ext_profiles
       WHERE slug = :slug`,
      { slug },
    );

    if (row === undefined) {
      throw new Error(`Profile ${slug} does not exist.`);
    }

    return this.mapProfile(row);
  }

  private mapProfile(row: ProfileRow): ProfileRecord {
    return {
      slug: row.slug,
      name: row.name,
      role: row.role,
      contextPack: row.context_pack,
      skills: this.parseJson<Array<{ id: string; name: string; tags: string[] }>>(row.skills_json, []),
      memoryKeys: this.parseJson<string[]>(row.memory_keys_json, []),
      vaultPaths: this.parseJson<string[]>(row.vault_paths_json, []),
      updatedAt: row.updated_at,
    };
  }

  private readGoalRow(goalId: string): GoalRow {
    const row = this.get<GoalRow>(
      `SELECT goal_id, goal_type, title, description, status, parent_goal_id, owner_agent_id, created_by_agent_id, created_at, updated_at
       FROM macp_ext_goals
       WHERE goal_id = :goal_id`,
      { goal_id: goalId },
    );

    if (row === undefined) {
      throw new Error(`Goal ${goalId} does not exist.`);
    }

    return row;
  }

  private readGoal(goalId: string): GoalRecord {
    return this.mapGoal(this.readGoalRow(goalId));
  }

  private mapGoal(row: GoalRow): GoalRecord {
    return {
      goalId: row.goal_id,
      type: row.goal_type,
      title: row.title,
      description: row.description,
      status: row.status,
      parentGoalId: row.parent_goal_id,
      ownerAgentId: row.owner_agent_id,
      createdByAgentId: row.created_by_agent_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      progress: this.goalProgress(row.goal_id),
    };
  }

  private goalProgress(goalId: string): GoalProgress {
    const count = this.get<{ total: number; completed: number }>(
      `SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS completed
       FROM macp_ext_tasks
       WHERE goal_id = :goal_id
         AND archived_at IS NULL`,
      { goal_id: goalId },
    );
    const totalTasks = count?.total ?? 0;
    const completedTasks = count?.completed ?? 0;
    return {
      totalTasks,
      completedTasks,
      completionRatio: totalTasks === 0 ? 0 : completedTasks / totalTasks,
    };
  }

  private readTaskRow(taskId: string): TaskRow {
    const row = this.get<TaskRow>(
      `SELECT task_id, title, description, profile_slug, priority, status, goal_id, parent_task_id, dispatcher_agent_id,
              assigned_agent_id, result_text, reason_text, created_at, updated_at, archived_at
       FROM macp_ext_tasks
       WHERE task_id = :task_id`,
      { task_id: taskId },
    );

    if (row === undefined) {
      throw new Error(`Task ${taskId} does not exist.`);
    }

    return row;
  }

  private readTask(taskId: string): TaskRecord {
    return this.mapTask(this.readTaskRow(taskId));
  }

  private mapTask(row: TaskRow): TaskRecord {
    return {
      taskId: row.task_id,
      title: row.title,
      description: row.description,
      profileSlug: row.profile_slug,
      priority: row.priority as TaskPriority,
      status: row.status as TaskStatus,
      goalId: row.goal_id,
      parentTaskId: row.parent_task_id,
      dispatcherAgentId: row.dispatcher_agent_id,
      assignedAgentId: row.assigned_agent_id,
      result: row.result_text,
      reason: row.reason_text,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      archivedAt: row.archived_at,
    };
  }

  private collectVaultDocs(rootPath: string, currentPath: string): VaultDocRecord[] {
    const docs: VaultDocRecord[] = [];
    for (const entry of readdirSync(currentPath, { withFileTypes: true })) {
      const absolutePath = resolve(currentPath, entry.name);
      if (entry.isDirectory()) {
        docs.push(...this.collectVaultDocs(rootPath, absolutePath));
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const extension = extname(entry.name).toLowerCase();
      if (!SUPPORTED_VAULT_EXTENSIONS.has(extension)) {
        continue;
      }

      const content = readFileSync(absolutePath, 'utf8');
      const stats = statSync(absolutePath);
      docs.push({
        docId: randomUUID(),
        path: relative(rootPath, absolutePath).split('\\').join('/'),
        title: this.extractTitle(entry.name, content),
        tags: this.deriveVaultTags(rootPath, absolutePath),
        updatedAt: stats.mtime.toISOString(),
        sourcePath: absolutePath,
        content,
      });
    }

    return docs;
  }

  private extractTitle(fileName: string, content: string): string {
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('#')) {
        return trimmed.replace(/^#+\s*/, '').trim() || basename(fileName, extname(fileName));
      }
    }

    return basename(fileName, extname(fileName));
  }

  private deriveVaultTags(rootPath: string, absolutePath: string): string[] {
    const rel = relative(rootPath, absolutePath).split('\\').join('/');
    const noExt = rel.replace(/\.[^.]+$/, '');
    const parts = noExt.split('/').flatMap((part) => part.split(/[^a-zA-Z0-9]+/g));
    return [...new Set(parts.map((part) => part.trim().toLowerCase()).filter((part) => part.length > 0))];
  }

  private mapVaultDoc(row: VaultDocRow, includeContent: boolean): VaultDocRecord {
    return {
      docId: row.doc_id,
      path: row.doc_path,
      title: row.title,
      tags: this.parseJson<string[]>(row.tags_json, []),
      updatedAt: row.updated_at,
      sourcePath: row.source_path,
      content: includeContent ? row.content : undefined,
    };
  }

  private hashContent(content: string): string {
    return createHash('sha256').update(content).digest('hex');
  }

  private normalizeSkills(
    skills: Array<{ id: string; name: string; tags?: string[] | undefined }> | undefined,
  ): Array<{ id: string; name: string; tags: string[] }> {
    if (skills === undefined) {
      return [];
    }

    return skills
      .map((skill) => ({
        id: skill.id.trim().toLowerCase(),
        name: skill.name.trim(),
        tags: this.normalizeStrings(skill.tags).map((tag) => tag.toLowerCase()),
      }))
      .filter((skill) => skill.id.length > 0 && skill.name.length > 0);
  }

  private normalizeStrings(values: string[] | undefined): string[] {
    if (values === undefined) {
      return [];
    }

    return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
  }

  private parseJson<T>(value: string, fallback: T): T {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }

  private textScore(text: string, query: string): number {
    const lowerText = text.toLowerCase();
    const tokens = query.split(/\s+/g).map((token) => token.trim()).filter((token) => token.length > 0);
    let score = 0;
    for (const token of tokens) {
      if (lowerText.includes(token)) {
        score += token.length;
      }
    }
    return score;
  }

  private makeSnippet(text: string, query: string): string {
    const lowerText = text.toLowerCase();
    const index = lowerText.indexOf(query.split(/\s+/g)[0] ?? '');
    if (index === -1) {
      return text.length > 200 ? `${text.slice(0, 197)}...` : text;
    }
    const start = Math.max(0, index - 60);
    const end = Math.min(text.length, index + 140);
    const snippet = text.slice(start, end).trim();
    return start > 0 || end < text.length ? `...${snippet}...` : snippet;
  }

  private matchesTags(tagsJson: string, requiredTags: string[] | undefined): boolean {
    if (requiredTags === undefined || requiredTags.length === 0) {
      return true;
    }

    const rowTags = new Set(this.parseJson<string[]>(tagsJson, []));
    return this.normalizeStrings(requiredTags).every((tag) => rowTags.has(tag.toLowerCase()) || rowTags.has(tag));
  }

  private isVisibleMemory(
    row: {
      scope: string;
      owner_agent_id: string | null;
      channel_id: string | null;
    },
    agentId: string,
    channelId: string | undefined,
  ): boolean {
    switch (row.scope) {
      case 'agent':
        return row.owner_agent_id === agentId;
      case 'channel':
        return channelId !== undefined && row.channel_id === channelId;
      case 'workspace':
        return true;
      default:
        return false;
    }
  }

  private releaseAgentClaims(agentId: string, sessionId: string, now: string, reason: string): void {
    this.run(
      `UPDATE macp_ext_file_claims
       SET released_at = :released_at,
           release_reason = :release_reason
       WHERE agent_id = :agent_id
         AND session_id = :session_id
         AND released_at IS NULL`,
      {
        released_at: now,
        release_reason: reason,
        agent_id: agentId,
        session_id: sessionId,
      },
    );
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
