import { SmartLpIndexer } from "./dist/smartLp.js";
import { createDb } from "@binflip/db";
const { db, close } = createDb(process.env.DATABASE_URL);
const log = { info: (o, m) => console.log(m, JSON.stringify(o)), warn: (o, m) => console.log("WARN", m, JSON.stringify(o)), debug() {} };
await new SmartLpIndexer(db, "https://api.mainnet-beta.solana.com", log, { pools: 10, wallets: 60, concurrency: 4 }).run();
await close();
