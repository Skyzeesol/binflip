import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { Keypair } from "@solana/web3.js";
import { eq, sql } from "drizzle-orm";
import { MIN_PASSWORD_LENGTH, encryptKeypair, hashPassword, readPassphraseFile } from "@binflip/core";
import { createDb } from "./client.js";
import * as schema from "./schema.js";

/**
 * Leader management until the panel exists (stage 5).
 *
 *   node packages/db/dist/cli.js user:init --wallet <login wallet>
 *   node packages/db/dist/cli.js user:password --username skyzee
 *     Sets the panel username + password (asked twice on the terminal, never echoed). Ends every open session.
 *   node packages/db/dist/cli.js user:logout-all      Ends every open panel session.
 *   node packages/db/dist/cli.js leader:add --address <addr> --label <name> [--pct 50] [--max-per-tx 2]
 *        [--max-per-position 10] [--tp 5] [--sl 5] [--trailing 5] [--no-damm] [--no-meme] [--strategies spot,curve,bid_ask,custom]
 *        [--mode mirror|staged_flip|bottom_flip|precision_hybrid] [--flip-threshold 10]   (flip threshold in %, default 10)
 *        [--compound 60]   (auto-compound every N minutes when fees ≥ COMPOUND_MIN_LAMPORTS; 0 = off)
 *   node packages/db/dist/cli.js leader:list
 *   node packages/db/dist/cli.js leader:pause|leader:resume|leader:remove --address <addr>
 *   node packages/db/dist/cli.js wallet:create --label agent [--out keystore/agent.json] [--passphrase-file secrets/keystore_passphrase]
 *     Generates a NEW agent wallet (never import your main wallet), writes it encrypted, prints only the public key.
 *   node packages/db/dist/cli.js risk:show | risk:set [--max-per-tx 1] [--max-per-day 10] | kill | unkill
 *   node packages/db/dist/cli.js manual:set [--mode staged_flip] [--flip-threshold 10] [--tp 10] [--sl 10] [--trailing 5] [--compound 60] [--off]
 *     How the bot manages positions YOU open in the bot wallet (found automatically every 5 min, live mode).
 *   node packages/db/dist/cli.js manual:show
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
    username: { type: "string" },
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
    out: { type: "string", default: "keystore/agent.json" },
    "passphrase-file": { type: "string" },
    "max-per-day": { type: "string" },
    mode: { type: "string" },
    "flip-threshold": { type: "string" },
    compound: { type: "string" },
    reason: { type: "string" },
    off: { type: "boolean", default: false },
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
    case "user:password": {
      const u = await owner();
      const username = (o.username ?? u.username ?? "").trim().toLowerCase();
      if (!/^[a-z0-9._-]{3,32}$/.test(username)) throw new Error("--username is required: 3-32 chars, letters, digits, . _ -");
      const password = await promptSecret(`New panel password for "${username}" (min ${MIN_PASSWORD_LENGTH} chars): `);
      if (password.length < MIN_PASSWORD_LENGTH) throw new Error(`password must be at least ${MIN_PASSWORD_LENGTH} characters`);
      if ((await promptSecret("Repeat: ")) !== password) throw new Error("passwords do not match");
      const passwordHash = await hashPassword(password);
      await db
        .update(schema.users)
        .set({ username, passwordHash, sessionVersion: sql`${schema.users.sessionVersion} + 1` })
        .where(eq(schema.users.id, u.id));
      console.log(`panel login set: username "${username}". All open sessions were ended; sign in again.`);
      break;
    }
    case "user:logout-all": {
      const u = await owner();
      await db.update(schema.users).set({ sessionVersion: sql`${schema.users.sessionVersion} + 1` }).where(eq(schema.users.id, u.id));
      console.log("all panel sessions ended");
      break;
    }
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
        ...(o.mode ? { managementMode: parseMode(o.mode) } : {}),
        ...(o["flip-threshold"] ? { managementParams: { flipThresholdBps: toBps(o["flip-threshold"]) } } : {}),
        ...(o.compound ? { compoundIntervalMinutes: Number(o.compound) || null } : {}),
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
        const flip = (c.managementParams as { flipThresholdBps?: number }).flipThresholdBps ?? 1000;
        const mode = c.managementMode === "mirror" ? "aynala" : `${c.managementMode}${c.managementMode === "staged_flip" ? ` %${flip / 100}` : ""}`;
        const comp = c.compoundIntervalMinutes ? ` compound:${c.compoundIntervalMinutes}dk` : "";
        console.log(`${l.status.padEnd(6)} ${l.label.padEnd(20)} ${l.address}  ${pct} ${max}  ${exit}  yönetim:${mode}${comp}  DAMM:${c.copyDammV2 ? "açık" : "kapalı"} meme:${c.memeProtection ? "açık" : "kapalı"}`);
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
    case "wallet:create": {
      const u = await owner();
      if (existsSync(o.out!)) throw new Error(`${o.out} already exists; refusing to overwrite a keystore`);
      const pass = o["passphrase-file"] ? readPassphraseFile(o["passphrase-file"]) : await promptPassphrase();
      const kp = Keypair.generate();
      const file = encryptKeypair(kp, pass);
      mkdirSync(dirname(o.out!), { recursive: true, mode: 0o700 });
      writeFileSync(o.out!, JSON.stringify(file, null, 2), { mode: 0o600, flag: "wx" });
      await db.insert(schema.agentWallets).values({
        userId: u.id,
        label: o.label ?? "agent",
        publicKey: file.publicKey,
        keystoreRef: basename(o.out!),
      });
      console.log(`agent wallet ${file.publicKey}`);
      console.log(`keystore written to ${o.out} (encrypted). Fund this address with a SMALL amount of SOL to test.`);
      break;
    }
    case "manual:set": {
      const u = await owner();
      const v = {
        userId: u.id,
        enabled: !o.off,
        ...(o.mode ? { managementMode: parseMode(o.mode) } : {}),
        ...(o["flip-threshold"] ? { managementParams: { flipThresholdBps: toBps(o["flip-threshold"]) } } : {}),
        ...(o.tp !== undefined ? { takeProfitBps: toBps(o.tp) } : {}),
        ...(o.sl !== undefined ? { stopLossBps: toBps(o.sl) } : {}),
        ...(o.trailing !== undefined ? { trailingStopBps: toBps(o.trailing) } : {}),
        ...(o.compound !== undefined ? { compoundIntervalMinutes: Number(o.compound) || null } : {}),
      };
      await db.insert(schema.manualSettings).values(v).onConflictDoUpdate({ target: schema.manualSettings.userId, set: v });
      console.log(`manual positions: ${o.off ? "off" : "managed"}`);
      break;
    }
    case "manual:show": {
      const u = await owner();
      const [m] = await db.select().from(schema.manualSettings).where(eq(schema.manualSettings.userId, u.id));
      if (!m) {
        console.log("manual positions: not configured (defaults: staged_flip 10%, no TP/SL). Run manual:set.");
        break;
      }
      const f = (m.managementParams as { flipThresholdBps?: number }).flipThresholdBps ?? 1000;
      console.log(`manual positions: ${m.enabled ? "managed" : "off"} | mode ${m.managementMode}${m.managementMode === "staged_flip" ? ` %${f / 100}` : ""} | TP ${m.takeProfitBps ? m.takeProfitBps / 100 + "%" : "-"} SL ${m.stopLossBps ? m.stopLossBps / 100 + "%" : "-"} trailing ${m.trailingStopBps ? m.trailingStopBps / 100 + "%" : "-"} | compound ${m.compoundIntervalMinutes ? m.compoundIntervalMinutes + " dk" : "kapalı"}`);
      break;
    }
    case "risk:show": {
      const u = await owner();
      const [r] = await db.select().from(schema.userRiskSettings).where(eq(schema.userRiskSettings.userId, u.id));
      if (!r) throw new Error("no risk settings; run user:init");
      console.log(
        `kill switch: ${r.killSwitch ? `ON (${r.killSwitchReason ?? ""})` : "off"} | per tx: ${Number(r.maxSolPerTx) / SOL} SOL | per day: ${Number(r.maxSolPerDay) / SOL} SOL | fund protection: ${r.fundProtectionEnabled ? `${r.fundProtectionLossBps / 100}%` : "off"}${r.fundProtectionTrippedAt ? " (TRIPPED)" : ""}`,
      );
      break;
    }
    case "risk:set": {
      const u = await owner();
      const set: Partial<typeof schema.userRiskSettings.$inferInsert> = {};
      if (o["max-per-tx"]) set.maxSolPerTx = toLamports(o["max-per-tx"])!;
      if (o["max-per-day"]) set.maxSolPerDay = toLamports(o["max-per-day"])!;
      if (!Object.keys(set).length) throw new Error("nothing to set (--max-per-tx / --max-per-day)");
      await db.update(schema.userRiskSettings).set(set).where(eq(schema.userRiskSettings.userId, u.id));
      console.log("risk settings updated");
      break;
    }
    case "kill":
    case "unkill": {
      const u = await owner();
      await db
        .update(schema.userRiskSettings)
        .set({ killSwitch: cmd === "kill", killSwitchReason: cmd === "kill" ? (o.reason ?? "manual") : null })
        .where(eq(schema.userRiskSettings.userId, u.id));
      console.log(cmd === "kill" ? "KILL SWITCH ON: no new opens/adds (exits still follow leaders)" : "kill switch off");
      break;
    }
    default:
      console.log("commands: user:init, leader:add, leader:list, leader:pause, leader:resume, leader:remove, wallet:create, risk:show, risk:set, kill, unkill, manual:set, manual:show");
      process.exitCode = cmd ? 1 : 0;
  }
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await close();
}

/** Read a passphrase twice from the TTY without echoing it. */
async function promptPassphrase(): Promise<string> {
  const a = await promptSecret("Keystore passphrase (min 12 chars): ");
  const b = await promptSecret("Repeat: ");
  if (a !== b) throw new Error("passphrases do not match");
  return a;
}

/** One line from the TTY, not echoed. */
function promptSecret(q: string): Promise<string> {
  if (!process.stdin.isTTY) throw new Error("no TTY: run with `docker compose run --rm -it ...`");
  return (
    new Promise<string>((resolve) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
      const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
      let prompted = false;
      out._writeToOutput = (s: string) => {
        if (!prompted) {
          out.output.write(s);
          prompted = true;
        }
      };
      rl.question(q, (a) => {
        rl.close();
        process.stdout.write("\n");
        resolve(a);
      });
    })
  );
}

function parseMode(m: string): "mirror" | "staged_flip" | "bottom_flip" | "precision_hybrid" {
  if (m === "mirror" || m === "staged_flip" || m === "bottom_flip" || m === "precision_hybrid") return m;
  throw new Error(`--mode must be mirror, staged_flip, bottom_flip or precision_hybrid`);
}
