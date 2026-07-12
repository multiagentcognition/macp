/**
 * End-to-end smoke test against a live center over streamable HTTP.
 * Exercises: registration + scope, roster, advisory send → inbox → ack,
 * default-deny downgrade, operator grant, granted steering, subscription
 * push (notifications/resources/updated), and durable offline delivery.
 *
 * Run: node test/smoke.mjs   (starts its own center on a random port)
 */
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";

const PORT = 7000 + Math.floor(Math.random() * 2000);
const URL_ = `http://localhost:${PORT}/mcp`;
const DB = `./test/smoke-${PORT}.db`;

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}`); };
const toolJson = (res) => JSON.parse(res.content[0].text);
const readJson = (res) => JSON.parse(res.contents[0].text);

async function connect(name) {
  const client = new Client({ name, version: "0.0.1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(URL_)));
  return client;
}

// ── boot center ─────────────────────────────────────────────────────
rmSync(DB, { force: true });
const proc = spawn("node", ["dist/index.js", "--port", String(PORT), "--db", DB], { stdio: ["ignore", "pipe", "pipe"] });
proc.stderr.on("data", (d) => process.stderr.write(d));
await new Promise((resolve, reject) => {
  proc.stdout.on("data", (d) => d.toString().includes("listening") && resolve());
  proc.on("exit", (c) => reject(new Error(`center exited early (${c})`)));
  setTimeout(() => reject(new Error("center boot timeout")), 8000);
});

try {
  // ── register two agents (same explicit project) + operator ────────────
  const a = await connect("smoke-harness-a");
  const b = await connect("smoke-harness-b");
  const op = await connect("smoke-operator");

  const regA = toolJson(await a.callTool({ name: "macp_register", arguments: { agent_id: "a1", harness: "harness-a", role: "worker", project: "demo" } }));
  const regB = toolJson(await b.callTool({ name: "macp_register", arguments: { agent_id: "b1", harness: "harness-b", role: "reviewer", project: "demo" } }));
  const regOp = toolJson(await op.callTool({ name: "macp_register", arguments: { agent_id: "smoke-op", harness: "operator" } }));
  ok("register A → address", regA.address === "agent://harness-a/a1");
  ok("register B → address", regB.address === "agent://harness-b/b1");
  ok("register operator → human://", regOp.address === "human://smoke-op" && regOp.operator === true);
  ok("A and B co-resolve to one project", regA.project === regB.project);

  // ── roster ─────────────────────────────────────────────────────────────
  const roster = toolJson(await a.callTool({ name: "macp_roster", arguments: {} }));
  ok("roster shows both live agents", roster.agents.length === 2 && roster.agents.every((e) => e.live));

  // ── subscription push: B subscribes to its inbox ───────────────────────
  let updated = [];
  b.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => updated.push(n.params.uri));
  const inboxB = `macp://agent/${regB.address}/inbox`;
  await b.subscribeResource({ uri: inboxB });

  // ── advisory send (no grant needed within project) ─────────────────────
  const send1 = toolJson(await a.callTool({ name: "macp_send", arguments: { to: regB.address, body: "heads-up: schema changing", priority: "advisory" } }));
  ok("advisory delivered", send1.deliveries.length === 1 && send1.deliveries[0].priority === "advisory");

  await new Promise((r) => setTimeout(r, 300));
  ok("subscription push received (resources/updated)", updated.includes(inboxB));

  const inbox1 = readJson(await b.readResource({ uri: inboxB }));
  ok("inbox holds the envelope", inbox1.length === 1 && inbox1[0].body.includes("schema changing") && inbox1[0].from === regA.address);

  const acked = toolJson(await b.callTool({ name: "macp_ack", arguments: { delivery_id: inbox1[0].id } }));
  ok("ack processed", acked.acked === inbox1[0].id);
  const inbox2 = readJson(await b.readResource({ uri: inboxB }));
  ok("inbox empty after ack", inbox2.length === 0);

  // ── default-deny: steering without grant downgrades ────────────────────
  const send2 = toolJson(await a.callTool({ name: "macp_send", arguments: { to: regB.address, body: "stop what you are doing", priority: "steering" } }));
  ok("ungranted steering downgraded to advisory", send2.deliveries[0].priority === "advisory" && send2.deliveries[0].downgraded === true);
  const inboxAfterDowngrade = readJson(await b.readResource({ uri: inboxB }));
  for (const e of inboxAfterDowngrade) await b.callTool({ name: "macp_ack", arguments: { delivery_id: e.id } });

  // ── agent cannot self-grant ────────────────────────────────────────────
  const selfGrant = toolJson(await a.callTool({ name: "macp_grant", arguments: { action: "create", holder: regA.address, subject: regB.address, max_priority: "steering" } }));
  ok("agent self-grant refused", selfGrant.error !== undefined);

  // ── operator grants A steering over B; steering now flows ──────────────
  const grant = toolJson(await op.callTool({ name: "macp_grant", arguments: { action: "create", holder: regA.address, subject: regB.address, max_priority: "steering", note: "smoke" } }));
  ok("operator grant created", grant.grant?.id?.startsWith("g_"));

  const send3 = toolJson(await a.callTool({ name: "macp_send", arguments: { to: regB.address, body: "granted steering", priority: "steering", ack: "required" } }));
  ok("granted steering delivered at steering priority", send3.deliveries[0].priority === "steering" && !send3.deliveries[0].downgraded);

  const inbox3 = readJson(await b.readResource({ uri: inboxB }));
  ok("steering envelope carries ack:required", inbox3[0].ack === "required" && inbox3[0].priority === "steering");
  await b.callTool({ name: "macp_ack", arguments: { delivery_id: inbox3[0].id } });

  // ── isolation: B cannot read A's inbox ─────────────────────────────────
  let denied = false;
  try { await b.readResource({ uri: `macp://agent/${regA.address}/inbox` }); } catch { denied = true; }
  ok("cross-agent inbox read denied", denied);

  // ── durable offline delivery: B disconnects, A sends, B reconnects ─────
  await b.close();
  await new Promise((r) => setTimeout(r, 200));
  const send4 = toolJson(await a.callTool({ name: "macp_send", arguments: { to: regB.address, body: "while you were away", priority: "advisory" } }));
  ok("send to offline agent accepted (durable)", send4.deliveries.length === 1);

  const b2 = await connect("smoke-harness-b");
  const regB2 = toolJson(await b2.callTool({ name: "macp_register", arguments: { agent_id: "b1", harness: "harness-b", role: "reviewer", project: "demo" } }));
  ok("reconnect keeps the same address", regB2.address === regB.address);
  const inbox4 = readJson(await b2.readResource({ uri: inboxB }));
  ok("offline delivery drained after reconnect", inbox4.some((e) => e.body === "while you were away"));

  // ── project isolation: an agent in another project is invisible ────────
  const c = await connect("smoke-harness-c");
  const regC = toolJson(await c.callTool({ name: "macp_register", arguments: { agent_id: "c1", harness: "harness-c", project: "other" } }));
  ok("C resolves to a different project", regC.project !== regA.project);
  const send5 = toolJson(await c.callTool({ name: "macp_send", arguments: { to: regA.address, body: "cross-project hello", priority: "advisory" } }));
  ok("cross-project advisory without link not delivered", send5.deliveries.length === 0);

  await a.close(); await b2.close(); await c.close(); await op.close();
} finally {
  proc.kill("SIGINT");
  rmSync(DB, { force: true });
  rmSync(DB + "-wal", { force: true });
  rmSync(DB + "-shm", { force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
