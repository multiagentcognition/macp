/**
 * MACP 2.0 reference coordinator — per-session MCP server (spec §6).
 * Tools: macp_register / macp_send / macp_ack / macp_roster / macp_grant.
 * Resources: macp://self · macp://project/{project}/roster · macp://agent/{address}/inbox.
 * All standard MCP: no custom methods, no custom notification types.
 */
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SubscribeRequestSchema, UnsubscribeRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { Store, type Priority } from "./store.js";
import { resolveProject } from "./scope.js";

export interface SessionCtx {
  sessionId: string;
  address: string | null; // assigned at register (or provisional)
  project: string | null;
  isOperator: boolean;
  roots: string[];
  subscriptions: Set<string>; // resource URIs this session subscribed to
  server: McpServer;
}

/** Cross-session router: address → live session, for inbox update notifications. */
export class Hub {
  private byAddress = new Map<string, SessionCtx>();

  bind(ctx: SessionCtx): void {
    if (ctx.address) this.byAddress.set(ctx.address, ctx);
  }

  unbind(ctx: SessionCtx): void {
    if (ctx.address && this.byAddress.get(ctx.address) === ctx) this.byAddress.delete(ctx.address);
  }

  /** Notify the recipient's session that its inbox resource changed (spec §6.2/§6.3 rung 1). */
  async notifyInbox(address: string): Promise<void> {
    const ctx = this.byAddress.get(address);
    if (!ctx) return; // offline — delivery waits durably in the store
    const uri = `macp://agent/${address}/inbox`;
    if (!ctx.subscriptions.has(uri)) return;
    try {
      await ctx.server.server.sendResourceUpdated({ uri });
    } catch {
      /* session racing shutdown — the delivery remains in the store */
    }
  }
}

const prioritySchema = z.enum(["interrupt", "steering", "advisory", "info"]);

