import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

type SchemaNode = {
  const?: string | number | boolean;
  properties?: Record<string, SchemaNode>;
};

type LoadedSchema = {
  properties: {
    connection: {
      properties: {
        pragmas: {
          properties: {
            journal_mode: { const: string };
            busy_timeout: { const: number };
            foreign_keys: { const: boolean };
          };
        };
        schema_ddl: { const: string };
      };
    };
    operations: {
      properties: Record<string, { properties: Record<string, { const?: string; description?: string }> }>;
    };
    context_budget_pruning: {
      properties: {
        default_budget_bytes: { const: number };
      };
    };
    agent_prompt_template: { const: string };
  };
};

let cachedSchema: LoadedSchema | null = null;

function schemaCandidates(): string[] {
  const sourceDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.MACP_SCHEMA_PATH,
    resolve(process.cwd(), 'macp.schema.json'),
    resolve(sourceDir, '..', 'macp.schema.json'),
    resolve(sourceDir, '..', '..', 'macp.schema.json'),
  ];

  return [...new Set(candidates.filter((candidate): candidate is string => Boolean(candidate)))];
}

export function loadMacpSchema(): LoadedSchema {
  if (cachedSchema !== null) {
    return cachedSchema;
  }

  for (const candidate of schemaCandidates()) {
    if (!existsSync(candidate)) {
      continue;
    }

    cachedSchema = JSON.parse(readFileSync(candidate, 'utf8')) as LoadedSchema;
    return cachedSchema;
  }

  throw new Error(`Unable to locate macp.schema.json. Checked: ${schemaCandidates().join(', ')}`);
}

export function getConnectionPragmas(): {
  journalMode: string;
  busyTimeout: number;
  foreignKeys: boolean;
} {
  const pragmas = loadMacpSchema().properties.connection.properties.pragmas.properties;
  return {
    journalMode: pragmas.journal_mode.const,
    busyTimeout: pragmas.busy_timeout.const,
    foreignKeys: pragmas.foreign_keys.const,
  };
}

export function getSchemaDdl(): string {
  return loadMacpSchema().properties.connection.properties.schema_ddl.const;
}

export function getOperationSql(operation: string, step: string): string {
  const operationNode = loadMacpSchema().properties.operations.properties[operation];
  const stepNode = operationNode?.properties?.[step];

  if (typeof stepNode?.const !== 'string') {
    throw new Error(`Missing SQL for operations.${operation}.${step}`);
  }

  return stepNode.const;
}

export function getDefaultBudgetBytes(): number {
  return loadMacpSchema().properties.context_budget_pruning.properties.default_budget_bytes.const;
}

export function getAgentPromptTemplate(): string {
  return loadMacpSchema().properties.agent_prompt_template.const;
}

export function getSchemaValue(path: string[]): string | number | boolean | undefined {
  let cursor: SchemaNode | undefined = loadMacpSchema() as unknown as SchemaNode;

  for (const part of path) {
    cursor = cursor?.properties?.[part];
  }

  return cursor?.const;
}
