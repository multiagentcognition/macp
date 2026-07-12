/**
 * MACP 2.0 reference center — store.
 *
 * Storage is implementation-private per spec §3; this reference uses an
 * embedded SQLite database (node:sqlite, no native build step). Any backend
 * satisfying spec §7.4 (durable until acked, per-recipient order within a
 * priority, full audit) is equally valid.
 */
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

export type Priority = "interrupt" | "steering" | "advisory" | "info";
const PRIORITY_ORDER: Record<Priority, number> = {
  interrupt: 0,
  steering: 1,
  advisory: 2,
  info: 3,
};

export interface Envelope {
  macp: "2.0";
  id: string;
  from: string;
  to: string;
  project: string;
  priority: Priority;
  sent_at: string;
  ack: "auto" | "required";
  in_reply_to: string | null;
  body: string;
  interrupted: { operation: string; partial_output: boolean } | null;
}

export interface RegistryEntry {
  address: string;
  project: string;
  harness: { name: string; version?: string };
  role: string | null;
  capabilities: string[];
  roots: string[];
  conformance: "L0" | "L1" | "L2" | "L3" | null;
  endpoint: string | null;
  live: boolean;
  registered_at: string;
  last_seen_at: string | null;
}

export interface Grant {
  id: string;
  holder: string;
  subject: string;
  max_priority: "steering" | "interrupt";
  granted_by: string;
  granted_at: string;
  expires_at: string | null;
  note: string | null;
}

const now = () => new Date().toISOString();

