/**
 * MACP 2.0 reference center — HTTP host.
 * One long-lived process serving MCP over streamable HTTP (spec §3):
 * every agent in the fleet connects to the same URL; each MCP session is one agent.
 *
 *   macp-center [--port 7737] [--db ./macp.db]
 *   MACP_OPERATOR_TOKEN=…   optional; when set, operator registration requires it.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Store } from "./store.js";
import { Notifier, buildSessionServer, type SessionCtx } from "./server.js";

const args = process.argv.slice(2);
const flag = (name: string, dflt: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};

const PORT = Number(flag("port", process.env.MACP_PORT ?? "7737"));
const DB = flag("db", process.env.MACP_DB ?? "./macp.db");
const OPERATOR_TOKEN = process.env.MACP_OPERATOR_TOKEN ?? null;

const store = new Store(DB);
const notifier = new Notifier();

interface Session {
  transport: StreamableHTTPServerTransport;
  ctx: SessionCtx;
}
const sessions = new Map<string, Session>();

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  if (url.pathname !== "/mcp") {
    res.writeHead(404).end("MACP center: MCP endpoint is /mcp");
    return;
  }

  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  // Existing session → route to its transport.
  if (sessionId && sessions.has(sessionId)) {
    const s = sessions.get(sessionId)!;
    if (s.ctx.address) store.heartbeat(s.ctx.address);
    await s.transport.handleRequest(req, res);
    if (req.method === "DELETE") endSession(sessionId);
    return;
  }

  // New session → new transport + per-session MCP server.
  if (req.method === "POST") {
    const ctx = buildSessionServer(store, notifier, { operatorToken: OPERATOR_TOKEN });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        ctx.sessionId = id;
        sessions.set(id, { transport, ctx });
      },
    });
    transport.onclose = () => {
      if (ctx.sessionId) endSession(ctx.sessionId);
    };
    await ctx.server.connect(transport);
    await transport.handleRequest(req, res);
    return;
  }

  res.writeHead(400).end("unknown session");
}

function endSession(id: string) {
  const s = sessions.get(id);
  if (!s) return;
  sessions.delete(id);
  notifier.unbind(s.ctx);
  if (s.ctx.address && !s.ctx.isOperator) store.markStale(s.ctx.address); // spec §5.2 — inbox retained
}

const httpServer = createServer((req, res) => {
  handle(req, res).catch((e) => {
    console.error("request error:", e);
    if (!res.headersSent) res.writeHead(500).end("internal error");
  });
});

httpServer.listen(PORT, () => {
  console.log(`MACP center listening on http://localhost:${PORT}/mcp (db: ${DB})`);
});

process.on("SIGINT", () => {
  httpServer.close();
  store.close();
  process.exit(0);
});
