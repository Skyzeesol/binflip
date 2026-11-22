import { parseArgs } from "node:util";
import { eq } from "drizzle-orm";
import { createDb } from "./client.js";
import * as schema from "./schema.js";

/**
 * Leader management until the panel exists (stage 5).
 *
 *   node packages/db/dist/cli.js user:init --wallet <login wallet>
 *   node packages/db/dist/cli.js leader:add --address <addr> --label <name> [--pct 50] [--max-per-tx 2]
 *        [--max-per-position 10] [--tp 5] [--sl 5] [--no-damm] [--no-meme] [--strategies spot,curve,bid_ask,custom]
 *   node packages/db/dist/cli.js leader:list
 *   node packages/db/dist/cli.js leader:pause|leader:resume|leader:remove --address <addr>
 *
 * Single-user for now: commands act on the only owner user.
 */
const SOL = 1_000_000_000;
const toLamports = (v: string | undefined) => (v === undefined ? null : BigInt(Math.round(Number(v) * SOL)));
const toBps = (v: string | undefined) => (v === undefined ? null : Math.round(Number(v) * 100));

const [cmd, ...rest] = process.argv.slice(2);
const { values: o } = parseArgs({
  args: rest,
  options: {
    wallet: { type: "string" },
    address: { type: "string" },
    label: { type: "string" },
    pct: { type: "string" },
    "max-per-tx": { type: "string" },
    "max-per-position": { type: "string" },
    tp: { type: "string" },
    sl: { type: "string" },
    trailing: { type: "string" },
    strategies: { type: "string" },
    "no-damm": { type: "boolean", default: false },
    "no-meme": { type: "boolean", default: false },
  },
});

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");
const { db, close } = createDb(url, { max: 1 });

async function owner() {
  const [u] = await db.select().from(schema.users).where(eq(schema.users.role, "owner"));
  if (!u) throw new Error("No owner user. Run: user:init --wallet <your login wallet>");
  return u;
}

async function leaderByAddress(address: string | undefined) {
  if (!address) throw new Error("--address is required");
  const u = await owner();
  const [l] = await db.select().from(schema.leaders).where(eq(schema.leaders.address, address));
  if (!l || l.userId !== u.id) throw new Error(`leader ${address} not found`);
  return l;
}

try {
  switch (cmd) {
    case "user:init": {
      if (!o.wallet) throw new Error("--wallet is required");
      const [u] = await db
        .insert(schema.users)
        .values({ loginWallet: o.wallet, role: "owner", displayName: "owner" })
        .onConflictDoNothing()
        .returning();
      const user = u ?? (await owner());
      await db.insert(schema.userRiskSettings).values({ userId: user.id }).onConflictDoNothing();
      console.log(`owner user ${user.id}`);
      break;
    }
    case "leader:add": {
      if (!o.address || !o.label) throw new Error("--address and --label are required");
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(o.address)) throw new Error("not a base58 address");
      const u = await owner();
      const [l] = await db
        .insert(schema.leaders)
        .values({ userId: u.id, address: o.address, label: o.label })
        .onConflictDoUpdate({ target: [schema.leaders.userId, schema.leaders.address], set: { label: o.label } })
        .returning();
      const settings = {
        leaderId: l!.id,
        userId: u.id,
        sizingPercentBps: toBps(o.pct ?? "100"),
        maxSolPerAdd: toLamports(o["max-per-tx"]),
        maxSolPerPosition: toLamports(o["max-per-position"]),
        takeProfitBps: toBps(o.tp),
        stopLossBps: toBps(o.sl),
        trailingStopBps: toBps(o.trailing),
        copyDammV2: !o["no-damm"],
        memeProtection: !o["no-meme"],
        ...(o.strategies
          ? { copyDlmmStrategies: o.strategies.split(",") as Array<"spot" | "curve" | "bid_ask" | "custom"> }
          : {}),
      };
      await db
        .insert(schema.copySettings)
        .values(settings)
        .onConflictDoUpdate({ target: schema.copySettings.leaderId, set: settings });
      console.log(`leader ${o.label} (${o.address}) saved`);
      break;
    }
    case "leader:list": {
      const rows = await db
        .select()
        .from(schema.leaders)
        .innerJoin(schema.copySettings, eq(schema.copySettings.leaderId, schema.leaders.id));
      for (const { leaders: l, copy_settings: c } of rows) {
        const pct = c.sizingPercentBps !== null ? `%${c.sizingPercentBps / 100}` : "-";
        const max = c.maxSolPerAdd !== null ? `${Number(c.maxSolPerAdd) / SOL} SOL/tx` : "sınırsız";
        const exit = c.takeProfitBps || c.stopLossBps ? `TP ${(c.takeProfitBps ?? 0) / 100}% / SL ${(c.stopLossBps ?? 0) / 100}%` : "liderle çık";
        console.log(`${l.status.padEnd(6)} ${l.label.padEnd(20)} ${l.address}  ${pct} ${max}  ${exit}  DAMM:${c.copyDammV2 ? "açık" : "kapalı"} meme:${c.memeProtection ? "açık" : "kapalı"}`);
      }
      if (!rows.length) console.log("(no leaders)");
      break;
    }
    case "leader:pause":
    case "leader:resume": {
      const l = await leaderByAddress(o.address);
      await db
        .update(schema.leaders)
        .set({ status: cmd === "leader:pause" ? "paused" : "active" })
        .where(eq(schema.leaders.id, l.id));
      console.log(`${l.label}: ${cmd === "leader:pause" ? "paused" : "active"}`);
      break;
    }
    case "leader:remove": {
      const l = await leaderByAddress(o.address);
      await db.delete(schema.leaders).where(eq(schema.leaders.id, l.id));
      console.log(`${l.label} removed`);
      break;
    }
    default:
      console.log("commands: user:init, leader:add, leader:list, leader:pause, leader:resume, leader:remove");
      process.exitCode = cmd ? 1 : 0;
  }
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await close();
}
