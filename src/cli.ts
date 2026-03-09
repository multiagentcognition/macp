#!/usr/bin/env node

import { parseArgs } from 'node:util';

import { initProject } from './project.js';
import { runServerCli } from './server.js';

function printCliHelp(): void {
  console.log(`MACP MCP CLI

Usage:
  macp-mcp init [options]
  macp-mcp server [options]
  macp-mcp help

Commands:
  init      Activate MACP for the current project
  server    Run the stdio MCP server for one agent session
  help      Show this help

Examples:
  npx -y macp-mcp init
  npx -y macp-mcp server
`);
}

function runInitCli(args: string[]): void {
  const parsed = parseArgs({
    args,
    options: {
      help: {
        type: 'boolean',
        short: 'h',
      },
      'project-id': {
        type: 'string',
      },
      channel: {
        type: 'string',
      },
      db: {
        type: 'string',
      },
      force: {
        type: 'boolean',
      },
    },
    allowPositionals: false,
    strict: true,
  });

  if (parsed.values.help) {
    console.log(`Activate MACP for the current project

Usage:
  macp-mcp init [options]

Options:
  --project-id <id>  Override the logical shared workspace id
  --channel <id>     Override the default MACP broadcast channel
  --db <path>        Override the shared SQLite file path
  --force            Replace existing MACP project config values
  -h, --help         Show help
`);
    return;
  }

  const projectId = parsed.values['project-id'];
  const result = initProject({
    ...(projectId !== undefined ? { projectId } : {}),
    ...(parsed.values.channel !== undefined ? { defaultChannel: parsed.values.channel } : {}),
    ...(parsed.values.db !== undefined ? { dbPath: parsed.values.db } : {}),
    force: parsed.values.force ?? false,
  });

  console.log(`MACP activated for this project

Project root: ${result.projectRoot}
Project id: ${result.projectId}
Shared DB: ${result.dbPath}
Default channel: ${result.defaultChannel}

Updated files:
${result.updatedFiles.map((filePath) => `- ${filePath}`).join('\n')}

Next:
1. Open Claude, Codex, Gemini CLI, Goose, or another MCP-capable agent in this project.
2. The host should load .mcp.json and start macp-mcp automatically.
3. Each agent session will auto-register, auto-join the default channel on startup, and deregister on normal shutdown.
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command === undefined) {
    printCliHelp();
    return;
  }

  if (command === 'help' || command === '--help' || command === '-h') {
    printCliHelp();
    return;
  }

  if (command === 'init') {
    runInitCli(args.slice(1));
    return;
  }

  if (command === 'server') {
    await runServerCli(args);
    return;
  }

  printCliHelp();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
