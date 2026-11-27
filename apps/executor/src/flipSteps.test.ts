import { describe, expect, it } from "vitest";
import { runFlip, stepOutcome, type FlipDeps, type FlipProgress, type SigStatus } from "./flipSteps.js";

/**
 * A fake chain: transactions land when sent; the token a remove takes out shows up in its tx.
 * `crashAfter` makes the service "die" right after a given step's tx confirmed (the next save throws).
 */
function fakeChain(opts: { crashAfter?: "remove" | "add"; tokenOut?: bigint } = {}) {
  const landed = new Map<string, { kind: "remove" | "add"; token: bigint }>();
  const sent: Array<"remove" | "add"> = [];
  let db: FlipProgress = { stage: "planned", signatures: [] };
  let crash = opts.crashAfter;
  let clock = 1_000;
  let n = 0;
  const deps: FlipDeps = {
    async save(p) {
      const lastKind = p.signatures.length ? landed.get(p.signatures[p.signatures.length - 1]!)?.kind : undefined;
      // Crash on the first save after the crash step's signature was recorded (tx already confirmed on chain).
      if (crash && lastKind === crash && p.stage === (crash === "remove" ? "removed" : "added")) {
        crash = undefined;
        throw new Error("service stopped");
      }
      db = structuredClone(p);
    },
    async statuses(sigs) {
      return sigs.map((s): SigStatus => (landed.has(s) ? "confirmed" : "unknown"));
    },
    async tokenDelta(sigs) {
      return sigs.reduce((t, s) => t + (landed.get(s)?.token ?? 0n), 0n);
    },
    async decide() {
      return { from: 10, to: 19 };
    },
    async buildRemove() {
      return { txs: ["remove"], extraSigners: new Map() };
    },
    async buildAdd() {
      return { txs: ["add"], extraSigners: new Map() };
    },
    async send(tx, _extra, onSignature) {
      const kind = tx as "remove" | "add";
      const sig = `sig${++n}`;
      sent.push(kind);
      landed.set(sig, { kind, token: kind === "remove" ? (opts.tokenOut ?? 500n) : -(opts.tokenOut ?? 500n) });
      await onSignature(sig);
    },
    now: () => (clock += 1_000),
  };
  return { deps, sent, load: () => structuredClone(db) };
}

describe("flip steps", () => {
  it("normal run: one remove, one add of exactly what came out", async () => {
    const c = fakeChain();
    expect(await runFlip(c.load(), c.deps)).toEqual({ flipped: true, received: 500n });
    expect(c.sent).toEqual(["remove", "add"]);
  });

  it("crash after the remove confirmed: restart adds once, never removes again", async () => {
    const c = fakeChain({ crashAfter: "remove" });
    await expect(runFlip(c.load(), c.deps)).rejects.toThrow("service stopped");
    // Restart with what was persisted (stage still "planned", the remove step and its signature saved).
    expect(c.load().stage).toBe("planned");
    expect(await runFlip(c.load(), c.deps)).toEqual({ flipped: true, received: 500n });
    expect(c.sent).toEqual(["remove", "add"]);
    expect(c.load().stage).toBe("added");
  });

  it("crash after the add confirmed: restart finishes without a second add", async () => {
    const c = fakeChain({ crashAfter: "add" });
    await expect(runFlip(c.load(), c.deps)).rejects.toThrow("service stopped");
    expect(await runFlip(c.load(), c.deps)).toEqual({ flipped: true, received: 500n });
    expect(c.sent).toEqual(["remove", "add"]);
  });

  it("a step still in flight is waited for; nothing new is built", async () => {
    const c = fakeChain();
    const p: FlipProgress = { stage: "planned", signatures: ["ghost"], remove: { planned: 1, sigs: ["ghost"], startedAt: 1_500 } };
    expect(await runFlip(p, c.deps)).toEqual({ waiting: "remove" });
    expect(c.sent).toEqual([]);
  });
});

describe("step outcome", () => {
  const step = { planned: 2, sigs: ["a", "b"], startedAt: 0 };
  it("classifies", () => {
    expect(stepOutcome(step, ["confirmed", "confirmed"], 10)).toBe("landed");
    expect(stepOutcome(step, ["confirmed", "unknown"], 10)).toBe("uncertain");
    expect(stepOutcome(step, ["failed", "failed"], 10)).toBe("not_landed");
    expect(stepOutcome(step, ["confirmed", "failed"], 10)).toBe("partial");
    expect(stepOutcome({ ...step, sigs: [] }, [], 10)).toBe("uncertain");
    expect(stepOutcome({ ...step, sigs: [] }, [], 10 * 60_000)).toBe("not_landed");
    expect(stepOutcome(step, ["unknown", "unknown"], 10 * 60_000)).toBe("not_landed");
  });
});