export class Store {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS agents (
        address TEXT PRIMARY KEY,
        project TEXT NOT NULL,
        harness_name TEXT NOT NULL,
        harness_version TEXT,
        role TEXT,
        capabilities TEXT NOT NULL DEFAULT '[]',
        roots TEXT NOT NULL DEFAULT '[]',
        conformance TEXT,
        endpoint TEXT,
        live INTEGER NOT NULL DEFAULT 1,
        registered_at TEXT NOT NULL,
        last_seen_at TEXT
      );
      CREATE TABLE IF NOT EXISTS deliveries (
        id TEXT PRIMARY KEY,
        seq INTEGER,
        from_addr TEXT NOT NULL,
        to_addr TEXT NOT NULL,
        project TEXT NOT NULL,
        priority TEXT NOT NULL,
        sent_at TEXT NOT NULL,
        ack TEXT NOT NULL,
        in_reply_to TEXT,
        body TEXT NOT NULL,
        interrupted TEXT,
        received_at TEXT,
        processed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS deliveries_pending
        ON deliveries (to_addr, processed_at, seq);
      CREATE TABLE IF NOT EXISTS delivery_seq (n INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS grants (
        id TEXT PRIMARY KEY,
        holder TEXT NOT NULL,
        subject TEXT NOT NULL,
        max_priority TEXT NOT NULL,
        granted_by TEXT NOT NULL,
        granted_at TEXT NOT NULL,
        expires_at TEXT,
        note TEXT,
        revoked_at TEXT
      );
      CREATE TABLE IF NOT EXISTS audit (
        at TEXT NOT NULL,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        detail TEXT NOT NULL
      );
    `);
    const seeded = this.db.prepare(`SELECT COUNT(*) AS c FROM delivery_seq`).get() as { c: number };
    if (seeded.c === 0) this.db.prepare(`INSERT INTO delivery_seq (n) VALUES (0)`).run();
  }

  audit(actor: string, action: string, detail: unknown): void {
    this.db
      .prepare(`INSERT INTO audit (at, actor, action, detail) VALUES (?, ?, ?, ?)`)
      .run(now(), actor, action, JSON.stringify(detail));
  }

  // ── registry ────────────────────────────────────────────────────────────

  register(entry: Omit<RegistryEntry, "live" | "registered_at" | "last_seen_at">): RegistryEntry {
    const registered_at = now();
    this.db
      .prepare(
        `INSERT INTO agents
           (address, project, harness_name, harness_version, role, capabilities,
            roots, conformance, endpoint, live, registered_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT(address) DO UPDATE SET
           project = excluded.project,
           harness_name = excluded.harness_name,
           harness_version = excluded.harness_version,
           role = excluded.role,
           capabilities = excluded.capabilities,
           roots = excluded.roots,
           conformance = excluded.conformance,
           endpoint = excluded.endpoint,
           live = 1,
           last_seen_at = excluded.last_seen_at`,
      )
      .run(
        entry.address,
        entry.project,
        entry.harness.name,
        entry.harness.version ?? null,
        entry.role,
        JSON.stringify(entry.capabilities),
        JSON.stringify(entry.roots),
        entry.conformance,
        entry.endpoint,
        registered_at,
        registered_at,
      );
    this.audit(entry.address, "register", { project: entry.project, role: entry.role });
    return { ...entry, live: true, registered_at, last_seen_at: registered_at };
  }

  heartbeat(address: string): void {
    this.db.prepare(`UPDATE agents SET live = 1, last_seen_at = ? WHERE address = ?`).run(now(), address);
  }

  markStale(address: string): void {
    this.db.prepare(`UPDATE agents SET live = 0, last_seen_at = ? WHERE address = ?`).run(now(), address);
    this.audit(address, "stale", {});
  }

  getAgent(address: string): RegistryEntry | null {
    const r = this.db.prepare(`SELECT * FROM agents WHERE address = ?`).get(address) as
      | Record<string, unknown>
      | undefined;
    return r ? rowToEntry(r) : null;
  }

  roster(project: string, includeStale = false): RegistryEntry[] {
    const rows = this.db
      .prepare(
        includeStale
          ? `SELECT * FROM agents WHERE project = ? ORDER BY registered_at`
          : `SELECT * FROM agents WHERE project = ? AND live = 1 ORDER BY registered_at`,
      )
      .all(project) as Record<string, unknown>[];
    return rows.map(rowToEntry);
  }

  agentsInProject(project: string): string[] {
    return this.roster(project).map((e) => e.address);
  }

  // ── grants (spec §9) ───────────────────────────────────────────────────

  addGrant(g: Omit<Grant, "id" | "granted_at">): Grant {
    const grant: Grant = { ...g, id: `g_${randomUUID()}`, granted_at: now() };
    this.db
      .prepare(
        `INSERT INTO grants (id, holder, subject, max_priority, granted_by, granted_at, expires_at, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(grant.id, grant.holder, grant.subject, grant.max_priority, grant.granted_by, grant.granted_at, grant.expires_at, grant.note);
    this.audit(grant.granted_by, "grant", grant);
    return grant;
  }

  revokeGrant(id: string, by: string): boolean {
    const res = this.db.prepare(`UPDATE grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`).run(now(), id);
    if (res.changes > 0) this.audit(by, "revoke", { id });
    return res.changes > 0;
  }

  grantsHeldBy(holder: string): Grant[] {
    const rows = this.db
      .prepare(`SELECT * FROM grants WHERE holder = ? AND revoked_at IS NULL`)
      .all(holder) as Record<string, unknown>[];
    return rows.map(rowToGrant).filter((g) => !expired(g));
  }

  /** May `from` send at `priority` to `to` (an agent in `toProject`)? Spec §9. */
  allowed(from: string, to: string, toProject: string, fromProject: string | null, priority: Priority): boolean {
    if (priority === "advisory" || priority === "info") {
      // No grant needed within a project (G1); cross-project still needs a link/grant (§5.4).
      return fromProject === toProject || this.hasGrant(from, to, toProject, fromProject, "steering", true);
    }
    if (from.startsWith("human://")) return true; // G3 operator precedence
    return this.hasGrant(from, to, toProject, fromProject, priority === "interrupt" ? "interrupt" : "steering", false);
  }

  private hasGrant(
    from: string,
    to: string,
    toProject: string,
    fromProject: string | null,
    needed: "steering" | "interrupt",
    anyPriorityCounts: boolean,
  ): boolean {
    const rows = this.db
      .prepare(`SELECT * FROM grants WHERE revoked_at IS NULL AND (holder = ? OR holder = ?)`)
      .all(from, fromProject ? `project:${fromProject}` : "__none__") as Record<string, unknown>[];
    return rows.map(rowToGrant).some((g) => {
      if (expired(g)) return false;
      const covers =
        g.subject === to ||
        g.subject === `project:${toProject}` ||
        (fromProject !== null &&
          (g.subject === `link:${fromProject}:${toProject}` || g.subject === `link:${toProject}:${fromProject}`));
      if (!covers) return false;
      if (anyPriorityCounts) return true;
      return needed === "steering" || g.max_priority === "interrupt";
    });
  }

  // ── deliveries (spec §7, §8.5) ─────────────────────────────────────────

  send(input: {
    from: string;
    to: string;
    project: string;
    priority: Priority;
    ack: "auto" | "required";
    in_reply_to: string | null;
    body: string;
  }): Envelope {
    const seqRow = this.db.prepare(`UPDATE delivery_seq SET n = n + 1 RETURNING n`).get() as { n: number };
    const env: Envelope = {
      macp: "2.0",
      id: `d_${randomUUID()}`,
      from: input.from,
      to: input.to,
      project: input.project,
      priority: input.priority,
      sent_at: now(),
      ack: input.ack,
      in_reply_to: input.in_reply_to,
      body: input.body,
      interrupted: null,
    };
    this.db
      .prepare(
        `INSERT INTO deliveries
           (id, seq, from_addr, to_addr, project, priority, sent_at, ack, in_reply_to, body, interrupted)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(env.id, seqRow.n, env.from, env.to, env.project, env.priority, env.sent_at, env.ack, env.in_reply_to, env.body);
    this.audit(input.from, "send", { id: env.id, to: env.to, priority: env.priority });
    return env;
  }

  /** Pending deliveries for an address, priority-ordered then send-ordered (D3). */
  inbox(address: string): Envelope[] {
    const rows = this.db
      .prepare(`SELECT * FROM deliveries WHERE to_addr = ? AND processed_at IS NULL ORDER BY seq`)
      .all(address) as Record<string, unknown>[];
    return rows
      .map(rowToEnvelope)
      .sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]);
  }

  /** Reading the inbox marks deliveries received (§8.5). */
  markReceived(address: string): void {
    this.db
      .prepare(`UPDATE deliveries SET received_at = ? WHERE to_addr = ? AND received_at IS NULL AND processed_at IS NULL`)
      .run(now(), address);
  }

  ackProcessed(address: string, deliveryId: string): boolean {
    const res = this.db
      .prepare(`UPDATE deliveries SET processed_at = ? WHERE id = ? AND to_addr = ? AND processed_at IS NULL`)
      .run(now(), deliveryId, address);
    if (res.changes > 0) this.audit(address, "ack", { id: deliveryId });
    return res.changes > 0;
  }

  close(): void {
    this.db.close();
  }
}

// ── row mappers ─────────────────────────────────────────────────────────

function rowToEntry(r: Record<string, unknown>): RegistryEntry {
  return {
    address: r.address as string,
    project: r.project as string,
    harness: { name: r.harness_name as string, version: (r.harness_version as string) ?? undefined },
    role: (r.role as string) ?? null,
    capabilities: JSON.parse(r.capabilities as string),
    roots: JSON.parse(r.roots as string),
    conformance: (r.conformance as RegistryEntry["conformance"]) ?? null,
    endpoint: (r.endpoint as string) ?? null,
    live: (r.live as number) === 1,
    registered_at: r.registered_at as string,
    last_seen_at: (r.last_seen_at as string) ?? null,
  };
}

function rowToGrant(r: Record<string, unknown>): Grant {
  return {
    id: r.id as string,
    holder: r.holder as string,
    subject: r.subject as string,
    max_priority: r.max_priority as Grant["max_priority"],
    granted_by: r.granted_by as string,
    granted_at: r.granted_at as string,
    expires_at: (r.expires_at as string) ?? null,
    note: (r.note as string) ?? null,
  };
}

function rowToEnvelope(r: Record<string, unknown>): Envelope {
  return {
    macp: "2.0",
    id: r.id as string,
    from: r.from_addr as string,
    to: r.to_addr as string,
    project: r.project as string,
    priority: r.priority as Priority,
    sent_at: r.sent_at as string,
    ack: r.ack as "auto" | "required",
    in_reply_to: (r.in_reply_to as string) ?? null,
    body: r.body as string,
    interrupted: r.interrupted ? JSON.parse(r.interrupted as string) : null,
  };
}

function expired(g: Grant): boolean {
  return g.expires_at !== null && g.expires_at < now();
}
