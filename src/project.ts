import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

export const MACP_CONFIG_DIR = '.macp';
export const MACP_CONFIG_FILENAME = 'config.json';
export const MACP_MCP_FILENAME = '.mcp.json';
export const MACP_OPENCODE_CONFIG_FILENAME = 'opencode.json';
export const MACP_GEMINI_SETTINGS_PATH = '.gemini/settings.json';
export const MACP_VSCODE_MCP_PATH = '.vscode/mcp.json';
export const MACP_CURSOR_MCP_PATH = '.cursor/mcp.json';
export const MACP_AGENT_BLOCK_START = '<!-- MACP-MCP:START -->';
export const MACP_AGENT_BLOCK_END = '<!-- MACP-MCP:END -->';

export type MacpProjectConfig = {
  version: 1;
  packageName: 'macp-mcp';
  projectRoot: string;
  projectId: string;
  defaultChannel: string;
  dbPath: string;
  createdAt: string;
  updatedAt: string;
};

export type InitProjectOptions = {
  projectRoot?: string;
  projectId?: string;
  defaultChannel?: string;
  dbPath?: string;
  force?: boolean;
  now?: () => string;
};

export type InitProjectResult = {
  projectRoot: string;
  projectId: string;
  configPath: string;
  mcpConfigPath: string;
  dbPath: string;
  defaultChannel: string;
  updatedFiles: string[];
};

export type LoadedProjectConfig = {
  path: string;
  config: MacpProjectConfig;
};