export function buildSessionServer(store: Store, hub: Hub, opts: { operatorToken: string | null }): SessionCtx {
  const server = new McpServer(
    { name: "macp-coordinator", version: "0.1.0" },
    { capabilities: { resources: { subscribe: true, listChanged: true }, tools: {}, logging: {} } },
  );

  const ctx: SessionCtx = {
    sessionId: "",
    address: null,
    project: null,
    isOperator: false,
    roots: [],
    subscriptions: new Set(),
    server,
  };

  // ── macp_register (spec §5.1, §6.1) ─────────────────────────────────────
  server.registerTool(
    "macp_register",
    {
      description:
        "Register this connection as an agent. Returns the assigned address. " +
        "Project resolves per spec §5.3: explicit > repository identity > workspace path.",
      inputSchema: {
        agent_id: z.string().min(1).describe("The harness's stable identifier for this agent (session ID or equivalent)."),
        harness: z.string().min(1).describe("Lowercase harness product id (e.g. 'opencode', 'pi')."),
        role: z.string().nullable().optional(),
        capabilities: z.array(z.string()).optional(),
        project: z.string().nullable().optional().describe("Explicit logical project (strongest scope evidence)."),
        conformance: z.enum(["L0", "L1", "L2", "L3"]).nullable().optional(),
        endpoint: z.string().nullable().optional().describe("Optional L3 drive endpoint served by this agent's harness."),
        operator_token: z.string().optional().describe("Present + matching registers this connection as the human operator."),
      },
    },
    async (args) => {
      // Operator registration (spec §9 G3): local trust when no token configured.
      if (args.operator_token !== undefined || args.harness === "operator") {
        const ok = opts.operatorToken === null || args.operator_token === opts.operatorToken;
        if (!ok) return err("operator registration rejected: bad token");
        ctx.isOperator = true;
        ctx.address = `human://${args.agent_id}`;
        ctx.project = null;
        hub.bind(ctx);
        store.audit(ctx.address, "register-operator", {});
        return ok_({ address: ctx.address, operator: true });
      }

      // Best-effort roots from the client (scope evidence).
      try {
        const caps = server.server.getClientCapabilities();
        if (caps?.roots) {
          const res = await server.server.listRoots();
          ctx.roots = res.roots.map((r) => r.uri);
        }
      } catch {
        /* client has no roots support — evidence ladder continues */
      }

      const clientInfo = server.server.getClientVersion();
      const project = resolveProject(args.project ?? null, ctx.roots);
      const address = `agent://${args.harness}/${args.agent_id}`;

      hub.unbind(ctx);
      ctx.address = address;
      ctx.project = project;
      const entry = store.register({
        address,
        project,
        harness: { name: args.harness, version: clientInfo?.version },
        role: args.role ?? null,
        capabilities: args.capabilities ?? [],
        roots: ctx.roots,
        conformance: args.conformance ?? null,
        endpoint: args.endpoint ?? null,
      });
      hub.bind(ctx);
      return ok_({ address: entry.address, project: entry.project });
    },
  );

  // ── macp_send (spec §6.1, §7, §9) ───────────────────────────────────────
  server.registerTool(
    "macp_send",
    {
      description:
        "Send an envelope. 'to' is an agent address, 'role:<label>' (all live agents with that role " +
        "in your project), or 'project' (broadcast to your project). steering/interrupt require a grant; " +
        "ungranted sends are downgraded to advisory and audited (spec §11.4).",
      inputSchema: {
        to: z.string().min(1),
        body: z.string().min(1),
        priority: prioritySchema.default("advisory"),
        ack: z.enum(["auto", "required"]).default("auto"),
        in_reply_to: z.string().nullable().optional(),
      },
    },
    async (args) => {
      if (!ctx.address) return err("not registered — call macp_register first");
      const from = ctx.address;
      const fromProject = ctx.project;

      // Resolve recipients.
      let recipients: { address: string; project: string }[];
      if (args.to === "project") {
        if (!fromProject) return err("operator broadcast requires an explicit address list");
        recipients = store
          .roster(fromProject)
          .filter((e) => e.address !== from)
          .map((e) => ({ address: e.address, project: e.project }));
      } else if (args.to.startsWith("role:")) {
        if (!fromProject) return err("role targeting requires a project-scoped sender");
        const role = args.to.slice(5);
        recipients = store
          .roster(fromProject)
          .filter((e) => e.role === role && e.address !== from)
          .map((e) => ({ address: e.address, project: e.project }));
      } else {
        const target = store.getAgent(args.to);
        if (!target && !args.to.startsWith("human://")) return err(`unknown recipient: ${args.to}`);
        recipients = [{ address: args.to, project: target?.project ?? fromProject ?? "unknown" }];
      }
      if (recipients.length === 0) return ok_({ deliveries: [], note: "no matching recipients" });

      const results: { id: string; to: string; priority: Priority; downgraded?: true }[] = [];
      for (const r of recipients) {
        let priority = args.priority as Priority;
        let downgraded = false;
        if (!store.allowed(from, r.address, r.project, fromProject, priority)) {
          if (priority === "steering" || priority === "interrupt") {
            // Spec §11.4: downgrade rather than drop, so misconfiguration is visible.
            priority = "advisory";
            downgraded = true;
            store.audit(from, "downgrade", { to: r.address, requested: args.priority });
          } else {
            store.audit(from, "blocked-cross-project", { to: r.address });
            continue; // cross-project advisory/info without a link: not delivered (§5.4)
          }
        }
        const env = store.send({
          from,
          to: r.address,
          project: r.project,
          priority,
          ack: args.ack as "auto" | "required",
          in_reply_to: args.in_reply_to ?? null,
          body: args.body,
        });
        results.push(downgraded ? { id: env.id, to: env.to, priority, downgraded: true } : { id: env.id, to: env.to, priority });
        void hub.notifyInbox(r.address);
      }
      return ok_({ deliveries: results });
    },
  );

  // ── macp_ack (spec §8.5) ────────────────────────────────────────────────
  server.registerTool(
    "macp_ack",
    {
      description: "Acknowledge a delivery as processed (removes it from your pending inbox).",
      inputSchema: { delivery_id: z.string().min(1) },
    },
    async (args) => {
      if (!ctx.address) return err("not registered");
      const done = store.ackProcessed(ctx.address, args.delivery_id);
      return done ? ok_({ acked: args.delivery_id }) : err(`no pending delivery ${args.delivery_id} for ${ctx.address}`);
    },
  );

  // ── macp_roster (spec §6.1) ─────────────────────────────────────────────
  server.registerTool(
    "macp_roster",
    {
      description: "Live agents in a project (default: your own).",
      inputSchema: { project: z.string().optional() },
    },
    async (args) => {
      const project = args.project ?? ctx.project;
      if (!project) return err("no project — register first or pass one explicitly");
      if (args.project && args.project !== ctx.project && !ctx.isOperator) {
        return err("cross-project roster requires the operator (spec §5.4)");
      }
      return ok_({ project, agents: store.roster(project) });
    },
  );

  // ── macp_grant (spec §9) ────────────────────────────────────────────────
  server.registerTool(
    "macp_grant",
    {
      description:
        "Create or revoke an authority grant. The operator may grant anything; an agent may grant " +
        "only over agents it spawned (subject address under its own). No self-granting (spec §9 G2).",
      inputSchema: {
        action: z.enum(["create", "revoke"]),
        grant_id: z.string().optional().describe("For revoke."),
        holder: z.string().optional(),
        subject: z.string().optional().describe("Address, 'project:<id>', or 'link:<a>:<b>'."),
        max_priority: z.enum(["steering", "interrupt"]).optional(),
        expires_at: z.string().nullable().optional(),
        note: z.string().nullable().optional(),
      },
    },
    async (args) => {
      if (!ctx.address) return err("not registered");
      if (args.action === "revoke") {
        if (!args.grant_id) return err("grant_id required");
        return store.revokeGrant(args.grant_id, ctx.address)
          ? ok_({ revoked: args.grant_id })
          : err("no such active grant");
      }
      if (!args.holder || !args.subject || !args.max_priority) return err("holder, subject, max_priority required");
      const spawnerOk =
        !ctx.isOperator &&
        args.subject.startsWith(`${ctx.address}/`) && // only over own spawned subtree
        args.holder === ctx.address;
      if (!ctx.isOperator && !spawnerOk) {
        return err("only the operator may create this grant (spec §9 G2 — no self-granting)");
      }
      const grant = store.addGrant({
        holder: args.holder,
        subject: args.subject,
        max_priority: args.max_priority,
        granted_by: ctx.address,
        expires_at: args.expires_at ?? null,
        note: args.note ?? null,
      });
      return ok_({ grant });
    },
  );

  // ── resources (spec §6.2) ───────────────────────────────────────────────
  server.registerResource(
    "self",
    "macp://self",
    { description: "Your registry entry, project, and grants held.", mimeType: "application/json" },
    async (uri) => {
      if (!ctx.address) return json(uri.href, { registered: false });
      const entry = store.getAgent(ctx.address);
      return json(uri.href, { ...entry, address: ctx.address, grants: store.grantsHeldBy(ctx.address) });
    },
  );

  server.registerResource(
    "roster",
    new ResourceTemplate("macp://project/{project}/roster", { list: undefined }),
    { description: "Live agents in a project.", mimeType: "application/json" },
    async (uri, vars) => {
      const project = decodeURIComponent(String(vars.project));
      if (project !== ctx.project && !ctx.isOperator) {
        throw new Error("cross-project roster requires the operator (spec §5.4)");
      }
      return json(uri.href, store.roster(project));
    },
  );

  server.registerResource(
    "inbox",
    new ResourceTemplate("macp://agent/{+address}/inbox", { list: undefined }),
    {
      description: "Your pending deliveries, priority-ordered. Reading marks them received (spec §8.5).",
      mimeType: "application/json",
    },
    async (uri, vars) => {
      const address = decodeURIComponent(String(vars.address));
      // An agent may only read ITS OWN inbox — enforced by connection identity (spec §6.2).
      if (address !== ctx.address) throw new Error("an agent may only read its own inbox (spec §6.2)");
      const pending = store.inbox(address);
      store.markReceived(address);
      return json(uri.href, pending);
    },
  );

  // ── subscriptions (spec §6.3 rung 1) ───────────────────────────────────
  server.server.setRequestHandler(SubscribeRequestSchema, async (req) => {
    ctx.subscriptions.add(req.params.uri);
    return {};
  });
  server.server.setRequestHandler(UnsubscribeRequestSchema, async (req) => {
    ctx.subscriptions.delete(req.params.uri);
    return {};
  });

  return ctx;
}

// ── helpers ───────────────────────────────────────────────────────────────

function ok_(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

function err(message: string) {
  return { content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }], isError: true as const };
}

function json(uri: string, payload: unknown) {
  return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(payload, null, 2) }] };
}
