import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { decodeMeteoraTx, extractActions } from "@binflip/core";
import { createDb, schema } from "@binflip/db";
import { eq } from "drizzle-orm";
import { WebSocketServer } from "ws";

const fixture = readdirSync("/fixtures").find((name) => name.startsWith("dlmm-2oxGTs22bM"));
const close = JSON.parse(readFileSync(`/fixtures/${fixture}`, "utf8"));
const [action] = extractActions(decodeMeteoraTx(close));
assert.equal(action.kind, "close");
const baseline = { signature: "before-downtime", slot: close.slot - 1, err: null, blockTime: close.blockTime };
const closing = { signature: close.signature, slot: close.slot, err: null, blockTime: close.blockTime };

async function waitFor(read, description) {
  const deadline = Date.now() + 30_000;
  do {
    if (await read()) return;
    await delay(250);
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${description}`);
}

switch (process.argv[2]) {
  case "rpc": {
    let released = false;
    const server = createServer(async (req, res) => {
      if (req.url === "/health") return res.end("ok");
      if (req.method === "POST" && req.url === "/release") {
        released = true;
        return res.end("ok");
      }
      let body = "";
      for await (const chunk of req) body += chunk;
      const { id, method, params } = JSON.parse(body);
      let result;
      if (method === "getSignaturesForAddress") {
        const until = params[1].until;
        const history = released ? [closing, baseline] : [baseline];
        const boundary = history.findIndex(({ signature }) => signature === until);
        result = (boundary < 0 ? history : history.slice(0, boundary)).slice(0, params[1].limit);
      } else if (method === "getTransaction") {
        result = params[0] === close.signature && released ? close : null;
      } else {
        return res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: "fixture does not serve this method" } }));
      }
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
    });
    const ws = new WebSocketServer({ server });
    ws.on("connection", (socket) => socket.on("message", (data) => {
      const { id, method } = JSON.parse(data);
      socket.send(JSON.stringify({ jsonrpc: "2.0", id, result: method === "logsSubscribe" ? 1 : true }));
    }));
    server.listen(8899, "0.0.0.0");
    break;
  }
  case "release": {
    const response = await fetch("http://127.0.0.1:8899/release", { method: "POST" });
    assert.ok(response.ok);
    break;
  }
  default: {
    const { db, close: disconnect } = createDb("postgres://binflip:binflip@postgres:5432/binflip");
    try {
      if (process.argv[2] === "seed") {
        await db.transaction(async (tx) => {
          const [user] = await tx.insert(schema.users).values({ loginWallet: action.owner, role: "owner" }).returning();
          const [leader] = await tx.insert(schema.leaders).values({ userId: user.id, address: action.owner, label: "Compose fixture" }).returning();
          await tx.insert(schema.copySettings).values({ userId: user.id, leaderId: leader.id });
          await tx.insert(schema.positions).values({
            userId: user.id, leaderId: leader.id, pool: action.pool,
            protocol: "dlmm", leaderPosition: action.position, state: "ACTIVE",
            dryRun: true, managementMode: "mirror",
          });
        });
      } else {
        const events = () => db.select().from(schema.leaderEvents).where(eq(schema.leaderEvents.signature, close.signature));
        if (process.argv[2] === "queued") {
          await waitFor(async () => (await events()).length === 1, "listener to store the close");
          assert.equal((await events())[0].processedAt, null, "executor must still be stopped");
        } else {
          assert.equal(process.argv[2], "closed");
          await waitFor(async () => Boolean((await events())[0]?.processedAt), "executor to process the close");
          const stored = await events();
          assert.equal(stored.length, 1);
          assert.equal(stored[0].payload.source, "poll");
          const [position] = await db.select().from(schema.positions).where(eq(schema.positions.leaderPosition, action.position));
          assert.equal(position.state, "CLOSED");
          assert.equal(position.closeReason, "leader_exit");
          const transactions = await db.select().from(schema.txs).where(eq(schema.txs.leaderEventId, stored[0].id));
          assert.equal(transactions.length, 1);
          assert.equal(transactions[0].kind, "close");
          assert.equal(transactions[0].dryRun, true);
          assert.equal(transactions[0].signature, null);
        }
      }
    } finally {
      await disconnect();
    }
  }
}