function normalizeOptionalString(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function slugifyIdentifier(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

function buildAgentInstructionBlock(projectId: string, channel: string): string {
  return `${MACP_AGENT_BLOCK_START}
## MACP Coordination

MACP is active for this project. The shared project id is \`${projectId}\`. The MCP server auto-registers this session on startup and auto-joins the default channel \`${channel}\`.

Normal workflow:
- do not run SQL directly
- do not manually attach another MACP server inside the agent loop
- call \`macp_poll\` regularly to stay aware of peer work
- call \`macp_send_channel\` for shared updates and \`macp_send_direct\` for one-to-one requests
- call \`macp_ack\` after acting on a delivery
- use \`macp_ext_claim_files\`, shared memory, tasks, goals, and vault tools when this project requires them

If this project uses shared memory, tasks, goals, or the vault, follow the local instructions in this file and use those tools as part of normal work.
${MACP_AGENT_BLOCK_END}
`;
}

function upsertMarkedBlock(filePath: string, block: string): boolean {
  const existing = existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';
  const startIndex = existing.indexOf(MACP_AGENT_BLOCK_START);
  const endIndex = existing.indexOf(MACP_AGENT_BLOCK_END);

  let nextContent: string;
  if (startIndex >= 0 && endIndex >= startIndex) {
    nextContent = `${existing.slice(0, startIndex)}${block}${existing.slice(endIndex + MACP_AGENT_BLOCK_END.length)}`.replace(/\n{3,}/g, '\n\n');
  } else if (existing.trim().length === 0) {
    nextContent = `${block.trimEnd()}\n`;
  } else {
    nextContent = `${existing.trimEnd()}\n\n${block.trimEnd()}\n`;
  }

  if (existing === nextContent) {
    return false;
  }

  writeFileSync(filePath, nextContent, 'utf8');
  return true;
}

function readJsonFile<T>(filePath: string): T | undefined {
  if (!existsSync(filePath)) {
    return undefined;
  }

  return JSON.parse(readFileSync(filePath, 'utf8')) as T;
}

function defaultLocalProjectDbPath(projectRoot: string, projectId: string): string {
  return resolve(projectRoot, MACP_CONFIG_DIR, `${projectId}.macp.db`);
}

function defaultSharedProjectDbPath(projectId: string): string {
  return resolve(homedir(), '.macp', 'projects', `${projectId}.macp.db`);
}

export function defaultProjectDbPath(projectRoot: string, projectId: string, shared: boolean): string {
  return shared ? defaultSharedProjectDbPath(projectId) : defaultLocalProjectDbPath(projectRoot, projectId);
}

function resolveDbPath(projectRoot: string, dbPath: string | undefined, projectId: string, shared: boolean): string {
  const requested = normalizeOptionalString(dbPath);
  if (requested === undefined) {
    return defaultProjectDbPath(projectRoot, projectId, shared);
  }

  return resolve(projectRoot, requested);
}

export function findProjectConfigPath(startDir: string = process.cwd()): string | undefined {
  let current = resolve(startDir);

  while (true) {
    const candidate = join(current, MACP_CONFIG_DIR, MACP_CONFIG_FILENAME);
    if (existsSync(candidate)) {
      return candidate;
    }

    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }

    current = parent;
  }
}

export function loadProjectConfig(startDir: string = process.cwd()): LoadedProjectConfig | undefined {
  const configPath = findProjectConfigPath(startDir);
  if (configPath === undefined) {
    return undefined;
  }

  const rawConfig = readJsonFile<MacpProjectConfig>(configPath);
  const config = rawConfig === undefined
    ? undefined
    : rawConfig;
  if (config === undefined) {
    return undefined;
  }

  return {
    path: configPath,
    config,
  };
}

function buildProjectConfig(options: InitProjectOptions): MacpProjectConfig {
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const now = options.now?.() ?? new Date().toISOString();
  const requestedProjectId = normalizeOptionalString(options.projectId)
    ?? basename(projectRoot);
  const projectId = slugifyIdentifier(requestedProjectId) || 'macp';
  const sharedProject = normalizeOptionalString(options.projectId) !== undefined;
  const defaultChannel = slugifyIdentifier(
    normalizeOptionalString(options.defaultChannel) ?? projectId,
  ) || 'macp';

  return {
    version: 1,
    packageName: 'macp-mcp',
    projectRoot,
    projectId,
    defaultChannel,
    dbPath: resolveDbPath(projectRoot, options.dbPath, projectId, sharedProject),
    createdAt: now,
    updatedAt: now,
  };
}

function buildStandardMcpServer(projectRoot: string): Record<string, unknown> {
  return {
    command: 'npx',
    args: ['-y', 'macp-mcp', 'server'],
    env: {
      MACP_PROJECT_ROOT: projectRoot,
    },
  };
}

function buildMcpConfig(projectRoot: string): Record<string, unknown> {
  return {
    mcpServers: {
      macp: buildStandardMcpServer(projectRoot),
    },
  };
}

function buildVsCodeMcpConfig(projectRoot: string): Record<string, unknown> {
  return {
    servers: {
      macp: {
        type: 'stdio',
        ...buildStandardMcpServer(projectRoot),
      },
    },
  };
}

function buildOpenCodeConfig(projectRoot: string): Record<string, unknown> {
  return {
    $schema: 'https://opencode.ai/config.json',
    instructions: ['AGENTS.md'],
    mcp: {
      macp: {
        type: 'local',
        command: ['npx', '-y', 'macp-mcp', 'server'],
        enabled: true,
        environment: {
          MACP_PROJECT_ROOT: projectRoot,
        },
      },
    },
  };
}

export function initProject(options: InitProjectOptions = {}): InitProjectResult {
  const config = buildProjectConfig(options);
  const macpDir = join(config.projectRoot, MACP_CONFIG_DIR);
  const configPath = join(macpDir, MACP_CONFIG_FILENAME);
  const mcpConfigPath = join(config.projectRoot, MACP_MCP_FILENAME);
  const updatedFiles: string[] = [];

  mkdirSync(macpDir, { recursive: true });

  const existingConfig = readJsonFile<MacpProjectConfig>(configPath);
  const explicitProjectIdOverride = normalizeOptionalString(options.projectId) !== undefined;
  const explicitChannelOverride = normalizeOptionalString(options.defaultChannel) !== undefined;
  const explicitDbOverride = normalizeOptionalString(options.dbPath) !== undefined;
  const nextConfig: MacpProjectConfig = existingConfig && !options.force
    ? {
        ...existingConfig,
        packageName: 'macp-mcp',
        projectRoot: config.projectRoot,
        projectId: explicitProjectIdOverride ? config.projectId : existingConfig.projectId,
        defaultChannel: explicitChannelOverride ? config.defaultChannel : existingConfig.defaultChannel,
        dbPath: explicitDbOverride || explicitProjectIdOverride ? config.dbPath : existingConfig.dbPath,
        updatedAt: config.updatedAt,
      }
    : config;

  if (existingConfig === undefined || JSON.stringify(existingConfig) !== JSON.stringify(nextConfig)) {
    writeFileSync(configPath, `${JSON.stringify(nextConfig, null, 2)}\n`, 'utf8');
    updatedFiles.push(configPath);
  }

  const gitignorePath = join(macpDir, '.gitignore');
  const gitignoreContent = ['*.db', '*.db-shm', '*.db-wal', 'config.local.json'].join('\n') + '\n';
  if (!existsSync(gitignorePath) || readFileSync(gitignorePath, 'utf8') !== gitignoreContent) {
    writeFileSync(gitignorePath, gitignoreContent, 'utf8');
    updatedFiles.push(gitignorePath);
  }

  const writeMergedJsonFile = (filePath: string, fieldName: 'mcpServers' | 'servers', payload: Record<string, unknown>): void => {
    const existing = readJsonFile<Record<string, unknown>>(filePath) ?? {};
    const existingField = (existing[fieldName] ?? {}) as Record<string, unknown>;
    const nextValue = {
      ...existing,
      [fieldName]: {
        ...existingField,
        ...payload,
      },
    };

    mkdirSync(dirname(filePath), { recursive: true });
    if (JSON.stringify(existing) !== JSON.stringify(nextValue)) {
      writeFileSync(filePath, `${JSON.stringify(nextValue, null, 2)}\n`, 'utf8');
      updatedFiles.push(filePath);
    }
  };

  const writeMergedGeminiSettings = (filePath: string): void => {
    const existing = readJsonFile<Record<string, unknown>>(filePath) ?? {};
    const existingMcpServers = (existing.mcpServers ?? {}) as Record<string, unknown>;
    const existingContext = (existing.context ?? {}) as Record<string, unknown>;
    const nextValue = {
      ...existing,
      mcpServers: {
        ...existingMcpServers,
        ...((buildMcpConfig(config.projectRoot).mcpServers ?? {}) as Record<string, unknown>),
      },
      context: {
        ...existingContext,
        fileName: 'AGENTS.md',
      },
    };

    mkdirSync(dirname(filePath), { recursive: true });
    if (JSON.stringify(existing) !== JSON.stringify(nextValue)) {
      writeFileSync(filePath, `${JSON.stringify(nextValue, null, 2)}\n`, 'utf8');
      updatedFiles.push(filePath);
    }
  };

  const writeMergedOpenCodeConfig = (filePath: string): void => {
    const existing = readJsonFile<Record<string, unknown>>(filePath) ?? {};
    const built = buildOpenCodeConfig(config.projectRoot);
    const existingMcp = (existing.mcp ?? {}) as Record<string, unknown>;
    const existingInstructions = Array.isArray(existing.instructions)
      ? existing.instructions.filter((value): value is string => typeof value === 'string')
      : [];
    const nextInstructions = existingInstructions.includes('AGENTS.md')
      ? existingInstructions
      : ['AGENTS.md', ...existingInstructions];
    const nextValue = {
      ...existing,
      $schema: built.$schema,
      instructions: nextInstructions,
      mcp: {
        ...existingMcp,
        ...((built.mcp ?? {}) as Record<string, unknown>),
      },
    };

    if (JSON.stringify(existing) !== JSON.stringify(nextValue)) {
      writeFileSync(filePath, `${JSON.stringify(nextValue, null, 2)}\n`, 'utf8');
      updatedFiles.push(filePath);
    }
  };

  writeMergedJsonFile(
    mcpConfigPath,
    'mcpServers',
    (buildMcpConfig(config.projectRoot).mcpServers ?? {}) as Record<string, unknown>,
  );
  writeMergedGeminiSettings(join(config.projectRoot, MACP_GEMINI_SETTINGS_PATH));
  writeMergedJsonFile(
    join(config.projectRoot, MACP_CURSOR_MCP_PATH),
    'mcpServers',
    (buildMcpConfig(config.projectRoot).mcpServers ?? {}) as Record<string, unknown>,
  );
  writeMergedJsonFile(
    join(config.projectRoot, MACP_VSCODE_MCP_PATH),
    'servers',
    (buildVsCodeMcpConfig(config.projectRoot).servers ?? {}) as Record<string, unknown>,
  );
  writeMergedOpenCodeConfig(join(config.projectRoot, MACP_OPENCODE_CONFIG_FILENAME));

  const agentBlock = buildAgentInstructionBlock(nextConfig.projectId, nextConfig.defaultChannel);
  for (const filePath of [join(config.projectRoot, 'AGENTS.md'), join(config.projectRoot, 'CLAUDE.md')]) {
    if (upsertMarkedBlock(filePath, agentBlock)) {
      updatedFiles.push(filePath);
    }
  }

  return {
    projectRoot: config.projectRoot,
    projectId: nextConfig.projectId,
    configPath,
    mcpConfigPath,
    dbPath: nextConfig.dbPath,
    defaultChannel: nextConfig.defaultChannel,
    updatedFiles,
  };
}
